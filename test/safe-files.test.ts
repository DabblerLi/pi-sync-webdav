import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readRegularFileSnapshot } from '../src/safe-files.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

describe('regular file snapshots', () => {
	it('reads regular files and refuses symbolic links without following them', async () => {
		const root = await createTemporaryDirectory('pi-sync-webdav-safe-files-');
		temporaryDirectories.push(root);
		const source = join(root, 'source.txt');
		const link = join(root, 'link.txt');
		await writeFile(source, 'safe', 'utf8');
		await symlink(source, link, 'file');

		await expect(
			readRegularFileSnapshot(source, { errorMessage: 'Unsafe file', maxBytes: 1024 }),
		).resolves.toEqual(Buffer.from('safe', 'utf8'));
		await expect(
			readRegularFileSnapshot(link, { errorMessage: 'Unsafe file', maxBytes: 1024 }),
		).rejects.toThrow('Unsafe file');
	});
});
