import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

import {
	generateRevisionId,
	parseManifest,
	serializeManifest,
	validateManifest,
	type ManifestFile,
	type ManifestV1,
	type RevisionId,
} from './manifest.js';
import type { OperationOptions, OperationProgress } from './operation.js';
import {
	parseManifestPath,
	parseRemotePath,
	type RemotePath,
	type SafeRelativePath,
} from './paths.js';
import { WebDavRequestError, type WebDavGateway, type WebDavRequestOptions } from './webdav.js';

const MANIFEST_FILE_NAME = 'manifest.json';
const REVISIONS_DIRECTORY_NAME = 'revisions';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROBE_DIRECTORY_NAME_PATTERN =
	/^\.pi-sync-webdav-probe-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface RemoteOperationOptions extends OperationOptions {
	readonly onRetry?: WebDavRequestOptions['onRetry'];
}

export type RemoteOperationProgress = OperationProgress;

export interface RemoteResidueCandidate {
	readonly kind: 'probe' | 'revision';
	readonly path: SafeRelativePath;
}

export interface RemoteResidueReport {
	readonly candidates: readonly RemoteResidueCandidate[];
	readonly unknownCount: number;
}

export interface RemoteResidueCleanupResult {
	readonly deleted: readonly SafeRelativePath[];
	readonly failed: readonly SafeRelativePath[];
	readonly retained: readonly SafeRelativePath[];
}

export interface RemoteRootInspection {
	readonly kind: 'empty' | 'foreign' | 'managed' | 'missing';
}

export interface RawManifestSnapshot {
	readonly bytes: Buffer;
	readonly sha256: string;
}

export interface RemoteManifestSnapshot extends RawManifestSnapshot {
	readonly manifest: ManifestV1;
}

export interface RevisionFile {
	readonly contents: Buffer;
	readonly path: SafeRelativePath;
}

export interface PublishRevisionInput {
	readonly allowUnverifiedManifest: boolean;
	readonly expectedManifestSha256: string | undefined;
	readonly files: readonly RevisionFile[];
}

export interface PublishRevisionResult {
	readonly manifest: ManifestV1;
	readonly previousRevisionCleanup: 'deleted' | 'failed' | 'not-applicable' | 'retained';
}

export interface WriteCapabilityResult {
	readonly canWrite: boolean;
	readonly error: WebDavRequestError | undefined;
	readonly cleanupFailed: boolean;
}

export class RemoteManifestChangedError extends Error {
	constructor() {
		super('The remote manifest changed; run diff again before pushing');
		this.name = 'RemoteManifestChangedError';
	}
}

export class UnverifiedRemoteManifestError extends Error {
	constructor() {
		super('The remote manifest cannot be verified');
		this.name = 'UnverifiedRemoteManifestError';
	}
}

export class RemoteCommitRejectedError extends Error {
	constructor() {
		super('The remote manifest did not activate the new revision; it was removed');
		this.name = 'RemoteCommitRejectedError';
	}
}

export class RemoteCommitUnknownError extends Error {
	constructor() {
		super('The remote manifest write result is unknown; the new revision was retained');
		this.name = 'RemoteCommitUnknownError';
	}
}

export class WriteCapabilityProbeCancelledError extends WebDavRequestError {
	readonly cleanupFailed: boolean;

	constructor(cleanupFailed: boolean) {
		super('WebDAV request cancelled', { retryable: false });
		this.name = 'WriteCapabilityProbeCancelledError';
		this.cleanupFailed = cleanupFailed;
	}
}

function sha256(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function requestOptions(options: RemoteOperationOptions | undefined): WebDavRequestOptions {
	return {
		...(options?.onRetry === undefined ? {} : { onRetry: options.onRetry }),
		...(options?.signal === undefined ? {} : { signal: options.signal }),
	};
}

function cleanupOptions(options: RemoteOperationOptions | undefined): RemoteOperationOptions {
	return {
		...(options?.onProgress === undefined ? {} : { onProgress: options.onProgress }),
		...(options?.onRetry === undefined ? {} : { onRetry: options.onRetry }),
	};
}

function reportProgress(
	options: RemoteOperationOptions | undefined,
	progress: RemoteOperationProgress,
): void {
	options?.onProgress?.(progress);
}

function throwIfCancelled(options: RemoteOperationOptions | undefined): void {
	if (options?.signal?.aborted) {
		throw new WebDavRequestError('WebDAV request cancelled', { retryable: false });
	}
}

function remoteChild(parent: RemotePath, child: string): RemotePath {
	return parseRemotePath(`${parent}/${child}`);
}

function decodeManifest(bytes: Buffer): ManifestV1 {
	let json: string;
	try {
		json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new UnverifiedRemoteManifestError();
	}
	try {
		return parseManifest(json);
	} catch {
		throw new UnverifiedRemoteManifestError();
	}
}

function toSafeRequestError(error: unknown): WebDavRequestError {
	if (error instanceof WebDavRequestError) {
		return error;
	}
	return new WebDavRequestError('WebDAV write capability check failed', { retryable: false });
}

function assertExpectedManifestHash(value: string | undefined): void {
	if (value !== undefined && !SHA256_PATTERN.test(value)) {
		throw new Error('Invalid expected manifest hash');
	}
}

export class RemoteStore {
	readonly #gateway: WebDavGateway;
	readonly #remoteRoot: RemotePath;

	constructor(gateway: WebDavGateway, remoteRoot: RemotePath) {
		this.#gateway = gateway;
		this.#remoteRoot = parseRemotePath(remoteRoot);
	}

	async inspectRoot(options?: RemoteOperationOptions): Promise<RemoteRootInspection> {
		throwIfCancelled(options);
		reportProgress(options, { phase: 'validating' });
		throwIfCancelled(options);
		if (!(await this.#gateway.exists(this.#remoteRoot, requestOptions(options)))) {
			return { kind: 'missing' };
		}
		const entries = await this.#gateway.directoryContents(
			this.#remoteRoot,
			requestOptions(options),
		);
		if (entries.some((entry) => entry.basename === MANIFEST_FILE_NAME && entry.type === 'file')) {
			return { kind: 'managed' };
		}
		return {
			kind:
				entries.length === 0 ||
				entries.every(
					(entry) =>
						entry.type === 'directory' && PROBE_DIRECTORY_NAME_PATTERN.test(entry.basename),
				)
					? 'empty'
					: 'foreign',
		};
	}

	async ensureRoot(options?: RemoteOperationOptions): Promise<RemoteRootInspection> {
		const segments = this.#remoteRoot.split('/');
		for (let depth = 1; depth <= segments.length; depth += 1) {
			throwIfCancelled(options);
			const path = parseRemotePath(segments.slice(0, depth).join('/'));
			if (!(await this.#gateway.exists(path, requestOptions(options)))) {
				await this.#gateway.createDirectory(path, requestOptions(options));
			}
		}
		return this.inspectRoot(options);
	}

	async readRawManifest(
		options?: RemoteOperationOptions,
	): Promise<RawManifestSnapshot | undefined> {
		throwIfCancelled(options);
		try {
			const bytes = await this.#gateway.readFile(
				this.#manifestPath(),
				undefined,
				requestOptions(options),
			);
			return { bytes, sha256: sha256(bytes) };
		} catch (error: unknown) {
			if (error instanceof WebDavRequestError && error.status === 404) {
				return undefined;
			}
			throw error;
		}
	}

	async readManifest(
		options?: RemoteOperationOptions,
	): Promise<RemoteManifestSnapshot | undefined> {
		const rawManifest = await this.readRawManifest(options);
		if (rawManifest === undefined) {
			return undefined;
		}
		return {
			...rawManifest,
			manifest: decodeManifest(rawManifest.bytes),
		};
	}

	async verifyReadCapability(options?: RemoteOperationOptions): Promise<void> {
		throwIfCancelled(options);
		if (await this.#gateway.exists(this.#remoteRoot, requestOptions(options))) {
			await this.#gateway.directoryContents(this.#remoteRoot, requestOptions(options));
		}
		await this.readRawManifest(options);
	}

	async readRevisionFile(
		manifest: ManifestV1,
		file: ManifestFile,
		options?: RemoteOperationOptions,
	): Promise<Buffer> {
		throwIfCancelled(options);
		const validatedManifest = validateManifest(manifest);
		const expected = validatedManifest.files.find((candidate) => candidate.path === file.path);
		if (expected === undefined || expected.sha256 !== file.sha256 || expected.size !== file.size) {
			throw new Error('Invalid revision file request');
		}
		const contents = await this.#gateway.readFile(
			remoteChild(this.#revisionPath(validatedManifest.revision), expected.path),
			undefined,
			requestOptions(options),
		);
		if (contents.byteLength !== expected.size || sha256(contents) !== expected.sha256) {
			throw new Error('Remote revision file failed integrity verification');
		}
		return contents;
	}

	async verifyWriteCapability(options?: RemoteOperationOptions): Promise<WriteCapabilityResult> {
		throwIfCancelled(options);
		reportProgress(options, { phase: 'validating' });
		throwIfCancelled(options);
		const probeDirectory = remoteChild(this.#remoteRoot, `.pi-sync-webdav-probe-${randomUUID()}`);
		const probeFile = remoteChild(probeDirectory, 'probe');
		let probeDirectoryMayExist = false;
		let probeFileMayExist = false;
		let cleanupFailed = false;

		try {
			probeDirectoryMayExist = true;
			await this.#gateway.createDirectory(probeDirectory, requestOptions(options));
			const probeContents = Buffer.from('pi-sync-webdav-probe', 'utf8');
			probeFileMayExist = true;
			await this.#gateway.writeFile(probeFile, probeContents, undefined, requestOptions(options));
			if (
				!(await this.#gateway.readFile(probeFile, undefined, requestOptions(options))).equals(
					probeContents,
				)
			) {
				throw new WebDavRequestError('WebDAV write capability check returned unexpected data', {
					retryable: false,
				});
			}
			await this.#gateway.deletePath(probeFile, requestOptions(options));
			probeFileMayExist = false;
			await this.#gateway.deletePath(probeDirectory, requestOptions(options));
			probeDirectoryMayExist = false;
			return { canWrite: true, cleanupFailed: false, error: undefined };
		} catch (error: unknown) {
			if (probeFileMayExist) {
				cleanupFailed = !(await this.#deleteProbePath(probeFile, cleanupOptions(options)));
			}
			if (probeDirectoryMayExist) {
				cleanupFailed =
					!(await this.#deleteProbePath(probeDirectory, cleanupOptions(options))) || cleanupFailed;
			}
			if (options?.signal?.aborted) {
				throw new WriteCapabilityProbeCancelledError(cleanupFailed);
			}
			return { canWrite: false, cleanupFailed, error: toSafeRequestError(error) };
		}
	}

	async publishRevision(
		input: PublishRevisionInput,
		options?: RemoteOperationOptions,
	): Promise<PublishRevisionResult> {
		assertExpectedManifestHash(input.expectedManifestSha256);
		const inspection = await this.ensureRoot(options);
		if (inspection.kind === 'foreign') {
			throw new Error('The remote root contains unrecognized files');
		}

		const currentManifest = await this.readRawManifest(options);
		if (currentManifest?.sha256 !== input.expectedManifestSha256) {
			throw new RemoteManifestChangedError();
		}

		let previousManifest: ManifestV1 | undefined;
		if (currentManifest !== undefined) {
			try {
				previousManifest = decodeManifest(currentManifest.bytes);
			} catch (error: unknown) {
				if (!input.allowUnverifiedManifest) {
					throw error;
				}
			}
		}

		const revision = generateRevisionId();
		const manifest = validateManifest({
			files: input.files.map((file) => ({
				path: file.path,
				sha256: sha256(file.contents),
				size: file.contents.byteLength,
			})),
			revision,
			version: 1,
		});
		const revisionPath = this.#revisionPath(revision);
		let manifestWriteStarted = false;
		let manifestWriteCompleted = false;

		try {
			await this.#ensureRevisionDirectory(revisionPath, manifest, options);
			for (const [index, file] of input.files.entries()) {
				throwIfCancelled(options);
				reportProgress(options, {
					completed: index + 1,
					phase: 'uploading',
					total: input.files.length,
				});
				throwIfCancelled(options);
				await this.#gateway.writeFile(
					remoteChild(revisionPath, file.path),
					file.contents,
					undefined,
					requestOptions(options),
				);
			}

			const beforeCommit = await this.readRawManifest(options);
			if (beforeCommit?.sha256 !== currentManifest?.sha256) {
				throw new RemoteManifestChangedError();
			}

			manifestWriteStarted = true;
			await this.#gateway.writeFile(
				this.#manifestPath(),
				Buffer.from(serializeManifest(manifest), 'utf8'),
				undefined,
				requestOptions(options),
			);
			manifestWriteCompleted = true;
			const committedManifest = await this.readManifest(options);
			if (committedManifest?.manifest.revision !== revision) {
				throw new RemoteCommitRejectedError();
			}

			const previousRevisionCleanup =
				previousManifest === undefined || previousManifest.revision === revision
					? 'not-applicable'
					: await this.#cleanupPreviousRevision(previousManifest.revision, options);
			return { manifest, previousRevisionCleanup };
		} catch (error: unknown) {
			const cleanup = cleanupOptions(options);
			if (manifestWriteStarted) {
				try {
					const committedManifest = await this.readManifest(cleanup);
					if (committedManifest?.manifest.revision === revision) {
						const previousRevisionCleanup =
							previousManifest === undefined || previousManifest.revision === revision
								? 'not-applicable'
								: await this.#cleanupPreviousRevision(previousManifest.revision, cleanup);
						return { manifest, previousRevisionCleanup };
					}
				} catch {
					throw new RemoteCommitUnknownError();
				}
				if (!manifestWriteCompleted) {
					throw new RemoteCommitUnknownError();
				}
			}
			if (await this.#deleteRevisionIfUnreferenced(revision, cleanup).catch(() => false)) {
				throw error;
			}
			throw new RemoteCommitUnknownError();
		}
	}

	async inspectResidue(options?: RemoteOperationOptions): Promise<RemoteResidueReport> {
		throwIfCancelled(options);
		if (!(await this.#gateway.exists(this.#remoteRoot, requestOptions(options)))) {
			return { candidates: [], unknownCount: 0 };
		}
		const rootEntries = await this.#gateway.directoryContents(
			this.#remoteRoot,
			requestOptions(options),
		);
		const manifestEntry = rootEntries.find(
			(entry) => entry.basename === MANIFEST_FILE_NAME && entry.type === 'file',
		);
		let activeRevision: RevisionId | undefined;
		let manifestVerified = false;
		if (manifestEntry !== undefined) {
			try {
				activeRevision = (await this.readManifest(options))?.manifest.revision;
				manifestVerified = activeRevision !== undefined;
			} catch {
				manifestVerified = false;
			}
		}

		const candidates: RemoteResidueCandidate[] = [];
		let unknownCount = 0;
		for (const entry of rootEntries) {
			throwIfCancelled(options);
			if (entry.basename === MANIFEST_FILE_NAME || entry.basename === REVISIONS_DIRECTORY_NAME) {
				continue;
			}
			if (entry.type === 'directory' && PROBE_DIRECTORY_NAME_PATTERN.test(entry.basename)) {
				candidates.push({ kind: 'probe', path: parseManifestPath(entry.basename) });
			} else {
				unknownCount += 1;
			}
		}

		const revisionsEntry = rootEntries.find(
			(entry) => entry.basename === REVISIONS_DIRECTORY_NAME && entry.type === 'directory',
		);
		if (revisionsEntry !== undefined) {
			const entries = await this.#gateway.directoryContents(
				remoteChild(this.#remoteRoot, REVISIONS_DIRECTORY_NAME),
				requestOptions(options),
			);
			for (const entry of entries) {
				throwIfCancelled(options);
				if (
					manifestVerified &&
					entry.type === 'directory' &&
					REVISION_ID_PATTERN.test(entry.basename) &&
					entry.basename !== activeRevision
				) {
					candidates.push({
						kind: 'revision',
						path: parseManifestPath(`${REVISIONS_DIRECTORY_NAME}/${entry.basename}`),
					});
				} else if (entry.basename !== activeRevision) {
					unknownCount += 1;
				}
			}
		}
		return {
			candidates: candidates.sort((left, right) => (left.path < right.path ? -1 : 1)),
			unknownCount,
		};
	}

	async cleanupResidue(
		candidates: readonly RemoteResidueCandidate[],
		options?: RemoteOperationOptions,
	): Promise<RemoteResidueCleanupResult> {
		const report = await this.inspectResidue(options);
		const root = await this.inspectRoot(options);
		if (root.kind === 'foreign' || root.kind === 'missing') {
			return { deleted: [], failed: [], retained: candidates.map((candidate) => candidate.path) };
		}
		if (root.kind === 'managed') {
			try {
				await this.readManifest(options);
			} catch (error: unknown) {
				if (options?.signal?.aborted) {
					throw error;
				}
				return { deleted: [], failed: [], retained: candidates.map((candidate) => candidate.path) };
			}
		}
		const current = new Map(report.candidates.map((candidate) => [candidate.path, candidate]));
		const deleted: SafeRelativePath[] = [];
		const failed: SafeRelativePath[] = [];
		const retained: SafeRelativePath[] = [];
		for (const selected of candidates) {
			throwIfCancelled(options);
			const candidate = current.get(selected.path);
			if (candidate === undefined || candidate.kind !== selected.kind) {
				retained.push(selected.path);
				continue;
			}
			reportProgress(options, { phase: 'cleaning' });
			throwIfCancelled(options);
			try {
				if (candidate.kind === 'probe') {
					await this.#gateway.deletePath(
						remoteChild(this.#remoteRoot, candidate.path),
						requestOptions(options),
					);
				} else {
					const revision = candidate.path.slice(`${REVISIONS_DIRECTORY_NAME}/`.length);
					if (!REVISION_ID_PATTERN.test(revision)) {
						retained.push(candidate.path);
						continue;
					}
					if (!(await this.#deleteRevisionIfUnreferenced(revision as RevisionId, options))) {
						retained.push(candidate.path);
						continue;
					}
				}
				deleted.push(candidate.path);
			} catch (error: unknown) {
				if (options?.signal?.aborted) {
					throw error;
				}
				failed.push(candidate.path);
			}
		}
		return { deleted, failed, retained };
	}

	#manifestPath(): RemotePath {
		return remoteChild(this.#remoteRoot, MANIFEST_FILE_NAME);
	}

	#revisionPath(revision: RevisionId): RemotePath {
		return remoteChild(remoteChild(this.#remoteRoot, REVISIONS_DIRECTORY_NAME), revision);
	}

	async #ensureRevisionDirectory(
		revisionPath: RemotePath,
		manifest: ManifestV1,
		options?: RemoteOperationOptions,
	): Promise<void> {
		const revisionsDirectory = remoteChild(this.#remoteRoot, REVISIONS_DIRECTORY_NAME);
		throwIfCancelled(options);
		if (!(await this.#gateway.exists(revisionsDirectory, requestOptions(options)))) {
			await this.#gateway.createDirectory(revisionsDirectory, requestOptions(options));
		}
		await this.#gateway.createDirectory(revisionPath, requestOptions(options));

		const directories = new Set<string>();
		for (const file of manifest.files) {
			const segments = file.path.split('/');
			segments.pop();
			for (let depth = 1; depth <= segments.length; depth += 1) {
				directories.add(segments.slice(0, depth).join('/'));
			}
		}
		for (const directory of [...directories].sort(
			(left, right) => left.split('/').length - right.split('/').length,
		)) {
			throwIfCancelled(options);
			await this.#gateway.createDirectory(
				remoteChild(revisionPath, directory),
				requestOptions(options),
			);
		}
	}

	async #cleanupPreviousRevision(
		revision: RevisionId,
		options?: RemoteOperationOptions,
	): Promise<PublishRevisionResult['previousRevisionCleanup']> {
		try {
			return (await this.#deleteRevisionIfUnreferenced(revision, cleanupOptions(options)))
				? 'deleted'
				: 'retained';
		} catch {
			return 'failed';
		}
	}

	async #deleteProbePath(path: RemotePath, options?: RemoteOperationOptions): Promise<boolean> {
		try {
			await this.#gateway.deletePath(path, requestOptions(options));
			return true;
		} catch (error: unknown) {
			return error instanceof WebDavRequestError && error.status === 404;
		}
	}

	async #deleteRevisionIfUnreferenced(
		revision: RevisionId,
		options?: RemoteOperationOptions,
	): Promise<boolean> {
		reportProgress(options, { phase: 'cleaning' });
		throwIfCancelled(options);
		const currentManifest = await this.readManifest(options);
		if (currentManifest?.manifest.revision === revision) {
			return false;
		}
		const revisionPath = this.#revisionPath(revision);
		if (!(await this.#gateway.exists(revisionPath, requestOptions(options)))) {
			return true;
		}
		await this.#gateway.deletePath(revisionPath, requestOptions(options));
		return true;
	}
}
