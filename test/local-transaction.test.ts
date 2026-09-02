import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	applyPullPlan,
	applyRestorePlan,
	createPullWorkspace,
	detectCaseInsensitiveDestination,
	disposePullWorkspace,
	listBackups,
	planRestore,
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
	return workspace;
}

async function writeBackups(
	root: string,
	files: ReadonlyArray<{ contents: string; path: string }>,
): Promise<void> {
	const backupsDirectory = join(root, 'pi-sync-webdav', 'backups');
	await mkdir(backupsDirectory, { mode: 0o700, recursive: true });
	for (const file of files) {
		await writeFile(join(backupsDirectory, file.path), file.contents, 'utf8');
	}
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

	it('detects destination case sensitivity without leaving probe files', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);

		const caseInsensitive = await detectCaseInsensitiveDestination(root);

		expect(caseInsensitive).toBe(process.platform === 'win32' || process.platform === 'darwin');
		expect(await readdir(join(root, 'pi-sync-webdav'))).toEqual([]);
	});

	it('removes directories emptied by managed deletions and keeps populated ones', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		await mkdir(join(root, 'gone'));
		await writeFile(join(root, 'gone', 'old.json'), 'old', 'utf8');
		await mkdir(join(root, 'kept'));
		await writeFile(join(root, 'kept', 'old.json'), 'old', 'utf8');
		await writeFile(join(root, 'kept', 'user.json'), 'user', 'utf8');
		const workspace = await createPullWorkspace(root);
		const plan: PullPlan = {
			actions: [
				{
					action: 'delete',
					expectedLocal: expected('old'),
					path: parseManifestPath('gone/old.json'),
					source: undefined,
				},
				{
					action: 'delete',
					expectedLocal: expected('old'),
					path: parseManifestPath('kept/old.json'),
					source: undefined,
				},
			],
			downloads: [],
			nextManagedPaths: [],
		};

		await expect(applyPullPlan(root, workspace, plan)).resolves.toEqual({ status: 'applied' });

		await expect(stat(join(root, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' });
		expect((await stat(join(root, 'kept'))).isDirectory()).toBe(true);
		expect(await readFile(join(root, 'kept', 'user.json'), 'utf8')).toBe('user');
		await disposePullWorkspace(root, workspace);
	});

	it('applies a case-renamed replacement after removing the managed old spelling', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'Themes.json'), 'old', 'utf8');
		const manifest = createManifest([{ contents: 'new', path: 'themes.json' }]);
		const workspace = await stageManifest(root, manifest, new Map([['themes.json', 'new']]));
		const plan: PullPlan = {
			actions: [
				{
					action: 'delete',
					expectedLocal: expected('old'),
					path: parseManifestPath('Themes.json'),
					source: undefined,
				},
				{
					action: 'add',
					expectedLocal: { kind: 'absent' },
					path: parseManifestPath('themes.json'),
					source: source(manifest, 'themes.json'),
				},
			],
			downloads: manifest.files,
			nextManagedPaths: manifest.files.map((file) => file.path),
		};

		await expect(applyPullPlan(root, workspace, plan)).resolves.toEqual({ status: 'applied' });
		expect(await readFile(join(root, 'themes.json'), 'utf8')).toBe('new');
		const backups = await listBackups(root);
		expect(backups.map((backup) => backup.path)).toEqual(['Themes.json']);
		expect(await readFile(join(root, 'pi-sync-webdav', 'backups', 'Themes.json'), 'utf8')).toBe(
			'old',
		);
		await disposePullWorkspace(root, workspace);
	});

	it('applies a directory-to-file replacement after removing emptied directories', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		await mkdir(join(root, 'assets'));
		await writeFile(join(root, 'assets', 'old.json'), 'old', 'utf8');
		const manifest = createManifest([{ contents: 'new', path: 'assets' }]);
		const workspace = await stageManifest(root, manifest, new Map([['assets', 'new']]));
		const plan: PullPlan = {
			actions: [
				{
					action: 'delete',
					expectedLocal: expected('old'),
					path: parseManifestPath('assets/old.json'),
					source: undefined,
				},
				{
					action: 'add',
					expectedLocal: { kind: 'absent' },
					path: parseManifestPath('assets'),
					source: source(manifest, 'assets'),
				},
			],
			downloads: manifest.files,
			nextManagedPaths: manifest.files.map((file) => file.path),
		};

		await expect(applyPullPlan(root, workspace, plan)).resolves.toEqual({ status: 'applied' });
		expect((await stat(join(root, 'assets'))).isFile()).toBe(true);
		expect(await readFile(join(root, 'assets'), 'utf8')).toBe('new');
		await disposePullWorkspace(root, workspace);
	});

	it('removes stale workspaces from interrupted pulls when creating a new one', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		const stale = await createPullWorkspace(root);
		const parent = join(root, 'pi-sync-webdav', 'workspace');
		await writeFile(join(parent, stale.id, 'partial.json'), '{}', 'utf8');
		const unrecognized = join(parent, 'keep-me');
		await mkdir(unrecognized);

		const workspace = await createPullWorkspace(root);

		await expect(stat(join(parent, stale.id))).rejects.toMatchObject({ code: 'ENOENT' });
		expect((await stat(unrecognized)).isDirectory()).toBe(true);
		expect((await stat(join(parent, workspace.id))).isDirectory()).toBe(true);
		await disposePullWorkspace(root, workspace);
	});

	it('removes the empty workspace parent directory after disposal', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		const workspace = await createPullWorkspace(root);
		const parent = join(root, 'pi-sync-webdav', 'workspace');

		await disposePullWorkspace(root, workspace);

		await expect(stat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('keeps the workspace parent directory while another workspace is staged', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		const first = await createPullWorkspace(root);
		const second = await createPullWorkspace(root);
		const parent = join(root, 'pi-sync-webdav', 'workspace');

		await disposePullWorkspace(root, first);

		expect((await stat(parent)).isDirectory()).toBe(true);
		await disposePullWorkspace(root, second);
		await expect(stat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('replaces the previous backup set when a later pull writes new backups', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		const backupsDirectory = join(root, 'pi-sync-webdav', 'backups');
		await writeFile(join(root, 'test.json'), 'old test', 'utf8');
		const firstManifest = createManifest([{ contents: 'new test', path: 'test.json' }]);
		const firstWorkspace = await stageManifest(
			root,
			firstManifest,
			new Map([['test.json', 'new test']]),
		);
		await applyPullPlan(root, firstWorkspace, {
			actions: [
				{
					action: 'update',
					expectedLocal: expected('old test'),
					path: parseManifestPath('test.json'),
					source: source(firstManifest, 'test.json'),
				},
			],
			downloads: firstManifest.files,
			nextManagedPaths: firstManifest.files.map((file) => file.path),
		});
		await disposePullWorkspace(root, firstWorkspace);
		expect(await readFile(join(backupsDirectory, 'test.json'), 'utf8')).toBe('old test');

		await rm(join(root, 'test.json'));
		await writeFile(join(root, 'test2.json'), 'old test2', 'utf8');
		const secondManifest = createManifest([{ contents: 'new test2', path: 'test2.json' }]);
		const secondWorkspace = await stageManifest(
			root,
			secondManifest,
			new Map([['test2.json', 'new test2']]),
		);
		await applyPullPlan(root, secondWorkspace, {
			actions: [
				{
					action: 'update',
					expectedLocal: expected('old test2'),
					path: parseManifestPath('test2.json'),
					source: source(secondManifest, 'test2.json'),
				},
			],
			downloads: secondManifest.files,
			nextManagedPaths: secondManifest.files.map((file) => file.path),
		});
		await disposePullWorkspace(root, secondWorkspace);

		expect(await readFile(join(backupsDirectory, 'test2.json'), 'utf8')).toBe('old test2');
		await expect(stat(join(backupsDirectory, 'test.json'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('keeps the previous backup set when a pull adds only new files', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		const backupsDirectory = join(root, 'pi-sync-webdav', 'backups');
		await writeFile(join(root, 'test.json'), 'old test', 'utf8');
		const firstManifest = createManifest([{ contents: 'new test', path: 'test.json' }]);
		const firstWorkspace = await stageManifest(
			root,
			firstManifest,
			new Map([['test.json', 'new test']]),
		);
		await applyPullPlan(root, firstWorkspace, {
			actions: [
				{
					action: 'update',
					expectedLocal: expected('old test'),
					path: parseManifestPath('test.json'),
					source: source(firstManifest, 'test.json'),
				},
			],
			downloads: firstManifest.files,
			nextManagedPaths: firstManifest.files.map((file) => file.path),
		});
		await disposePullWorkspace(root, firstWorkspace);

		const secondManifest = createManifest([{ contents: 'brand new', path: 'added.json' }]);
		const secondWorkspace = await stageManifest(
			root,
			secondManifest,
			new Map([['added.json', 'brand new']]),
		);
		await applyPullPlan(root, secondWorkspace, {
			actions: [
				{
					action: 'add',
					expectedLocal: { kind: 'absent' },
					path: parseManifestPath('added.json'),
					source: source(secondManifest, 'added.json'),
				},
			],
			downloads: secondManifest.files,
			nextManagedPaths: secondManifest.files.map((file) => file.path),
		});
		await disposePullWorkspace(root, secondWorkspace);

		expect(await readFile(join(backupsDirectory, 'test.json'), 'utf8')).toBe('old test');
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
		const workspace = await createPullWorkspace(root);
		const plan: PullPlan = {
			actions: [
				{
					action: 'secure',
					expectedLocal: expected('private'),
					path: parseManifestPath('auth.json'),
					source: source(manifest, 'auth.json'),
				},
			],
			downloads: [],
			nextManagedPaths: manifest.files.map((file) => file.path),
		};

		await expect(applyPullPlan(root, workspace, plan)).resolves.toEqual({ status: 'applied' });
		expect(await readFile(authPath, 'utf8')).toBe('private');
		expect((await stat(authPath)).mode & 0o777).toBe(0o600);
		await expect(listBackups(root)).resolves.toEqual([]);
		await disposePullWorkspace(root, workspace);
	});

	it('matches Pi permissions for added, updated, and restored regular files', async () => {
		if (process.platform === 'win32') {
			return;
		}
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		const existingPath = join(root, 'settings.json');
		const addedPath = join(root, 'added.json');
		await writeFile(existingPath, 'old settings', 'utf8');
		await chmod(existingPath, 0o640);
		const manifest = createManifest([
			{ contents: 'new settings', path: 'settings.json' },
			{ contents: 'added', path: 'added.json' },
		]);
		const workspace = await stageManifest(
			root,
			manifest,
			new Map([
				['settings.json', 'new settings'],
				['added.json', 'added'],
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
					path: parseManifestPath('added.json'),
					source: source(manifest, 'added.json'),
				},
			],
			downloads: manifest.files,
			nextManagedPaths: manifest.files.map((file) => file.path),
		};

		await expect(applyPullPlan(root, workspace, plan)).resolves.toEqual({ status: 'applied' });
		expect((await stat(existingPath)).mode & 0o777).toBe(0o640);
		expect((await stat(addedPath)).mode & 0o777).toBe(0o666 & ~process.umask());

		await chmod(existingPath, 0o600);
		const restorePlan = await planRestore(root, await listBackups(root));
		await expect(applyRestorePlan(root, restorePlan)).resolves.toEqual({ status: 'applied' });
		expect(await readFile(existingPath, 'utf8')).toBe('old settings');
		expect((await stat(existingPath)).mode & 0o777).toBe(0o600);
		await disposePullWorkspace(root, workspace);
	});

	it('rejects a changed workspace before mutating active files', async () => {
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
			'Pull workspace does not match the download plan',
		);
		await expect(readFile(join(root, 'settings.json'), 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('rolls back earlier mutations when a later target becomes unsafe', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		const settingsPath = join(root, 'settings.json');
		await writeFile(settingsPath, 'old settings', 'utf8');
		if (process.platform !== 'win32') {
			await chmod(settingsPath, 0o600);
		}
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

		await expect(applyPullPlan(root, workspace, plan)).resolves.toEqual({
			failureMessage: 'Unsafe local target',
			status: 'rolled-back',
		});
		expect(await readFile(settingsPath, 'utf8')).toBe('old settings');
		if (process.platform !== 'win32') {
			expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
		}
	});

	it('keeps the pull failure reason when rollback cannot complete', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'a.json'), 'old a', 'utf8');
		await writeFile(join(root, 'b.json'), 'old b', 'utf8');
		const manifest = createManifest([
			{ contents: 'new a', path: 'a.json' },
			{ contents: 'new b', path: 'b.json' },
		]);
		const workspace = await stageManifest(
			root,
			manifest,
			new Map([
				['a.json', 'new a'],
				['b.json', 'new b'],
			]),
		);
		const plan: PullPlan = {
			actions: [
				{
					action: 'update',
					expectedLocal: expected('old a'),
					path: parseManifestPath('a.json'),
					source: source(manifest, 'a.json'),
				},
				{
					action: 'update',
					expectedLocal: expected('old b'),
					path: parseManifestPath('b.json'),
					source: source(manifest, 'b.json'),
				},
			],
			downloads: manifest.files,
			nextManagedPaths: manifest.files.map((file) => file.path),
		};

		await expect(
			applyPullPlan(root, workspace, plan, {
				onProgress: (progress) => {
					if (progress.phase === 'applying' && progress.completed === 2) {
						unlinkSync(join(root, 'a.json'));
						mkdirSync(join(root, 'a.json'));
						writeFileSync(join(root, 'b.json'), 'changed b', 'utf8');
					}
				},
			}),
		).resolves.toEqual({ failureMessage: 'Local target changed', status: 'rollback-failed' });
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
		).resolves.toEqual({ failureMessage: 'Sync operation cancelled', status: 'failed' });
		await expect(readFile(join(root, 'settings.json'), 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});
		await disposePullWorkspace(root, workspace);
	});

	it('reports a restore failure when a local target changes after planning', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'settings.json'), 'current', 'utf8');
		await writeBackups(root, [{ contents: 'backup', path: 'settings.json' }]);
		const plan = await planRestore(root, await listBackups(root));
		await writeFile(join(root, 'settings.json'), 'changed after planning', 'utf8');

		await expect(applyRestorePlan(root, plan)).resolves.toEqual({
			failureMessage: 'Local target changed',
			status: 'failed',
		});
		expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe('changed after planning');
	});

	it('reports the restore failure reason after rolling back an earlier restore', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-transaction-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'a.json'), 'current a', 'utf8');
		await writeFile(join(root, 'b.json'), 'current b', 'utf8');
		await writeBackups(root, [
			{ contents: 'backup a', path: 'a.json' },
			{ contents: 'backup b', path: 'b.json' },
		]);
		const plan = await planRestore(root, await listBackups(root));
		await writeFile(join(root, 'b.json'), 'changed b', 'utf8');

		await expect(applyRestorePlan(root, plan)).resolves.toEqual({
			failureMessage: 'Local target changed',
			status: 'rolled-back',
		});
		expect(await readFile(join(root, 'a.json'), 'utf8')).toBe('current a');
		expect(await readFile(join(root, 'b.json'), 'utf8')).toBe('changed b');
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
