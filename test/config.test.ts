import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connectionFingerprint, readConfig, writeConfig } from '../src/config.js';
import {
	getPrivatePaths,
	normalizeConnection,
	parseManifestPath,
	parsePushInclude,
} from '../src/paths.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers.js';

const temporaryDirectories: string[] = [];

function createConfig() {
	const connection = normalizeConnection({
		password: 'correct horse battery staple',
		remotePath: 'pi-sync-webdav/',
		url: 'https://example.com/dav',
		username: 'alice',
	});

	return {
		connection: { ...connection, readOnly: false },
		pushInclude: [parsePushInclude('settings.json'), parsePushInclude('themes')],
		syncState: {
			connectionFingerprint: connectionFingerprint(connection),
			managedPaths: [parseManifestPath('settings.json'), parseManifestPath('themes/dark.json')],
		},
		version: 1 as const,
	};
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('private configuration', () => {
	it('returns undefined only when config.json is absent', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-config-');
		temporaryDirectories.push(root);

		await expect(readConfig(root)).resolves.toBeUndefined();
	});

	it('writes and reads a canonical, private configuration', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-config-');
		temporaryDirectories.push(root);
		const config = createConfig();

		await writeConfig(root, config);

		await expect(readConfig(root)).resolves.toEqual(config);
		const configPath = getPrivatePaths(root).configFile;
		expect((await stat(configPath)).isFile()).toBe(true);
		if (process.platform !== 'win32') {
			expect((await stat(configPath)).mode & 0o777).toBe(0o600);
		}
	});

	it('reads private configuration without mutating it', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-config-');
		temporaryDirectories.push(root);
		const config = createConfig();
		await writeConfig(root, config);
		const path = getPrivatePaths(root).configFile;
		const before = await stat(path);

		await expect(readConfig(root)).resolves.toEqual(config);
		const after = await stat(path);
		expect(after.mode).toBe(before.mode);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	it('persists the minimal pending package-operation queue', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-config-');
		temporaryDirectories.push(root);
		const config = {
			...createConfig(),
			pendingPackageOperations: [
				{ action: 'install' as const, source: 'npm:example-package@1.2.3' },
				{ action: 'remove' as const, source: 'git:github.com/example/obsolete-package@v1' },
			],
		};

		await writeConfig(root, config);

		await expect(readConfig(root)).resolves.toEqual(config);
	});

	it('persists scoped npm package retries without treating the scope as credentials', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-config-');
		temporaryDirectories.push(root);
		const config = {
			...createConfig(),
			pendingPackageOperations: [
				{ action: 'install' as const, source: 'npm:@scope/package@1.0.0' },
			],
		};

		await writeConfig(root, config);
		await expect(readConfig(root)).resolves.toEqual(config);
	});

	it('rejects malformed pending package-operation queues', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-config-');
		temporaryDirectories.push(root);

		await expect(
			writeConfig(root, {
				...createConfig(),
				pendingPackageOperations: [],
			}),
		).rejects.toThrow('Invalid plugin configuration');
	});

	it.each([
		{
			pendingPackageOperations: [
				{ action: 'install', source: 'npm:example-package', unexpected: true },
			],
		},
		{ pendingPackageOperations: [{ action: 'retry', source: 'npm:example-package' }] },
		{ pendingPackageOperations: [{ action: 'install', source: '' }] },
		{ pendingPackageOperations: [{ action: 'install', source: 'npm:\u0085example-package' }] },
		{
			pendingPackageOperations: [
				{ action: 'install', source: 'ssh://token@example.com/acme/private-package@v1' },
			],
		},
		{
			pendingPackageOperations: [
				{ action: 'install', source: 'git:alice:secret@example.com/acme/private-package@v1' },
			],
		},
		{
			pendingPackageOperations: [
				{ action: 'install', source: 'git:git@token@example.com:acme/private-package@v1' },
			],
		},
		{
			pendingPackageOperations: [{ action: 'install', source: 'file:///tmp/package?token=secret' }],
		},
		{
			pendingPackageOperations: [
				{
					action: 'install',
					source: 'npm:example@https://token@registry.example/package.tgz',
				},
			],
		},
		{ pendingPackageOperations: ['npm:example-package'] },
		{
			pendingPackageOperations: [
				{ action: 'install', source: 'npm:example-package' },
				{ action: 'install', source: 'npm:example-package' },
			],
		},
	])('rejects invalid pending package-operation entries', async ({ pendingPackageOperations }) => {
		const root = await createTemporaryDirectory('pi-sync-webdav-config-');
		temporaryDirectories.push(root);

		await expect(
			writeConfig(root, {
				...createConfig(),
				pendingPackageOperations,
			} as unknown as Parameters<typeof writeConfig>[1]),
		).rejects.toThrow('Invalid plugin configuration');
	});

	it('rejects malformed and unknown on-disk config fields without exposing secrets', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-config-');
		temporaryDirectories.push(root);
		const paths = getPrivatePaths(root);
		await mkdir(paths.directory, { recursive: true });
		await chmod(paths.directory, 0o700);
		await writeFile(paths.configFile, '{"password":"correct horse battery staple"}', 'utf8');
		await chmod(paths.configFile, 0o600);

		await expect(readConfig(root)).rejects.toThrow('Invalid plugin configuration');

		await writeFile(
			paths.configFile,
			JSON.stringify({ ...createConfig(), unexpected: true }),
			'utf8',
		);
		await chmod(paths.configFile, 0o600);
		await expect(readConfig(root)).rejects.toThrow('Invalid plugin configuration');
	});

	it('validates before replacing an existing configuration', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-config-');
		temporaryDirectories.push(root);
		const config = createConfig();
		await writeConfig(root, config);
		const previous = await readFile(getPrivatePaths(root).configFile, 'utf8');

		await expect(
			writeConfig(root, {
				...config,
				pushInclude: [parseManifestPath('themes/nested.json')],
			}),
		).rejects.toThrow('Invalid push include');
		expect(await readFile(getPrivatePaths(root).configFile, 'utf8')).toBe(previous);
	});

	it('rejects a symlinked private directory', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-config-');
		const external = await createTemporaryDirectory('pi-sync-webdav-external-');
		temporaryDirectories.push(root, external);
		const type = process.platform === 'win32' ? 'junction' : 'dir';
		await symlink(external, join(root, 'pi-sync-webdav'), type);

		await expect(writeConfig(root, createConfig())).rejects.toThrow(
			'Unsafe private configuration directory',
		);
	});

	it('uses a stable fingerprint for canonical equivalents and changes it with the connection identity', () => {
		const first = normalizeConnection({
			password: 'one',
			remotePath: 'backup/',
			url: 'https://example.com/dav',
			username: 'alice',
		});
		const equivalent = normalizeConnection({
			password: 'two',
			remotePath: 'backup',
			url: 'https://example.com/dav/',
			username: 'alice',
		});
		const changedUser = normalizeConnection({
			password: 'two',
			remotePath: 'backup',
			url: 'https://example.com/dav/',
			username: 'bob',
		});

		expect(connectionFingerprint(first)).toBe(connectionFingerprint(equivalent));
		expect(connectionFingerprint(first)).not.toBe(connectionFingerprint(changedUser));
	});
});
