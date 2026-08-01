import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

import {
	createClient,
	parseXML,
	prepareFileFromProps,
	type FileStat,
	type WebDAVClient,
} from 'webdav';

import { MAX_FILE_BYTES } from './manifest.js';
import {
	encodeRemotePath,
	parseRemotePath,
	type NormalizedConnection,
	type RemotePath,
} from './paths.js';

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

export interface WebDavRequestOptions {
	readonly onRetry?: (progress: { readonly attempt: number; readonly total: number }) => void;
	readonly signal?: AbortSignal;
}

export interface WebDavGateway {
	createDirectory(path: RemotePath, options?: WebDavRequestOptions): Promise<void>;
	deletePath(path: RemotePath, options?: WebDavRequestOptions): Promise<void>;
	directoryContents(
		path: RemotePath,
		options?: WebDavRequestOptions,
	): Promise<readonly RemoteDirectoryEntry[]>;
	exists(path: RemotePath, options?: WebDavRequestOptions): Promise<boolean>;
	readFile(
		path: RemotePath,
		onProgress?: (progress: TransferProgress) => void,
		options?: AbortSignal | WebDavRequestOptions,
	): Promise<Buffer>;
	writeFile(
		path: RemotePath,
		contents: Buffer,
		onProgress?: (progress: TransferProgress) => void,
		options?: WebDavRequestOptions,
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
	signal: AbortSignal | undefined,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let loaded = 0;
	const abort = (): void => {
		stream.destroy(new Error('WebDAV response stream aborted'));
	};
	if (signal?.aborted) {
		abort();
	}
	signal?.addEventListener('abort', abort, { once: true });

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
	} finally {
		signal?.removeEventListener('abort', abort);
	}

	return Buffer.concat(chunks);
}

function responsePath(href: string, baseUrl: string): string {
	try {
		return new URL(href, baseUrl).pathname.replace(/\/+$/u, '');
	} catch {
		throw new WebDavRequestError('WebDAV response contains an invalid path', { retryable: false });
	}
}

function isRequestedResource(href: string, path: RemotePath, baseUrl: string): boolean {
	const requested = responsePath(encodeRemotePath(path), baseUrl);
	return responsePath(href, baseUrl) === requested;
}

function responseBasename(href: string, baseUrl: string): string {
	const name = responsePath(href, baseUrl).split('/').at(-1);
	if (name === undefined || name.length === 0) {
		throw new WebDavRequestError('WebDAV response contains an invalid path', { retryable: false });
	}
	try {
		return decodeURIComponent(name);
	} catch {
		throw new WebDavRequestError('WebDAV response contains an invalid path', { retryable: false });
	}
}

function normalizeRequestOptions(
	options: AbortSignal | WebDavRequestOptions | undefined,
): WebDavRequestOptions {
	if (options === undefined) {
		return {};
	}
	if ('aborted' in options && 'addEventListener' in options) {
		return { signal: options as AbortSignal };
	}
	return options;
}

async function waitForRetryDelay(delay: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) {
		throw new WebDavRequestError('WebDAV request cancelled', { retryable: false });
	}
	if (delay === 0) {
		return;
	}
	await new Promise<void>((resolveDelay, rejectDelay) => {
		const timeout = setTimeout(finish, delay);
		const abort = (): void => {
			clearTimeout(timeout);
			finish(new WebDavRequestError('WebDAV request cancelled', { retryable: false }));
		};
		function finish(error?: Error): void {
			signal?.removeEventListener('abort', abort);
			if (error === undefined) {
				resolveDelay();
			} else {
				rejectDelay(error);
			}
		}
		signal?.addEventListener('abort', abort, { once: true });
	});
}

class SafeWebDavGateway implements WebDavGateway {
	readonly #baseUrl: string;
	readonly #client: WebDAVClient;
	readonly #maxResponseBytes: number;
	readonly #requestTimeoutMs: number;
	readonly #retryDelaysMs: readonly number[];

	constructor(connection: NormalizedConnection, options: WebDavGatewayOptions) {
		this.#baseUrl = connection.url;
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

	async createDirectory(path: RemotePath, options?: WebDavRequestOptions): Promise<void> {
		const remotePath = parseRemotePath(path);
		await this.#execute(
			(signal) => this.#client.createDirectory(remotePath, { signal }),
			normalizeRequestOptions(options),
		);
	}

	async deletePath(path: RemotePath, options?: WebDavRequestOptions): Promise<void> {
		const remotePath = parseRemotePath(path);
		await this.#execute(
			(signal) => this.#client.deleteFile(remotePath, { signal }),
			normalizeRequestOptions(options),
		);
	}

	async directoryContents(
		path: RemotePath,
		options?: WebDavRequestOptions,
	): Promise<readonly RemoteDirectoryEntry[]> {
		const remotePath = parseRemotePath(path);
		const bytes = await this.#execute(async (signal) => {
			const response = await this.#client.customRequest(remotePath, {
				method: 'PROPFIND',
				headers: {
					Accept: 'text/plain,application/xml',
					Depth: '1',
				},
				signal,
			});
			if (response.body === null) {
				throw new WebDavRequestError('WebDAV response has no body', { retryable: false });
			}
			return readStreamWithLimit(
				response.body as unknown as Readable,
				this.#maxResponseBytes,
				undefined,
				signal,
			);
		}, normalizeRequestOptions(options));
		let parsed;
		try {
			parsed = await parseXML(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		} catch {
			throw new WebDavRequestError('WebDAV directory response is invalid', { retryable: false });
		}
		return parsed.multistatus.response
			.filter((entry) => !isRequestedResource(entry.href, remotePath, this.#baseUrl))
			.map((entry) => {
				if (entry.propstat === undefined) {
					throw new WebDavRequestError('WebDAV directory response is invalid', {
						retryable: false,
					});
				}
				const filename = entry.propstat.prop.displayname;
				return toRemoteDirectoryEntry(
					prepareFileFromProps(
						entry.propstat.prop,
						typeof filename === 'string' ? filename : responseBasename(entry.href, this.#baseUrl),
					),
				);
			});
	}

	async exists(path: RemotePath, options?: WebDavRequestOptions): Promise<boolean> {
		const remotePath = parseRemotePath(path);
		try {
			await this.#execute(async (signal) => {
				const response = await this.#client.customRequest(remotePath, {
					method: 'PROPFIND',
					headers: {
						Accept: 'text/plain,application/xml',
						Depth: '0',
					},
					signal,
				});
				if (response.body === null) {
					throw new WebDavRequestError('WebDAV response has no body', { retryable: false });
				}
				await readStreamWithLimit(
					response.body as unknown as Readable,
					this.#maxResponseBytes,
					undefined,
					signal,
				);
			}, normalizeRequestOptions(options));
			return true;
		} catch (error: unknown) {
			if (error instanceof WebDavRequestError && error.status === 404) {
				return false;
			}
			throw error;
		}
	}

	async readFile(
		path: RemotePath,
		onProgress?: (progress: TransferProgress) => void,
		options?: AbortSignal | WebDavRequestOptions,
	): Promise<Buffer> {
		const remotePath = parseRemotePath(path);
		return this.#execute(async (signal) => {
			const stream = this.#client.createReadStream(remotePath, { signal });
			return readStreamWithLimit(stream, this.#maxResponseBytes, onProgress, signal);
		}, normalizeRequestOptions(options));
	}

	async writeFile(
		path: RemotePath,
		contents: Buffer,
		onProgress?: (progress: TransferProgress) => void,
		options?: WebDavRequestOptions,
	): Promise<void> {
		const remotePath = parseRemotePath(path);
		if (contents.byteLength > MAX_FILE_BYTES) {
			throw new WebDavRequestError('WebDAV upload exceeds the size limit', { retryable: false });
		}
		const wasWritten = await this.#execute(
			(signal) =>
				this.#client.putFileContents(remotePath, contents, {
					onUploadProgress: ({ loaded, total }) => onProgress?.({ loaded, total }),
					signal,
				}),
			normalizeRequestOptions(options),
		);
		if (!wasWritten) {
			throw new WebDavRequestError('WebDAV write was rejected', { retryable: false });
		}
	}

	async #execute<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		options: WebDavRequestOptions = {},
	): Promise<T> {
		let latestError: WebDavRequestError | undefined;
		for (let attempt = 0; attempt <= this.#retryDelaysMs.length; attempt += 1) {
			if (options.signal?.aborted) {
				throw new WebDavRequestError('WebDAV request cancelled', { retryable: false });
			}
			try {
				return await this.#executeOnce(operation, options.signal);
			} catch (error: unknown) {
				const safeError = toSafeRequestError(error);
				latestError = safeError;
				const delay = this.#retryDelaysMs[attempt];
				if (!safeError.retryable || delay === undefined) {
					throw safeError;
				}
				options.onRetry?.({ attempt: attempt + 2, total: this.#retryDelaysMs.length + 1 });
				await waitForRetryDelay(delay, options.signal);
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
