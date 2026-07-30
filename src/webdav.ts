import { Readable } from 'node:stream';

import { createClient, type FileStat, type WebDAVClient } from 'webdav';

import { MAX_FILE_BYTES } from './manifest.js';
import { parseRemotePath, type NormalizedConnection, type RemotePath } from './paths.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 500] as const;

export interface RemoteDirectoryEntry {
	readonly basename: string;
	readonly type: 'directory' | 'file';
}

export interface TransferProgress {
	readonly loaded: number;
	readonly total: number | undefined;
}

export interface WebDavGateway {
	createDirectory(path: RemotePath): Promise<void>;
	deletePath(path: RemotePath): Promise<void>;
	directoryContents(path: RemotePath): Promise<readonly RemoteDirectoryEntry[]>;
	exists(path: RemotePath): Promise<boolean>;
	readFile(
		path: RemotePath,
		onProgress?: (progress: TransferProgress) => void,
		signal?: AbortSignal,
	): Promise<Buffer>;
	writeFile(
		path: RemotePath,
		contents: Buffer,
		onProgress?: (progress: TransferProgress) => void,
	): Promise<void>;
}

export interface WebDavGatewayOptions {
	readonly maxResponseBytes?: number;
	readonly requestTimeoutMs?: number;
	readonly retryDelaysMs?: readonly number[];
}

export class WebDavRequestError extends Error {
	readonly retryable: boolean;
	readonly status: number | undefined;

	constructor(message: string, options: { readonly retryable: boolean; readonly status?: number }) {
		super(message);
		this.name = 'WebDavRequestError';
		this.retryable = options.retryable;
		this.status = options.status;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getHttpStatus(error: unknown): number | undefined {
	if (!isRecord(error) || typeof error.status !== 'number' || !Number.isInteger(error.status)) {
		return undefined;
	}
	return error.status;
}

function isRetryableStatus(status: number | undefined): boolean {
	return status === undefined || status === 429 || status >= 500;
}

function toSafeRequestError(error: unknown): WebDavRequestError {
	if (error instanceof WebDavRequestError) {
		return error;
	}

	const status = getHttpStatus(error);
	if (status === 401) {
		return new WebDavRequestError('WebDAV authentication failed', { retryable: false, status });
	}
	if (status === 403) {
		return new WebDavRequestError('WebDAV authorization failed', { retryable: false, status });
	}
	if (status === 404) {
		return new WebDavRequestError('WebDAV resource was not found', { retryable: false, status });
	}
	if (status !== undefined) {
		return new WebDavRequestError(`WebDAV request failed with HTTP status ${status}`, {
			retryable: isRetryableStatus(status),
			status,
		});
	}
	return new WebDavRequestError('WebDAV network request failed', { retryable: true });
}

function assertPositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`Invalid ${name}`);
	}
}

function toRemoteDirectoryEntry(stat: FileStat): RemoteDirectoryEntry {
	return {
		basename: stat.basename,
		type: stat.type,
	};
}

async function readStreamWithLimit(
	stream: Readable,
	maxResponseBytes: number,
	onProgress: ((progress: TransferProgress) => void) | undefined,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let loaded = 0;

	try {
		for await (const chunk of stream) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			loaded += buffer.byteLength;
			if (loaded > maxResponseBytes) {
				stream.destroy();
				throw new WebDavRequestError('WebDAV response exceeds the size limit', {
					retryable: false,
				});
			}
			chunks.push(buffer);
			onProgress?.({ loaded, total: undefined });
		}
	} catch (error: unknown) {
		if (error instanceof WebDavRequestError) {
			throw error;
		}
		throw toSafeRequestError(error);
	}

	return Buffer.concat(chunks);
}

class SafeWebDavGateway implements WebDavGateway {
	readonly #client: WebDAVClient;
	readonly #maxResponseBytes: number;
	readonly #requestTimeoutMs: number;
	readonly #retryDelaysMs: readonly number[];

	constructor(connection: NormalizedConnection, options: WebDavGatewayOptions) {
		this.#client = createClient(connection.url, {
			password: connection.password,
			username: connection.username,
		});
		this.#maxResponseBytes = options.maxResponseBytes ?? MAX_FILE_BYTES;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
		assertPositiveSafeInteger(this.#maxResponseBytes, 'maximum response size');
		assertPositiveSafeInteger(this.#requestTimeoutMs, 'request timeout');
		if (this.#retryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
			throw new Error('Invalid retry delays');
		}
	}

	async createDirectory(path: RemotePath): Promise<void> {
		const remotePath = parseRemotePath(path);
		await this.#execute((signal) => this.#client.createDirectory(remotePath, { signal }));
	}

	async deletePath(path: RemotePath): Promise<void> {
		const remotePath = parseRemotePath(path);
		await this.#execute((signal) => this.#client.deleteFile(remotePath, { signal }));
	}

	async directoryContents(path: RemotePath): Promise<readonly RemoteDirectoryEntry[]> {
		const remotePath = parseRemotePath(path);
		const contents = await this.#execute((signal) =>
			this.#client.getDirectoryContents(remotePath, { signal }),
		);
		return contents.map(toRemoteDirectoryEntry);
	}

	async exists(path: RemotePath): Promise<boolean> {
		const remotePath = parseRemotePath(path);
		return this.#execute((signal) => this.#client.exists(remotePath, { signal }));
	}

	async readFile(
		path: RemotePath,
		onProgress?: (progress: TransferProgress) => void,
		externalSignal?: AbortSignal,
	): Promise<Buffer> {
		const remotePath = parseRemotePath(path);
		return this.#execute(async (signal) => {
			const stream = this.#client.createReadStream(remotePath, { signal });
			return readStreamWithLimit(stream, this.#maxResponseBytes, onProgress);
		}, externalSignal);
	}

	async writeFile(
		path: RemotePath,
		contents: Buffer,
		onProgress?: (progress: TransferProgress) => void,
	): Promise<void> {
		const remotePath = parseRemotePath(path);
		if (contents.byteLength > MAX_FILE_BYTES) {
			throw new WebDavRequestError('WebDAV upload exceeds the size limit', { retryable: false });
		}
		const wasWritten = await this.#execute((signal) =>
			this.#client.putFileContents(remotePath, contents, {
				onUploadProgress: ({ loaded, total }) => onProgress?.({ loaded, total }),
				signal,
			}),
		);
		if (!wasWritten) {
			throw new WebDavRequestError('WebDAV write was rejected', { retryable: false });
		}
	}

	async #execute<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		externalSignal?: AbortSignal,
	): Promise<T> {
		let latestError: WebDavRequestError | undefined;
		for (let attempt = 0; attempt <= this.#retryDelaysMs.length; attempt += 1) {
			if (externalSignal?.aborted) {
				throw new WebDavRequestError('WebDAV request cancelled', { retryable: false });
			}
			try {
				return await this.#executeOnce(operation, externalSignal);
			} catch (error: unknown) {
				const safeError = toSafeRequestError(error);
				latestError = safeError;
				const delay = this.#retryDelaysMs[attempt];
				if (!safeError.retryable || delay === undefined) {
					throw safeError;
				}
				await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay));
			}
		}
		throw latestError ?? new WebDavRequestError('WebDAV request failed', { retryable: false });
	}

	async #executeOnce<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		externalSignal?: AbortSignal,
	): Promise<T> {
		const controller = new AbortController();
		const abortForExternalSignal = (): void => controller.abort();
		const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
		if (externalSignal !== undefined) {
			externalSignal.addEventListener('abort', abortForExternalSignal, { once: true });
		}
		try {
			if (externalSignal?.aborted) {
				throw new WebDavRequestError('WebDAV request cancelled', { retryable: false });
			}
			return await operation(controller.signal);
		} catch (error: unknown) {
			if (externalSignal?.aborted) {
				throw new WebDavRequestError('WebDAV request cancelled', { retryable: false });
			}
			if (controller.signal.aborted) {
				throw new WebDavRequestError('WebDAV request timed out', { retryable: true });
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			externalSignal?.removeEventListener('abort', abortForExternalSignal);
		}
	}
}

export function createWebDavGateway(
	connection: NormalizedConnection,
	options: WebDavGatewayOptions = {},
): WebDavGateway {
	return new SafeWebDavGateway(connection, options);
}
