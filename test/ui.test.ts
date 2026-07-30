import { describe, expect, it } from 'vitest';

import { parseManifestPath } from '../src/paths.js';
import { formatPlanLines } from '../src/ui.js';

describe('sync plan rendering', () => {
	it('renders only actions, paths, package sources, and explicit warnings', () => {
		expect(
			formatPlanLines({
				files: [
					{ action: 'add', path: parseManifestPath('settings.json') },
					{ action: 'delete', path: parseManifestPath('themes/old.json') },
				],
				packages: [{ action: 'update', source: 'npm:example@2.0.0' }],
				warnings: ['Selected text may contain credentials.'],
			}),
		).toEqual([
			'ADD settings.json',
			'DELETE themes/old.json',
			'UPDATE PACKAGE npm:example@2.0.0',
			'Warning: Selected text may contain credentials.',
		]);
	});
});
