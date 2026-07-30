import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { SyncOperationCancelledError } from '../src/operation.js';
import { parseManifestPath } from '../src/paths.js';
import { formatOperationProgress, formatPlanLines, runCancellableOperation } from '../src/ui.js';

describe('sync plan rendering', () => {
	it('renders only actions, paths, package sources, and explicit warnings', () => {
		expect(
			formatPlanLines({
				files: [
					{ action: 'add', path: parseManifestPath('settings.json') },
					{ action: 'delete', path: parseManifestPath('themes/old.json') },
					{ action: 'secure', path: parseManifestPath('auth.json') },
				],
				packages: [{ action: 'update', source: 'npm:example@2.0.0' }],
				warnings: ['Selected text may contain credentials.'],
			}),
		).toEqual([
			'ADD settings.json',
			'DELETE themes/old.json',
			'SECURE auth.json',
			'UPDATE PACKAGE npm:example@2.0.0',
			'Warning: Selected text may contain credentials.',
		]);
	});

	it('renders progress without sizes, paths, or credentials', () => {
		expect(formatOperationProgress({ completed: 2, phase: 'uploading', total: 5 })).toBe(
			'Uploading configuration (2/5)…',
		);
		expect(formatOperationProgress({ completed: 2, phase: 'retrying', total: 3 })).toBe(
			'Retrying WebDAV request (2/3)…',
		);
	});

	it('waits for an aborted operation to clean up before reporting cancellation', async () => {
		const custom = vi.fn(
			async (factory) =>
				new Promise((resolve) => {
					const component = factory(
						{ requestRender: vi.fn() },
						{ fg: (_color: string, value: string) => value },
						{},
						resolve,
					) as unknown as {
						abortController: AbortController;
						dispose?: () => void;
						onAbort?: () => void;
					};
					component.abortController.abort();
					component.onAbort?.();
					setTimeout(() => component.dispose?.(), 0);
				}),
		);
		const result = await runCancellableOperation(
			{ mode: 'tui', ui: { custom } } as unknown as ExtensionCommandContext,
			{ phase: 'downloading' },
			({ signal }) =>
				new Promise<never>((_resolve, reject) => {
					signal?.addEventListener('abort', () => reject(new SyncOperationCancelledError()), {
						once: true,
					});
				}),
		);

		expect(result).toEqual({ cancelled: true, value: undefined });
	});
});
