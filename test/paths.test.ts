import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	assertSafeLocalTarget,
	encodeRemotePath,
	normalizeConnection,
	parseManifestPath,
	parsePushInclude,
	resolveLocalTarget,
} from '../src/paths.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('normalizeConnection', () => {
	it('canonicalizes a connection and records HTTP confirmation requirements', () => {
		const https = normalizeConnection({
			password: 'password',
			remotePath: 'pi-sync-webdav/',
			url: 'HTTPS://example.com/dav',
			username: 'alice',
		});
		const http = normalizeConnection({
			password: 'password',
			remotePath: 'backup',
			url: 'http://example.com/dav',
			username: 'alice',
		});

		expect(https).toMatchObject({
			requiresInsecureTransportConfirmation: false,
			remotePath: 'pi-sync-webdav',
			url: 'https://example.com/dav/',
		});
		expect(http.requiresInsecureTransportConfirmation).toBe(true);
	});

	it.each([
		'https://alice:password@example.com/dav',
		'https://example.com/dav?query=yes',
		'https://example.com/dav#fragment',
		'ftp://example.com/dav',
		'https://example.com/\u0000dav',
	])('rejects unsafe service URLs', (url) => {
		expect(() =>
			normalizeConnection({
				password: 'password',
				remotePath: 'backup',
				url,
				username: 'alice',
			}),
		).toThrow('Invalid WebDAV URL');
	});

	it.each([
		{ password: 'password', username: '' },
		{ password: '', username: 'alice' },
		{ password: 'password', username: 'alice:admin' },
		{ password: 'password', username: 'alice\nadmin' },
		{ password: 'password', username: 'alice\u0085admin' },
	])('rejects invalid Basic Auth credentials', ({ password, username }) => {
		expect(() =>
			normalizeConnection({
				password,
				remotePath: 'backup',
				url: 'https://example.com/dav',
				username,
			}),
		).toThrow();
	});

	it.each([
		'',
		'/backup',
		'backup//nested',
		'backup//',
		'.',
		'..',
		'backup\\nested',
		'backup/\u0000',
	])('rejects unsafe remote paths', (remotePath) => {
		expect(() =>
			normalizeConnection({
				password: 'password',
				remotePath,
				url: 'https://example.com/dav',
				username: 'alice',
			}),
		).toThrow('Invalid remote path');
	});
});

describe('safe relative paths', () => {
	it('accepts normal manifest paths but rejects unsafe and excluded paths', () => {
		expect(parseManifestPath('themes/dark.json')).toBe('themes/dark.json');
		expect(parseManifestPath('auth.json')).toBe('auth.json');

		for (const path of [
			'',
			'/settings.json',
			'C:/settings.json',
			'C:settings.json',
			'themes//dark.json',
			'../settings.json',
			'npm/pkg',
			'git/repo',
			'pi-sync-webdav/config.json',
			'themes/\u0085dark.json',
		]) {
			expect(() => parseManifestPath(path)).toThrow();
		}
	});

	it('limits push includes to one safe top-level path', () => {
		expect(parsePushInclude('themes')).toBe('themes');
		expect(() => parsePushInclude('themes/dark.json')).toThrow();
		expect(() => parsePushInclude('npm')).toThrow();
	});

	it('encodes every remote path segment independently', () => {
		const path = parseManifestPath('themes/a b%#?.json');

		expect(encodeRemotePath(path)).toBe('themes/a%20b%25%23%3F.json');
	});

	it('resolves targets beneath the configured agent root', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-paths-');
		temporaryDirectories.push(root);
		const relativePath = parseManifestPath('themes/dark.json');

		expect(resolveLocalTarget(root, relativePath)).toBe(join(root, 'themes', 'dark.json'));
		await mkdir(join(root, 'themes'));
		await expect(assertSafeLocalTarget(root, relativePath)).resolves.toBe(
			join(root, 'themes', 'dark.json'),
		);
	});

	it('rejects a symlinked parent instead of following it', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-paths-');
		const external = await createTemporaryDirectory('pi-sync-webdav-external-');
		temporaryDirectories.push(root, external);
		const type = process.platform === 'win32' ? 'junction' : 'dir';
		await symlink(external, join(root, 'themes'), type);

		await expect(
			assertSafeLocalTarget(root, parseManifestPath('themes/dark.json')),
		).rejects.toThrow('Unsafe local target');
	});

	it('rejects a symlinked agent root instead of following it', async () => {
		const container = await createTemporaryDirectory('pi-sync-webdav-container-');
		const root = await createTemporaryDirectory('pi-sync-webdav-root-');
		temporaryDirectories.push(container, root);
		const linkedRoot = join(container, 'linked-agent-root');
		const type = process.platform === 'win32' ? 'junction' : 'dir';
		await symlink(root, linkedRoot, type);

		await expect(
			assertSafeLocalTarget(linkedRoot, parseManifestPath('settings.json')),
		).rejects.toThrow('Unsafe local target');
	});
});
