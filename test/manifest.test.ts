import { describe, expect, it } from 'vitest';

import {
	generateRevisionId,
	MAX_FILE_BYTES,
	MAX_OPERATION_BYTES,
	parseManifest,
	serializeManifest,
	validateManifest,
} from '../src/manifest.js';

describe('manifest validation', () => {
	function createManifest() {
		return {
			files: [
				{
					path: 'themes/dark.json',
					sha256: 'a'.repeat(64),
					size: 1024,
				},
			],
			revision: generateRevisionId(),
			version: 1,
		};
	}

	it('generates lowercase UUID-v4 revision IDs and round-trips canonical manifests', () => {
		const manifest = createManifest();
		const serialized = serializeManifest(manifest);
		const parsed = parseManifest(serialized);

		expect(manifest.revision).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(parsed).toEqual(manifest);
	});

	it('sorts files without mutating the caller input', () => {
		const manifest = {
			...createManifest(),
			files: [
				{ path: 'themes/light.json', sha256: 'b'.repeat(64), size: 1 },
				{ path: 'themes/dark.json', sha256: 'a'.repeat(64), size: 1 },
			],
		};

		const serialized = serializeManifest(manifest);

		expect(manifest.files.map((file) => file.path)).toEqual([
			'themes/light.json',
			'themes/dark.json',
		]);
		expect(JSON.parse(serialized).files.map((file: { path: string }) => file.path)).toEqual([
			'themes/dark.json',
			'themes/light.json',
		]);
	});

	it.each([
		undefined,
		null,
		[],
		{},
		{ version: 2, revision: generateRevisionId(), files: [] },
		{ version: 1, revision: 'UPPERCASE-REVISION', files: [] },
		{ version: 1, revision: generateRevisionId(), files: [], unexpected: true },
		{
			version: 1,
			revision: generateRevisionId(),
			files: [{ path: 'themes/dark.json', sha256: 'A'.repeat(64), size: 1 }],
		},
		{
			version: 1,
			revision: generateRevisionId(),
			files: [{ path: 'themes/dark.json', sha256: 'a'.repeat(64), size: -1 }],
		},
		{
			version: 1,
			revision: generateRevisionId(),
			files: [{ path: 'themes/dark.json', sha256: 'a'.repeat(64), size: MAX_FILE_BYTES + 1 }],
		},
		{
			version: 1,
			revision: generateRevisionId(),
			files: [
				{ path: 'themes/dark.json', sha256: 'a'.repeat(64), size: MAX_OPERATION_BYTES / 2 + 1 },
				{ path: 'themes/light.json', sha256: 'b'.repeat(64), size: MAX_OPERATION_BYTES / 2 + 1 },
			],
		},
		{
			version: 1,
			revision: generateRevisionId(),
			files: [
				{ path: 'themes/dark.json', sha256: 'a'.repeat(64), size: 1 },
				{ path: 'themes/dark.json', sha256: 'b'.repeat(64), size: 1 },
			],
		},
		{
			version: 1,
			revision: generateRevisionId(),
			files: [
				{ path: 'themes', sha256: 'a'.repeat(64), size: 1 },
				{ path: 'themes/dark.json', sha256: 'b'.repeat(64), size: 1 },
			],
		},
		{
			version: 1,
			revision: generateRevisionId(),
			files: [{ path: 'npm/package.json', sha256: 'a'.repeat(64), size: 1 }],
		},
		{
			version: 1,
			revision: generateRevisionId(),
			files: [{ path: 'extensions/logs/activity.log', sha256: 'a'.repeat(64), size: 1 }],
		},
		{
			version: 1,
			revision: generateRevisionId(),
			files: [
				{ path: 'skills/tool/node_modules/package/index.js', sha256: 'a'.repeat(64), size: 1 },
			],
		},
		{
			version: 1,
			revision: generateRevisionId(),
			files: [{ path: 'themes/CON.json', sha256: 'a'.repeat(64), size: 1 }],
		},
		{
			version: 1,
			revision: generateRevisionId(),
			files: [{ path: 'themes/settings:stream', sha256: 'a'.repeat(64), size: 1 }],
		},
	])('rejects invalid manifests', (manifest) => {
		expect(() => validateManifest(manifest)).toThrow('Invalid manifest');
	});

	it('rejects malformed JSON', () => {
		expect(() => parseManifest('{')).toThrow('Manifest is not valid JSON');
	});
});
