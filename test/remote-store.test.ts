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
		const truncatingGateway: WebDavGateway = {
			createDirectory: (path, options) => gateway.createDirectory(path, options),
			deletePath: (path, options) => gateway.deletePath(path, options),
			directoryContents: (path, options) => gateway.directoryContents(path, options),
			exists: (path, options) => gateway.exists(path, options),
			readFile: (path, onProgress, options) => gateway.readFile(path, onProgress, options),
			writeFile: (path, contents, onProgress, options) =>
				gateway.writeFile(
					path,
					path.includes('/revisions/') ? contents.subarray(0, contents.byteLength - 1) : contents,
					onProgress,
					options,
				),
		};

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
		const rewritingGateway: WebDavGateway = {
			createDirectory: (path, options) => gateway.createDirectory(path, options),
			deletePath: (path, options) => gateway.deletePath(path, options),
			directoryContents: (path, options) => gateway.directoryContents(path, options),
			exists: (path, options) => gateway.exists(path, options),
			readFile: (path, onProgress, options) => gateway.readFile(path, onProgress, options),
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
		};

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

	it('retains a revision when an aborted manifest write may commit after verification', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const manifestPath = parseRemotePath(`${root}/manifest.json`);
		const delayedGateway: WebDavGateway = {
			createDirectory: (path, options) => gateway.createDirectory(path, options),
			deletePath: (path, options) => gateway.deletePath(path, options),
			directoryContents: (path, options) => gateway.directoryContents(path, options),
			exists: (path, options) => gateway.exists(path, options),
			readFile: (path, onProgress, options) => gateway.readFile(path, onProgress, options),
			writeFile: async (path, contents, onProgress, options) => {
				if (path === manifestPath) {
					setTimeout(() => {
						void gateway.writeFile(path, contents, onProgress, options);
					}, 20);
					throw new WebDavRequestError('WebDAV request cancelled', { retryable: false });
				}
				await gateway.writeFile(path, contents, onProgress, options);
			},
		};

		await expect(
			new RemoteStore(delayedGateway, root).publishRevision({
				allowUnverifiedManifest: false,
				expectedManifestSha256: undefined,
				files: [{ contents: Buffer.from('new', 'utf8'), path: parseManifestPath('settings.json') }],
			}),
		).rejects.toBeInstanceOf(RemoteCommitUnknownError);
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
		const committed = await store.readManifest();
		if (committed === undefined) {
			throw new Error('Expected delayed manifest activation');
		}
		expect(
			await gateway.exists(parseRemotePath(`${root}/revisions/${committed.manifest.revision}`)),
		).toBe(true);
	});

	it('validates read capability independently from write probing', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const unreadableGateway: WebDavGateway = {
			createDirectory: (path, options) => gateway.createDirectory(path, options),
			deletePath: (path, options) => gateway.deletePath(path, options),
			directoryContents: (path, options) => gateway.directoryContents(path, options),
			exists: (path, options) => gateway.exists(path, options),
			readFile: async (path, onProgress, options) => {
				if (path === parseRemotePath(`${root}/manifest.json`)) {
					throw new WebDavRequestError('WebDAV authorization failed', {
						retryable: false,
						status: 403,
					});
				}
				return gateway.readFile(path, onProgress, options);
			},
			writeFile: (path, contents, onProgress, options) =>
				gateway.writeFile(path, contents, onProgress, options),
		};

		await expect(
			new RemoteStore(unreadableGateway, root).verifyReadCapability(),
		).rejects.toMatchObject({
			status: 403,
		});
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
		const failingGateway: WebDavGateway = {
			createDirectory: (path, options) => gateway.createDirectory(path, options),
			deletePath: (path, options) => gateway.deletePath(path, options),
			directoryContents: (path, options) => gateway.directoryContents(path, options),
			exists: (path, options) => gateway.exists(path, options),
			readFile: (path, onProgress, options) => gateway.readFile(path, onProgress, options),
			writeFile: async (path, contents, onProgress, options) => {
				if (path === manifestPath) {
					throw new WebDavRequestError('WebDAV network request failed', { retryable: false });
				}
				await gateway.writeFile(path, contents, onProgress, options);
			},
		};

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

	it('cleans a probe when directory creation has an unknown outcome', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const uncertainGateway: WebDavGateway = {
			createDirectory: async (path) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					await gateway.createDirectory(path);
					throw new WebDavRequestError('WebDAV network request failed', { retryable: false });
				}
				await gateway.createDirectory(path);
			},
			deletePath: (path) => gateway.deletePath(path),
			directoryContents: (path) => gateway.directoryContents(path),
			exists: (path) => gateway.exists(path),
			readFile: (path, onProgress) => gateway.readFile(path, onProgress),
			writeFile: (path, contents, onProgress) => gateway.writeFile(path, contents, onProgress),
		};

		await expect(new RemoteStore(uncertainGateway, root).verifyWriteCapability()).resolves.toEqual({
			canWrite: false,
			cleanupFailed: false,
			error: expect.objectContaining({ message: 'WebDAV network request failed' }),
		});
		expect(await store.inspectRoot()).toEqual({ kind: 'empty' });
	});

	it('reports probe cleanup failure when capability validation is cancelled', async () => {
		const { gateway, root, store } = await createStore();
		await store.ensureRoot();
		const controller = new AbortController();
		const cancelledGateway: WebDavGateway = {
			createDirectory: (path, options) => gateway.createDirectory(path, options),
			deletePath: async (path) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					throw new WebDavRequestError('WebDAV authorization failed', {
						retryable: false,
						status: 403,
					});
				}
				await gateway.deletePath(path);
			},
			directoryContents: (path, options) => gateway.directoryContents(path, options),
			exists: (path, options) => gateway.exists(path, options),
			readFile: (path, onProgress, options) => gateway.readFile(path, onProgress, options),
			writeFile: async (path) => {
				if (path.includes('.pi-sync-webdav-probe-')) {
					controller.abort();
					throw new WebDavRequestError('WebDAV request cancelled', { retryable: false });
				}
				throw new Error('Unexpected write request');
			},
		};

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
