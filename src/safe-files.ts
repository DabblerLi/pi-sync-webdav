import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { readonly code?: unknown }).code === 'ENOENT'
	);
}

function sameFile(
	left: Awaited<ReturnType<typeof fs.lstat>>,
	right: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

export async function readRegularFileSnapshot(
	path: string,
	options: { readonly errorMessage: string; readonly maxBytes: number; readonly mode?: number },
): Promise<Buffer | undefined> {
	let initial;
	try {
		initial = await fs.lstat(path);
	} catch (error: unknown) {
		if (isMissingPath(error)) {
			return undefined;
		}
		throw new Error(options.errorMessage);
	}
	if (!initial.isFile() || initial.isSymbolicLink() || initial.size > options.maxBytes) {
		throw new Error(options.errorMessage);
	}

	let handle;
	try {
		handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error: unknown) {
		if (isMissingPath(error)) {
			return undefined;
		}
		throw new Error(options.errorMessage);
	}
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.size > options.maxBytes || !sameFile(initial, opened)) {
			throw new Error(options.errorMessage);
		}
		const contents = await handle.readFile();
		if (contents.byteLength > options.maxBytes) {
			throw new Error(options.errorMessage);
		}
		if (options.mode !== undefined) {
			await handle.chmod(options.mode);
		}
		return contents;
	} finally {
		await handle.close();
	}
}
