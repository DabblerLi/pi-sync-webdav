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
import {
	FILE_OPERATION_CONCURRENCY,
	mapConcurrent,
	type OperationOptions,
	type OperationProgress,
} from './operation.js';
import {
	parseManifestPath,
	parseRemotePath,
	type RemotePath,
	type SafeRelativePath,
} from './paths.js';
import {
	WebDavRequestError,
	type RemoteDirectoryEntry,
	type WebDavGateway,
	type WebDavRequestOptions,
} from './webdav.js';

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

interface WriteCapabilityResult {
	readonly canWrite: boolean;
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

function assertRevisionFileIntegrity(
	file: Pick<ManifestFile, 'sha256' | 'size'>,
	contents: Buffer,
): void {
	if (contents.byteLength !== file.size || sha256(contents) !== file.sha256) {
		throw new Error('Remote revision file failed integrity verification');
	}
}

function isExpectedManifest(
	snapshot: RawManifestSnapshot | undefined,
	expectedBytes: Buffer,
	expectedSha256: string,
): boolean {
	return (
		snapshot !== undefined &&
		snapshot.sha256 === expectedSha256 &&
		snapshot.bytes.equals(expectedBytes)
	);
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
	progress: OperationProgress,
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
	try {
		return parseManifest(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		throw new UnverifiedRemoteManifestError();
	}
}

function assertExpectedManifestHash(value: string | undefined): void {
	if (value !== undefined && !SHA256_PATTERN.test(value)) {
		throw new Error('Invalid expected manifest hash');
	}
}

function classifyRootEntries(entries: readonly RemoteDirectoryEntry[]): RemoteRootInspection {
	if (entries.some((entry) => entry.basename === MANIFEST_FILE_NAME && entry.type === 'file')) {
		return { kind: 'managed' };
	}
	const containsOnlyProbes = entries.every(
		(entry) => entry.type === 'directory' && PROBE_DIRECTORY_NAME_PATTERN.test(entry.basename),
	);
	return { kind: containsOnlyProbes ? 'empty' : 'foreign' };
}

function manifestDirectories(manifest: ManifestV1): readonly SafeRelativePath[] {
	const directories = new Set<SafeRelativePath>();
	for (const file of manifest.files) {
		const segments = file.path.split('/');
		segments.pop();
		for (let depth = 1; depth <= segments.length; depth += 1) {
			directories.add(parseManifestPath(segments.slice(0, depth).join('/')));
		}
	}
	return [...directories].sort((left, right) => left.split('/').length - right.split('/').length);
}

function topLevelPath(path: SafeRelativePath): SafeRelativePath {
	return parseManifestPath(path.split('/')[0]);
}

function planRevisionReuse(
	previousManifest: ManifestV1,
	nextManifest: ManifestV1,
): {
	readonly copyPaths: readonly SafeRelativePath[];
	readonly deletionPaths: readonly SafeRelativePath[];
	readonly directoriesToCreate: readonly SafeRelativePath[];
} {
	const previousDirectories = manifestDirectories(previousManifest);
	const nextDirectories = manifestDirectories(nextManifest);
	const nextDirectorySet = new Set(nextDirectories);
	const nextPaths = new Set(nextManifest.files.map((file) => file.path));
	const previousFiles = new Map(previousManifest.files.map((file) => [file.path, file]));
	const copyPathSet = new Set<SafeRelativePath>();
	for (const file of nextManifest.files) {
		const previous = previousFiles.get(file.path);
		if (previous?.sha256 === file.sha256 && previous.size === file.size) {
			copyPathSet.add(topLevelPath(file.path));
		}
	}

	const candidates = new Set<SafeRelativePath>();
	for (const previousFile of previousManifest.files) {
		if (nextPaths.has(previousFile.path) || !copyPathSet.has(topLevelPath(previousFile.path))) {
			continue;
		}
		candidates.add(previousFile.path);
	}
	for (const directory of previousDirectories) {
		if (!nextDirectorySet.has(directory) && copyPathSet.has(topLevelPath(directory))) {
			candidates.add(directory);
		}
	}

	const sortedCandidates = [...candidates].sort(
		(left, right) => left.split('/').length - right.split('/').length,
	);
	const deletionPaths = sortedCandidates.filter((path) => {
		const segments = path.split('/');
		while (segments.length > 1) {
			segments.pop();
			if (candidates.has(parseManifestPath(segments.join('/')))) {
				return false;
			}
		}
		return true;
	});
	const copiedDirectorySet = new Set(
		previousDirectories.filter((directory) => copyPathSet.has(topLevelPath(directory))),
	);
	return {
		copyPaths: [...copyPathSet].sort(),
		deletionPaths,
		directoriesToCreate: nextDirectories.filter((directory) => !copiedDirectorySet.has(directory)),
	};
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
		try {
			return classifyRootEntries(
				await this.#gateway.directoryContents(this.#remoteRoot, requestOptions(options)),
			);
		} catch (error: unknown) {
			if (error instanceof WebDavRequestError && error.status === 404) {
				return { kind: 'missing' };
			}
			throw error;
		}
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
		return classifyRootEntries(
			await this.#gateway.directoryContents(this.#remoteRoot, requestOptions(options)),
		);
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
		assertRevisionFileIntegrity(expected, contents);
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
			return { canWrite: true, cleanupFailed: false };
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
			if (!(error instanceof WebDavRequestError)) {
				throw error;
			}
			return { canWrite: false, cleanupFailed };
		}
	}

	async publishRevision(
		input: PublishRevisionInput,
		options?: RemoteOperationOptions,
	): Promise<PublishRevisionResult> {
		assertExpectedManifestHash(input.expectedManifestSha256);
		const currentManifest = await this.readRawManifest(options);
		if (currentManifest === undefined) {
			const inspection = await this.ensureRoot(options);
			if (inspection.kind === 'foreign') {
				throw new Error('The remote root contains unrecognized files');
			}
		}
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
		const preparedFiles = input.files.map((file) => ({
			...file,
			sha256: sha256(file.contents),
			size: file.contents.byteLength,
		}));
		const manifest = validateManifest({
			files: preparedFiles.map((file) => ({
				path: file.path,
				sha256: file.sha256,
				size: file.size,
			})),
			revision,
			version: 1,
		});
		const manifestBytes = Buffer.from(serializeManifest(manifest), 'utf8');
		const manifestSha256 = sha256(manifestBytes);
		const revisionPath = this.#revisionPath(revision);
		const previousFiles = new Map(previousManifest?.files.map((file) => [file.path, file]) ?? []);
		const filesToUpload = preparedFiles.filter((file) => {
			const previous = previousFiles.get(file.path);
			return (
				previous === undefined || previous.sha256 !== file.sha256 || previous.size !== file.size
			);
		});
		let manifestWriteStarted = false;
		let manifestWriteCompleted = false;

		try {
			if (previousManifest === undefined) {
				await this.#ensureRevisionDirectory(revisionPath, manifest, options);
			} else {
				await this.#reuseRevisionContents(previousManifest, revisionPath, manifest, options);
			}
			let completedUploads = 0;
			await mapConcurrent(filesToUpload, FILE_OPERATION_CONCURRENCY, async (file) => {
				throwIfCancelled(options);
				const remoteFile = remoteChild(revisionPath, file.path);
				await this.#gateway.writeFile(
					remoteFile,
					file.contents,
					undefined,
					requestOptions(options),
				);
				const uploadedContents = await this.#gateway.readFile(
					remoteFile,
					undefined,
					requestOptions(options),
				);
				assertRevisionFileIntegrity(file, uploadedContents);
				completedUploads += 1;
				reportProgress(options, {
					completed: completedUploads,
					phase: 'uploading',
					total: filesToUpload.length,
				});
			});

			const beforeCommit = await this.readRawManifest(options);
			if (beforeCommit?.sha256 !== currentManifest?.sha256) {
				throw new RemoteManifestChangedError();
			}

			manifestWriteStarted = true;
			await this.#gateway.writeFile(
				this.#manifestPath(),
				manifestBytes,
				undefined,
				requestOptions(options),
			);
			manifestWriteCompleted = true;
			const committedManifest = await this.readRawManifest(options);
			if (!isExpectedManifest(committedManifest, manifestBytes, manifestSha256)) {
				throw new RemoteCommitRejectedError();
			}

			const previousRevisionCleanup = await this.#cleanupPreviousRevision(
				previousManifest,
				options,
			);
			return { manifest, previousRevisionCleanup };
		} catch (error: unknown) {
			const cleanup = cleanupOptions(options);
			if (manifestWriteStarted) {
				try {
					const committedManifest = await this.readRawManifest(cleanup);
					if (isExpectedManifest(committedManifest, manifestBytes, manifestSha256)) {
						const previousRevisionCleanup = await this.#cleanupPreviousRevision(
							previousManifest,
							cleanup,
						);
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
		let rootEntries: readonly RemoteDirectoryEntry[];
		try {
			rootEntries = await this.#gateway.directoryContents(
				this.#remoteRoot,
				requestOptions(options),
			);
		} catch (error: unknown) {
			if (error instanceof WebDavRequestError && error.status === 404) {
				return { candidates: [], unknownCount: 0 };
			}
			throw error;
		}
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
			if (
				(entry.basename === MANIFEST_FILE_NAME && entry.type === 'file') ||
				(entry.basename === REVISIONS_DIRECTORY_NAME && entry.type === 'directory')
			) {
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
				} else if (entry.basename !== activeRevision || entry.type !== 'directory') {
					unknownCount += 1;
				}
			}
		}
		return {
			candidates: candidates.sort((left, right) => {
				if (left.path === right.path) {
					return 0;
				}
				return left.path < right.path ? -1 : 1;
			}),
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
		await this.#ensureRevisionRoot(revisionPath, options);
		for (const directory of manifestDirectories(manifest)) {
			throwIfCancelled(options);
			await this.#gateway.createDirectory(
				remoteChild(revisionPath, directory),
				requestOptions(options),
			);
		}
	}

	async #ensureRevisionRoot(
		revisionPath: RemotePath,
		options?: RemoteOperationOptions,
	): Promise<void> {
		const revisionsDirectory = remoteChild(this.#remoteRoot, REVISIONS_DIRECTORY_NAME);
		throwIfCancelled(options);
		if (!(await this.#gateway.exists(revisionsDirectory, requestOptions(options)))) {
			await this.#gateway.createDirectory(revisionsDirectory, requestOptions(options));
		}
		await this.#gateway.createDirectory(revisionPath, requestOptions(options));
	}

	async #reuseRevisionContents(
		previousManifest: ManifestV1,
		revisionPath: RemotePath,
		manifest: ManifestV1,
		options?: RemoteOperationOptions,
	): Promise<void> {
		await this.#ensureRevisionRoot(revisionPath, options);
		const plan = planRevisionReuse(previousManifest, manifest);
		const previousRevisionPath = this.#revisionPath(previousManifest.revision);
		await mapConcurrent(plan.copyPaths, FILE_OPERATION_CONCURRENCY, (path) =>
			this.#gateway.copyPath(
				remoteChild(previousRevisionPath, path),
				remoteChild(revisionPath, path),
				requestOptions(options),
			),
		);
		await mapConcurrent(plan.deletionPaths, FILE_OPERATION_CONCURRENCY, (path) =>
			this.#gateway.deletePath(remoteChild(revisionPath, path), requestOptions(options)),
		);

		for (const directory of plan.directoriesToCreate) {
			throwIfCancelled(options);
			await this.#gateway.createDirectory(
				remoteChild(revisionPath, directory),
				requestOptions(options),
			);
		}
	}

	async #cleanupPreviousRevision(
		previousManifest: ManifestV1 | undefined,
		options?: RemoteOperationOptions,
	): Promise<PublishRevisionResult['previousRevisionCleanup']> {
		if (previousManifest === undefined) {
			return 'not-applicable';
		}
		try {
			return (await this.#deleteRevisionIfUnreferenced(
				previousManifest.revision,
				cleanupOptions(options),
			))
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
		try {
			await this.#gateway.deletePath(this.#revisionPath(revision), requestOptions(options));
		} catch (error: unknown) {
			if (!(error instanceof WebDavRequestError && error.status === 404)) {
				throw error;
			}
		}
		return true;
	}
}
