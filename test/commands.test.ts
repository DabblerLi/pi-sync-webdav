import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockWebDavServer } from './mock-webdav-server.js';

import { parseSyncWebdavCommand, registerSyncWebdavCommands } from '../src/commands.js';
import { connectionFingerprint, readConfig, writeConfig } from '../src/config.js';
import { generateRevisionId } from '../src/manifest.js';
import {
	parseRemotePath,
	normalizeConnection,
	parseManifestPath,
	parsePushInclude,
} from '../src/paths.js';
import { RemoteStore } from '../src/remote-store.js';
import { createWebDavGateway } from '../src/webdav.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers.js';

const temporaryDirectories: string[] = [];
const servers: MockWebDavServer[] = [];

interface CancellableTestComponent {
	abortController?: AbortController;
	dispose?(): void;
	onAbort?(): void;
}

type CancellableTestFactory<T> = (
	tui: { readonly requestRender: () => void },
	theme: { readonly fg: (color: string, value: string) => string },
	keybindings: unknown,
	done: (value: T) => void,
) => CancellableTestComponent;

function completeCancellableCustom<T>(factory: CancellableTestFactory<T>): Promise<T> {
	return new Promise<T>((resolve) => {
		const state: { component: CancellableTestComponent | undefined } = { component: undefined };
		state.component = factory(
			{ requestRender: vi.fn() },
			{ fg: (_color: string, value: string) => value },
			{},
			(value: T) => {
				state.component?.dispose?.();
				resolve(value);
			},
		);
	});
}

function cancelCancellableCustom<T>(factory: CancellableTestFactory<T>): Promise<T> {
	return new Promise<T>((resolve) => {
		const state: { component: CancellableTestComponent | undefined } = { component: undefined };
		state.component = factory(
			{ requestRender: vi.fn() },
			{ fg: (_color: string, value: string) => value },
			{},
			(value: T) => {
				state.component?.dispose?.();
				resolve(value);
			},
		);
		if (state.component.abortController === undefined) {
			throw new Error('Expected a cancellable loader');
		}
		state.component.abortController.abort();
		state.component.onAbort?.();
	});
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('sync command parsing', () => {
	it.each([
		['', 'dashboard'],
		['  status  ', 'status'],
		['diff', 'diff'],
		['settings', 'settings'],
		['setup', undefined],
		['settings now', undefined],
		['unknown', undefined],
	])('parses %j as %j', (args, expected) => {
		expect(parseSyncWebdavCommand(args)).toBe(expected);
	});
});

describe('sync command registration', () => {
	it('registers /sync-webdav with subcommand completion and blocks mutations outside TUI mode', async () => {
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		const pi = {
			registerCommand: vi.fn(
				(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
					registered = options;
				},
			),
		} as unknown as ExtensionAPI;
		registerSyncWebdavCommands(pi, () => '/not-used');

		expect(pi.registerCommand).toHaveBeenCalledWith('sync-webdav', expect.any(Object));
		expect(registered?.getArgumentCompletions?.('p')).toEqual([
			{ label: 'push', value: 'push' },
			{ label: 'pull', value: 'pull' },
		]);
		for (const command of ['settings', 'push', 'pull', 'restore']) {
			const notify = vi.fn();
			await registered?.handler(command, {
				mode: 'print',
				ui: { notify },
			} as unknown as ExtensionCommandContext);
			expect(notify).toHaveBeenCalledWith('This action requires an interactive terminal.', 'error');
		}
		const statusNotify = vi.fn();
		await registered?.handler('status', {
			mode: 'print',
			ui: { notify: statusNotify },
		} as unknown as ExtensionCommandContext);
		expect(statusNotify).not.toHaveBeenCalledWith(
			'This action requires an interactive terminal.',
			'error',
		);
	});

	it('starts initial configuration from the dashboard when no configuration exists', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const server = await MockWebDavServer.create();
		servers.push(server);
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		const pi = {
			registerCommand: vi.fn(
				(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
					registered = options;
				},
			),
		} as unknown as ExtensionAPI;
		registerSyncWebdavCommands(pi, () => root);
		const select = vi.fn();

		await registered?.handler('', {
			mode: 'tui',
			ui: {
				confirm: vi.fn().mockResolvedValue(true),
				custom: vi
					.fn()
					.mockResolvedValueOnce('password')
					.mockImplementationOnce(completeCancellableCustom)
					.mockResolvedValueOnce([parsePushInclude('settings.json')])
					.mockImplementationOnce(completeCancellableCustom),
				input: vi
					.fn()
					.mockResolvedValueOnce(server.baseUrl)
					.mockResolvedValueOnce('pi-sync-webdav')
					.mockResolvedValueOnce('alice'),
				notify: vi.fn(),
				select,
			},
		} as unknown as ExtensionCommandContext);

		expect(select).not.toHaveBeenCalled();
		expect(await readConfig(root)).toMatchObject({
			connection: { password: 'password', username: 'alice' },
			pushInclude: [parsePushInclude('settings.json')],
		});
	});

	it('does not save initial configuration when connection validation is cancelled', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const server = await MockWebDavServer.create();
		servers.push(server);
		server.delayNext('PROPFIND', 'pi-sync-webdav', 50);
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		registerSyncWebdavCommands(
			{
				registerCommand: vi.fn(
					(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
						registered = options;
					},
				),
			} as unknown as ExtensionAPI,
			() => root,
		);
		const notify = vi.fn();

		await registered?.handler('', {
			mode: 'tui',
			ui: {
				confirm: vi.fn().mockResolvedValue(true),
				custom: vi
					.fn()
					.mockResolvedValueOnce('password')
					.mockImplementationOnce(completeCancellableCustom)
					.mockResolvedValueOnce([parsePushInclude('settings.json')])
					.mockImplementationOnce(cancelCancellableCustom),
				input: vi
					.fn()
					.mockResolvedValueOnce(server.baseUrl)
					.mockResolvedValueOnce('pi-sync-webdav')
					.mockResolvedValueOnce('alice'),
				notify,
				select: vi.fn(),
			},
		} as unknown as ExtensionCommandContext);

		expect(await readConfig(root)).toBeUndefined();
		expect(notify).toHaveBeenCalledWith('Connection validation cancelled.', 'info');
	});

	it('updates push selection locally through settings without requesting connection input', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const server = await MockWebDavServer.create();
		servers.push(server);
		const connection = normalizeConnection({
			password: 'password',
			remotePath: 'pi-sync-webdav',
			url: server.baseUrl,
			username: 'alice',
		});
		await writeConfig(root, {
			connection: { ...connection, readOnly: false },
			pushInclude: [parsePushInclude('settings.json')],
			version: 1,
		});
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		const pi = {
			registerCommand: vi.fn(
				(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
					registered = options;
				},
			),
		} as unknown as ExtensionAPI;
		registerSyncWebdavCommands(pi, () => root);
		const input = vi.fn();
		const select = vi
			.fn()
			.mockResolvedValueOnce('settings')
			.mockResolvedValueOnce('Push selection')
			.mockResolvedValueOnce('Cancel');
		const custom = vi
			.fn()
			.mockImplementationOnce(completeCancellableCustom)
			.mockResolvedValue([parsePushInclude('AGENTS.md')]);
		const notify = vi.fn();

		await registered?.handler('', {
			mode: 'tui',
			ui: { confirm: vi.fn().mockResolvedValue(true), custom, input, notify, select },
		} as unknown as ExtensionCommandContext);

		expect(input).not.toHaveBeenCalled();
		expect(server.requests).toEqual([]);
		expect(await readConfig(root)).toMatchObject({
			pushInclude: [parsePushInclude('AGENTS.md')],
		});
		expect(notify).toHaveBeenCalledWith('Push selection saved.', 'info');
	});

	it('validates and saves a complete connection without publishing configuration', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const server = await MockWebDavServer.create('bob', 'new-password');
		servers.push(server);
		const existingConnection = normalizeConnection({
			password: 'old-password',
			remotePath: 'old-root',
			url: server.baseUrl,
			username: 'alice',
		});
		await writeConfig(root, {
			connection: { ...existingConnection, readOnly: false },
			pushInclude: [parsePushInclude('settings.json')],
			syncState: {
				connectionFingerprint: 'a'.repeat(64),
				managedPaths: [parseManifestPath('settings.json')],
			},
			version: 1,
		});
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		const pi = {
			registerCommand: vi.fn(
				(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
					registered = options;
				},
			),
		} as unknown as ExtensionAPI;
		registerSyncWebdavCommands(pi, () => root);
		const select = vi
			.fn()
			.mockResolvedValueOnce('settings')
			.mockResolvedValueOnce('Connection')
			.mockResolvedValueOnce('Change password')
			.mockResolvedValueOnce('Cancel');
		const input = vi
			.fn()
			.mockResolvedValueOnce(server.baseUrl)
			.mockResolvedValueOnce('new-root')
			.mockResolvedValueOnce('bob');

		await registered?.handler('', {
			mode: 'tui',
			ui: {
				confirm: vi.fn().mockResolvedValue(true),
				custom: vi
					.fn()
					.mockResolvedValueOnce('new-password')
					.mockImplementationOnce(completeCancellableCustom),
				input,
				notify: vi.fn(),
				select,
			},
		} as unknown as ExtensionCommandContext);

		const saved = await readConfig(root);
		expect(saved?.connection).toMatchObject({
			password: 'new-password',
			remotePath: 'new-root',
			url: server.baseUrl,
			username: 'bob',
		});
		expect(saved).not.toHaveProperty('syncState');
		expect(
			server.requests.some(
				(request) => request.method === 'PUT' && request.pathname.includes('/manifest.json'),
			),
		).toBe(false);
		expect(server.requests.some((request) => request.pathname.includes('/revisions/'))).toBe(false);
	});

	it('does not alter saved configuration when connection validation fails', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const server = await MockWebDavServer.create();
		servers.push(server);
		const existingConnection = normalizeConnection({
			password: 'password',
			remotePath: 'sync-root',
			url: server.baseUrl,
			username: 'alice',
		});
		const existing = {
			connection: { ...existingConnection, readOnly: false },
			pushInclude: [parsePushInclude('settings.json')],
			syncState: {
				connectionFingerprint: connectionFingerprint(existingConnection),
				managedPaths: [parseManifestPath('settings.json')],
			},
			version: 1 as const,
		};
		await writeConfig(root, existing);
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		const pi = {
			registerCommand: vi.fn(
				(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
					registered = options;
				},
			),
		} as unknown as ExtensionAPI;
		registerSyncWebdavCommands(pi, () => root);
		const notify = vi.fn();

		await registered?.handler('', {
			mode: 'tui',
			ui: {
				confirm: vi.fn().mockResolvedValue(true),
				custom: vi.fn().mockImplementationOnce(completeCancellableCustom),
				input: vi
					.fn()
					.mockResolvedValueOnce(server.baseUrl)
					.mockResolvedValueOnce('new-root')
					.mockResolvedValueOnce('bob'),
				notify,
				select: vi
					.fn()
					.mockResolvedValueOnce('settings')
					.mockResolvedValueOnce('Connection')
					.mockResolvedValueOnce('Keep current password'),
			},
		} as unknown as ExtensionCommandContext);

		expect(await readConfig(root)).toEqual(existing);
		expect(notify).toHaveBeenCalledWith(expect.any(String), 'error');
	});

	it('keeps sync state when only the password changes', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const server = await MockWebDavServer.create('alice', 'new-password');
		servers.push(server);
		const existingConnection = normalizeConnection({
			password: 'old-password',
			remotePath: 'sync-root',
			url: server.baseUrl,
			username: 'alice',
		});
		const syncState = {
			connectionFingerprint: connectionFingerprint(existingConnection),
			managedPaths: [parseManifestPath('settings.json')],
		};
		await writeConfig(root, {
			connection: { ...existingConnection, readOnly: false },
			pushInclude: [parsePushInclude('settings.json')],
			syncState,
			version: 1,
		});
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		const pi = {
			registerCommand: vi.fn(
				(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
					registered = options;
				},
			),
		} as unknown as ExtensionAPI;
		registerSyncWebdavCommands(pi, () => root);
		const select = vi
			.fn()
			.mockResolvedValueOnce('settings')
			.mockResolvedValueOnce('Connection')
			.mockResolvedValueOnce('Change password')
			.mockResolvedValueOnce('Cancel');

		await registered?.handler('', {
			mode: 'tui',
			ui: {
				confirm: vi.fn().mockResolvedValue(true),
				custom: vi
					.fn()
					.mockResolvedValueOnce('new-password')
					.mockImplementationOnce(completeCancellableCustom),
				input: vi
					.fn()
					.mockResolvedValueOnce(server.baseUrl)
					.mockResolvedValueOnce('sync-root')
					.mockResolvedValueOnce('alice'),
				notify: vi.fn(),
				select,
			},
		} as unknown as ExtensionCommandContext);

		expect(await readConfig(root)).toMatchObject({
			connection: { password: 'new-password' },
			syncState,
		});
	});

	it('reports remote readability without changing configuration', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const server = await MockWebDavServer.create();
		servers.push(server);
		const connection = normalizeConnection({
			password: 'password',
			remotePath: 'sync-root',
			url: server.baseUrl,
			username: 'alice',
		});
		await writeConfig(root, {
			connection: { ...connection, readOnly: false },
			pushInclude: [parsePushInclude('settings.json')],
			version: 1,
		});
		const gateway = createWebDavGateway(connection);
		const store = new RemoteStore(gateway, parseRemotePath(connection.remotePath));
		await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [],
		});
		server.requests.splice(0);
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		registerSyncWebdavCommands(
			{
				registerCommand: vi.fn(
					(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
						registered = options;
					},
				),
			} as unknown as ExtensionAPI,
			() => root,
		);
		const notify = vi.fn();

		await registered?.handler('status', {
			mode: 'print',
			ui: { notify },
		} as unknown as ExtensionCommandContext);

		expect(notify).toHaveBeenCalledWith(
			'Remote status: managed; read access available; manifest available.',
			'info',
		);
		expect(server.requests).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ pathname: expect.stringContaining('/revisions/') }),
			]),
		);
		expect(await readConfig(root)).toMatchObject({ connection: { password: 'password' } });
	});

	it('reports a status read failure without exposing remote details or changing configuration', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const server = await MockWebDavServer.create();
		servers.push(server);
		const connection = normalizeConnection({
			password: 'password',
			remotePath: 'sync-root',
			url: server.baseUrl,
			username: 'alice',
		});
		const config = {
			connection: { ...connection, readOnly: false },
			pushInclude: [parsePushInclude('settings.json')],
			version: 1 as const,
		};
		await writeConfig(root, config);
		const store = new RemoteStore(
			createWebDavGateway(connection),
			parseRemotePath(connection.remotePath),
		);
		await store.ensureRoot();
		server.failNext('GET', 'sync-root/manifest.json', 403);
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		registerSyncWebdavCommands(
			{
				registerCommand: vi.fn(
					(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
						registered = options;
					},
				),
			} as unknown as ExtensionAPI,
			() => root,
		);
		const notify = vi.fn();

		await registered?.handler('status', {
			mode: 'print',
			ui: { notify },
		} as unknown as ExtensionCommandContext);

		expect(notify).toHaveBeenCalledWith('WebDAV authorization failed', 'error');
		expect(await readConfig(root)).toEqual(config);
	});

	it('does not save a connection when the remote cannot be read', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const server = await MockWebDavServer.create('bob', 'new-password');
		servers.push(server);
		const oldConnection = normalizeConnection({
			password: 'old-password',
			remotePath: 'old-root',
			url: server.baseUrl,
			username: 'alice',
		});
		const existing = {
			connection: { ...oldConnection, readOnly: false },
			pushInclude: [parsePushInclude('settings.json')],
			version: 1 as const,
		};
		await writeConfig(root, existing);
		const nextConnection = normalizeConnection({
			password: 'new-password',
			remotePath: 'new-root',
			url: server.baseUrl,
			username: 'bob',
		});
		const gateway = createWebDavGateway(nextConnection);
		const store = new RemoteStore(gateway, parseRemotePath(nextConnection.remotePath));
		await store.ensureRoot();
		server.failNext('GET', 'new-root/manifest.json', 403);
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		registerSyncWebdavCommands(
			{
				registerCommand: vi.fn(
					(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
						registered = options;
					},
				),
			} as unknown as ExtensionAPI,
			() => root,
		);
		const notify = vi.fn();

		await registered?.handler('', {
			mode: 'tui',
			ui: {
				confirm: vi.fn().mockResolvedValue(true),
				custom: vi
					.fn()
					.mockResolvedValueOnce('new-password')
					.mockImplementationOnce(completeCancellableCustom),
				input: vi
					.fn()
					.mockResolvedValueOnce(server.baseUrl)
					.mockResolvedValueOnce('new-root')
					.mockResolvedValueOnce('bob'),
				notify,
				select: vi
					.fn()
					.mockResolvedValueOnce('settings')
					.mockResolvedValueOnce('Connection')
					.mockResolvedValueOnce('Change password')
					.mockResolvedValueOnce('Cancel'),
			},
		} as unknown as ExtensionCommandContext);

		expect(await readConfig(root)).toEqual(existing);
		expect(notify).toHaveBeenCalledWith('WebDAV authorization failed', 'error');
	});

	it('requires review confirmation before saving a changed push selection', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const server = await MockWebDavServer.create();
		servers.push(server);
		const connection = normalizeConnection({
			password: 'password',
			remotePath: 'sync-root',
			url: server.baseUrl,
			username: 'alice',
		});
		await writeConfig(root, {
			connection: { ...connection, readOnly: false },
			pushInclude: [parsePushInclude('settings.json')],
			version: 1,
		});
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		registerSyncWebdavCommands(
			{
				registerCommand: vi.fn(
					(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
						registered = options;
					},
				),
			} as unknown as ExtensionAPI,
			() => root,
		);
		const confirm = vi.fn().mockResolvedValue(false);

		await registered?.handler('', {
			mode: 'tui',
			ui: {
				confirm,
				custom: vi
					.fn()
					.mockImplementationOnce(completeCancellableCustom)
					.mockResolvedValue([parsePushInclude('AGENTS.md')]),
				input: vi.fn(),
				notify: vi.fn(),
				select: vi
					.fn()
					.mockResolvedValueOnce('settings')
					.mockResolvedValueOnce('Push selection')
					.mockResolvedValueOnce('Cancel'),
			},
		} as unknown as ExtensionCommandContext);

		expect(confirm).toHaveBeenCalledWith('Save push selection?', 'INCLUDE AGENTS.md');
		expect(await readConfig(root)).toMatchObject({
			pushInclude: [parsePushInclude('settings.json')],
		});
		expect(server.requests).toEqual([]);
	});

	it('cleans only verified remote residue from the dashboard after confirmation', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const server = await MockWebDavServer.create();
		servers.push(server);
		const connection = normalizeConnection({
			password: 'password',
			remotePath: 'sync-root',
			url: server.baseUrl,
			username: 'alice',
		});
		await writeConfig(root, {
			connection: { ...connection, readOnly: false },
			pushInclude: [parsePushInclude('settings.json')],
			version: 1,
		});
		const gateway = createWebDavGateway(connection);
		const store = new RemoteStore(gateway, parseRemotePath(connection.remotePath));
		await store.ensureRoot();
		const active = await store.publishRevision({
			allowUnverifiedManifest: false,
			expectedManifestSha256: undefined,
			files: [],
		});
		const staleRevision = generateRevisionId();
		await gateway.createDirectory(parseRemotePath(`sync-root/revisions/${staleRevision}`));
		await gateway.createDirectory(
			parseRemotePath(`sync-root/.pi-sync-webdav-probe-${generateRevisionId()}`),
		);
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		registerSyncWebdavCommands(
			{
				registerCommand: vi.fn(
					(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
						registered = options;
					},
				),
			} as unknown as ExtensionAPI,
			() => root,
		);
		const notify = vi.fn();

		await registered?.handler('', {
			mode: 'tui',
			ui: {
				confirm: vi.fn().mockResolvedValue(true),
				custom: vi
					.fn()
					.mockImplementationOnce(completeCancellableCustom)
					.mockImplementationOnce(completeCancellableCustom),
				notify,
				select: vi.fn().mockResolvedValue('Clean remote residue'),
			},
		} as unknown as ExtensionCommandContext);

		expect(active.manifest.revision).not.toBe(staleRevision);
		expect((await store.inspectResidue()).candidates).toEqual([]);
		expect(await readConfig(root)).toMatchObject({
			connection: { password: 'password' },
			pushInclude: [parsePushInclude('settings.json')],
		});
		expect(notify).toHaveBeenCalledWith('Remote residue cleaned.', 'info');
	});

	it('warns about privacy and size before including sessions', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const connection = normalizeConnection({
			password: 'password',
			remotePath: 'sync-root',
			url: 'https://example.com/dav',
			username: 'alice',
		});
		await writeConfig(root, {
			connection: { ...connection, readOnly: true },
			pushInclude: [parsePushInclude('sessions')],
			version: 1,
		});
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		registerSyncWebdavCommands(
			{
				registerCommand: vi.fn(
					(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
						registered = options;
					},
				),
			} as unknown as ExtensionAPI,
			() => root,
		);
		const confirm = vi.fn().mockResolvedValue(false);

		await registered?.handler('push', {
			mode: 'tui',
			ui: { confirm, notify: vi.fn() },
		} as unknown as ExtensionCommandContext);

		expect(confirm).toHaveBeenCalledWith(
			'Include sessions?',
			'Session data may contain private conversation content and can be large. Continue?',
		);
	});

	it('persists read-only capability by hiding push from the dashboard and rejecting it directly', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-commands-');
		temporaryDirectories.push(root);
		const connection = normalizeConnection({
			password: 'password',
			remotePath: 'pi-sync-webdav',
			url: 'https://example.com/dav',
			username: 'alice',
		});
		await writeConfig(root, {
			connection: { ...connection, readOnly: true },
			pushInclude: [parsePushInclude('settings.json')],
			version: 1,
		});
		let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
		const pi = {
			registerCommand: vi.fn(
				(_name: string, options: Parameters<ExtensionAPI['registerCommand']>[1]) => {
					registered = options;
				},
			),
		} as unknown as ExtensionAPI;
		registerSyncWebdavCommands(pi, () => root);
		const select = vi.fn().mockResolvedValue('cancel');
		const notify = vi.fn();

		await registered?.handler('', {
			mode: 'tui',
			ui: { notify, select },
		} as unknown as ExtensionCommandContext);
		expect(select).toHaveBeenCalledWith(
			'WebDAV sync',
			expect.not.arrayContaining(['push', 'Clean remote residue']),
		);

		await registered?.handler('push', {
			mode: 'tui',
			ui: { notify, select },
		} as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenCalledWith(
			'Push is unavailable because the remote connection is read-only.',
			'warning',
		);
	});
});
