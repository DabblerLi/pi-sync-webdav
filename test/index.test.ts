import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import registerSyncWebdav from '../src/index.js';

describe('extension entrypoint', () => {
	it('exports an extension factory and registers the sync command', () => {
		const pi = { registerCommand: vi.fn() } as unknown as ExtensionAPI;
		expect(registerSyncWebdav).toBeTypeOf('function');
		registerSyncWebdav(pi);
		expect(pi.registerCommand).toHaveBeenCalledWith('sync-webdav', expect.any(Object));
	});
});
