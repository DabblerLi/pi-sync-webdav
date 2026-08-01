import { afterEach, describe, expect, it } from 'vitest';

import { normalizeConnection, parseRemotePath } from '../src/paths.js';
import { createWebDavGateway, WebDavRequestError } from '../src/webdav.js';
import { MockWebDavServer } from './mock-webdav-server.js';

const servers: MockWebDavServer[] = [];

function testConnection(server: MockWebDavServer, password = 'password') {
	return normalizeConnection({
		password,
		remotePath: 'pi-sync-webdav',
		url: server.baseUrl,
		username: 'alice',
	});
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createGateway() {
	const server = await MockWebDavServer.create();
	servers.push(server);
	const gateway = createWebDavGateway(testConnection(server), {
		requestTimeoutMs: 1_000,
		retryDelaysMs: [0, 0],
	});
	return { gateway, server };
}

describe('WebDAV gateway', () => {
	it('uses Basic Auth and supports the required WebDAV operations', async () => {
		const { gateway, server } = await createGateway();
		const root = parseRemotePath('pi-sync-webdav');
		const file = parseRemotePath('pi-sync-webdav/a b#.txt');

		await gateway.createDirectory(root);
		expect(await gateway.exists(root)).toBe(true);
		await gateway.writeFile(file, Buffer.from('contents', 'utf8'));
		expect(await gateway.readFile(file)).toEqual(Buffer.from('contents', 'utf8'));
		expect(await gateway.directoryContents(root)).toEqual([{ basename: 'a b#.txt', type: 'file' }]);
		await gateway.deletePath(file);
		await gateway.deletePath(root);
		expect(await gateway.exists(root)).toBe(false);
		expect(server.requests).toContainEqual({
			method: 'PUT',
			pathname: '/dav/pi-sync-webdav/a%20b%23.txt',
		});
	});

	it('retries temporary server failures without exposing credentials', async () => {
		const { gateway, server } = await createGateway();
		const root = parseRemotePath('pi-sync-webdav');
		const file = parseRemotePath('pi-sync-webdav/retry.txt');
		await gateway.createDirectory(root);
		await gateway.writeFile(file, Buffer.from('retry', 'utf8'));
		server.failNext('GET', 'pi-sync-webdav/retry.txt', 503);

		await expect(gateway.readFile(file)).resolves.toEqual(Buffer.from('retry', 'utf8'));
		expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(2);
	});

	it('retries rate limits and timed-out requests', async () => {
		const { gateway: setupGateway, server } = await createGateway();
		const root = parseRemotePath('pi-sync-webdav');
		const file = parseRemotePath('pi-sync-webdav/retry-timeout.txt');
		await setupGateway.createDirectory(root);
		await setupGateway.writeFile(file, Buffer.from('retry', 'utf8'));
		const gateway = createWebDavGateway(testConnection(server), {
			requestTimeoutMs: 10,
			retryDelaysMs: [0, 0],
		});
		server.failNext('GET', 'pi-sync-webdav/retry-timeout.txt', 429);
		server.delayNext('GET', 'pi-sync-webdav/retry-timeout.txt', 50);

		await expect(gateway.readFile(file)).resolves.toEqual(Buffer.from('retry', 'utf8'));
		expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(3);
	});

	it('cancels a read when its caller aborts', async () => {
		const { gateway, server } = await createGateway();
		const root = parseRemotePath('pi-sync-webdav');
		const file = parseRemotePath('pi-sync-webdav/cancel.txt');
		await gateway.createDirectory(root);
		await gateway.writeFile(file, Buffer.from('cancel', 'utf8'));
		server.delayNext('GET', 'pi-sync-webdav/cancel.txt', 50);
		const controller = new AbortController();
		const request = gateway.readFile(file, undefined, controller.signal);
		controller.abort();

		await expect(request).rejects.toMatchObject({
			message: 'WebDAV request cancelled',
			retryable: false,
		});
	});

	it('cancels and times out reads after a response body has started', async () => {
		const { gateway, server } = await createGateway();
		const file = parseRemotePath('pi-sync-webdav/stalled.txt');
		server.stallNextBody('GET', file, Buffer.from('partial', 'utf8'));
		const controller = new AbortController();
		const cancelled = gateway.readFile(file, () => controller.abort(), controller.signal);

		await expect(cancelled).rejects.toMatchObject({ message: 'WebDAV request cancelled' });

		server.stallNextBody('GET', file, Buffer.from('partial', 'utf8'));
		const timeoutGateway = createWebDavGateway(testConnection(server), {
			requestTimeoutMs: 10,
			retryDelaysMs: [],
		});
		await expect(timeoutGateway.readFile(file)).rejects.toMatchObject({
			message: 'WebDAV request timed out',
		});
	});

	it('reports retry state and cancels before another retry begins', async () => {
		const { gateway, server } = await createGateway();
		const root = parseRemotePath('pi-sync-webdav');
		const file = parseRemotePath('pi-sync-webdav/retry-cancel.txt');
		await gateway.createDirectory(root);
		await gateway.writeFile(file, Buffer.from('retry', 'utf8'));
		server.failNext('GET', 'pi-sync-webdav/retry-cancel.txt', 503);
		const controller = new AbortController();
		const retries: Array<{ attempt: number; total: number }> = [];

		const request = gateway.readFile(file, undefined, {
			onRetry: (retry) => {
				retries.push(retry);
				controller.abort();
			},
			signal: controller.signal,
		});

		await expect(request).rejects.toMatchObject({ message: 'WebDAV request cancelled' });
		expect(retries).toEqual([{ attempt: 2, total: 3 }]);
	});

	it('cancels a directory request when its caller aborts', async () => {
		const { gateway, server } = await createGateway();
		const root = parseRemotePath('pi-sync-webdav');
		await gateway.createDirectory(root);
		server.delayNext('PROPFIND', 'pi-sync-webdav', 50);
		const controller = new AbortController();
		const request = gateway.directoryContents(root, { signal: controller.signal });
		controller.abort();

		await expect(request).rejects.toMatchObject({
			message: 'WebDAV request cancelled',
			retryable: false,
		});
	});

	it('cancels an upload when its caller aborts', async () => {
		const { gateway, server } = await createGateway();
		const root = parseRemotePath('pi-sync-webdav');
		const file = parseRemotePath('pi-sync-webdav/cancel-upload.txt');
		await gateway.createDirectory(root);
		server.delayNext('PUT', 'pi-sync-webdav/cancel-upload.txt', 50);
		const controller = new AbortController();
		const request = gateway.writeFile(file, Buffer.from('cancel', 'utf8'), undefined, {
			signal: controller.signal,
		});
		controller.abort();

		await expect(request).rejects.toMatchObject({
			message: 'WebDAV request cancelled',
			retryable: false,
		});
	});

	it('bounds successful/error responses and redacts authentication failures', async () => {
		const { gateway, server } = await createGateway();
		const root = parseRemotePath('pi-sync-webdav');
		const file = parseRemotePath('pi-sync-webdav/large.txt');
		await gateway.createDirectory(root);
		await gateway.writeFile(file, Buffer.from('large', 'utf8'));
		const limitedGateway = createWebDavGateway(testConnection(server), {
			maxResponseBytes: 4,
			retryDelaysMs: [],
		});
		const noRetryGateway = createWebDavGateway(testConnection(server), { retryDelaysMs: [] });
		const unauthorizedGateway = createWebDavGateway(testConnection(server, 'wrong-password'), {
			retryDelaysMs: [],
		});

		await expect(limitedGateway.readFile(file)).rejects.toThrow(
			'WebDAV response exceeds the size limit',
		);
		await expect(limitedGateway.directoryContents(root)).rejects.toThrow(
			'WebDAV response exceeds the size limit',
		);
		await expect(limitedGateway.exists(root)).rejects.toThrow(
			'WebDAV response exceeds the size limit',
		);
		server.failNext(
			'GET',
			'pi-sync-webdav/large.txt',
			500,
			1,
			'Authorization: Basic YWxpY2U6cGFzc3dvcmQ= password \u0000'.repeat(4_096),
		);
		const error = await noRetryGateway
			.readFile(file)
			.catch((requestError: unknown) => requestError);
		expect(error).toBeInstanceOf(WebDavRequestError);
		expect((error as Error).message).toBe('WebDAV request failed with HTTP status 500');
		expect((error as Error).message).not.toContain('Authorization');
		expect((error as Error).message).not.toContain('password');
		await expect(unauthorizedGateway.exists(root)).rejects.toMatchObject({
			message: 'WebDAV authentication failed',
			status: 401,
		});
		await expect(unauthorizedGateway.exists(root)).rejects.toBeInstanceOf(WebDavRequestError);
	});
});
