import { chmod, mkdir, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MAX_FILE_BYTES } from '../src/manifest.js';
import { parsePushInclude } from '../src/paths.js';
import {
	collectLocalSelection,
	DEFAULT_PUSH_INCLUDES,
	listSelectionCandidates,
} from '../src/selection.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('selection candidates', () => {
	it('combines default entries with safe top-level candidates and excludes private/package paths', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-selection-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'settings.json'), '{}', 'utf8');
		await mkdir(join(root, 'themes'));
		await writeFile(join(root, 'auth.json'), '{}', 'utf8');
		await writeFile(join(root, 'custom.txt'), 'custom', 'utf8');
		await mkdir(join(root, 'npm'));
		await mkdir(join(root, 'git'));
		await mkdir(join(root, 'logs'));
		await mkdir(join(root, 'node_modules'));
		await mkdir(join(root, 'pi-sync-webdav'));
		await symlink(root, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

		const candidates = await listSelectionCandidates(root);
		const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));

		expect(DEFAULT_PUSH_INCLUDES.map(String)).toEqual([
			'settings.json',
			'keybindings.json',
			'AGENTS.md',
			'SYSTEM.md',
			'APPEND_SYSTEM.md',
			'models.json',
			'themes',
			'prompts',
			'skills',
			'extensions',
		]);
		expect(byPath.get(parsePushInclude('settings.json'))).toMatchObject({
			defaultSelected: true,
			type: 'file',
		});
		expect(byPath.get(parsePushInclude('SYSTEM.md'))).toMatchObject({
			defaultSelected: true,
			type: 'missing',
		});
		expect(byPath.get(parsePushInclude('auth.json'))).toMatchObject({ defaultSelected: false });
		expect(byPath.get(parsePushInclude('sessions'))).toMatchObject({
			defaultSelected: false,
			type: 'missing',
		});
		expect(byPath.has(parsePushInclude('custom.txt'))).toBe(true);
		expect([...byPath.keys()].map(String)).not.toContain('npm');
		expect([...byPath.keys()].map(String)).not.toContain('git');
		expect([...byPath.keys()].map(String)).not.toContain('logs');
		expect([...byPath.keys()].map(String)).not.toContain('node_modules');
		expect([...byPath.keys()].map(String)).not.toContain('pi-sync-webdav');
		expect([...byPath.keys()].map(String)).not.toContain('linked');
	});
});

describe('local selection collection', () => {
	it('captures immutable recursive snapshots, skips symlinks, and reports only warning paths', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-selection-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'settings.json'), '{"theme":"dark"}', 'utf8');
		await mkdir(join(root, 'themes'));
		await writeFile(
			join(root, 'themes', 'secret.txt'),
			'api_key = "abcdefghijklmnopqrstuvwxyz"',
			'utf8',
		);
		await writeFile(join(root, 'themes', 'binary.bin'), Buffer.from([0, 1, 2]));
		await mkdir(join(root, 'themes', '.git'));
		await writeFile(join(root, 'themes', '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
		await mkdir(join(root, 'themes', 'logs'));
		await writeFile(join(root, 'themes', 'logs', 'activity.txt'), 'log', 'utf8');
		await mkdir(join(root, 'themes', 'node_modules', 'package'), { recursive: true });
		await writeFile(
			join(root, 'themes', 'node_modules', 'package', 'index.js'),
			'export default {}',
			'utf8',
		);
		await symlink(
			root,
			join(root, 'themes', 'linked-root'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		const selection = await collectLocalSelection({
			agentRoot: root,
			includes: [parsePushInclude('themes'), parsePushInclude('settings.json')],
		});

		expect(selection.files.map((file) => file.path)).toEqual([
			'settings.json',
			'themes/.git/HEAD',
			'themes/binary.bin',
			'themes/secret.txt',
		]);
		expect(selection.secretWarningPaths).toEqual(['themes/secret.txt']);
		expect(selection.skippedSymlinkPaths).toEqual(['themes/linked-root']);
		expect(selection.totalBytes).toBe(
			selection.files.reduce((total, file) => total + file.contents.byteLength, 0),
		);
	});

	it('stops selection before scanning when cancelled', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-selection-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'settings.json'), '{}', 'utf8');
		const controller = new AbortController();
		controller.abort();

		await expect(
			collectLocalSelection({
				agentRoot: root,
				includes: [parsePushInclude('settings.json')],
				operation: { signal: controller.signal },
			}),
		).rejects.toThrow('Sync operation cancelled');
	});

	it('does not mutate auth.json permissions during a read-only selection', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-selection-');
		temporaryDirectories.push(root);
		const authFile = join(root, 'auth.json');
		await writeFile(authFile, '{"token":"private"}', 'utf8');
		await chmod(authFile, 0o644);

		await collectLocalSelection({
			agentRoot: root,
			includes: [parsePushInclude('auth.json')],
		});
		if (process.platform !== 'win32') {
			expect((await stat(authFile)).mode & 0o777).toBe(0o644);
		}
	});

	it('restores auth.json to owner-only permissions when preparing a push', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-selection-');
		temporaryDirectories.push(root);
		const authFile = join(root, 'auth.json');
		await writeFile(authFile, '{"token":"private"}', 'utf8');
		await chmod(authFile, 0o644);

		await collectLocalSelection({
			agentRoot: root,
			enforceAuthPermissions: true,
			includes: [parsePushInclude('auth.json')],
		});
		if (process.platform !== 'win32') {
			expect((await stat(authFile)).mode & 0o777).toBe(0o600);
		}
	});

	it('allows missing selected roots but rejects files over the configured limit', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-selection-');
		temporaryDirectories.push(root);
		await expect(
			collectLocalSelection({ agentRoot: root, includes: [parsePushInclude('themes')] }),
		).resolves.toMatchObject({ files: [], totalBytes: 0 });

		const largeFile = join(root, 'large.bin');
		await writeFile(largeFile, '');
		await truncate(largeFile, MAX_FILE_BYTES + 1);
		await expect(
			collectLocalSelection({ agentRoot: root, includes: [parsePushInclude('large.bin')] }),
		).rejects.toThrow('Selected file exceeds the size limit');
	});
});
