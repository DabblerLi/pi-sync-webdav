import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';

import type { SyncState } from './config.js';
import {
	MAX_FILE_BYTES,
	MAX_OPERATION_BYTES,
	validateManifest,
	type ManifestFile,
	type ManifestV1,
} from './manifest.js';
import {
	FILE_OPERATION_CONCURRENCY,
	mapConcurrent,
	throwIfOperationCancelled,
	type OperationOptions,
} from './operation.js';
import {
	assertNoPathCollisions,
	assertSafeLocalTarget,
	parseManifestPath,
	type SafeRelativePath,
} from './paths.js';
import type { RemoteManifestSnapshot } from './remote-store.js';
import type { CollectedLocalFile, LocalSelection } from './selection.js';
import { readRegularFileSnapshot } from './safe-files.js';

export type PlannedAction = 'add' | 'delete' | 'secure' | 'update';

export interface LocalFileObservation {
	readonly mode: number;
	readonly path: SafeRelativePath;
	readonly sha256: string;
	readonly size: number;
}

export interface ExpectedAbsentLocalState {
	readonly kind: 'absent';
}

export interface ExpectedFileLocalState {
	readonly kind: 'file';
	readonly sha256: string;
	readonly size: number;
}

export type ExpectedLocalState = ExpectedAbsentLocalState | ExpectedFileLocalState;

export interface FileMutation {
	readonly action: PlannedAction;
	readonly expectedLocal: ExpectedLocalState;
	readonly path: SafeRelativePath;
	readonly source: ManifestFile | undefined;
}

export interface PushPlan {
	readonly actions: readonly FileMutation[];
	readonly expectedRemoteManifestSha256: string | undefined;
	readonly nextManagedPaths: readonly SafeRelativePath[];
	readonly sourceFiles: readonly CollectedLocalFile[];
}

export interface PullPlan {
	readonly actions: readonly FileMutation[];
	readonly downloads: readonly ManifestFile[];
	readonly nextManagedPaths: readonly SafeRelativePath[];
}

export interface PlanPullInput {
	readonly agentRoot: string;
	readonly caseInsensitiveDestination?: boolean;
	readonly connectionFingerprint: string;
	readonly manifest: ManifestV1;
	readonly operation?: OperationOptions;
	readonly syncState: SyncState | undefined;
}

function sha256(contents: Buffer): string {
	return createHash('sha256').update(contents).digest('hex');
}

function comparePaths(left: SafeRelativePath, right: SafeRelativePath): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}

function expectedFromObservation(
	observation: LocalFileObservation | undefined,
): ExpectedLocalState {
	if (observation === undefined) {
		return { kind: 'absent' };
	}
	return {
		kind: 'file',
		sha256: observation.sha256,
		size: observation.size,
	};
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { readonly code?: unknown }).code === 'ENOENT'
	);
}

function localDestinationKey(path: SafeRelativePath, caseInsensitiveDestination: boolean): string {
	return caseInsensitiveDestination ? path.toLocaleLowerCase('en-US') : path;
}

async function observeLocalFile(
	agentRoot: string,
	path: SafeRelativePath,
	operation?: OperationOptions,
): Promise<LocalFileObservation | undefined> {
	throwIfOperationCancelled(operation?.signal);
	const target = await assertSafeLocalTarget(agentRoot, path);
	throwIfOperationCancelled(operation?.signal);
	let entry;
	try {
		entry = await lstat(target);
	} catch (error: unknown) {
		if (isMissingPath(error)) {
			return undefined;
		}
		throw new Error('Unable to inspect local sync target', { cause: error });
	}
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new Error('Unsafe local sync target');
	}
	if (entry.size > MAX_FILE_BYTES) {
		throw new Error('Local sync target exceeds the size limit');
	}

	const contents = await readRegularFileSnapshot(target, {
		errorMessage: 'Unsafe local sync target',
		maxBytes: MAX_FILE_BYTES,
	});
	if (contents === undefined) {
		return undefined;
	}
	throwIfOperationCancelled(operation?.signal);
	return { mode: entry.mode, path, sha256: sha256(contents), size: contents.byteLength };
}

function toRemoteManifestFiles(
	remote: RemoteManifestSnapshot | undefined,
): ReadonlyMap<SafeRelativePath, ManifestFile> {
	if (remote === undefined) {
		return new Map();
	}
	const manifest = validateManifest(remote.manifest);
	return new Map(manifest.files.map((file) => [file.path, file]));
}

export function planPush(input: {
	readonly local: LocalSelection;
	readonly remote: RemoteManifestSnapshot | undefined;
}): PushPlan {
	const localFiles = [...input.local.files].sort((left, right) =>
		comparePaths(left.path, right.path),
	);
	const localByPath = new Map(localFiles.map((file) => [file.path, file]));
	if (localByPath.size !== localFiles.length) {
		throw new Error('Duplicate local selection path');
	}
	assertNoPathCollisions(
		localFiles.map((file) => file.path),
		'Local selection contains colliding destinations',
	);
	const remoteByPath = toRemoteManifestFiles(input.remote);
	const actions: FileMutation[] = [];

	for (const [path, localFile] of localByPath) {
		const remoteFile = remoteByPath.get(path);
		if (remoteFile === undefined) {
			actions.push({
				action: 'add',
				expectedLocal: {
					kind: 'file',
					sha256: localFile.sha256,
					size: localFile.size,
				},
				path,
				source: remoteFile,
			});
			continue;
		}
		if (remoteFile.sha256 !== localFile.sha256 || remoteFile.size !== localFile.size) {
			actions.push({
				action: 'update',
				expectedLocal: {
					kind: 'file',
					sha256: localFile.sha256,
					size: localFile.size,
				},
				path,
				source: remoteFile,
			});
		}
	}

	for (const [path, remoteFile] of remoteByPath) {
		if (!localByPath.has(path)) {
			actions.push({
				action: 'delete',
				expectedLocal: { kind: 'absent' },
				path,
				source: remoteFile,
			});
		}
	}

	return {
		actions: actions.sort((left, right) => comparePaths(left.path, right.path)),
		expectedRemoteManifestSha256: input.remote?.sha256,
		nextManagedPaths: localFiles.map((file) => file.path),
		sourceFiles: localFiles,
	};
}

export async function planPull(input: PlanPullInput): Promise<PullPlan> {
	throwIfOperationCancelled(input.operation?.signal);
	input.operation?.onProgress?.({ phase: 'preparing' });
	throwIfOperationCancelled(input.operation?.signal);
	const manifest = validateManifest(input.manifest);
	const caseInsensitiveDestination = input.caseInsensitiveDestination ?? true;
	assertNoPathCollisions(
		manifest.files.map((file) => file.path),
		'Remote manifest contains colliding local paths',
		caseInsensitiveDestination,
	);

	const manifestPaths = new Set(manifest.files.map((file) => file.path));
	const manifestPathsByDestination = new Map(
		manifest.files.map((file) => [
			localDestinationKey(file.path, caseInsensitiveDestination),
			file.path,
		]),
	);
	const deletionCandidates: SafeRelativePath[] = [];
	if (
		input.syncState !== undefined &&
		input.syncState.connectionFingerprint === input.connectionFingerprint
	) {
		for (const rawPath of input.syncState.managedPaths) {
			const path = parseManifestPath(rawPath);
			const manifestPath = manifestPathsByDestination.get(
				localDestinationKey(path, caseInsensitiveDestination),
			);
			if (manifestPath !== undefined) {
				if (manifestPath !== path) {
					throw new Error('Managed paths collide with remote local destinations');
				}
				continue;
			}
			deletionCandidates.push(path);
		}
	}
	assertNoPathCollisions(
		[...manifest.files.map((file) => file.path), ...deletionCandidates],
		'Managed paths collide with remote local destinations',
		caseInsensitiveDestination,
	);

	const actions: FileMutation[] = [];
	const downloads: ManifestFile[] = [];
	let observedLocalBytes = 0;
	const observeAndCount = async (
		path: SafeRelativePath,
	): Promise<LocalFileObservation | undefined> => {
		const local = await observeLocalFile(input.agentRoot, path, input.operation);
		if (local === undefined) {
			return undefined;
		}
		observedLocalBytes += local.size;
		if (observedLocalBytes > MAX_OPERATION_BYTES) {
			throw new Error('Local sync targets exceed the size limit');
		}
		return local;
	};
	const manifestObservations = await mapConcurrent(
		manifest.files,
		FILE_OPERATION_CONCURRENCY,
		(file) => observeAndCount(file.path),
	);
	for (const [index, file] of manifest.files.entries()) {
		const local = manifestObservations[index];
		if (local === undefined) {
			actions.push({
				action: 'add',
				expectedLocal: { kind: 'absent' },
				path: file.path,
				source: file,
			});
			downloads.push(file);
			continue;
		}
		if (local.sha256 !== file.sha256 || local.size !== file.size) {
			actions.push({
				action: 'update',
				expectedLocal: expectedFromObservation(local),
				path: file.path,
				source: file,
			});
			downloads.push(file);
			continue;
		}
		if (
			file.path === 'auth.json' &&
			(process.platform === 'win32' || (local.mode & 0o7777) !== 0o600)
		) {
			actions.push({
				action: 'secure',
				expectedLocal: expectedFromObservation(local),
				path: file.path,
				source: file,
			});
		}
	}

	const deletionObservations = await mapConcurrent(
		deletionCandidates,
		FILE_OPERATION_CONCURRENCY,
		(path) => observeAndCount(path),
	);
	for (const [index, path] of deletionCandidates.entries()) {
		const local = deletionObservations[index];
		if (local !== undefined) {
			actions.push({
				action: 'delete',
				expectedLocal: expectedFromObservation(local),
				path,
				source: undefined,
			});
		}
	}

	return {
		actions: actions.sort((left, right) => comparePaths(left.path, right.path)),
		downloads: downloads.sort((left, right) => comparePaths(left.path, right.path)),
		nextManagedPaths: [...manifestPaths].sort(comparePaths),
	};
}
