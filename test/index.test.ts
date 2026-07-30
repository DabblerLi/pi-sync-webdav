import { describe, expect, it } from 'vitest';

import registerSyncWebdav from '../src/index.js';

describe('extension entrypoint', () => {
	it('exports an extension factory', () => {
		expect(registerSyncWebdav).toBeTypeOf('function');
	});
});
