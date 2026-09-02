import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { ManifestFile } from './manifest.js';
import { MAX_FILE_BYTES, MAX_OPERATION_BYTES } from './manifest.js';
import { getPrivatePaths, parseManifestPath, type SafeRelativePath } from './paths.js';
import { throwIfOperationCancelled, type OperationOptions } from './operation.js';
import { readRegularFileSnapshot } from './safe-files.js';
import type { ExpectedLocalState, PullPlan } from './sync-plan.js';

const WORKSPACE_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface PullWorkspace {
	readonly id: string;
}

export interface BackupFile {
	readonly path: SafeRelativePath;
	readonly sha256: string;
	readonly size: number;
}

export interface RestoreMutation {
	readonly action: 'add' | 'update';
	readonly backup: BackupFile;
	readonly expectedLocal: ExpectedLocalState;
	readonly path: SafeRelativePath;
}

export interface RestorePlan {
	readonly actions: readonly RestoreMutation[];
}

export type ApplyResult =
	| { readonly status: 'applied' }
	| {
			readonly failureMessage: string;
			readonly status: 'failed' | 'rolled-back' | 'rollback-failed';
	  };

interface ActiveSnapshot {
	readonly contents: Buffer;
	readonly mode: number;
	readonly path: SafeRelativePath;
	readonly sha256: string;
	readonly size: number;
}

interface AppliedMutation {
	readonly path: SafeRelativePath;
	readonly previous: ActiveSnapshot | undefined;
}

class ActiveWriteError extends Error {
	constructor() {
		super('Unable to secure local file permissions after replacement');
		this.name = 'ActiveWriteError';
	}
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { readonly code?: unknown }).code === 'ENOENT'
	);
}

function isAlreadyExistsPath(error: unknown): error is NodeJS.ErrnoException {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { readonly code?: unknown }).code === 'EEXIST'
	);
}

function isNonEmptyDirectoryError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { readonly code?: unknown }).code === 'ENOTEMPTY'
	);
}

function sha256(contents: Buffer): string {
	return createHash('sha256').update(contents).digest('hex');
}

function safeFailureMessage(error: unknown): string {
	return error instanceof Error && error.message.trim().length > 0
		? error.message
		: 'Local file operation failed';
}

function comparePaths(left: SafeRelativePath, right: SafeRelativePath): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}

function assertWorkspaceId(workspace: PullWorkspace): void {
	if (!WORKSPACE_ID_PATTERN.test(workspace.id)) {
		throw new Error('Invalid pull workspace');
	}
}

function assertSafeAgentRoot(agentRoot: string): string {
	if (typeof agentRoot !== 'string' || agentRoot.length === 0) {
		throw new Error('Invalid Pi agent directory');
	}
	return resolve(agentRoot);
}

async function assertDirectory(
	path: string,
	errorMessage: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
	let entry;
	try {
		entry = await fs.lstat(path);
	} catch {
		throw new Error(errorMessage);
	}
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error(errorMessage);
	}
	return entry;
}

async function ensureSafeDirectory(
	path: string,
	mode: number,
	errorMessage: string,
): Promise<void> {
	try {
		const entry = await fs.lstat(path);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(errorMessage);
		}
	} catch (error: unknown) {
		if (!isMissingPath(error)) {
			throw error;
		}
		try {
			await fs.mkdir(path, { mode });
		} catch (mkdirError: unknown) {
			if (!isAlreadyExistsPath(mkdirError)) {
				throw mkdirError;
			}
		}
		const entry = await fs.lstat(path);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(errorMessage, { cause: error });
		}
	}
}

async function ensureSafeDirectories(
	root: string,
	segments: readonly string[],
	mode: number,
	errorMessage: string,
): Promise<string> {
	await assertDirectory(root, errorMessage);
	let current = root;
	for (const segment of segments) {
		current = join(current, segment);
		await ensureSafeDirectory(current, mode, errorMessage);
	}
	return current;
}

async function inspectSafeDirectories(
	root: string,
	segments: readonly string[],
	errorMessage: string,
): Promise<boolean> {
	await assertDirectory(root, errorMessage);
	let current = root;
	for (const segment of segments) {
		current = join(current, segment);
		try {
			const entry = await fs.lstat(current);
			if (!entry.isDirectory() || entry.isSymbolicLink()) {
				throw new Error(errorMessage);
			}
		} catch (error: unknown) {
			if (isMissingPath(error)) {
				return false;
			}
			throw error;
		}
	}
	return true;
}

async function getPrivateDirectory(agentRoot: string): Promise<ReturnType<typeof getPrivatePaths>> {
	const root = assertSafeAgentRoot(agentRoot);
	await assertDirectory(root, 'Invalid Pi agent directory');
	const paths = getPrivatePaths(root);
	await ensureSafeDirectory(paths.directory, 0o700, 'Unsafe private directory');
	await fs.chmod(paths.directory, 0o700);
	return paths;
}

async function getExistingPrivateDirectory(
	agentRoot: string,
): Promise<ReturnType<typeof getPrivatePaths> | undefined> {
	const root = assertSafeAgentRoot(agentRoot);
	await assertDirectory(root, 'Invalid Pi agent directory');
	const paths = getPrivatePaths(root);
	try {
		const entry = await fs.lstat(paths.directory);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error('Unsafe private directory');
		}
	} catch (error: unknown) {
		if (isMissingPath(error)) {
			return undefined;
		}
		throw error;
	}
	return paths;
}

function toAbsolutePath(root: string, path: SafeRelativePath): string {
	const canonicalPath = parseManifestPath(path);
	return join(root, ...canonicalPath.split('/'));
}

async function assertSafeRegularOrMissing(path: string, errorMessage: string): Promise<boolean> {
	try {
		const entry = await fs.lstat(path);
		if (!entry.isFile() || entry.isSymbolicLink()) {
			throw new Error(errorMessage);
		}
		return true;
	} catch (error: unknown) {
		if (isMissingPath(error)) {
			return false;
		}
		throw error;
	}
}

async function writeAtomically(
	target: string,
	contents: Buffer,
	options: {
		readonly enforceMode: boolean;
		readonly mode: number;
		readonly requireAbsent: boolean;
	},
): Promise<void> {
	const parent = join(target, '..');
	const originalParent = await assertDirectory(parent, 'Unsafe local target');
	const targetExists = await assertSafeRegularOrMissing(target, 'Unsafe local target');
	if (options.requireAbsent && targetExists) {
		throw new Error('Local target changed');
	}

	const temporaryPath = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
	let renamed = false;
	try {
		await fs.writeFile(temporaryPath, contents, { flag: 'wx', mode: options.mode });
		if (options.enforceMode) {
			await fs.chmod(temporaryPath, options.mode);
		}
		const currentParent = await assertDirectory(parent, 'Unsafe local target');
		if (currentParent.dev !== originalParent.dev || currentParent.ino !== originalParent.ino) {
			throw new Error('Unsafe local target');
		}
		const currentTargetExists = await assertSafeRegularOrMissing(target, 'Unsafe local target');
		if (options.requireAbsent && currentTargetExists) {
			throw new Error('Local target changed');
		}
		await fs.rename(temporaryPath, target);
		renamed = true;
	} finally {
		if (!renamed) {
			await fs.rm(temporaryPath, { force: true });
		}
	}
}

function verifyContents(
	file: Pick<ManifestFile | BackupFile, 'sha256' | 'size'>,
	contents: Buffer,
): void {
	if (contents.byteLength !== file.size || sha256(contents) !== file.sha256) {
		throw new Error('File contents failed integrity verification');
	}
}

async function getWorkspaceDirectory(agentRoot: string, workspace: PullWorkspace): Promise<string> {
	assertWorkspaceId(workspace);
	const paths = await getPrivateDirectory(agentRoot);
	await ensureSafeDirectory(paths.workspaceDirectory, 0o700, 'Unsafe pull workspace directory');
	const directory = join(paths.workspaceDirectory, workspace.id);
	await assertDirectory(directory, 'Unsafe pull workspace');
	return directory;
}

async function observeActiveSnapshot(
	agentRoot: string,
	path: SafeRelativePath,
): Promise<ActiveSnapshot | undefined> {
	const root = assertSafeAgentRoot(agentRoot);
	const target = toAbsolutePath(root, path);
	const parentSegments = path.split('/').slice(0, -1);
	if (!(await inspectSafeDirectories(root, parentSegments, 'Unsafe local target'))) {
		return undefined;
	}
	if (!(await assertSafeRegularOrMissing(target, 'Unsafe local target'))) {
		return undefined;
	}
	const initialEntry = await fs.lstat(target);
	if (initialEntry.size > MAX_FILE_BYTES) {
		throw new Error('Local target exceeds the size limit');
	}
	const contents = await readRegularFileSnapshot(target, {
		errorMessage: 'Unsafe local target',
		maxBytes: MAX_FILE_BYTES,
	});
	if (contents === undefined) {
		throw new Error('Local target changed');
	}
	return {
		contents,
		mode: initialEntry.mode & 0o7777,
		path,
		sha256: sha256(contents),
		size: contents.byteLength,
	};
}

async function readActiveSnapshot(
	agentRoot: string,
	path: SafeRelativePath,
	expected: ExpectedLocalState,
): Promise<ActiveSnapshot | undefined> {
	const snapshot = await observeActiveSnapshot(agentRoot, path);
	if (snapshot === undefined) {
		if (expected.kind !== 'absent') {
			throw new Error('Local target changed');
		}
		return undefined;
	}
	if (
		expected.kind !== 'file' ||
		snapshot.sha256 !== expected.sha256 ||
		snapshot.size !== expected.size
	) {
		throw new Error('Local target changed');
	}
	return snapshot;
}

async function writePersistentBackup(agentRoot: string, snapshot: ActiveSnapshot): Promise<void> {
	const paths = await getPrivateDirectory(agentRoot);
	await ensureSafeDirectory(paths.backupsDirectory, 0o700, 'Unsafe backup directory');
	const parentSegments = snapshot.path.split('/').slice(0, -1);
	const parent = await ensureSafeDirectories(
		paths.backupsDirectory,
		parentSegments,
		0o700,
		'Unsafe backup directory',
	);
	const target = join(parent, snapshot.path.split('/').at(-1) ?? '');
	await writeAtomically(target, snapshot.contents, {
		enforceMode: true,
		mode: 0o600,
		requireAbsent: false,
	});
	const backupContents = await readRegularFileSnapshot(target, {
		errorMessage: 'Unsafe backup file',
		maxBytes: MAX_FILE_BYTES,
	});
	if (backupContents === undefined) {
		throw new Error('Missing backup file');
	}
	verifyContents(snapshot, backupContents);
}

async function clearPersistentBackups(agentRoot: string): Promise<void> {
	const paths = await getPrivateDirectory(agentRoot);
	await ensureSafeDirectory(paths.backupsDirectory, 0o700, 'Unsafe backup directory');
	for (const entry of await fs.readdir(paths.backupsDirectory)) {
		await fs.rm(join(paths.backupsDirectory, entry), { force: true, recursive: true });
	}
}

async function readStagedFile(
	agentRoot: string,
	workspace: PullWorkspace,
	file: ManifestFile,
): Promise<Buffer> {
	const workspaceDirectory = await getWorkspaceDirectory(agentRoot, workspace);
	const path = parseManifestPath(file.path);
	if (
		!(await inspectSafeDirectories(
			workspaceDirectory,
			path.split('/').slice(0, -1),
			'Unsafe staged file',
		))
	) {
		throw new Error('Missing staged file');
	}
	const target = toAbsolutePath(workspaceDirectory, path);
	if (!(await assertSafeRegularOrMissing(target, 'Unsafe staged file'))) {
		throw new Error('Missing staged file');
	}
	const contents = await readRegularFileSnapshot(target, {
		errorMessage: 'Unsafe staged file',
		maxBytes: MAX_FILE_BYTES,
	});
	if (contents === undefined) {
		throw new Error('Missing staged file');
	}
	verifyContents(file, contents);
	return contents;
}

async function walkRegularFiles(
	root: string,
	prefix: SafeRelativePath | undefined,
	operation?: OperationOptions,
): Promise<readonly BackupFile[]> {
	throwIfOperationCancelled(operation?.signal);
	const entries = await fs.readdir(root);
	const files: BackupFile[] = [];
	for (const name of entries.sort()) {
		throwIfOperationCancelled(operation?.signal);
		const path =
			prefix === undefined ? parseManifestPath(name) : parseManifestPath(`${prefix}/${name}`);
		const absolutePath = join(root, name);
		const entry = await fs.lstat(absolutePath);
		if (entry.isSymbolicLink()) {
			throw new Error('Unsafe private file');
		}
		if (entry.isDirectory()) {
			files.push(...(await walkRegularFiles(absolutePath, path, operation)));
			continue;
		}
		if (!entry.isFile()) {
			throw new Error('Unsupported private file type');
		}
		if (entry.size > MAX_FILE_BYTES) {
			throw new Error('Backup file exceeds the size limit');
		}
		const contents = await readRegularFileSnapshot(absolutePath, {
			errorMessage: 'Unsafe private file',
			maxBytes: MAX_FILE_BYTES,
		});
		if (contents === undefined) {
			throw new Error('Unsafe private file');
		}
		files.push({ path, sha256: sha256(contents), size: contents.byteLength });
	}
	return files;
}

async function verifyWorkspaceFiles(
	agentRoot: string,
	workspace: PullWorkspace,
	files: readonly ManifestFile[],
	operation?: OperationOptions,
): Promise<void> {
	throwIfOperationCancelled(operation?.signal);
	const expected = new Map(files.map((file) => [file.path, file]));
	const workspaceDirectory = await getWorkspaceDirectory(agentRoot, workspace);
	const stagedFiles = await walkRegularFiles(workspaceDirectory, undefined, operation);
	if (
		stagedFiles.length !== expected.size ||
		stagedFiles.some((file) => expected.get(file.path) === undefined)
	) {
		throw new Error('Pull workspace does not match the download plan');
	}
	for (const file of stagedFiles) {
		throwIfOperationCancelled(operation?.signal);
		const expectedFile = expected.get(file.path);
		if (
			expectedFile === undefined ||
			file.size !== expectedFile.size ||
			file.sha256 !== expectedFile.sha256
		) {
			throw new Error('Pull workspace does not match the download plan');
		}
	}
}

async function writeActiveFile(
	agentRoot: string,
	path: SafeRelativePath,
	contents: Buffer,
	requireAbsent: boolean,
	previousMode: number | undefined,
): Promise<void> {
	const root = assertSafeAgentRoot(agentRoot);
	const target = toAbsolutePath(root, path);
	const parentSegments = path.split('/').slice(0, -1);
	await ensureSafeDirectories(root, parentSegments, 0o755, 'Unsafe local target');
	const authFile = path === 'auth.json';
	const mode = authFile ? 0o600 : (previousMode ?? 0o666);
	await writeAtomically(target, contents, {
		enforceMode: authFile || (previousMode !== undefined && process.platform !== 'win32'),
		mode,
		requireAbsent,
	});
	if (authFile) {
		try {
			await fs.chmod(target, 0o600);
		} catch {
			throw new ActiveWriteError();
		}
	}
}

async function writeAndRecordMutation(
	agentRoot: string,
	path: SafeRelativePath,
	contents: Buffer,
	previous: ActiveSnapshot | undefined,
	mutations: AppliedMutation[],
): Promise<void> {
	try {
		await writeActiveFile(agentRoot, path, contents, previous === undefined, previous?.mode);
	} catch (error: unknown) {
		if (error instanceof ActiveWriteError) {
			mutations.push({ path, previous });
		}
		throw error;
	}
	mutations.push({ path, previous });
}

async function deleteActiveFile(agentRoot: string, path: SafeRelativePath): Promise<void> {
	const root = assertSafeAgentRoot(agentRoot);
	const parentSegments = path.split('/').slice(0, -1);
	if (!(await inspectSafeDirectories(root, parentSegments, 'Unsafe local target'))) {
		throw new Error('Local target changed');
	}
	const target = toAbsolutePath(root, path);
	if (!(await assertSafeRegularOrMissing(target, 'Unsafe local target'))) {
		throw new Error('Local target changed');
	}
	await fs.unlink(target);
	await removeEmptyAncestorDirectories(root, parentSegments);
}

async function removeEmptyAncestorDirectories(
	root: string,
	segments: readonly string[],
): Promise<void> {
	let directory = join(root, ...segments);
	while (directory !== root) {
		let entries: readonly string[];
		try {
			entries = await fs.readdir(directory);
		} catch (error: unknown) {
			if (isMissingPath(error)) {
				directory = dirname(directory);
				continue;
			}
			throw new Error('Unable to remove emptied directories', { cause: error });
		}
		if (entries.length > 0) {
			return;
		}
		try {
			await fs.rmdir(directory);
		} catch (error: unknown) {
			if (isNonEmptyDirectoryError(error)) {
				return;
			}
			throw new Error('Unable to remove emptied directories', { cause: error });
		}
		directory = dirname(directory);
	}
}

async function rollbackMutations(
	agentRoot: string,
	mutations: readonly AppliedMutation[],
): Promise<boolean> {
	let complete = true;
	for (const mutation of [...mutations].reverse()) {
		try {
			if (mutation.previous === undefined) {
				const root = assertSafeAgentRoot(agentRoot);
				if (
					!(await inspectSafeDirectories(
						root,
						mutation.path.split('/').slice(0, -1),
						'Unsafe local target',
					))
				) {
					throw new Error('Unsafe local target');
				}
				const target = toAbsolutePath(root, mutation.path);
				if (await assertSafeRegularOrMissing(target, 'Unsafe local target')) {
					await fs.unlink(target);
				}
			} else {
				await writeActiveFile(
					agentRoot,
					mutation.path,
					mutation.previous.contents,
					false,
					mutation.previous.mode,
				);
			}
		} catch {
			complete = false;
		}
	}
	return complete;
}

async function recoverFromApplyFailure(
	agentRoot: string,
	mutations: readonly AppliedMutation[],
	error: unknown,
): Promise<ApplyResult> {
	const failureMessage = safeFailureMessage(error);
	if (mutations.length === 0) {
		return { failureMessage, status: 'failed' };
	}
	return {
		failureMessage,
		status: (await rollbackMutations(agentRoot, mutations)) ? 'rolled-back' : 'rollback-failed',
	};
}

export async function createPullWorkspace(agentRoot: string): Promise<PullWorkspace> {
	const paths = await getPrivateDirectory(agentRoot);
	await ensureSafeDirectory(paths.workspaceDirectory, 0o700, 'Unsafe pull workspace directory');
	// Remove workspaces left behind by interrupted pulls; unrecognized entries are kept.
	for (const entry of await fs.readdir(paths.workspaceDirectory, { withFileTypes: true })) {
		if (entry.isDirectory() && WORKSPACE_ID_PATTERN.test(entry.name)) {
			await fs.rm(join(paths.workspaceDirectory, entry.name), { force: true, recursive: true });
		}
	}
	const id = randomUUID();
	const directory = join(paths.workspaceDirectory, id);
	await fs.mkdir(directory, { mode: 0o700 });
	await assertDirectory(directory, 'Unsafe pull workspace');
	return { id };
}

export async function detectCaseInsensitiveDestination(agentRoot: string): Promise<boolean> {
	const paths = await getPrivateDirectory(agentRoot);
	const suffix = randomUUID();
	const probePath = join(paths.directory, `Probe-${suffix}`);
	const variantPath = join(paths.directory, `pROBE-${suffix}`);
	let caseInsensitive = false;
	let probeError: unknown;
	try {
		await fs.writeFile(probePath, '', { flag: 'wx', mode: 0o600 });
	} catch (error: unknown) {
		probeError = error;
	}
	if (probeError === undefined) {
		try {
			const entry = await fs.lstat(variantPath);
			if (!entry.isFile() || entry.isSymbolicLink()) {
				probeError = new Error('Unexpected case-sensitivity probe state');
			} else {
				caseInsensitive = true;
			}
		} catch (error: unknown) {
			if (!isMissingPath(error)) {
				probeError = error;
			}
		}
	}
	let cleanupError: unknown;
	try {
		await fs.rm(probePath, { force: true });
	} catch (error: unknown) {
		cleanupError = error;
	}
	if (probeError !== undefined) {
		throw new Error('Unable to detect destination case sensitivity', { cause: probeError });
	}
	if (cleanupError !== undefined) {
		throw new Error('Unable to remove the case-sensitivity probe', { cause: cleanupError });
	}
	return caseInsensitive;
}

export async function stageVerifiedFile(
	agentRoot: string,
	workspace: PullWorkspace,
	file: ManifestFile,
	contents: Buffer,
	operation?: OperationOptions,
): Promise<void> {
	throwIfOperationCancelled(operation?.signal);
	const path = parseManifestPath(file.path);
	verifyContents(file, contents);
	const workspaceDirectory = await getWorkspaceDirectory(agentRoot, workspace);
	const parentSegments = path.split('/').slice(0, -1);
	const parent = await ensureSafeDirectories(
		workspaceDirectory,
		parentSegments,
		0o700,
		'Unsafe pull workspace',
	);
	const target = join(parent, path.split('/').at(-1) ?? '');
	await writeAtomically(target, contents, {
		enforceMode: true,
		mode: 0o600,
		requireAbsent: true,
	});
	const stagedContents = await readRegularFileSnapshot(target, {
		errorMessage: 'Unsafe staged file',
		maxBytes: MAX_FILE_BYTES,
	});
	if (stagedContents === undefined) {
		throw new Error('Missing staged file');
	}
	verifyContents(file, stagedContents);
	throwIfOperationCancelled(operation?.signal);
}

export async function applyPullPlan(
	agentRoot: string,
	workspace: PullWorkspace,
	plan: PullPlan,
	operation?: OperationOptions,
): Promise<ApplyResult> {
	throwIfOperationCancelled(operation?.signal);
	await verifyWorkspaceFiles(agentRoot, workspace, plan.downloads, operation);
	const mutations: AppliedMutation[] = [];
	// Backups capture the files replaced or removed by this pull. The first
	// backup write replaces the set left by the previous pull.
	let backupsCleared = false;
	const backupPrevious = async (previous: ActiveSnapshot): Promise<void> => {
		if (!backupsCleared) {
			backupsCleared = true;
			await clearPersistentBackups(agentRoot);
		}
		await writePersistentBackup(agentRoot, previous);
	};
	try {
		if (new Set(plan.actions.map((mutation) => mutation.path)).size !== plan.actions.length) {
			throw new Error('Duplicate pull mutation path');
		}
		for (const mutation of plan.actions) {
			throwIfOperationCancelled(operation?.signal);
			operation?.onProgress?.({
				completed: mutations.length + 1,
				phase: 'applying',
				total: plan.actions.length,
			});
			throwIfOperationCancelled(operation?.signal);
			const previous = await readActiveSnapshot(agentRoot, mutation.path, mutation.expectedLocal);
			throwIfOperationCancelled(operation?.signal);
			if (mutation.action === 'secure') {
				if (mutation.path !== 'auth.json' || previous === undefined) {
					throw new Error('Local target changed');
				}
				const root = assertSafeAgentRoot(agentRoot);
				const target = toAbsolutePath(root, mutation.path);
				await fs.chmod(target, 0o600);
				continue;
			}
			if (mutation.action === 'delete') {
				if (previous === undefined) {
					throw new Error('Local target changed');
				}
				await backupPrevious(previous);
				throwIfOperationCancelled(operation?.signal);
				await readActiveSnapshot(agentRoot, mutation.path, mutation.expectedLocal);
				throwIfOperationCancelled(operation?.signal);
				await deleteActiveFile(agentRoot, mutation.path);
				mutations.push({ path: mutation.path, previous });
				continue;
			}
			if (mutation.source === undefined || mutation.source.path !== mutation.path) {
				throw new Error('Missing staged source file');
			}
			const contents = await readStagedFile(agentRoot, workspace, mutation.source);
			throwIfOperationCancelled(operation?.signal);
			if (previous !== undefined) {
				await backupPrevious(previous);
				throwIfOperationCancelled(operation?.signal);
			}
			await readActiveSnapshot(agentRoot, mutation.path, mutation.expectedLocal);
			throwIfOperationCancelled(operation?.signal);
			await writeAndRecordMutation(agentRoot, mutation.path, contents, previous, mutations);
		}
		return { status: 'applied' };
	} catch (error: unknown) {
		return recoverFromApplyFailure(agentRoot, mutations, error);
	}
}

export async function disposePullWorkspace(
	agentRoot: string,
	workspace: PullWorkspace,
): Promise<void> {
	assertWorkspaceId(workspace);
	const paths = await getPrivateDirectory(agentRoot);
	await ensureSafeDirectory(paths.workspaceDirectory, 0o700, 'Unsafe pull workspace directory');
	const workspaceDirectory = join(paths.workspaceDirectory, workspace.id);
	try {
		const entry = await fs.lstat(workspaceDirectory);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error('Unsafe pull workspace');
		}
		await fs.rm(workspaceDirectory, { force: true, recursive: true });
	} catch (error: unknown) {
		if (!isMissingPath(error)) {
			throw error;
		}
	}
	// Remove the workspace parent when no staged workspaces remain.
	await fs.rmdir(paths.workspaceDirectory).catch(() => undefined);
}

export async function listBackups(
	agentRoot: string,
	operation?: OperationOptions,
): Promise<readonly BackupFile[]> {
	throwIfOperationCancelled(operation?.signal);
	operation?.onProgress?.({ phase: 'restoring' });
	throwIfOperationCancelled(operation?.signal);
	const paths = await getExistingPrivateDirectory(agentRoot);
	if (paths === undefined) {
		return [];
	}
	try {
		const entry = await fs.lstat(paths.backupsDirectory);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error('Unsafe backup directory');
		}
	} catch (error: unknown) {
		if (isMissingPath(error)) {
			return [];
		}
		throw error;
	}
	const backups = await walkRegularFiles(paths.backupsDirectory, undefined, operation);
	const totalBytes = backups.reduce((total, backup) => total + backup.size, 0);
	if (totalBytes > MAX_OPERATION_BYTES) {
		throw new Error('Backup files exceed the size limit');
	}
	return [...backups].sort((left, right) => comparePaths(left.path, right.path));
}

export async function planRestore(
	agentRoot: string,
	backups: readonly BackupFile[],
	operation?: OperationOptions,
): Promise<RestorePlan> {
	const actions: RestoreMutation[] = [];
	for (const backup of [...backups].sort((left, right) => comparePaths(left.path, right.path))) {
		throwIfOperationCancelled(operation?.signal);
		const current = await observeActiveSnapshot(agentRoot, backup.path);
		const expectedLocal: ExpectedLocalState =
			current === undefined
				? { kind: 'absent' }
				: { kind: 'file', sha256: current.sha256, size: current.size };
		actions.push({
			action: current === undefined ? 'add' : 'update',
			backup,
			expectedLocal,
			path: backup.path,
		});
	}
	return { actions };
}

export async function applyRestorePlan(
	agentRoot: string,
	plan: RestorePlan,
	operation?: OperationOptions,
): Promise<ApplyResult> {
	throwIfOperationCancelled(operation?.signal);
	const paths = await getPrivateDirectory(agentRoot);
	await ensureSafeDirectory(paths.backupsDirectory, 0o700, 'Unsafe backup directory');
	const mutations: AppliedMutation[] = [];
	try {
		for (const action of plan.actions) {
			throwIfOperationCancelled(operation?.signal);
			operation?.onProgress?.({
				completed: mutations.length + 1,
				phase: 'restoring',
				total: plan.actions.length,
			});
			throwIfOperationCancelled(operation?.signal);
			if (
				!(await inspectSafeDirectories(
					paths.backupsDirectory,
					action.path.split('/').slice(0, -1),
					'Unsafe backup directory',
				))
			) {
				throw new Error('Missing backup file');
			}
			const backupTarget = toAbsolutePath(paths.backupsDirectory, action.path);
			if (!(await assertSafeRegularOrMissing(backupTarget, 'Unsafe backup file'))) {
				throw new Error('Missing backup file');
			}
			const backupContents = await readRegularFileSnapshot(backupTarget, {
				errorMessage: 'Unsafe backup file',
				maxBytes: MAX_FILE_BYTES,
			});
			if (backupContents === undefined) {
				throw new Error('Missing backup file');
			}
			verifyContents(action.backup, backupContents);
			throwIfOperationCancelled(operation?.signal);
			const previous = await readActiveSnapshot(agentRoot, action.path, action.expectedLocal);
			throwIfOperationCancelled(operation?.signal);
			await readActiveSnapshot(agentRoot, action.path, action.expectedLocal);
			throwIfOperationCancelled(operation?.signal);
			await writeAndRecordMutation(agentRoot, action.path, backupContents, previous, mutations);
		}
		return { status: 'applied' };
	} catch (error: unknown) {
		return recoverFromApplyFailure(agentRoot, mutations, error);
	}
}
