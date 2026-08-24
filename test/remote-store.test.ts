import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { generateRevisionId } from '../src/manifest.js';
import { parseRemotePath, parseManifestPath, normalizeConnection } from '../src/paths.js';
import {
	RemoteCommitRejectedError,
	RemoteCommitUnknownError,
	RemoteManifestChangedError,
	RemoteStore,
	UnverifiedRemoteManifestError,
	WriteCapabilityProbeCancelledError,
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
	const connection = normalizeConnection({
		password: 'password',
		remotePath: remoteRoot,
		url: server.baseUrl,
		username: 'alice',
	});
	const gateway = createWebDavGateway(connection, {
		requestTimeoutMs: 1_000,
		retryDelaysMs: [],
	});
	const root = parseRemotePath(remoteRoot);
	return { connection, gateway, root, server, store: new RemoteStore(gateway, root) };
}

function overrideGateway(gateway: WebDavGateway, overrides: Partial<WebDavGateway>): WebDavGateway {
	return {
		copyPath:
			overrides.copyPath ??
			((source, destination, options) => gateway.copyPath(source, destination, options)),
		createDirectory:
			overrides.createDirectory ?? ((path, options) => gateway.createDirectory(path, options)),
		deletePath: overrides.deletePath ?? ((path, options) => gateway.deletePath(path, options)),
		directoryContents:
			overrides.directoryContents ?? ((path, options) => gateway.directoryContents(path, options)),
		exists: overrides.exists ?? ((path, options) => gateway.exists(path, options)),
		readFile:
			overrides.readFile ??
			((path, onProgress, options) => gateway.readFile(path, onProgress, options)),
		writeFile:
			overrides.writeFile ??
			((path, contents, onProgress, options) =>
				gateway.writeFile(path, contents, onProgress, options)),
	};
}

describe('remote store', () => {
	it('creates nested roots and verifies write capability with a temporary probe', async () => {
		const { root, store } = await createStore('pi/pi-sync-webdav');

		expect(await store.inspectRoot()).toEqual({ kind: 'missing' });
		expect(await store.ensureRoot()).toEqual({ kind: 'empty' });
		expect(await store.verifyWriteCapability()).toEqual({
			canWrite: true,
			cleanupFailed: false,
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

	it('reuses unchanged top-level entries, uploads only changes, and removes the previous revision', async () => {
		const { gateway, root, server, store } = await createStore();
		await store.ensureRoot();
		const first = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{ contents: Buffer.from('agents', 'utf8'), path: parseManifestPath('AGENTS.md') },
				{
					contents: Buffer.from('old extension', 'utf8'),
					path: parseManifestPath('extensions/config.json'),
				},
				{ contents: Buffer.from('old', 'utf8'), path: parseManifestPath('removed.txt') },
				{
					contents: Buffer.from('{"theme":"dark"}', 'utf8'),
					path: parseManifestPath('settings.json'),
				},
				{ contents: Buffer.from('dark', 'utf8'), path: parseManifestPath('themes/dark.txt') },
				{ contents: Buffer.from('old', 'utf8'), path: parseManifestPath('themes/removed.txt') },
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
		server.requests.splice(0);
		const copiedPaths: Array<{ destination: string; source: string }> = [];
		const recordingGateway = overrideGateway(gateway, {
			copyPath: async (source, destination, options) => {
				copiedPaths.push({ destination, source });
				await gateway.copyPath(source, destination, options);
			},
		});

		const second = await new RemoteStore(recordingGateway, root).publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: firstSnapshot.sha256,
			files: [
				{ contents: Buffer.from('agents', 'utf8'), path: parseManifestPath('AGENTS.md') },
				{
					contents: Buffer.from('new extension', 'utf8'),
					path: parseManifestPath('extensions/config.json'),
				},
				{
					contents: Buffer.from('{"theme":"light"}', 'utf8'),
					path: parseManifestPath('settings.json'),
				},
				{ contents: Buffer.from('dark', 'utf8'), path: parseManifestPath('themes/dark.txt') },
			],
		});

		const secondRevisionFragment = `/revisions/${second.manifest.revision}/`;
		expect(copiedPaths).toEqual([
			{
				destination: `${root}/revisions/${second.manifest.revision}/AGENTS.md`,
				source: `${root}/revisions/${first.manifest.revision}/AGENTS.md`,
			},
			{
				destination: `${root}/revisions/${second.manifest.revision}/themes`,
				source: `${root}/revisions/${first.manifest.revision}/themes`,
			},
		]);
		expect(
			server.requests
				.filter(
					(request) =>
						request.method === 'PUT' && request.pathname.includes(secondRevisionFragment),
				)
				.map((request) => request.pathname)
				.sort(),
		).toEqual([
			`/dav/${root}/revisions/${second.manifest.revision}/extensions/config.json`,
			`/dav/${root}/revisions/${second.manifest.revision}/settings.json`,
		]);
		expect(
			server.requests.some(
				(request) =>
					request.method === 'DELETE' &&
					request.pathname ===
						`/dav/${root}/revisions/${second.manifest.revision}/themes/removed.txt`,
			),
		).toBe(true);
		await expect(
			gateway.readFile(
				parseRemotePath(`${root}/revisions/${second.manifest.revision}/themes/dark.txt`),
			),
		).resolves.toEqual(Buffer.from('dark', 'utf8'));
		expect(second.previousRevisionCleanup).toBe('deleted');
		expect(
			await gateway.exists(parseRemotePath(`${root}/revisions/${first.manifest.revision}`)),
		).toBe(false);
		expect((await store.readManifest())?.manifest).toEqual(second.manifest);
	});

	it('uploads an entry in full when its top-level COPY is unsupported', async () => {
		const { gateway, root, server, store } = await createStore();
		const first = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{ contents: Buffer.from('first'), path: parseManifestPath('settings.json') },
				{ contents: Buffer.from('dark'), path: parseManifestPath('themes/dark.txt') },
			],
		});
		const snapshot = await store.readManifest();
		if (snapshot === undefined) {
			throw new Error('Expected a manifest after publishing');
		}
		server.failNext('COPY', `${root}/revisions/${first.manifest.revision}/themes`, 405);

		const second = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: snapshot.sha256,
			files: [
				{ contents: Buffer.from('second'), path: parseManifestPath('settings.json') },
				{ contents: Buffer.from('dark'), path: parseManifestPath('themes/dark.txt') },
			],
		});
		expect(second.copyFallbackEntries).toEqual([parseManifestPath('themes')]);
		expect((await store.readManifest())?.manifest).toEqual(second.manifest);
		const revisionRoot = `${root}/revisions/${second.manifest.revision}`;
		await expect(
			gateway.readFile(parseRemotePath(`${revisionRoot}/themes/dark.txt`)),
		).resolves.toEqual(Buffer.from('dark'));
		await expect(
			gateway.readFile(parseRemotePath(`${revisionRoot}/settings.json`)),
		).resolves.toEqual(Buffer.from('second'));
		expect(
			await gateway.exists(parseRemotePath(`${root}/revisions/${first.manifest.revision}`)),
		).toBe(false);
	});

	it('converges when an uncertain COPY failure follows a completed copy', async () => {
		const { gateway, root, server, store } = await createStore();
		await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{ contents: Buffer.from('first'), path: parseManifestPath('settings.json') },
				{ contents: Buffer.from('dark'), path: parseManifestPath('themes/dark.txt') },
				{ contents: Buffer.from('stale'), path: parseManifestPath('themes/stale.txt') },
			],
		});
		const snapshot = await store.readManifest();
		if (snapshot === undefined) {
			throw new Error('Expected a manifest after publishing');
		}
		const failingGateway = overrideGateway(gateway, {
			copyPath: async (source, destination, options) => {
				await gateway.copyPath(source, destination, options);
				throw new WebDavRequestError('WebDAV COPY failed with HTTP status 502', {
					retryable: true,
					status: 502,
				});
			},
		});

		const second = await new RemoteStore(failingGateway, root).publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: snapshot.sha256,
			files: [
				{ contents: Buffer.from('second'), path: parseManifestPath('settings.json') },
				{ contents: Buffer.from('dark'), path: parseManifestPath('themes/dark.txt') },
			],
		});
		expect(second.copyFallbackEntries).toEqual([parseManifestPath('themes')]);
		expect((await store.readManifest())?.manifest).toEqual(second.manifest);
		const revisionRoot = `${root}/revisions/${second.manifest.revision}`;
		expect(
			server.requests.some(
				(request) =>
					request.method === 'DELETE' && request.pathname === `/dav/${revisionRoot}/themes`,
			),
		).toBe(true);
		await expect(
			gateway.readFile(parseRemotePath(`${revisionRoot}/themes/dark.txt`)),
		).resolves.toEqual(Buffer.from('dark'));
		await expect(gateway.exists(parseRemotePath(`${revisionRoot}/themes/stale.txt`))).resolves.toBe(
			false,
		);
		expect(await gateway.directoryContents(parseRemotePath(`${root}/revisions`))).toEqual([
			{ basename: second.manifest.revision, type: 'directory' },
		]);
	});

	it('keeps push fatal when a fallback entry cannot be removed', async () => {
		const { gateway, root, store } = await createStore();
		const first = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{ contents: Buffer.from('first'), path: parseManifestPath('settings.json') },
				{ contents: Buffer.from('dark'), path: parseManifestPath('themes/dark.txt') },
			],
		});
		const snapshot = await store.readManifest();
		if (snapshot === undefined) {
			throw new Error('Expected a manifest after publishing');
		}
		const failingGateway = overrideGateway(gateway, {
			copyPath: async (source, destination, options) => {
				await gateway.copyPath(source, destination, options);
				throw new WebDavRequestError('WebDAV COPY failed with HTTP status 502', {
					retryable: true,
					status: 502,
				});
			},
			deletePath: async (path, options) => {
				if (path.endsWith('/themes')) {
					throw new WebDavRequestError('WebDAV request failed with HTTP status 500', {
						retryable: true,
						status: 500,
					});
				}
				await gateway.deletePath(path, options);
			},
		});

		await expect(
			new RemoteStore(failingGateway, root).publishRevision({
				allowUnverifiedManifest: false,
				expectedManifestSha256: snapshot.sha256,
				files: [
					{ contents: Buffer.from('second'), path: parseManifestPath('settings.json') },
					{ contents: Buffer.from('dark'), path: parseManifestPath('themes/dark.txt') },
				],
			}),
		).rejects.toMatchObject({ status: 500 });
		expect((await store.readManifest())?.manifest).toEqual(first.manifest);
		expect(await gateway.directoryContents(parseRemotePath(`${root}/revisions`))).toEqual([
			{ basename: first.manifest.revision, type: 'directory' },
		]);
	});

	it('keeps COPY authentication failures fatal without fallback', async () => {
		const { gateway, root, server, store } = await createStore();
		const first = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{ contents: Buffer.from('first'), path: parseManifestPath('settings.json') },
				{ contents: Buffer.from('dark'), path: parseManifestPath('themes/dark.txt') },
			],
		});
		const snapshot = await store.readManifest();
		if (snapshot === undefined) {
			throw new Error('Expected a manifest after publishing');
		}
		server.failNext('COPY', `${root}/revisions/${first.manifest.revision}/themes`, 403);

		await expect(
			store.publishRevision({
				allowUnverifiedManifest: false,
				expectedManifestSha256: snapshot.sha256,
				files: [
					{ contents: Buffer.from('second'), path: parseManifestPath('settings.json') },
					{ contents: Buffer.from('dark'), path: parseManifestPath('themes/dark.txt') },
				],
			}),
		).rejects.toMatchObject({ status: 403 });
		expect((await store.readManifest())?.manifest).toEqual(first.manifest);
		expect(await gateway.directoryContents(parseRemotePath(`${root}/revisions`))).toEqual([
			{ basename: first.manifest.revision, type: 'directory' },
		]);
	});

	it('keeps status-less COPY errors fatal without fallback', async () => {
		const { gateway, root, store } = await createStore();
		const first = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{ contents: Buffer.from('first'), path: parseManifestPath('settings.json') },
				{ contents: Buffer.from('dark'), path: parseManifestPath('themes/dark.txt') },
			],
		});
		const snapshot = await store.readManifest();
		if (snapshot === undefined) {
			throw new Error('Expected a manifest after publishing');
		}
		const failingGateway = overrideGateway(gateway, {
			copyPath: async () => {
				throw new WebDavRequestError('WebDAV network request failed', { retryable: true });
			},
		});

		await expect(
			new RemoteStore(failingGateway, root).publishRevision({
				allowUnverifiedManifest: false,
				expectedManifestSha256: snapshot.sha256,
				files: [
					{ contents: Buffer.from('second'), path: parseManifestPath('settings.json') },
					{ contents: Buffer.from('dark'), path: parseManifestPath('themes/dark.txt') },
				],
			}),
		).rejects.toThrow('WebDAV network request failed');
		expect((await store.readManifest())?.manifest).toEqual(first.manifest);
		expect(await gateway.directoryContents(parseRemotePath(`${root}/revisions`))).toEqual([
			{ basename: first.manifest.revision, type: 'directory' },
		]);
	});

	it('falls back per entry while other entries keep using COPY', async () => {
		const { gateway, root, server, store } = await createStore();
		const first = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{ contents: Buffer.from('util-v1'), path: parseManifestPath('lib/util.js') },
				{ contents: Buffer.from('a'), path: parseManifestPath('keep/a.txt') },
				{ contents: Buffer.from('logo'), path: parseManifestPath('themes/logo.txt') },
				{ contents: Buffer.from('stale'), path: parseManifestPath('themes/stale.css') },
			],
		});
		const snapshot = await store.readManifest();
		if (snapshot === undefined) {
			throw new Error('Expected a manifest after publishing');
		}
		server.requests.splice(0);
		server.failNext('COPY', `${root}/revisions/${first.manifest.revision}/themes`, 502);

		const second = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: snapshot.sha256,
			files: [
				{ contents: Buffer.from('a'), path: parseManifestPath('keep/a.txt') },
				{ contents: Buffer.from('util-v2'), path: parseManifestPath('lib/util.js') },
				{ contents: Buffer.from('v2'), path: parseManifestPath('themes/base.css') },
				{ contents: Buffer.from('logo'), path: parseManifestPath('themes/logo.txt') },
			],
		});
		expect(second.copyFallbackEntries).toEqual([parseManifestPath('themes')]);
		expect((await store.readManifest())?.manifest).toEqual(second.manifest);
		const revisionRoot = `${root}/revisions/${second.manifest.revision}`;
		await expect(gateway.readFile(parseRemotePath(`${revisionRoot}/lib/util.js`))).resolves.toEqual(
			Buffer.from('util-v2'),
		);
		await expect(gateway.readFile(parseRemotePath(`${revisionRoot}/keep/a.txt`))).resolves.toEqual(
			Buffer.from('a'),
		);
		await expect(
			gateway.readFile(parseRemotePath(`${revisionRoot}/themes/logo.txt`)),
		).resolves.toEqual(Buffer.from('logo'));
		await expect(
			gateway.readFile(parseRemotePath(`${revisionRoot}/themes/base.css`)),
		).resolves.toEqual(Buffer.from('v2'));
		await expect(gateway.exists(parseRemotePath(`${revisionRoot}/themes/stale.css`))).resolves.toBe(
			false,
		);
		const copyRequests = server.requests.filter((request) => request.method === 'COPY');
		expect(copyRequests).toHaveLength(2);
		expect(copyRequests.every((request) => /\/(keep|themes)$/u.test(request.pathname))).toBe(true);
		expect(
			server.requests.filter(
				(request) => request.method === 'DELETE' && request.pathname.includes('/themes/'),
			),
		).toEqual([]);
	});

	it('rebuilds paths that change between files and directories', async () => {
		const { gateway, root, server, store } = await createStore();
		await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{ contents: Buffer.from('file'), path: parseManifestPath('extensions') },
				{ contents: Buffer.from('nested'), path: parseManifestPath('themes/dark.json') },
			],
		});
		const snapshot = await store.readManifest();
		if (snapshot === undefined) {
			throw new Error('Expected a manifest after publishing');
		}
		server.requests.splice(0);

		const published = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: snapshot.sha256,
			files: [
				{ contents: Buffer.from('nested'), path: parseManifestPath('extensions/config.json') },
				{ contents: Buffer.from('file'), path: parseManifestPath('themes') },
			],
		});
		const revisionRoot = `${root}/revisions/${published.manifest.revision}`;

		await expect(
			gateway.readFile(parseRemotePath(`${revisionRoot}/extensions/config.json`)),
		).resolves.toEqual(Buffer.from('nested'));
		await expect(gateway.readFile(parseRemotePath(`${revisionRoot}/themes`))).resolves.toEqual(
			Buffer.from('file'),
		);
		expect(await gateway.directoryContents(parseRemotePath(revisionRoot))).toEqual([
			{ basename: 'extensions', type: 'directory' },
			{ basename: 'themes', type: 'file' },
		]);
		expect(server.requests.filter((request) => request.method === 'COPY')).toEqual([]);
	});

	it('rebuilds nested paths inside a copied top-level directory', async () => {
		const { gateway, root, server, store } = await createStore();
		await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{ contents: Buffer.from('same'), path: parseManifestPath('shared/anchor.txt') },
				{ contents: Buffer.from('file'), path: parseManifestPath('shared/file-to-dir') },
				{
					contents: Buffer.from('nested'),
					path: parseManifestPath('shared/dir-to-file/value.txt'),
				},
			],
		});
		const snapshot = await store.readManifest();
		if (snapshot === undefined) {
			throw new Error('Expected a manifest after publishing');
		}
		server.requests.splice(0);

		const published = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: snapshot.sha256,
			files: [
				{ contents: Buffer.from('same'), path: parseManifestPath('shared/anchor.txt') },
				{
					contents: Buffer.from('nested'),
					path: parseManifestPath('shared/file-to-dir/value.txt'),
				},
				{ contents: Buffer.from('file'), path: parseManifestPath('shared/dir-to-file') },
			],
		});
		const revisionRoot = `${root}/revisions/${published.manifest.revision}`;

		await expect(
			gateway.readFile(parseRemotePath(`${revisionRoot}/shared/file-to-dir/value.txt`)),
		).resolves.toEqual(Buffer.from('nested'));
		await expect(
			gateway.readFile(parseRemotePath(`${revisionRoot}/shared/dir-to-file`)),
		).resolves.toEqual(Buffer.from('file'));
		expect(server.requests.filter((request) => request.method === 'COPY')).toHaveLength(1);
	});

	it('leaves a late top-level COPY result inactive and available for residue cleanup', async () => {
		const { gateway, root, store } = await createStore();
		const first = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [{ contents: Buffer.from('first'), path: parseManifestPath('settings.json') }],
		});
		const snapshot = await store.readManifest();
		if (snapshot === undefined) {
			throw new Error('Expected a manifest after publishing');
		}
		const copyRelease = Promise.withResolvers<void>();
		let delayedCopy: Promise<void> | undefined;
		const timeoutGateway = overrideGateway(gateway, {
			copyPath: async (source, destination, options) => {
				const destinationSegments = destination.split('/');
				destinationSegments.pop();
				const destinationRevision = parseRemotePath(destinationSegments.join('/'));
				delayedCopy = copyRelease.promise.then(async () => {
					await gateway.createDirectory(destinationRevision, options);
					await gateway.copyPath(source, destination, options);
				});
				throw new WebDavRequestError('WebDAV request timed out', { retryable: true });
			},
		});

		await expect(
			new RemoteStore(timeoutGateway, root).publishRevision({
				allowUnverifiedManifest: false,
				expectedManifestSha256: snapshot.sha256,
				files: [{ contents: Buffer.from('first'), path: parseManifestPath('settings.json') }],
			}),
		).rejects.toThrow('WebDAV request timed out');
		if (delayedCopy === undefined) {
			throw new Error('Expected a delayed revision copy');
		}
		copyRelease.resolve();
		await delayedCopy;

		expect((await store.readManifest())?.manifest).toEqual(first.manifest);
		const residue = await store.inspectResidue();
		expect(residue.candidates).toHaveLength(1);
		await expect(store.cleanupResidue(residue.candidates)).resolves.toMatchObject({
			deleted: [residue.candidates[0]?.path],
			failed: [],
			retained: [],
		});
	});

	it('uploads revision files with bounded concurrency', async () => {
		const { gateway, root } = await createStore();
		let activeUploads = 0;
		let maximumActiveUploads = 0;
		const delayedGateway = overrideGateway(gateway, {
			writeFile: async (path, contents, onProgress, options) => {
				if (!path.includes('/revisions/')) {
					await gateway.writeFile(path, contents, onProgress, options);
					return;
				}
				activeUploads += 1;
				maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
				try {
					await delay(10);
					await gateway.writeFile(path, contents, onProgress, options);
				} finally {
					activeUploads -= 1;
				}
			},
		});
		const store = new RemoteStore(delayedGateway, root);

		await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: Array.from({ length: 6 }, (_, index) => ({
				contents: Buffer.from(`file-${index}`, 'utf8'),
				path: parseManifestPath(`file-${index}.txt`),
			})),
		});

		expect(maximumActiveUploads).toBeGreaterThan(1);
		expect(maximumActiveUploads).toBeLessThanOrEqual(4);
	});

	it('rejects a truncated revision upload without deleting the active revision', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const first = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [{ contents: Buffer.from('first', 'utf8'), path: parseManifestPath('settings.json') }],
		});
		const firstSnapshot = await store.readManifest();
		if (firstSnapshot === undefined) {
			throw new Error('Expected a manifest after publishing');
		}
		const truncatingGateway = overrideGateway(gateway, {
			writeFile: (path, contents, onProgress, options) =>
				gateway.writeFile(
					path,
					path.includes('/revisions/') ? contents.subarray(0, contents.byteLength - 1) : contents,
					onProgress,
					options,
				),
		});

		await expect(
			new RemoteStore(truncatingGateway, root).publishRevision({
				allowUnverifiedManifest: false,
				expectedManifestSha256: firstSnapshot.sha256,
				files: [
					{ contents: Buffer.from('second', 'utf8'), path: parseManifestPath('settings.json') },
				],
			}),
		).rejects.toThrow('Remote revision file failed integrity verification');
		expect((await store.readManifest())?.manifest).toEqual(first.manifest);
		expect(await gateway.directoryContents(parseRemotePath(`${root}/revisions`))).toEqual([
			{ basename: first.manifest.revision, type: 'directory' },
		]);
	});

	it('rejects a rewritten manifest with the expected revision without deleting the previous revision', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const first = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [{ contents: Buffer.from('first', 'utf8'), path: parseManifestPath('settings.json') }],
		});
		const firstSnapshot = await store.readManifest();
		if (firstSnapshot === undefined) {
			throw new Error('Expected a manifest after publishing');
		}
		const manifestPath = parseRemotePath(`${root}/manifest.json`);
		const rewritingGateway = overrideGateway(gateway, {
			writeFile: async (path, contents, onProgress, options) => {
				if (path !== manifestPath) {
					await gateway.writeFile(path, contents, onProgress, options);
					return;
				}
				const manifest = JSON.parse(contents.toString('utf8')) as Record<string, unknown>;
				await gateway.writeFile(
					path,
					Buffer.from(JSON.stringify({ ...manifest, files: [] }), 'utf8'),
					onProgress,
					options,
				);
			},
		});

		await expect(
			new RemoteStore(rewritingGateway, root).publishRevision({
				allowUnverifiedManifest: false,
				expectedManifestSha256: firstSnapshot.sha256,
				files: [
					{ contents: Buffer.from('second', 'utf8'), path: parseManifestPath('settings.json') },
				],
			}),
		).rejects.toBeInstanceOf(RemoteCommitUnknownError);
		expect(
			await gateway.exists(parseRemotePath(`${root}/revisions/${first.manifest.revision}`)),
		).toBe(true);
		expect(await gateway.directoryContents(parseRemotePath(`${root}/revisions`))).toHaveLength(2);
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
		const suppressingGateway = overrideGateway(gateway, {
			writeFile: async (path, contents, onProgress) => {
				if (path === manifestPath) {
					return;
				}
				await gateway.writeFile(path, contents, onProgress);
			},
		});

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
		const unreadableManifestGateway = overrideGateway(gateway, {
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
		});

		await expect(
			new RemoteStore(unreadableManifestGateway, root).publishRevision({
				allowUnverifiedManifest: false,
				expectedManifestSha256: undefined,
				files: [{ contents: Buffer.from('new', 'utf8'), path: parseManifestPath('settings.json') }],
			}),
		).rejects.toBeInstanceOf(RemoteCommitUnknownError);
		expect(await gateway.directoryContents(parseRemotePath(`${root}/revisions`))).toHaveLength(1);
	});

	it('retains a revision when an aborted manifest write may commit after verification', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const manifestPath = parseRemotePath(`${root}/manifest.json`);
		const manifestWriteRelease = Promise.withResolvers<void>();
		let delayedManifestWrite: Promise<void> | undefined;
		const delayedGateway = overrideGateway(gateway, {
			writeFile: async (path, contents, onProgress, options) => {
				if (path === manifestPath) {
					delayedManifestWrite = manifestWriteRelease.promise.then(() =>
						gateway.writeFile(path, contents, onProgress, options),
					);
					throw new WebDavRequestError('WebDAV request cancelled', { retryable: false });
				}
				await gateway.writeFile(path, contents, onProgress, options);
			},
		});

		await expect(
			new RemoteStore(delayedGateway, root).publishRevision({
				allowUnverifiedManifest: false,
				expectedManifestSha256: undefined,
				files: [{ contents: Buffer.from('new', 'utf8'), path: parseManifestPath('settings.json') }],
			}),
		).rejects.toBeInstanceOf(RemoteCommitUnknownError);
		if (delayedManifestWrite === undefined) {
			throw new Error('Expected a delayed manifest write');
		}
		manifestWriteRelease.resolve();
		await delayedManifestWrite;
		const committed = await store.readManifest();
		if (committed === undefined) {
			throw new Error('Expected delayed manifest activation');
		}
		expect(
			await gateway.exists(parseRemotePath(`${root}/revisions/${committed.manifest.revision}`)),
		).toBe(true);
	});

	it('lists and safely cleans only recognized inactive revision and probe residue', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const published = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{ contents: Buffer.from('active', 'utf8'), path: parseManifestPath('settings.json') },
			],
		});
		const staleRevision = generateRevisionId();
		const staleRevisionPath = parseRemotePath(`${root}/revisions/${staleRevision}`);
		const probeName = `.pi-sync-webdav-probe-${generateRevisionId()}`;
		const probePath = parseRemotePath(`${root}/${probeName}`);
		await gateway.createDirectory(staleRevisionPath);
		await gateway.createDirectory(probePath);
		await gateway.writeFile(parseRemotePath(`${root}/legacy.txt`), Buffer.from('legacy', 'utf8'));

		const residue = await store.inspectResidue();
		expect(residue).toEqual({
			candidates: [
				{ kind: 'probe', path: probeName },
				{ kind: 'revision', path: `revisions/${staleRevision}` },
			],
			unknownCount: 1,
		});
		const result = await store.cleanupResidue(residue.candidates);
		expect(result).toEqual({
			deleted: [probeName, `revisions/${staleRevision}`],
			failed: [],
			retained: [],
		});
		expect(await gateway.exists(probePath)).toBe(false);
		expect(await gateway.exists(staleRevisionPath)).toBe(false);
		expect(
			await gateway.exists(parseRemotePath(`${root}/revisions/${published.manifest.revision}`)),
		).toBe(true);
		expect(await gateway.exists(parseRemotePath(`${root}/legacy.txt`))).toBe(true);
	});

	it('counts reserved entries and the active revision as unknown when their types are wrong', async () => {
		const wrongReserved = await createStore('wrong-reserved');
		await wrongReserved.store.ensureRoot();
		await wrongReserved.gateway.createDirectory(
			parseRemotePath(`${wrongReserved.root}/manifest.json`),
		);
		await wrongReserved.gateway.writeFile(
			parseRemotePath(`${wrongReserved.root}/revisions`),
			Buffer.from('not a directory', 'utf8'),
		);
		expect(await wrongReserved.store.inspectResidue()).toEqual({ candidates: [], unknownCount: 2 });

		const wrongActiveRevision = await createStore('wrong-active-revision');
		await wrongActiveRevision.store.ensureRoot();
		const published = await wrongActiveRevision.store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [],
		});
		const activeRevisionPath = parseRemotePath(
			`${wrongActiveRevision.root}/revisions/${published.manifest.revision}`,
		);
		await wrongActiveRevision.gateway.deletePath(activeRevisionPath);
		await wrongActiveRevision.gateway.writeFile(
			activeRevisionPath,
			Buffer.from('not a directory', 'utf8'),
		);
		expect(await wrongActiveRevision.store.inspectResidue()).toEqual({
			candidates: [],
			unknownCount: 1,
		});
	});

	it('retains a revision that becomes active after residue inspection', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [],
		});
		const becomingActive = generateRevisionId();
		const revisionPath = parseRemotePath(`${root}/revisions/${becomingActive}`);
		await gateway.createDirectory(revisionPath);
		const residue = await store.inspectResidue();
		expect(residue.candidates).toEqual([{ kind: 'revision', path: `revisions/${becomingActive}` }]);
		await gateway.writeFile(
			parseRemotePath(`${root}/manifest.json`),
			Buffer.from(JSON.stringify({ files: [], revision: becomingActive, version: 1 }), 'utf8'),
		);

		await expect(store.cleanupResidue(residue.candidates)).resolves.toEqual({
			deleted: [],
			failed: [],
			retained: [`revisions/${becomingActive}`],
		});
		expect(await gateway.exists(revisionPath)).toBe(true);
	});

	it('retains residue when the managed manifest can no longer be verified', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const probeName = `.pi-sync-webdav-probe-${generateRevisionId()}`;
		const probePath = parseRemotePath(`${root}/${probeName}`);
		await gateway.createDirectory(probePath);
		await gateway.writeFile(parseRemotePath(`${root}/manifest.json`), Buffer.from('not json'));

		const residue = await store.inspectResidue();
		expect(residue.candidates).toEqual([{ kind: 'probe', path: probeName }]);
		await expect(store.cleanupResidue(residue.candidates)).resolves.toEqual({
			deleted: [],
			failed: [],
			retained: [probeName],
		});
		expect(await gateway.exists(probePath)).toBe(true);
	});

	it('cancels cleanup before deleting a verified residue candidate', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const probeName = `.pi-sync-webdav-probe-${generateRevisionId()}`;
		const probePath = parseRemotePath(`${root}/${probeName}`);
		await gateway.createDirectory(probePath);
		const residue = await store.inspectResidue();
		const controller = new AbortController();

		await expect(
			store.cleanupResidue(residue.candidates, {
				onProgress: () => controller.abort(),
				signal: controller.signal,
			}),
		).rejects.toThrow('WebDAV request cancelled');
		expect(await gateway.exists(probePath)).toBe(true);
	});

	it('retains a revision when manifest write failure leaves activation uncertain', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const manifestPath = parseRemotePath(`${root}/manifest.json`);
		const failingGateway = overrideGateway(gateway, {
			writeFile: async (path, contents, onProgress, options) => {
				if (path === manifestPath) {
					throw new WebDavRequestError('WebDAV network request failed', { retryable: false });
				}
				await gateway.writeFile(path, contents, onProgress, options);
			},
		});

		await expect(
			new RemoteStore(failingGateway, root).publishRevision({
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
		const failingGateway = overrideGateway(gateway, {
			createDirectory: async (path) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					throw new WebDavRequestError('WebDAV authorization failed', {
						retryable: false,
						status: 403,
					});
				}
				await gateway.createDirectory(path);
			},
		});
		const failingStore = new RemoteStore(failingGateway, root);

		await expect(failingStore.verifyWriteCapability()).resolves.toEqual({
			canWrite: false,
			cleanupFailed: false,
		});
	});

	it('does not hide unexpected capability probe failures as read-only access', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const failingGateway = overrideGateway(gateway, {
			createDirectory: async (path, options) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					throw new Error('Unexpected probe failure');
				}
				await gateway.createDirectory(path, options);
			},
		});

		await expect(new RemoteStore(failingGateway, root).verifyWriteCapability()).rejects.toThrow(
			'Unexpected probe failure',
		);
	});

	it('marks the connection read-only when probe writes are denied', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const failingGateway = overrideGateway(gateway, {
			writeFile: async (path, contents, onProgress) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					throw new WebDavRequestError('WebDAV authorization failed', {
						retryable: false,
						status: 403,
					});
				}
				await gateway.writeFile(path, contents, onProgress);
			},
		});

		await expect(new RemoteStore(failingGateway, root).verifyWriteCapability()).resolves.toEqual({
			canWrite: false,
			cleanupFailed: false,
		});
	});

	it('cleans a probe when directory creation has an unknown outcome', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const uncertainGateway = overrideGateway(gateway, {
			createDirectory: async (path) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					await gateway.createDirectory(path);
					throw new WebDavRequestError('WebDAV network request failed', { retryable: false });
				}
				await gateway.createDirectory(path);
			},
		});

		await expect(new RemoteStore(uncertainGateway, root).verifyWriteCapability()).resolves.toEqual({
			canWrite: false,
			cleanupFailed: false,
		});
		expect(await store.inspectRoot()).toEqual({ kind: 'empty' });
	});

	it('reports probe cleanup failure when capability validation is cancelled', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const controller = new AbortController();
		const cancelledGateway = overrideGateway(gateway, {
			deletePath: async (path) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					throw new WebDavRequestError('WebDAV authorization failed', {
						retryable: false,
						status: 403,
					});
				}
				await gateway.deletePath(path);
			},
			writeFile: async (path) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					controller.abort();
					throw new WebDavRequestError('WebDAV request cancelled', { retryable: false });
				}
				throw new Error('Unexpected write request');
			},
		});

		const error = await new RemoteStore(cancelledGateway, root)
			.verifyWriteCapability({ signal: controller.signal })
			.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(WriteCapabilityProbeCancelledError);
		expect(error).toMatchObject({
			cleanupFailed: true,
			message: 'WebDAV request cancelled',
		});
	});

	it('reports probe cleanup residue when deletes are denied', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const failingGateway = overrideGateway(gateway, {
			deletePath: async (path) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					throw new WebDavRequestError('WebDAV authorization failed', {
						retryable: false,
						status: 403,
					});
				}
				await gateway.deletePath(path);
			},
		});

		await expect(new RemoteStore(failingGateway, root).verifyWriteCapability()).resolves.toEqual({
			canWrite: false,
			cleanupFailed: true,
		});
	});
});
