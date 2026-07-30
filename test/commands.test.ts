import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseSyncWebdavCommand, registerSyncWebdavCommands } from '../src/commands.js';
import { writeConfig } from '../src/config.js';
import { normalizeConnection, parsePushInclude } from '../src/paths.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('sync command parsing', () => {
	it.each([
		['', 'dashboard'],
		['  status  ', 'status'],
		['diff', 'diff'],
		['setup now', undefined],
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
		for (const command of ['setup', 'push', 'pull', 'restore']) {
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
		expect(select).toHaveBeenCalledWith('WebDAV sync', expect.not.arrayContaining(['push']));

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
