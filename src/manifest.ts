import { randomUUID } from 'node:crypto';

import { parseManifestPath, type SafeRelativePath } from './paths.js';

export const MANIFEST_VERSION = 1 as const;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_OPERATION_BYTES = 500 * 1024 * 1024;

declare const revisionIdBrand: unique symbol;

export type RevisionId = string & { readonly [revisionIdBrand]: true };

export interface ManifestFile {
	readonly path: SafeRelativePath;
	readonly sha256: string;
	readonly size: number;
}

export interface ManifestV1 {
	readonly files: readonly ManifestFile[];
	readonly revision: RevisionId;
	readonly version: typeof MANIFEST_VERSION;
}

const REVISION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidManifest(): never {
	throw new Error('Invalid manifest');
}

function assertExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): void {
	const actualKeys = Object.keys(value).sort();
	const sortedExpectedKeys = [...expectedKeys].sort();
	if (
		actualKeys.length !== sortedExpectedKeys.length ||
		actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
	) {
		invalidManifest();
	}
}

function parseRevisionId(value: unknown): RevisionId {
	if (typeof value !== 'string' || !REVISION_ID_PATTERN.test(value)) {
		invalidManifest();
	}
	return value as RevisionId;
}

function parseManifestFile(value: unknown): ManifestFile {
	if (!isRecord(value)) {
		invalidManifest();
	}
	assertExactKeys(value, ['path', 'sha256', 'size']);
	if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
		invalidManifest();
	}
	if (
		typeof value.size !== 'number' ||
		!Number.isSafeInteger(value.size) ||
		value.size < 0 ||
		value.size > MAX_FILE_BYTES
	) {
		invalidManifest();
	}

	try {
		return {
			path: parseManifestPath(value.path),
			sha256: value.sha256,
			size: value.size,
		};
	} catch {
		invalidManifest();
	}
}

export function generateRevisionId(): RevisionId {
	const revisionId = randomUUID();
	if (!REVISION_ID_PATTERN.test(revisionId)) {
		throw new Error('Unable to generate revision ID');
	}
	return revisionId as RevisionId;
}

export function validateManifest(value: unknown): ManifestV1 {
	if (!isRecord(value)) {
		invalidManifest();
	}
	assertExactKeys(value, ['version', 'revision', 'files']);
	if (value.version !== MANIFEST_VERSION || !Array.isArray(value.files)) {
		invalidManifest();
	}

	const files = value.files.map(parseManifestFile);
	const paths = new Set(files.map((file) => file.path));
	if (paths.size !== files.length) {
		invalidManifest();
	}

	const totalBytes = files.reduce((total, file) => total + file.size, 0);
	if (totalBytes > MAX_OPERATION_BYTES) {
		invalidManifest();
	}

	return {
		files,
		revision: parseRevisionId(value.revision),
		version: MANIFEST_VERSION,
	};
}

export function parseManifest(json: string): ManifestV1 {
	if (typeof json !== 'string') {
		throw new Error('Manifest is not valid JSON');
	}
	try {
		return validateManifest(JSON.parse(json));
	} catch (error: unknown) {
		if (error instanceof SyntaxError) {
			throw new Error('Manifest is not valid JSON');
		}
		throw error;
	}
}

export function serializeManifest(manifest: unknown): string {
	const validated = validateManifest(manifest);
	const files = [...validated.files].sort((left, right) => {
		if (left.path < right.path) {
			return -1;
		}
		if (left.path > right.path) {
			return 1;
		}
		return 0;
	});
	return `${JSON.stringify(
		{
			files,
			revision: validated.revision,
			version: validated.version,
		},
		null,
		2,
	)}\n`;
}
