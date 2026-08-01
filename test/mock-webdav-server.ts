import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

interface DirectoryEntry {
	readonly type: 'directory';
}

interface FileEntry {
	readonly contents: Buffer;
	readonly type: 'file';
}

type Entry = DirectoryEntry | FileEntry;

export interface ReceivedRequest {
	readonly method: string;
	readonly pathname: string;
}

export class MockWebDavServer {
	readonly #delays: Array<{ delayMs: number; method: string; path: string; remaining: number }> =
		[];
	readonly #entries = new Map<string, Entry>([['', { type: 'directory' }]]);
	readonly #expectedAuthorization: string;
	readonly #failures: Array<{
		body: string;
		method: string;
		path: string;
		remaining: number;
		status: number;
	}> = [];
	readonly #server: Server;
	readonly #stalledBodies: Array<{
		contents: Buffer;
		method: string;
		path: string;
		remaining: number;
	}> = [];
	readonly requests: ReceivedRequest[] = [];
	baseUrl = '';

	private constructor(username: string, password: string) {
		this.#expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
		this.#server = createServer((request, response) => {
			void this.#handle(request, response);
		});
	}

	static async create(username = 'alice', password = 'password'): Promise<MockWebDavServer> {
		const server = new MockWebDavServer(username, password);
		server.#server.listen(0, '127.0.0.1');
		await once(server.#server, 'listening');
		const address = server.#server.address();
		if (address === null || typeof address === 'string') {
			throw new Error('Unable to start mock WebDAV server');
		}
		server.baseUrl = `http://127.0.0.1:${address.port}/dav/`;
		return server;
	}

	async close(): Promise<void> {
		this.#server.close();
		await once(this.#server, 'close');
	}

	failNext(
		method: string,
		path: string,
		status: number,
		count = 1,
		body = `Mock failure ${status}`,
	): void {
		this.#failures.push({ body, method, path: normalizePath(path), remaining: count, status });
	}

	delayNext(method: string, path: string, delayMs: number, count = 1): void {
		this.#delays.push({ delayMs, method, path: normalizePath(path), remaining: count });
	}

	stallNextBody(method: string, path: string, contents: Buffer, count = 1): void {
		this.#stalledBodies.push({
			contents,
			method,
			path: normalizePath(path),
			remaining: count,
		});
	}

	setFile(path: string, contents: Buffer): void {
		const normalizedPath = normalizePath(path);
		const parent = parentPath(normalizedPath);
		if (!this.#entries.get(parent)?.type || this.#entries.get(parent)?.type !== 'directory') {
			throw new Error('Parent directory does not exist');
		}
		this.#entries.set(normalizedPath, { contents, type: 'file' });
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const method = request.method ?? 'UNKNOWN';
		const url = new URL(request.url ?? '/', this.baseUrl || 'http://127.0.0.1/dav/');
		if (!url.pathname.startsWith('/dav/')) {
			response.writeHead(404).end();
			return;
		}
		const path = normalizePath(decodeURIComponent(url.pathname.slice('/dav/'.length)));
		this.requests.push({ method, pathname: url.pathname });

		if (request.headers.authorization !== this.#expectedAuthorization) {
			response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mock"' }).end('Unauthorized');
			return;
		}

		const failure = this.#failures.find(
			(candidate) =>
				candidate.method === method && candidate.path === path && candidate.remaining > 0,
		);
		if (failure !== undefined) {
			failure.remaining -= 1;
			response.writeHead(failure.status).end(failure.body);
			return;
		}
		const delay = this.#delays.find(
			(candidate) =>
				candidate.method === method && candidate.path === path && candidate.remaining > 0,
		);
		if (delay !== undefined) {
			delay.remaining -= 1;
			await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay.delayMs));
		}
		const stalledBody = this.#stalledBodies.find(
			(candidate) =>
				candidate.method === method && candidate.path === path && candidate.remaining > 0,
		);
		if (stalledBody !== undefined) {
			stalledBody.remaining -= 1;
			response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
			response.write(stalledBody.contents);
			return;
		}

		switch (method) {
			case 'PROPFIND':
				this.#handlePropfind(path, request, response);
				return;
			case 'MKCOL':
				this.#handleMkcol(path, response);
				return;
			case 'GET':
				this.#handleGet(path, response);
				return;
			case 'PUT':
				await this.#handlePut(path, request, response);
				return;
			case 'DELETE':
				this.#handleDelete(path, response);
				return;
			default:
				response.writeHead(405).end();
		}
	}

	#handlePropfind(path: string, request: IncomingMessage, response: ServerResponse): void {
		const entry = this.#entries.get(path);
		if (entry === undefined) {
			response.writeHead(404).end();
			return;
		}
		const depth = request.headers.depth === '1' ? 1 : 0;
		const entries = [[path, entry] as const, ...(depth === 1 ? this.#getDirectChildren(path) : [])];
		response
			.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
			.end(toMultistatus(entries));
	}

	#handleMkcol(path: string, response: ServerResponse): void {
		if (path.length === 0 || this.#entries.has(path)) {
			response.writeHead(405).end();
			return;
		}
		if (this.#entries.get(parentPath(path))?.type !== 'directory') {
			response.writeHead(409).end();
			return;
		}
		this.#entries.set(path, { type: 'directory' });
		response.writeHead(201).end();
	}

	#handleGet(path: string, response: ServerResponse): void {
		const entry = this.#entries.get(path);
		if (entry === undefined || entry.type !== 'file') {
			response.writeHead(404).end();
			return;
		}
		response
			.writeHead(200, {
				'Content-Length': entry.contents.byteLength,
				'Content-Type': 'application/octet-stream',
			})
			.end(entry.contents);
	}

	async #handlePut(
		path: string,
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		if (this.#entries.get(parentPath(path))?.type !== 'directory') {
			response.writeHead(409).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		this.#entries.set(path, { contents: Buffer.concat(chunks), type: 'file' });
		response.writeHead(201).end();
	}

	#handleDelete(path: string, response: ServerResponse): void {
		if (path.length === 0 || !this.#entries.has(path)) {
			response.writeHead(404).end();
			return;
		}
		for (const key of this.#entries.keys()) {
			if (key === path || key.startsWith(`${path}/`)) {
				this.#entries.delete(key);
			}
		}
		response.writeHead(204).end();
	}

	#getDirectChildren(path: string): Array<readonly [string, Entry]> {
		const prefix = path.length === 0 ? '' : `${path}/`;
		const children: Array<readonly [string, Entry]> = [];
		for (const [candidatePath, entry] of this.#entries) {
			if (!candidatePath.startsWith(prefix) || candidatePath === path) {
				continue;
			}
			const relativePath = candidatePath.slice(prefix.length);
			if (!relativePath.includes('/')) {
				children.push([candidatePath, entry]);
			}
		}
		return children;
	}
}

function normalizePath(path: string): string {
	return path.replace(/^\/+|\/+$/gu, '');
}

function parentPath(path: string): string {
	const separator = path.lastIndexOf('/');
	return separator === -1 ? '' : path.slice(0, separator);
}

function encodePath(path: string): string {
	return path
		.split('/')
		.filter((segment) => segment.length > 0)
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

function xmlEscape(value: string): string {
	return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function toMultistatus(entries: readonly (readonly [string, Entry])[]): string {
	const responses = entries
		.map(([path, entry]) => {
			const basename = path.split('/').at(-1) ?? '';
			const href = `/dav/${encodePath(path)}${entry.type === 'directory' ? '/' : ''}`;
			const size = entry.type === 'file' ? entry.contents.byteLength : 0;
			const resourceType = entry.type === 'directory' ? '<d:collection/>' : '';
			return `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop><d:displayname>${xmlEscape(basename)}</d:displayname><d:resourcetype>${resourceType}</d:resourcetype><d:getcontentlength>${size}</d:getcontentlength><d:getcontenttype>application/octet-stream</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
		})
		.join('');
	return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses}</d:multistatus>`;
}
