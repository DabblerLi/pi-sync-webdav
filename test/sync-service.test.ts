import { readFile, readdir, stat, writeFile } from 'node:fs/promises';

import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';

import { readConfig, writeConfig, type PluginConfig } from '../src/config.js';
import {
	getPrivatePaths,
	parseManifestPath,
	parsePushInclude,
	parseRemotePath,
	normalizeConnection,
} from '../src/paths.js';
import { RemoteStore } from '../src/remote-store.js';
import {
	applyStagedPull,
	discardStagedPull,
	preparePull,
	preparePush,
	publishPreparedPush,
	stagePreparedPull,
	type PackageRuntimeFactory,
} from '../src/sync-service.js';
import { createWebDavGateway } from '../src/webdav.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers.js';
import { MockWebDavServer } from './mock-webdav-server.js';

const servers: MockWebDavServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

async function createStore(remotePath = 'pi-sync-webdav') {
	const server = await MockWebDavServer.create();
	servers.push(server);
	const connection = normalizeConnection({
		password: 'password',
		remotePath,
		url: server.baseUrl,
		username: 'alice',
	});
	return {
		connection,
		gateway: createWebDavGateway(connection, { requestTimeoutMs: 1_000, retryDelaysMs: [] }),
		server,
		store: new RemoteStore(
			createWebDavGateway(connection, { requestTimeoutMs: 1_000, retryDelaysMs: [] }),
			parseRemotePath(remotePath),
		),
	};
}

function pluginConfig(connection: ReturnType<typeof normalizeConnection>): PluginConfig {
	return {
		connection: { ...connection, readOnly: false },
		pushInclude: [parsePushInclude('settings.json')],
		version: 1,
	};
}

describe('sync service', () => {
	it('prepares and publishes an immutable local snapshot, then saves sync state', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-service-');
		temporaryDirectories.push(root);
		const { connection, store } = await createStore();
		const config = pluginConfig(connection);
		await writeFile(`${root}/settings.json`, '{"theme":"dark"}', 'utf8');
		await writeConfig(root, config);

		const preparation = await preparePush({ agentRoot: root, config, store });
		expect(preparation.plan.actions.map((action) => [action.path, action.action])).toEqual([
			['settings.json', 'add'],
		]);
		expect(preparation.requiresUnverifiedManifestConfirmation).toBe(false);

		const published = await publishPreparedPush(root, preparation, {
			allowUnverifiedManifest: false,
		});
		expect(published.manifest.files.map((file) => file.path)).toEqual(['settings.json']);
		expect((await readConfig(root))?.syncState).toMatchObject({
			managedPaths: [parseManifestPath('settings.json')],
		});
	});

	it('requires an explicit confirmation flag before replacing an invalid manifest', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-service-');
		temporaryDirectories.push(root);
		const { connection, gateway, store } = await createStore();
		const config = pluginConfig(connection);
		await writeFile(`${root}/settings.json`, '{}', 'utf8');
		await writeConfig(root, config);
		await store.ensureRoot();
		await gateway.writeFile(
			parseRemotePath('pi-sync-webdav/manifest.json'),
			Buffer.from('{', 'utf8'),
		);

		const preparation = await preparePush({ agentRoot: root, config, store });
		expect(preparation.requiresUnverifiedManifestConfirmation).toBe(true);
		await expect(
			publishPreparedPush(root, preparation, { allowUnverifiedManifest: false }),
		).rejects.toThrow('Unverified remote manifest requires confirmation');
	});

	it('downloads only settings for package planning before staging the remaining revision files', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-service-');
		temporaryDirectories.push(root);
		const { connection, server, store } = await createStore();
		const config = pluginConfig(connection);
		await writeFile(`${root}/settings.json`, '{}', 'utf8');
		await writeConfig(root, config);
		await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{
					contents: Buffer.from('{"theme":"remote"}', 'utf8'),
					path: parseManifestPath('settings.json'),
				},
				{ contents: Buffer.from('dark', 'utf8'), path: parseManifestPath('themes/dark.txt') },
			],
		});
		server.requests.splice(0);

		const preparation = await preparePull({ agentRoot: root, config, store });
		expect(
			server.requests.some(
				(request) => request.method === 'GET' && request.pathname.includes('themes/dark.txt'),
			),
		).toBe(false);
		await expect(stat(getPrivatePaths(root).workspaceDirectory)).rejects.toMatchObject({
			code: 'ENOENT',
		});
		const staged = await stagePreparedPull(root, preparation);
		expect(
			server.requests.some(
				(request) => request.method === 'GET' && request.pathname.includes('themes/dark.txt'),
			),
		).toBe(true);
		await discardStagedPull(root, staged);
		await expect(
			stat(`${getPrivatePaths(root).workspaceDirectory}/${staged.workspace.id}`),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('cleans a pull workspace when staging is cancelled', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-service-');
		temporaryDirectories.push(root);
		const { connection, store } = await createStore();
		const config = pluginConfig(connection);
		await writeFile(`${root}/settings.json`, '{}', 'utf8');
		await writeConfig(root, config);
		await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{
					contents: Buffer.from('{"theme":"remote"}', 'utf8'),
					path: parseManifestPath('settings.json'),
				},
			],
		});
		const preparation = await preparePull({ agentRoot: root, config, store });
		const controller = new AbortController();
		controller.abort();

		await expect(stagePreparedPull(root, preparation, controller.signal)).rejects.toThrow(
			'Pull download cancelled',
		);
		await expect(readdir(getPrivatePaths(root).workspaceDirectory)).resolves.toEqual([]);
	});

	it('stages a pull, coordinates packages after files apply, and does not persist failures', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-service-');
		temporaryDirectories.push(root);
		const { connection, store } = await createStore();
		const config = pluginConfig(connection);
		await writeFile(`${root}/settings.json`, '{}', 'utf8');
		await writeConfig(root, config);
		await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [
				{
					contents: Buffer.from('{"packages":["npm:@scope/broken","npm:working"]}', 'utf8'),
					path: parseManifestPath('settings.json'),
				},
				{
					contents: Buffer.from('dark', 'utf8'),
					path: parseManifestPath('themes/dark.txt'),
				},
			],
		});
		const calls: string[] = [];
		const packageRuntimeFactory: PackageRuntimeFactory = () => ({
			packageManager: {
				install: async (source: string): Promise<void> => {
					calls.push(`install:${source}`);
					if (source === 'npm:@scope/broken') {
						throw new Error('broken package');
					}
				},
				remove: async (source: string): Promise<void> => {
					calls.push(`remove:${source}`);
				},
			},
			settingsManager: SettingsManager.inMemory(),
		});

		const preparation = await preparePull(
			{ agentRoot: root, config, store },
			packageRuntimeFactory,
		);
		expect(preparation.plan.actions.map((action) => [action.path, action.action])).toEqual([
			['settings.json', 'update'],
			['themes/dark.txt', 'add'],
		]);
		expect(preparation.packageOperations).toEqual([
			{ action: 'install', source: 'npm:@scope/broken' },
			{ action: 'install', source: 'npm:working' },
		]);

		const result = await applyStagedPull(
			root,
			await stagePreparedPull(root, preparation),
			packageRuntimeFactory,
		);
		expect(result.files).toEqual({ status: 'applied' });
		expect(result.packages).toEqual({
			failed: [{ action: 'install', source: 'npm:@scope/broken' }],
			failureMessage: 'One or more Pi package operations failed. Resolve them manually.',
			succeeded: [{ action: 'install', source: 'npm:working' }],
		});
		expect(calls).toEqual(['install:npm:@scope/broken', 'install:npm:working']);
		expect(await readFile(`${root}/themes/dark.txt`, 'utf8')).toBe('dark');
		expect(await readConfig(root)).not.toHaveProperty('pendingPackageOperations');

		const laterPreparation = await preparePull(
			{ agentRoot: root, config: (await readConfig(root))!, store },
			() => ({
				packageManager: {
					install: async (): Promise<void> => undefined,
					remove: async (): Promise<void> => undefined,
				},
				settingsManager: SettingsManager.create(root, root, { projectTrusted: false }),
			}),
		);
		expect(laterPreparation.packageOperations).toEqual([]);
	});
});
