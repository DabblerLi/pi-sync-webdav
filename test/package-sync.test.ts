import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SettingsManager, type PackageSource } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';

import {
	applyPackageOperations,
	createGlobalPackageSyncRuntime,
	planPackageSync,
	readGlobalPackageSources,
} from '../src/package-sync.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('package synchronization planning', () => {
	it('plans additions, removals, and source changes by package identity', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-package-sync-');
		temporaryDirectories.push(root);
		const before: PackageSource[] = [
			'npm:removed',
			'npm:@acme/theme@1.0.0',
			'git:github.com/acme/plugin@v1',
			{ extensions: ['extensions/current.ts'], source: 'npm:filtered' },
		];
		const after: PackageSource[] = [
			'npm:added',
			'npm:@acme/theme@2.0.0',
			'git:github.com/acme/plugin@v2',
			{ extensions: [], source: 'npm:filtered' },
		];

		await expect(planPackageSync({ after, agentRoot: root, before })).resolves.toEqual({
			operations: [
				{ action: 'remove', source: 'npm:removed' },
				{ action: 'update', source: 'git:github.com/acme/plugin@v2' },
				{ action: 'update', source: 'npm:@acme/theme@2.0.0' },
				{ action: 'install', source: 'npm:added' },
			],
		});
	});

	it('updates a Git package when its transport changes', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-package-sync-');
		temporaryDirectories.push(root);

		await expect(
			planPackageSync({
				after: ['https://github.com/acme/plugin@v2'],
				agentRoot: root,
				before: ['git:git@github.com:acme/plugin@v1'],
			}),
		).resolves.toEqual({
			operations: [{ action: 'update', source: 'https://github.com/acme/plugin@v2' }],
		});
	});

	it('reconciles supported Git protocol and hosted shorthand sources by repository and ref', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-package-sync-');
		temporaryDirectories.push(root);

		await expect(
			planPackageSync({
				after: ['git:git://example.com/acme/plugin@v2'],
				agentRoot: root,
				before: ['git:git://example.com/acme/plugin@v1'],
			}),
		).resolves.toEqual({
			operations: [{ action: 'update', source: 'git:git://example.com/acme/plugin@v2' }],
		});
		await expect(
			planPackageSync({
				after: ['ssh://git@example.com/acme/plugin@v2'],
				agentRoot: root,
				before: ['ssh://git@example.com/acme/plugin@v1'],
			}),
		).resolves.toEqual({
			operations: [{ action: 'update', source: 'ssh://git@example.com/acme/plugin@v2' }],
		});

		await expect(
			planPackageSync({
				after: ['git:github:acme/plugin#v2', 'git:gitlab:acme/other#v1'],
				agentRoot: root,
				before: ['git:github:acme/plugin#v1'],
			}),
		).resolves.toEqual({
			operations: [
				{ action: 'update', source: 'git:github:acme/plugin#v2' },
				{ action: 'install', source: 'git:gitlab:acme/other#v1' },
			],
		});
	});

	it('requires desired local package paths to exist', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-package-sync-');
		temporaryDirectories.push(root);
		await mkdir(join(root, 'local-package'));

		await expect(
			planPackageSync({ after: ['./local-package'], agentRoot: root, before: [] }),
		).resolves.toEqual({
			operations: [{ action: 'install', source: './local-package' }],
		});
		await expect(
			planPackageSync({ after: ['./missing-package'], agentRoot: root, before: [] }),
		).rejects.toThrow('A local Pi package path does not exist');
	});

	it('rejects ambiguous sources and duplicate identities', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-package-sync-');
		temporaryDirectories.push(root);

		const credentialedSource = 'https://token@example.com/acme/plugin@v1';
		const credentialedPlan = planPackageSync({
			after: [credentialedSource],
			agentRoot: root,
			before: [],
		});
		await expect(credentialedPlan).rejects.toThrow('Invalid Pi package source');
		await credentialedPlan.catch((error: unknown) => {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).not.toContain('token');
		});
		await expect(
			planPackageSync({
				after: ['ssh://token@example.com/acme/plugin@v1'],
				agentRoot: root,
				before: [],
			}),
		).rejects.toThrow('Invalid Pi package source');
		await expect(
			planPackageSync({
				after: ['git:alice:secret@example.com/acme/plugin@v1'],
				agentRoot: root,
				before: [],
			}),
		).rejects.toThrow('Invalid Pi package source');
		await expect(
			planPackageSync({
				after: ['https://example.com/%2e%2e/plugin'],
				agentRoot: root,
				before: [],
			}),
		).rejects.toThrow('Invalid Pi package source');
		await expect(
			planPackageSync({
				after: ['file:///tmp/package?token=secret'],
				agentRoot: root,
				before: [],
			}),
		).rejects.toThrow('Invalid Pi package source');
		const npmCredentialedPlan = planPackageSync({
			after: ['npm:example@https://token@registry.example/package.tgz'],
			agentRoot: root,
			before: [],
		});
		await expect(npmCredentialedPlan).rejects.toThrow('Invalid Pi package source');
		await npmCredentialedPlan.catch((error: unknown) => {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).not.toContain('token');
		});
		await expect(
			planPackageSync({
				after: ['git://example.com/acme/plugin@v1'],
				agentRoot: root,
				before: [],
			}),
		).rejects.toThrow('A local Pi package path does not exist');
		await expect(
			planPackageSync({
				after: ['npm:example@1.0.0', 'npm:example@2.0.0'],
				agentRoot: root,
				before: [],
			}),
		).rejects.toThrow('Duplicate Pi package source');
	});
});

describe('package operation execution', () => {
	it('continues independent operations and retains exactly failed operations', async () => {
		const calls: string[] = [];
		const packageManager = {
			install: async (source: string): Promise<void> => {
				calls.push(`install:${source}`);
				if (source === 'npm:broken') {
					throw new Error('failed');
				}
			},
			remove: async (source: string): Promise<void> => {
				calls.push(`remove:${source}`);
			},
		};
		const operations = [
			{ action: 'install' as const, source: 'npm:working' },
			{ action: 'update' as const, source: 'npm:broken' },
			{ action: 'remove' as const, source: 'npm:removed' },
		];

		await expect(applyPackageOperations(packageManager, operations)).resolves.toEqual({
			failed: [{ action: 'update', source: 'npm:broken' }],
			failureMessage: 'One or more Pi package operations failed. Resolve them manually.',
			succeeded: [
				{ action: 'install', source: 'npm:working' },
				{ action: 'remove', source: 'npm:removed' },
			],
		});
		expect(calls).toEqual(['install:npm:working', 'install:npm:broken', 'remove:npm:removed']);
	});

	it('reads global package declarations through Pi SettingsManager', async () => {
		const settingsManager = SettingsManager.inMemory({ packages: ['npm:example@1.0.0'] });
		expect(readGlobalPackageSources(settingsManager)).toEqual(['npm:example@1.0.0']);

		const root = await createTemporaryDirectory('pi-sync-webdav-package-sync-');
		temporaryDirectories.push(root);
		await writeFile(join(root, 'settings.json'), '{"packages":["npm:example@2.0.0"]}', 'utf8');
		const runtime = createGlobalPackageSyncRuntime(root);
		expect(readGlobalPackageSources(runtime.settingsManager)).toEqual(['npm:example@2.0.0']);

		await writeFile(join(root, 'settings.json'), '{', 'utf8');
		const invalidRuntime = createGlobalPackageSyncRuntime(root);
		expect(() => readGlobalPackageSources(invalidRuntime.settingsManager)).toThrow(
			'Unable to read Pi settings',
		);
	});
});
