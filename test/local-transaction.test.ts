import { createHash } from 'node:crypto';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	applyPullPlan,
	applyRestorePlan,
	createPullWorkspace,
	disposePullWorkspace,
	listBackups,
	planRestore,
	sealPullWorkspace,
	stageVerifiedFile,
} from '../src/local-transaction.js';
import { generateRevisionId, validateManifest, type ManifestFile } from '../src/manifest.js';
import { parseManifestPath } from '../src/paths.js';
import type { PullPlan } from '../src/sync-plan.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers.js';

const temporaryDirectories: string[] = [];

function sha256(contents: Buffer): string {
	return createHash('sha256').update(contents).digest('hex');
}

function expected(contents: string) {
	const buffer = Buffer.from(contents, 'utf8');
	return { kind: 'file' as const, sha256: sha256(buffer), size: buffer.byteLength };
}

function createManifest(files: ReadonlyArray<{ contents: string; path: string }>) {
	return validateManifest({
		files: files.map((file) => {
			const contents = Buffer.from(file.contents, 'utf8');
			return { path: file.path, sha256: sha256(contents), size: contents.byteLength };
		}),
		revision: generateRevisionId(),
		version: 1,
	});
}

function source(manifest: ReturnType<typeof createManifest>, path: string): ManifestFile {
	const file = manifest.files.find((candidate) => candidate.path === path);
	if (file === undefined) {
		throw new Error(`Missing manifest test file: ${path}`);
	}
	return file;
}

async function stageManifest(
	root: string,
	manifest: ReturnType<typeof createManifest>,
	contents: ReadonlyMap<string, string>,
) {
	const workspace = await createPullWorkspace(root);
	for (const file of manifest.files) {
		const fileContents = contents.get(file.path);
		if (fileContents === undefined) {
			throw new Error(`Missing staged test contents: ${file.path}`);
		}
		await stageVerifiedFile(root, workspace, file, Buffer.from(fileContents, 'utf8'));
	}
	await sealPullWorkspace(root, workspace, manifest);
	return workspace;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('pull transaction', () => {
	it('lists no backups without creating private state', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);

		await expect(listBackups(root)).resolves.toEqual([]);
		await expect(
			readFile(join(root, 'pi-sync-webdav', 'config.json'), 'utf8'),
		).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('stages, verifies, applies, and backs up overwrite/delete mutations', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'settings.json'), 'old settings', 'utf8');
		await writeFile(join(root, 'old.json'), 'old file', 'utf8');
		await writeFile(join(root, 'auth.json'), 'old auth', 'utf8');
		const manifest = createManifest([
			{ contents: 'new settings', path: 'settings.json' },
			{ contents: 'new file', path: 'new.json' },
			{ contents: 'auth', path: 'auth.json' },
		]);
		const workspace = await stageManifest(
			root,
			manifest,
			new Map([
				['settings.json', 'new settings'],
				['new.json', 'new file'],
				['auth.json', 'auth'],
			]),
		);
		const plan: PullPlan = {
			actions: [
				{
					action: 'update',
					expectedLocal: expected('old settings'),
					path: parseManifestPath('settings.json'),
					source: source(manifest, 'settings.json'),
				},
				{
					action: 'add',
					expectedLocal: { kind: 'absent' },
					path: parseManifestPath('new.json'),
					source: source(manifest, 'new.json'),
				},
				{
					action: 'update',
					expectedLocal: expected('old auth'),
					path: parseManifestPath('auth.json'),
					source: source(manifest, 'auth.json'),
				},
				{
					action: 'delete',
					expectedLocal: expected('old file'),
					path: parseManifestPath('old.json'),
					source: undefined,
				},
			],
			downloads: manifest.files,
			nextManagedPaths: manifest.files.map((file) => file.path),
		};

		await expect(applyPullPlan(root, workspace, plan)).resolves.toEqual({ status: 'applied' });
		expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('new settings');
		expect(await readFile(join(root, 'new.json'), 'utf8')).toBe('new file');
		expect(await readFile(join(root, 'auth.json'), 'utf8')).toBe('auth');
		await expect(readFile(join(root, 'old.json'), 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});
		if (process.platform !== 'win32') {
			expect((await stat(join(root, 'auth.json'))).mode & 0o777).toBe(0o600);
		}
		const backups = await listBackups(root);
		expect(backups.map((backup) => backup.path)).toEqual([
			'auth.json',
			'old.json',
			'settings.json',
		]);
		expect(await readFile(join(root, 'pi-sync-webdav', 'backups', 'settings.json'), 'utf8')).toBe(
			'old settings',
		);

		const restorePlan = await planRestore(root, backups);
		await expect(applyRestorePlan(root, restorePlan)).resolves.toEqual({ status: 'applied' });
		expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('old settings');
		expect(await readFile(join(root, 'old.json'), 'utf8')).toBe('old file');
		expect(await readFile(join(root, 'auth.json'), 'utf8')).toBe('old auth');
		if (process.platform !== 'win32') {
			expect((await stat(join(root, 'auth.json'))).mode & 0o777).toBe(0o600);
		}
		expect(await readFile(join(root, 'new.json'), 'utf8')).toBe('new file');
		expect(await readFile(join(root, 'pi-sync-webdav', 'backups', 'settings.json'), 'utf8')).toBe(
			'old settings',
		);
		await disposePullWorkspace(root, workspace);
	});

	it('repairs auth.json permissions without rewriting matching contents or creating a backup', async () => {
		if (process.platform === 'win32') {
			return;
		}
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		const authPath = join(root, 'auth.json');
		await writeFile(authPath, 'private', 'utf8');
		await chmod(authPath, 0o644);
		const manifest = createManifest([{ contents: 'private', path: 'auth.json' }]);
		const workspace = await stageManifest(root, manifest, new Map([['auth.json', 'private']]));
		const plan: PullPlan = {
			actions: [
				{
					action: 'secure',
					expectedLocal: expected('private'),
					path: parseManifestPath('auth.json'),
					source: source(manifest, 'auth.json'),
				},
			],
			downloads: manifest.files,
			nextManagedPaths: manifest.files.map((file) => file.path),
		};

		await expect(applyPullPlan(root, workspace, plan)).resolves.toEqual({ status: 'applied' });
		expect(await readFile(authPath, 'utf8')).toBe('private');
		expect((await stat(authPath)).mode & 0o777).toBe(0o600);
		await expect(listBackups(root)).resolves.toEqual([]);
		await disposePullWorkspace(root, workspace);
	});

	it('rejects a workspace changed after sealing before mutating active files', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		const manifest = createManifest([{ contents: 'new settings', path: 'settings.json' }]);
		const workspace = await stageManifest(
			root,
			manifest,
			new Map([['settings.json', 'new settings']]),
		);
		await writeFile(
			join(root, 'pi-sync-webdav', 'workspace', workspace.id, 'unexpected.json'),
			'unexpected',
			'utf8',
		);
		const plan: PullPlan = {
			actions: [
				{
					action: 'add',
					expectedLocal: { kind: 'absent' },
					path: parseManifestPath('settings.json'),
					source: source(manifest, 'settings.json'),
				},
			],
			downloads: manifest.files,
			nextManagedPaths: manifest.files.map((file) => file.path),
		};

		await expect(applyPullPlan(root, workspace, plan)).rejects.toThrow(
			'Pull workspace does not match the manifest',
		);
		await expect(readFile(join(root, 'settings.json'), 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('rolls back earlier mutations when a later target becomes unsafe', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'settings.json'), 'old settings', 'utf8');
		await writeFile(join(root, 'blocked'), 'not a directory', 'utf8');
		const manifest = createManifest([
			{ contents: 'new settings', path: 'settings.json' },
			{ contents: 'blocked child', path: 'blocked/child.json' },
		]);
		const workspace = await stageManifest(
			root,
			manifest,
			new Map([
				['settings.json', 'new settings'],
				['blocked/child.json', 'blocked child'],
			]),
		);
		const plan: PullPlan = {
			actions: [
				{
					action: 'update',
					expectedLocal: expected('old settings'),
					path: parseManifestPath('settings.json'),
					source: source(manifest, 'settings.json'),
				},
				{
					action: 'add',
					expectedLocal: { kind: 'absent' },
					path: parseManifestPath('blocked/child.json'),
					source: source(manifest, 'blocked/child.json'),
				},
			],
			downloads: manifest.files,
			nextManagedPaths: manifest.files.map((file) => file.path),
		};

		await expect(applyPullPlan(root, workspace, plan)).resolves.toEqual({ status: 'rolled-back' });
		expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('old settings');
	});

	it('does not start a pull mutation when cancellation is requested by progress reporting', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		const manifest = createManifest([{ contents: 'new settings', path: 'settings.json' }]);
		const workspace = await stageManifest(
			root,
			manifest,
			new Map([['settings.json', 'new settings']]),
		);
		const plan: PullPlan = {
			actions: [
				{
					action: 'add',
					expectedLocal: { kind: 'absent' },
					path: parseManifestPath('settings.json'),
					source: source(manifest, 'settings.json'),
				},
			],
			downloads: manifest.files,
			nextManagedPaths: manifest.files.map((file) => file.path),
		};
		const controller = new AbortController();

		await expect(
			applyPullPlan(root, workspace, plan, {
				onProgress: () => controller.abort(),
				signal: controller.signal,
			}),
		).resolves.toEqual({ status: 'failed' });
		await expect(readFile(join(root, 'settings.json'), 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});
		await disposePullWorkspace(root, workspace);
	});

	it('rejects invalid staged bytes and reports no backups before the first pull', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		const manifest = createManifest([{ contents: 'expected', path: 'settings.json' }]);
		const workspace = await createPullWorkspace(root);

		await expect(
			stageVerifiedFile(
				root,
				workspace,
				source(manifest, 'settings.json'),
				Buffer.from('wrong', 'utf8'),
			),
		).rejects.toThrow('File contents failed integrity verification');
		await expect(listBackups(root)).resolves.toEqual([]);
	});
});
