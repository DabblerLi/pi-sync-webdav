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
import { assertSafeLocalTarget, parseManifestPath, type SafeRelativePath } from './paths.js';
import type { RemoteManifestSnapshot } from './remote-store.js';
import type { CollectedLocalFile, LocalSelection } from './selection.js';
import { readRegularFileSnapshot } from './safe-files.js';

export type PlannedAction = 'add' | 'delete' | 'update';

export interface LocalFileObservation {
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
	readonly syncState: SyncState | undefined;
}

function sha256(contents: Buffer): string {
	return createHash('sha256').update(contents).digest('hex');
}

function comparePaths(left: SafeRelativePath, right: SafeRelativePath): number {
	return left < right ? -1 : left > right ? 1 : 0;
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

function assertNoLocalDestinationCollisions(
	paths: readonly SafeRelativePath[],
	caseInsensitiveDestination: boolean,
): void {
	const destinations = paths
		.map((path) => ({ key: localDestinationKey(path, caseInsensitiveDestination), path }))
		.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
	for (let index = 1; index < destinations.length; index += 1) {
		const previous = destinations[index - 1];
		const current = destinations[index];
		if (
			previous !== undefined &&
			current !== undefined &&
			(current.key === previous.key || current.key.startsWith(`${previous.key}/`))
		) {
			throw new Error('Remote manifest contains colliding local paths');
		}
	}
}

async function observeLocalFile(
	agentRoot: string,
	path: SafeRelativePath,
): Promise<LocalFileObservation | undefined> {
	const target = await assertSafeLocalTarget(agentRoot, path);
	let entry;
	try {
		entry = await lstat(target);
	} catch (error: unknown) {
		if (isMissingPath(error)) {
			return undefined;
		}
		throw new Error('Unable to inspect local sync target');
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
	return { path, sha256: sha256(contents), size: contents.byteLength };
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
	const manifest = validateManifest(input.manifest);
	const caseInsensitiveDestination =
		input.caseInsensitiveDestination ??
		(process.platform === 'darwin' || process.platform === 'win32');
	assertNoLocalDestinationCollisions(
		manifest.files.map((file) => file.path),
		caseInsensitiveDestination,
	);

	const manifestPaths = new Set(manifest.files.map((file) => file.path));
	const actions: FileMutation[] = [];
	let observedLocalBytes = 0;
	const countObservedBytes = (local: LocalFileObservation | undefined): void => {
		if (local === undefined) {
			return;
		}
		observedLocalBytes += local.size;
		if (observedLocalBytes > MAX_OPERATION_BYTES) {
			throw new Error('Local sync targets exceed the size limit');
		}
	};
	for (const file of manifest.files) {
		const local = await observeLocalFile(input.agentRoot, file.path);
		countObservedBytes(local);
		if (local === undefined) {
			actions.push({
				action: 'add',
				expectedLocal: { kind: 'absent' },
				path: file.path,
				source: file,
			});
			continue;
		}
		if (local.sha256 !== file.sha256 || local.size !== file.size) {
			actions.push({
				action: 'update',
				expectedLocal: expectedFromObservation(local),
				path: file.path,
				source: file,
			});
		}
	}

	if (
		input.syncState !== undefined &&
		input.syncState.connectionFingerprint === input.connectionFingerprint
	) {
		for (const rawPath of input.syncState.managedPaths) {
			const path = parseManifestPath(rawPath);
			if (manifestPaths.has(path)) {
				continue;
			}
			const local = await observeLocalFile(input.agentRoot, path);
			countObservedBytes(local);
			if (local !== undefined) {
				actions.push({
					action: 'delete',
					expectedLocal: expectedFromObservation(local),
					path,
					source: undefined,
				});
			}
		}
	}

	return {
		actions: actions.sort((left, right) => comparePaths(left.path, right.path)),
		downloads: [...manifest.files].sort((left, right) => comparePaths(left.path, right.path)),
		nextManagedPaths: [...manifestPaths].sort(comparePaths),
	};
}
