import { createHash } from 'node:crypto';
import { chmod, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SyncState } from '../src/config.js';
import { generateRevisionId, validateManifest } from '../src/manifest.js';
import { parseManifestPath } from '../src/paths.js';
import { planPull, planPush } from '../src/sync-plan.js';
import type { CollectedLocalFile, LocalSelection } from '../src/selection.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers.js';

const temporaryDirectories: string[] = [];

function sha256(contents: Buffer): string {
	return createHash('sha256').update(contents).digest('hex');
}

function localFile(path: string, contents: string): CollectedLocalFile {
	const buffer = Buffer.from(contents, 'utf8');
	return {
		contents: buffer,
		path: parseManifestPath(path),
		sha256: sha256(buffer),
		size: buffer.byteLength,
	};
}

function localSelection(files: readonly CollectedLocalFile[]): LocalSelection {
	return {
		files,
		secretWarningPaths: [],
		skippedSymlinkPaths: [],
		totalBytes: files.reduce((total, file) => total + file.size, 0),
	};
}

function manifest(files: ReadonlyArray<{ path: string; contents: string }>) {
	return validateManifest({
		files: files.map((file) => {
			const contents = Buffer.from(file.contents, 'utf8');
			return { path: file.path, sha256: sha256(contents), size: contents.byteLength };
		}),
		revision: generateRevisionId(),
		version: 1,
	});
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('push planning', () => {
	it('compares the complete local snapshot with the current remote manifest', () => {
		const remoteManifest = manifest([
			{ contents: 'old', path: 'changed.json' },
			{ contents: 'removed', path: 'removed.json' },
		]);
		const plan = planPush({
			local: localSelection([localFile('added.json', 'added'), localFile('changed.json', 'new')]),
			remote: {
				bytes: Buffer.from('{}', 'utf8'),
				manifest: remoteManifest,
				sha256: 'a'.repeat(64),
			},
		});

		expect(plan.actions.map((action) => [action.path, action.action])).toEqual([
			['added.json', 'add'],
			['changed.json', 'update'],
			['removed.json', 'delete'],
		]);
		expect(plan.expectedRemoteManifestSha256).toBe('a'.repeat(64));
		expect(plan.nextManagedPaths).toEqual(['added.json', 'changed.json']);
	});

	it('rejects case-folding and file-versus-directory destination collisions', () => {
		expect(() =>
			planPush({
				local: localSelection([
					localFile('themes', 'file'),
					localFile('themes-dark', 'other'),
					localFile('Themes/dark.json', 'child'),
				]),
				remote: undefined,
			}),
		).toThrow('Local selection contains colliding destinations');
	});
});

describe('pull planning', () => {
	it('downloads every manifest file and only deletes matching-connection managed files', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-plan-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'settings.json'), 'same', 'utf8');
		await writeFile(join(root, 'old.json'), 'old', 'utf8');
		const remoteManifest = manifest([
			{ contents: 'same', path: 'settings.json' },
			{ contents: 'new', path: 'themes/new.json' },
		]);
		const syncState: SyncState = {
			connectionFingerprint: 'b'.repeat(64),
			managedPaths: [parseManifestPath('settings.json'), parseManifestPath('old.json')],
		};

		const matchingPlan = await planPull({
			agentRoot: root,
			connectionFingerprint: 'b'.repeat(64),
			manifest: remoteManifest,
			syncState,
		});
		const changedConnectionPlan = await planPull({
			agentRoot: root,
			connectionFingerprint: 'c'.repeat(64),
			manifest: remoteManifest,
			syncState,
		});
		const firstPullPlan = await planPull({
			agentRoot: root,
			connectionFingerprint: 'b'.repeat(64),
			manifest: remoteManifest,
			syncState: undefined,
		});

		expect(matchingPlan.downloads.map((file) => file.path)).toEqual([
			'settings.json',
			'themes/new.json',
		]);
		expect(matchingPlan.actions.map((action) => [action.path, action.action])).toEqual([
			['old.json', 'delete'],
			['themes/new.json', 'add'],
		]);
		expect(changedConnectionPlan.actions.map((action) => [action.path, action.action])).toEqual([
			['themes/new.json', 'add'],
		]);
		expect(firstPullPlan.actions.map((action) => [action.path, action.action])).toEqual([
			['themes/new.json', 'add'],
		]);
		expect(matchingPlan.nextManagedPaths).toEqual(['settings.json', 'themes/new.json']);
	});

	it('plans an explicit auth.json permission repair when matching content is not owner-only', async () => {
		if (process.platform === 'win32') {
			return;
		}
		const root = await createTemporaryDirectory('pi-sync-webdav-plan-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'auth.json'), 'private', 'utf8');
		await chmod(join(root, 'auth.json'), 0o644);
		const remoteManifest = manifest([{ contents: 'private', path: 'auth.json' }]);

		const insecurePlan = await planPull({
			agentRoot: root,
			connectionFingerprint: 'a'.repeat(64),
			manifest: remoteManifest,
			syncState: undefined,
		});
		expect(insecurePlan.actions.map((action) => [action.path, action.action])).toEqual([
			['auth.json', 'secure'],
		]);

		await chmod(join(root, 'auth.json'), 0o600);
		await expect(
			planPull({
				agentRoot: root,
				connectionFingerprint: 'a'.repeat(64),
				manifest: remoteManifest,
				syncState: undefined,
			}),
		).resolves.toMatchObject({ actions: [] });
	});

	it('plans auth.json permission repair on Windows even when matching contents have mode 0600', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-plan-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'auth.json'), 'private', 'utf8');
		await chmod(join(root, 'auth.json'), 0o600);
		const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
		if (originalPlatform === undefined) {
			throw new Error('Unable to inspect process platform');
		}
		Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
		try {
			await expect(
				planPull({
					agentRoot: root,
					connectionFingerprint: 'a'.repeat(64),
					manifest: manifest([{ contents: 'private', path: 'auth.json' }]),
					syncState: undefined,
				}),
			).resolves.toMatchObject({
				actions: [expect.objectContaining({ action: 'secure', path: 'auth.json' })],
			});
		} finally {
			Object.defineProperty(process, 'platform', originalPlatform);
		}
	});

	it('protects sync-state deletions from case-insensitive destination collisions', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-plan-');
		temporaryDirectories.push(root);
		const state: SyncState = {
			connectionFingerprint: 'a'.repeat(64),
			managedPaths: [parseManifestPath('Themes')],
		};

		await expect(
			planPull({
				agentRoot: root,
				caseInsensitiveDestination: true,
				connectionFingerprint: 'a'.repeat(64),
				manifest: manifest([{ contents: 'new', path: 'themes/new.json' }]),
				syncState: state,
			}),
		).rejects.toThrow('Managed paths collide with remote local destinations');
		await expect(
			planPull({
				agentRoot: root,
				caseInsensitiveDestination: true,
				connectionFingerprint: 'a'.repeat(64),
				manifest: manifest([{ contents: 'new', path: 'themes.json' }]),
				syncState: {
					connectionFingerprint: 'a'.repeat(64),
					managedPaths: [parseManifestPath('Themes.json')],
				},
			}),
		).rejects.toThrow('Managed paths collide with remote local destinations');
		await expect(
			planPull({
				agentRoot: root,
				caseInsensitiveDestination: true,
				connectionFingerprint: 'a'.repeat(64),
				manifest: manifest([]),
				syncState: {
					connectionFingerprint: 'a'.repeat(64),
					managedPaths: [parseManifestPath('Old.json'), parseManifestPath('old.json')],
				},
			}),
		).rejects.toThrow('Managed paths collide with remote local destinations');
	});

	it('repairs auth.json permissions when special permission bits are present', async () => {
		if (process.platform === 'win32') {
			return;
		}
		const root = await createTemporaryDirectory('pi-sync-webdav-plan-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'auth.json'), 'private', 'utf8');
		await chmod(join(root, 'auth.json'), 0o4600);

		await expect(
			planPull({
				agentRoot: root,
				connectionFingerprint: 'a'.repeat(64),
				manifest: manifest([{ contents: 'private', path: 'auth.json' }]),
				syncState: undefined,
			}),
		).resolves.toMatchObject({
			actions: [expect.objectContaining({ action: 'secure', path: 'auth.json' })],
		});
	});

	it('rejects oversized existing manifest and managed-deletion targets before reading them', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-plan-');
		temporaryDirectories.push(root);
		const largeFile = join(root, 'large.json');
		await writeFile(largeFile, '');
		await truncate(largeFile, 50 * 1024 * 1024 + 1);
		const remoteManifest = validateManifest({
			files: [{ path: 'large.json', sha256: 'a'.repeat(64), size: 0 }],
			revision: generateRevisionId(),
			version: 1,
		});

		await expect(
			planPull({
				agentRoot: root,
				connectionFingerprint: 'a'.repeat(64),
				manifest: remoteManifest,
				syncState: undefined,
			}),
		).rejects.toThrow('Local sync target exceeds the size limit');
		await expect(
			planPull({
				agentRoot: root,
				connectionFingerprint: 'a'.repeat(64),
				manifest: manifest([]),
				syncState: {
					connectionFingerprint: 'a'.repeat(64),
					managedPaths: [parseManifestPath('large.json')],
				},
			}),
		).rejects.toThrow('Local sync target exceeds the size limit');
	});

	it('rejects unsafe local target types', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-plan-');
		temporaryDirectories.push(root);

		await writeFile(join(root, 'themes'), 'not a directory', 'utf8');
		await expect(
			planPull({
				agentRoot: root,
				connectionFingerprint: 'a'.repeat(64),
				manifest: manifest([{ contents: 'new', path: 'themes/new.json' }]),
				syncState: undefined,
			}),
		).rejects.toThrow('Unsafe local target');
	});
});
