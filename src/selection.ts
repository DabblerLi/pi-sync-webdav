import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import { MAX_FILE_BYTES, MAX_OPERATION_BYTES } from './manifest.js';
import { throwIfOperationCancelled, type OperationOptions } from './operation.js';
import {
	isPermanentlyExcluded,
	parseManifestPath,
	parsePushInclude,
	type SafeRelativePath,
} from './paths.js';
import { readRegularFileSnapshot } from './safe-files.js';

export const DEFAULT_PUSH_INCLUDES = [
	'settings.json',
	'keybindings.json',
	'AGENTS.md',
	'SYSTEM.md',
	'APPEND_SYSTEM.md',
	'models.json',
	'themes',
	'prompts',
	'skills',
	'extensions',
].map(parsePushInclude) as readonly SafeRelativePath[];

const SECRET_PATTERNS = [
	/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
	/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
	/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/iu,
] as const;

export interface SelectionCandidate {
	readonly defaultSelected: boolean;
	readonly path: SafeRelativePath;
	readonly type: 'directory' | 'file' | 'missing';
}

export interface CollectedLocalFile {
	readonly contents: Buffer;
	readonly path: SafeRelativePath;
	readonly sha256: string;
	readonly size: number;
}

export interface LocalSelection {
	readonly files: readonly CollectedLocalFile[];
	readonly secretWarningPaths: readonly SafeRelativePath[];
	readonly skippedSymlinkPaths: readonly SafeRelativePath[];
	readonly totalBytes: number;
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { readonly code?: unknown }).code === 'ENOENT'
	);
}

function sha256(contents: Buffer): string {
	return createHash('sha256').update(contents).digest('hex');
}

function assertSafeAgentRoot(agentRoot: string): string {
	if (typeof agentRoot !== 'string' || agentRoot.length === 0) {
		throw new Error('Invalid Pi agent directory');
	}
	return resolve(agentRoot);
}

async function assertAgentRootDirectory(agentRoot: string): Promise<void> {
	let entry;
	try {
		entry = await lstat(agentRoot);
	} catch {
		throw new Error('Invalid Pi agent directory');
	}
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error('Invalid Pi agent directory');
	}
}

function isTextLike(contents: Buffer): boolean {
	if (contents.includes(0)) {
		return false;
	}
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(contents);
		return true;
	} catch {
		return false;
	}
}

function containsSecretPattern(contents: Buffer): boolean {
	if (!isTextLike(contents)) {
		return false;
	}
	const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
	return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function comparePaths(left: SafeRelativePath, right: SafeRelativePath): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

async function getCandidateType(path: string): Promise<'directory' | 'file' | 'missing' | 'skip'> {
	try {
		const entry = await lstat(path);
		if (entry.isSymbolicLink()) {
			return 'skip';
		}
		if (entry.isDirectory()) {
			return 'directory';
		}
		if (entry.isFile()) {
			return 'file';
		}
		return 'skip';
	} catch (error: unknown) {
		if (isMissingPath(error)) {
			return 'missing';
		}
		throw new Error('Unable to inspect local selection candidate');
	}
}

export async function listSelectionCandidates(
	agentRoot: string,
	selectedPaths: readonly SafeRelativePath[] = [],
	operation?: OperationOptions,
): Promise<readonly SelectionCandidate[]> {
	const root = assertSafeAgentRoot(agentRoot);
	throwIfOperationCancelled(operation?.signal);
	operation?.onProgress?.({ phase: 'preparing' });
	throwIfOperationCancelled(operation?.signal);
	await assertAgentRootDirectory(root);

	const candidates = new Map<SafeRelativePath, SelectionCandidate>();
	for (const path of DEFAULT_PUSH_INCLUDES) {
		throwIfOperationCancelled(operation?.signal);
		const type = await getCandidateType(join(root, path));
		if (type !== 'skip') {
			candidates.set(path, { defaultSelected: true, path, type });
		}
	}
	const sessionsPath = parsePushInclude('sessions');
	throwIfOperationCancelled(operation?.signal);
	const sessionsType = await getCandidateType(join(root, sessionsPath));
	throwIfOperationCancelled(operation?.signal);
	if (sessionsType !== 'skip') {
		candidates.set(sessionsPath, {
			defaultSelected: false,
			path: sessionsPath,
			type: sessionsType,
		});
	}
	for (const rawPath of selectedPaths) {
		throwIfOperationCancelled(operation?.signal);
		const path = parsePushInclude(rawPath);
		if (candidates.has(path)) {
			continue;
		}
		const type = await getCandidateType(join(root, path));
		if (type !== 'skip') {
			candidates.set(path, { defaultSelected: false, path, type });
		}
	}

	let entries;
	try {
		entries = await readdir(root);
	} catch {
		throw new Error('Unable to list Pi agent directory');
	}
	for (const name of entries) {
		throwIfOperationCancelled(operation?.signal);
		let path: SafeRelativePath;
		try {
			path = parsePushInclude(name);
		} catch {
			continue;
		}
		const type = await getCandidateType(join(root, name));
		if (type === 'skip') {
			continue;
		}
		const existing = candidates.get(path);
		candidates.set(path, {
			defaultSelected: existing?.defaultSelected ?? false,
			path,
			type,
		});
	}

	return [...candidates.values()].sort((left, right) => comparePaths(left.path, right.path));
}

export async function collectLocalSelection(input: {
	readonly agentRoot: string;
	readonly enforceAuthPermissions?: boolean;
	readonly includes: readonly SafeRelativePath[];
	readonly operation?: OperationOptions;
}): Promise<LocalSelection> {
	const root = assertSafeAgentRoot(input.agentRoot);
	throwIfOperationCancelled(input.operation?.signal);
	input.operation?.onProgress?.({ phase: 'preparing' });
	throwIfOperationCancelled(input.operation?.signal);
	await assertAgentRootDirectory(root);
	const includes = input.includes.map(parsePushInclude);
	if (new Set(includes).size !== includes.length) {
		throw new Error('Duplicate push include');
	}

	const files: CollectedLocalFile[] = [];
	const secretWarningPaths = new Set<SafeRelativePath>();
	const skippedSymlinkPaths = new Set<SafeRelativePath>();
	let totalBytes = 0;

	const collectFile = async (
		absolutePath: string,
		relativePath: SafeRelativePath,
	): Promise<void> => {
		throwIfOperationCancelled(input.operation?.signal);
		let entry;
		try {
			entry = await lstat(absolutePath);
		} catch (error: unknown) {
			if (isMissingPath(error)) {
				return;
			}
			throw new Error('Unable to inspect selected file');
		}
		if (entry.isSymbolicLink()) {
			skippedSymlinkPaths.add(relativePath);
			return;
		}
		if (!entry.isFile()) {
			throw new Error('Selected path contains an unsupported file type');
		}
		if (entry.size > MAX_FILE_BYTES) {
			throw new Error('Selected file exceeds the size limit');
		}

		const contents = await readRegularFileSnapshot(absolutePath, {
			errorMessage: 'Unable to read selected file',
			maxBytes: MAX_FILE_BYTES,
			...(relativePath === 'auth.json' && input.enforceAuthPermissions ? { mode: 0o600 } : {}),
		});
		throwIfOperationCancelled(input.operation?.signal);
		if (contents === undefined) {
			return;
		}

		totalBytes += contents.byteLength;
		if (totalBytes > MAX_OPERATION_BYTES) {
			throw new Error('Selected files exceed the size limit');
		}
		files.push({
			contents,
			path: relativePath,
			sha256: sha256(contents),
			size: contents.byteLength,
		});
		if (containsSecretPattern(contents)) {
			secretWarningPaths.add(relativePath);
		}
	};

	const collectDirectory = async (
		absolutePath: string,
		relativePath: SafeRelativePath,
	): Promise<void> => {
		throwIfOperationCancelled(input.operation?.signal);
		let directoryEntry;
		try {
			directoryEntry = await lstat(absolutePath);
		} catch (error: unknown) {
			if (isMissingPath(error)) {
				return;
			}
			throw new Error('Unable to inspect selected directory');
		}
		if (directoryEntry.isSymbolicLink()) {
			skippedSymlinkPaths.add(relativePath);
			return;
		}
		if (!directoryEntry.isDirectory()) {
			throw new Error('Selected path contains an unsupported file type');
		}

		let entries;
		try {
			entries = await readdir(absolutePath);
		} catch (error: unknown) {
			if (isMissingPath(error)) {
				return;
			}
			throw new Error('Unable to list selected directory');
		}
		for (const name of entries.sort()) {
			throwIfOperationCancelled(input.operation?.signal);
			const rawChildPath = `${relativePath}/${name}`;
			if (isPermanentlyExcluded(rawChildPath)) {
				continue;
			}
			const childPath = parseManifestPath(rawChildPath);
			const childAbsolutePath = join(absolutePath, name);
			let entry;
			try {
				entry = await lstat(childAbsolutePath);
			} catch (error: unknown) {
				if (isMissingPath(error)) {
					continue;
				}
				throw new Error('Unable to inspect selected path');
			}
			if (entry.isSymbolicLink()) {
				skippedSymlinkPaths.add(childPath);
				continue;
			}
			if (entry.isDirectory()) {
				await collectDirectory(childAbsolutePath, childPath);
				continue;
			}
			if (entry.isFile()) {
				await collectFile(childAbsolutePath, childPath);
				continue;
			}
			throw new Error('Selected path contains an unsupported file type');
		}
	};

	for (const include of [...includes].sort(comparePaths)) {
		throwIfOperationCancelled(input.operation?.signal);
		const absolutePath = join(root, include);
		let entry;
		try {
			entry = await lstat(absolutePath);
		} catch (error: unknown) {
			if (isMissingPath(error)) {
				continue;
			}
			throw new Error('Unable to inspect selected path');
		}
		if (entry.isSymbolicLink()) {
			skippedSymlinkPaths.add(include);
			continue;
		}
		if (entry.isDirectory()) {
			await collectDirectory(absolutePath, include);
			continue;
		}
		if (entry.isFile()) {
			await collectFile(absolutePath, include);
			continue;
		}
		throw new Error('Selected path contains an unsupported file type');
	}

	return {
		files: files.sort((left, right) => comparePaths(left.path, right.path)),
		secretWarningPaths: [...secretWarningPaths].sort(comparePaths),
		skippedSymlinkPaths: [...skippedSymlinkPaths].sort(comparePaths),
		totalBytes,
	};
}
