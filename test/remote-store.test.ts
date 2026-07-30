import { afterEach, describe, expect, it } from 'vitest';

import { parseRemotePath, parseManifestPath, normalizeConnection } from '../src/paths.js';
import {
	RemoteCommitRejectedError,
	RemoteCommitUnknownError,
	RemoteManifestChangedError,
	RemoteStore,
	UnverifiedRemoteManifestError,
} from '../src/remote-store.js';
import { createWebDavGateway, WebDavRequestError, type WebDavGateway } from '../src/webdav.js';
import { MockWebDavServer } from './mock-webdav-server.js';

const servers: MockWebDavServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createStore(remoteRoot = 'pi-sync-webdav') {
	const server = await MockWebDavServer.create();
	servers.push(server);
	const gateway = createWebDavGateway(
		normalizeConnection({
			password: 'password',
			remotePath: remoteRoot,
			url: server.baseUrl,
			username: 'alice',
		}),
		{ requestTimeoutMs: 1_000, retryDelaysMs: [] },
	);
	const root = parseRemotePath(remoteRoot);
	return { gateway, root, server, store: new RemoteStore(gateway, root) };
}

describe('remote store', () => {
	it('creates nested roots and verifies write capability with a temporary probe', async () => {
		const { root, store } = await createStore('pi/pi-sync-webdav');

		expect(await store.inspectRoot()).toEqual({ kind: 'missing' });
		expect(await store.ensureRoot()).toEqual({ kind: 'empty' });
		expect(await store.verifyWriteCapability()).toEqual({
			canWrite: true,
			cleanupFailed: false,
			error: undefined,
		});
		expect(await store.inspectRoot()).toEqual({ kind: 'empty' });
		expect(root).toBe('pi/pi-sync-webdav');
	});

	it('rejects a non-empty root without a manifest without modifying its contents', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const foreignFile = parseRemotePath(`${root}/foreign.txt`);
		await gateway.writeFile(foreignFile, Buffer.from('foreign', 'utf8'));

		await expect(
			store.publishRevision({
				allowUnverifiedManifest: false,
				expectedManifestSha256: undefined,
				files: [{ contents: Buffer.from('new', 'utf8'), path: parseManifestPath('settings.json') }],
			}),
		).rejects.toThrow('The remote root contains unrecognized files');
		expect(await gateway.readFile(foreignFile)).toEqual(Buffer.from('foreign', 'utf8'));
		expect(await gateway.exists(parseRemotePath(`${root}/revisions`))).toBe(false);
	});

	it('publishes complete revisions, verifies the manifest, and removes the previous revision', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const first = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{
					contents: Buffer.from('{"theme":"dark"}', 'utf8'),
					path: parseManifestPath('settings.json'),
				},
				{ contents: Buffer.from('dark', 'utf8'), path: parseManifestPath('themes/dark.txt') },
			],
		});
		const firstSnapshot = await store.readManifest();
		if (firstSnapshot === undefined) {
			throw new Error('Expected a manifest after publishing');
		}
		expect(first.previousRevisionCleanup).toBe('not-applicable');
		expect(firstSnapshot.manifest).toEqual(first.manifest);
		expect(
			await gateway.readFile(
				parseRemotePath(`${root}/revisions/${first.manifest.revision}/themes/dark.txt`),
			),
		).toEqual(Buffer.from('dark', 'utf8'));

		const second = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: firstSnapshot.sha256,
			files: [
				{
					contents: Buffer.from('{"theme":"light"}', 'utf8'),
					path: parseManifestPath('settings.json'),
				},
			],
		});

		expect(second.previousRevisionCleanup).toBe('deleted');
		expect(
			await gateway.exists(parseRemotePath(`${root}/revisions/${first.manifest.revision}`)),
		).toBe(false);
		expect((await store.readManifest())?.manifest).toEqual(second.manifest);
	});

	it('downloads only manifest-declared revision files and verifies their integrity', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const published = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{ contents: Buffer.from('expected', 'utf8'), path: parseManifestPath('settings.json') },
			],
		});
		const file = published.manifest.files[0];
		if (file === undefined) {
			throw new Error('Expected published test file');
		}

		await expect(store.readRevisionFile(published.manifest, file)).resolves.toEqual(
			Buffer.from('expected', 'utf8'),
		);
		await gateway.writeFile(
			parseRemotePath(`${root}/revisions/${published.manifest.revision}/settings.json`),
			Buffer.from('tampered', 'utf8'),
		);
		await expect(store.readRevisionFile(published.manifest, file)).rejects.toThrow(
			'Remote revision file failed integrity verification',
		);
	});

	it('requires explicit permission before replacing an invalid current manifest', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		await gateway.writeFile(
			parseRemotePath(`${root}/manifest.json`),
			Buffer.from('not json', 'utf8'),
		);
		const snapshot = await store.readRawManifest();
		if (snapshot === undefined) {
			throw new Error('Expected a raw manifest');
		}
		const input = {
			expectedManifestSha256: snapshot.sha256,
			files: [{ contents: Buffer.from('{}', 'utf8'), path: parseManifestPath('settings.json') }],
		};

		await expect(
			store.publishRevision({ ...input, allowUnverifiedManifest: false }),
		).rejects.toBeInstanceOf(UnverifiedRemoteManifestError);
		await expect(
			store.publishRevision({ ...input, allowUnverifiedManifest: true }),
		).resolves.toMatchObject({ previousRevisionCleanup: 'not-applicable' });
	});

	it('stops before creating a revision when the remote manifest has changed', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const first = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [{ contents: Buffer.from('first', 'utf8'), path: parseManifestPath('settings.json') }],
		});
		const snapshot = await store.readRawManifest();
		if (snapshot === undefined) {
			throw new Error('Expected a raw manifest');
		}
		await gateway.writeFile(parseRemotePath(`${root}/manifest.json`), Buffer.from('{}', 'utf8'));

		await expect(
			store.publishRevision({
				allowUnverifiedManifest: true,
				expectedManifestSha256: snapshot.sha256,
				files: [
					{ contents: Buffer.from('second', 'utf8'), path: parseManifestPath('settings.json') },
				],
			}),
		).rejects.toBeInstanceOf(RemoteManifestChangedError);
		expect(
			await gateway.exists(parseRemotePath(`${root}/revisions/${first.manifest.revision}`)),
		).toBe(true);
	});

	it('removes a revision when post-commit verification proves it is inactive', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const manifestPath = parseRemotePath(`${root}/manifest.json`);
		const suppressingGateway: WebDavGateway = {
			createDirectory: (path) => gateway.createDirectory(path),
			deletePath: (path) => gateway.deletePath(path),
			directoryContents: (path) => gateway.directoryContents(path),
			exists: (path) => gateway.exists(path),
			readFile: (path, onProgress) => gateway.readFile(path, onProgress),
			writeFile: async (path, contents, onProgress) => {
				if (path === manifestPath) {
					return;
				}
				await gateway.writeFile(path, contents, onProgress);
			},
		};

		await expect(
			new RemoteStore(suppressingGateway, root).publishRevision({
				allowUnverifiedManifest: false,
				expectedManifestSha256: undefined,
				files: [{ contents: Buffer.from('new', 'utf8'), path: parseManifestPath('settings.json') }],
			}),
		).rejects.toBeInstanceOf(RemoteCommitRejectedError);
		expect(await gateway.directoryContents(parseRemotePath(`${root}/revisions`))).toEqual([]);
	});

	it('retains a revision when post-commit verification cannot be completed', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const manifestPath = parseRemotePath(`${root}/manifest.json`);
		let manifestWriteObserved = false;
		const unreadableManifestGateway: WebDavGateway = {
			createDirectory: (path) => gateway.createDirectory(path),
			deletePath: (path) => gateway.deletePath(path),
			directoryContents: (path) => gateway.directoryContents(path),
			exists: (path) => gateway.exists(path),
			readFile: async (path, onProgress) => {
				if (manifestWriteObserved && path === manifestPath) {
					throw new WebDavRequestError('WebDAV request failed with HTTP status 503', {
						retryable: true,
						status: 503,
					});
				}
				return gateway.readFile(path, onProgress);
			},
			writeFile: async (path, contents, onProgress) => {
				await gateway.writeFile(path, contents, onProgress);
				if (path === manifestPath) {
					manifestWriteObserved = true;
				}
			},
		};

		await expect(
			new RemoteStore(unreadableManifestGateway, root).publishRevision({
				allowUnverifiedManifest: false,
				expectedManifestSha256: undefined,
				files: [{ contents: Buffer.from('new', 'utf8'), path: parseManifestPath('settings.json') }],
			}),
		).rejects.toBeInstanceOf(RemoteCommitUnknownError);
		expect(await gateway.directoryContents(parseRemotePath(`${root}/revisions`))).toHaveLength(1);
	});

	it('reports a failed capability probe without treating the connection as writable', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const failingGateway: WebDavGateway = {
			createDirectory: async (path) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					throw new WebDavRequestError('WebDAV authorization failed', {
						retryable: false,
						status: 403,
					});
				}
				await gateway.createDirectory(path);
			},
			deletePath: (path) => gateway.deletePath(path),
			directoryContents: (path) => gateway.directoryContents(path),
			exists: (path) => gateway.exists(path),
			readFile: (path, onProgress) => gateway.readFile(path, onProgress),
			writeFile: (path, contents, onProgress) => gateway.writeFile(path, contents, onProgress),
		};
		const failingStore = new RemoteStore(failingGateway, root);

		await expect(failingStore.verifyWriteCapability()).resolves.toEqual({
			canWrite: false,
			cleanupFailed: false,
			error: expect.objectContaining({ status: 403 }),
		});
	});

	it('marks the connection read-only when probe writes are denied', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const failingGateway: WebDavGateway = {
			createDirectory: (path) => gateway.createDirectory(path),
			deletePath: (path) => gateway.deletePath(path),
			directoryContents: (path) => gateway.directoryContents(path),
			exists: (path) => gateway.exists(path),
			readFile: (path, onProgress) => gateway.readFile(path, onProgress),
			writeFile: async (path, contents, onProgress) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					throw new WebDavRequestError('WebDAV authorization failed', {
						retryable: false,
						status: 403,
					});
				}
				await gateway.writeFile(path, contents, onProgress);
			},
		};

		await expect(new RemoteStore(failingGateway, root).verifyWriteCapability()).resolves.toEqual({
			canWrite: false,
			cleanupFailed: false,
			error: expect.objectContaining({ status: 403 }),
		});
	});

	it('reports probe cleanup residue when deletes are denied', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const failingGateway: WebDavGateway = {
			createDirectory: (path) => gateway.createDirectory(path),
			deletePath: async (path) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					throw new WebDavRequestError('WebDAV authorization failed', {
						retryable: false,
						status: 403,
					});
				}
				await gateway.deletePath(path);
			},
			directoryContents: (path) => gateway.directoryContents(path),
			exists: (path) => gateway.exists(path),
			readFile: (path, onProgress) => gateway.readFile(path, onProgress),
			writeFile: (path, contents, onProgress) => gateway.writeFile(path, contents, onProgress),
		};

		await expect(new RemoteStore(failingGateway, root).verifyWriteCapability()).resolves.toEqual({
			canWrite: false,
			cleanupFailed: true,
			error: expect.objectContaining({ status: 403 }),
		});
	});
});
