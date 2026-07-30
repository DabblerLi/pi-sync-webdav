import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

import {
	generateRevisionId,
	parseManifest,
	serializeManifest,
	validateManifest,
	type ManifestV1,
	type RevisionId,
} from './manifest.js';
import { parseRemotePath, type RemotePath, type SafeRelativePath } from './paths.js';
import { WebDavRequestError, type WebDavGateway } from './webdav.js';

const MANIFEST_FILE_NAME = 'manifest.json';
const REVISIONS_DIRECTORY_NAME = 'revisions';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

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

function sha256(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
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

	async inspectRoot(): Promise<RemoteRootInspection> {
		if (!(await this.#gateway.exists(this.#remoteRoot))) {
			return { kind: 'missing' };
		}
		const entries = await this.#gateway.directoryContents(this.#remoteRoot);
		if (entries.some((entry) => entry.basename === MANIFEST_FILE_NAME && entry.type === 'file')) {
			return { kind: 'managed' };
		}
		return { kind: entries.length === 0 ? 'empty' : 'foreign' };
	}

	async ensureRoot(): Promise<RemoteRootInspection> {
		const segments = this.#remoteRoot.split('/');
		for (let depth = 1; depth <= segments.length; depth += 1) {
			const path = parseRemotePath(segments.slice(0, depth).join('/'));
			if (!(await this.#gateway.exists(path))) {
				await this.#gateway.createDirectory(path);
			}
		}
		return this.inspectRoot();
	}

	async readRawManifest(): Promise<RawManifestSnapshot | undefined> {
		try {
			const bytes = await this.#gateway.readFile(this.#manifestPath());
			return { bytes, sha256: sha256(bytes) };
		} catch (error: unknown) {
			if (error instanceof WebDavRequestError && error.status === 404) {
				return undefined;
			}
			throw error;
		}
	}

	async readManifest(): Promise<RemoteManifestSnapshot | undefined> {
		const rawManifest = await this.readRawManifest();
		if (rawManifest === undefined) {
			return undefined;
		}
		return {
			...rawManifest,
			manifest: decodeManifest(rawManifest.bytes),
		};
	}

	async verifyWriteCapability(): Promise<WriteCapabilityResult> {
		const probeDirectory = remoteChild(this.#remoteRoot, `.pi-sync-webdav-probe-${randomUUID()}`);
		const probeFile = remoteChild(probeDirectory, 'probe');
		let probeDirectoryCreated = false;
		let probeFileCreated = false;
		let cleanupFailed = false;

		try {
			await this.#gateway.createDirectory(probeDirectory);
			probeDirectoryCreated = true;
			const probeContents = Buffer.from('pi-sync-webdav-probe', 'utf8');
			await this.#gateway.writeFile(probeFile, probeContents);
			probeFileCreated = true;
			if (!(await this.#gateway.readFile(probeFile)).equals(probeContents)) {
				throw new WebDavRequestError('WebDAV write capability check returned unexpected data', {
					retryable: false,
				});
			}
			await this.#gateway.deletePath(probeFile);
			probeFileCreated = false;
			await this.#gateway.deletePath(probeDirectory);
			probeDirectoryCreated = false;
			return { canWrite: true, cleanupFailed: false, error: undefined };
		} catch (error: unknown) {
			if (probeFileCreated) {
				cleanupFailed = !(await this.#deleteProbePath(probeFile));
			}
			if (probeDirectoryCreated) {
				cleanupFailed = !(await this.#deleteProbePath(probeDirectory)) || cleanupFailed;
			}
			return { canWrite: false, cleanupFailed, error: toSafeRequestError(error) };
		}
	}

	async publishRevision(input: PublishRevisionInput): Promise<PublishRevisionResult> {
		assertExpectedManifestHash(input.expectedManifestSha256);
		const inspection = await this.ensureRoot();
		if (inspection.kind === 'foreign') {
			throw new Error('The remote root contains unrecognized files');
		}

		const currentManifest = await this.readRawManifest();
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

		try {
			await this.#ensureRevisionDirectory(revisionPath, manifest);
			for (const file of input.files) {
				await this.#gateway.writeFile(remoteChild(revisionPath, file.path), file.contents);
			}

			const beforeCommit = await this.readRawManifest();
			if (beforeCommit?.sha256 !== currentManifest?.sha256) {
				await this.#deleteRevisionIfUnreferenced(revision).catch(() => false);
				throw new RemoteManifestChangedError();
			}

			manifestWriteStarted = true;
			await this.#gateway.writeFile(
				this.#manifestPath(),
				Buffer.from(serializeManifest(manifest), 'utf8'),
			);
			let committedManifest: RemoteManifestSnapshot | undefined;
			try {
				committedManifest = await this.readManifest();
			} catch {
				throw new RemoteCommitUnknownError();
			}
			if (committedManifest?.manifest.revision !== revision) {
				let deleted = false;
				try {
					deleted = await this.#deleteRevisionIfUnreferenced(revision);
				} catch {
					throw new RemoteCommitUnknownError();
				}
				if (deleted) {
					throw new RemoteCommitRejectedError();
				}
				throw new RemoteCommitUnknownError();
			}

			const previousRevisionCleanup =
				previousManifest === undefined || previousManifest.revision === revision
					? 'not-applicable'
					: await this.#cleanupPreviousRevision(previousManifest.revision);
			return { manifest, previousRevisionCleanup };
		} catch (error: unknown) {
			if (!manifestWriteStarted) {
				await this.#deleteRevisionIfUnreferenced(revision).catch(() => false);
			}
			throw error;
		}
	}

	#manifestPath(): RemotePath {
		return remoteChild(this.#remoteRoot, MANIFEST_FILE_NAME);
	}

	#revisionPath(revision: RevisionId): RemotePath {
		return remoteChild(remoteChild(this.#remoteRoot, REVISIONS_DIRECTORY_NAME), revision);
	}

	async #ensureRevisionDirectory(revisionPath: RemotePath, manifest: ManifestV1): Promise<void> {
		const revisionsDirectory = remoteChild(this.#remoteRoot, REVISIONS_DIRECTORY_NAME);
		if (!(await this.#gateway.exists(revisionsDirectory))) {
			await this.#gateway.createDirectory(revisionsDirectory);
		}
		await this.#gateway.createDirectory(revisionPath);

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
			await this.#gateway.createDirectory(remoteChild(revisionPath, directory));
		}
	}

	async #cleanupPreviousRevision(
		revision: RevisionId,
	): Promise<PublishRevisionResult['previousRevisionCleanup']> {
		try {
			return (await this.#deleteRevisionIfUnreferenced(revision)) ? 'deleted' : 'retained';
		} catch {
			return 'failed';
		}
	}

	async #deleteProbePath(path: RemotePath): Promise<boolean> {
		try {
			await this.#gateway.deletePath(path);
			return true;
		} catch {
			return false;
		}
	}

	async #deleteRevisionIfUnreferenced(revision: RevisionId): Promise<boolean> {
		const currentManifest = await this.readManifest();
		if (currentManifest?.manifest.revision === revision) {
			return false;
		}
		await this.#gateway.deletePath(this.#revisionPath(revision));
		return true;
	}
}
