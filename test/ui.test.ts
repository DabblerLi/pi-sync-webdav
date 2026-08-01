import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import { getKeybindings, type Component, type TUI } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { SyncOperationCancelledError } from '../src/operation.js';
import { parseManifestPath, type SafeRelativePath } from '../src/paths.js';
import type { SelectionCandidate } from '../src/selection.js';
import {
	confirmDialog,
	confirmSyncPlan,
	formatOperationProgress,
	formatPlanLines,
	runCancellableOperation,
	selectOption,
	selectPushIncludes,
} from '../src/ui.js';

const themeStub = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as unknown as Theme;

const tuiStub = { requestRender: vi.fn() } as unknown as TUI;

interface DrivenComponent extends Component {
	dispose?(): void;
	handleInput?(data: string): void;
}

function createContext(
	drive: (component: DrivenComponent, done: (value: never) => void) => void,
): ExtensionCommandContext {
	const custom = vi.fn(
		async (
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: unknown,
				done: (value: never) => void,
			) => DrivenComponent,
		) =>
			new Promise((resolve) => {
				const component = factory(tuiStub, themeStub, getKeybindings(), (value: never) => {
					component.dispose?.();
					resolve(value);
				});
				drive(component, (value: never) => {
					component.dispose?.();
					resolve(value);
				});
			}),
	);
	return { mode: 'tui', ui: { custom } } as unknown as ExtensionCommandContext;
}

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
			'Files:',
			'  ADD settings.json',
			'  DELETE themes/old.json',
			'  SECURE auth.json',
			'',
			'Packages:',
			'  UPDATE npm:example@2.0.0',
			'',
			'⚠️ Warnings:',
			'  Selected text may contain credentials.',
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
});

describe('confirmSyncPlan', () => {
	it('truncates long plans and reports the hidden count', async () => {
		const files = Array.from({ length: 20 }, (_, index) => ({
			action: 'add' as const,
			path: parseManifestPath(`file-${index}.json`),
		}));
		let rendered: string[] = [];
		const ctx = createContext((component, done) => {
			rendered = component.render(60);
			done(false as never);
		});
		await confirmSyncPlan(ctx, 'Push these changes to WebDAV?', { files });
		const text = rendered.join('\n');
		expect(text).toContain('ADD file-4.json');
		expect(text).not.toContain('ADD file-5.json');
		expect(text).toContain('… and 15 more');
	});

	it('limits mixed file and package operations while keeping warnings and choices visible', async () => {
		const files = Array.from({ length: 10 }, (_, index) => ({
			action: 'add' as const,
			path: parseManifestPath(`file-${index}.json`),
		}));
		const packages = Array.from({ length: 10 }, (_, index) => ({
			action: 'install' as const,
			source: `npm:package-${index}`,
		}));
		let rendered: string[] = [];
		const ctx = createContext((component, done) => {
			rendered = component.render(80);
			done(false as never);
		});

		await confirmSyncPlan(ctx, 'Apply these changes from WebDAV?', {
			files,
			packages,
			warnings: ['Package code will run with your user permissions.'],
		});

		const text = rendered.join('\n');
		expect(text).toContain('ADD file-2.json');
		expect(text).not.toContain('ADD file-3.json');
		expect(text).toContain('… and 7 more');
		expect(text).toContain('INSTALL npm:package-1');
		expect(text).not.toContain('INSTALL npm:package-2');
		expect(text).toContain('… and 8 more');
		expect(text).toContain('Package code will run with your user permissions.');
		expect(text).toContain('→ Yes');
		expect(text).toContain('No');
		expect(rendered.length).toBeLessThanOrEqual(24);
	});

	it('shows short plans in full', async () => {
		let rendered: string[] = [];
		const ctx = createContext((component, done) => {
			rendered = component.render(60);
			done(false as never);
		});
		await confirmSyncPlan(ctx, 'Push these changes to WebDAV?', {
			files: [{ action: 'add', path: parseManifestPath('settings.json') }],
		});
		expect(rendered.join('\n')).toContain('ADD settings.json');
		expect(rendered.join('\n')).not.toContain('… and');
	});
});

describe('selectOption', () => {
	const options = ['First', 'Second', 'Third'];

	it('returns the highlighted option on enter', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.('\x1b[B');
			component.handleInput?.('\r');
		});
		await expect(selectOption(ctx, 'Pick', options)).resolves.toBe('Second');
	});

	it('wraps from the last option to the first when moving down', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.('\x1b[B');
			component.handleInput?.('\x1b[B');
			component.handleInput?.('\x1b[B');
			component.handleInput?.('\r');
		});
		await expect(selectOption(ctx, 'Pick', options)).resolves.toBe('First');
	});

	it('wraps from the first option to the last when moving up', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.('\x1b[A');
			component.handleInput?.('\r');
		});
		await expect(selectOption(ctx, 'Pick', options)).resolves.toBe('Third');
	});

	it('returns undefined on escape', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.('\x1b');
		});
		await expect(selectOption(ctx, 'Pick', options)).resolves.toBeUndefined();
	});

	it('renders a framed dialog with the title, options, and key hints', async () => {
		let rendered: string[] = [];
		const ctx = createContext((component, done) => {
			rendered = component.render(60);
			done(undefined as never);
		});
		await selectOption(ctx, 'Pick one', options);
		const text = rendered.join('\n');
		expect(text).toContain('Pick one');
		expect(text).toContain('→ First');
		expect(text).toContain('First');
		expect(text).toContain('navigate');
		expect(text).toContain('cancel');
	});
});

describe('confirmDialog', () => {
	it('confirms with enter on the default Yes option', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.('\r');
		});
		await expect(confirmDialog(ctx, 'Proceed?', 'Apply changes?')).resolves.toBe(true);
	});

	it('declines when No is selected', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.('\x1b[B');
			component.handleInput?.('\r');
		});
		await expect(confirmDialog(ctx, 'Proceed?', 'Apply changes?')).resolves.toBe(false);
	});

	it('declines on escape', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.('\x1b');
		});
		await expect(confirmDialog(ctx, 'Proceed?', 'Apply changes?')).resolves.toBe(false);
	});

	it('separates the title from the message and options', async () => {
		let rendered: string[] = [];
		const ctx = createContext((component, done) => {
			rendered = component.render(60);
			done(false as never);
		});
		await confirmDialog(ctx, 'Proceed?', 'This changes files.');
		const text = rendered.join('\n');
		expect(text).toContain('Proceed?');
		expect(text).toContain('This changes files.');
		expect(text).toContain('→ Yes');
		expect(text.indexOf('Proceed?')).toBeLessThan(text.indexOf('This changes files.'));
		expect(text.indexOf('This changes files.')).toBeLessThan(text.indexOf('→ Yes'));
	});
});

describe('selectPushIncludes', () => {
	const candidates: SelectionCandidate[] = [
		{ defaultSelected: true, path: parseManifestPath('settings.json'), type: 'file' },
		{ defaultSelected: true, path: parseManifestPath('themes'), type: 'directory' },
		{ defaultSelected: false, path: parseManifestPath('auth.json'), type: 'file' },
	];
	const defaults: SafeRelativePath[] = [
		parseManifestPath('settings.json'),
		parseManifestPath('themes'),
	];

	it('saves the toggled selection on enter', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.(' '); // toggle settings.json off
			component.handleInput?.('\x1b[A'); // wrap up to auth.json
			component.handleInput?.(' '); // toggle auth.json on
			component.handleInput?.('\r');
		});
		await expect(selectPushIncludes(ctx, candidates, defaults)).resolves.toEqual([
			parseManifestPath('themes'),
			parseManifestPath('auth.json'),
		]);
	});

	it('returns undefined on escape', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.('\x1b');
		});
		await expect(selectPushIncludes(ctx, candidates, defaults)).resolves.toBeUndefined();
	});

	it('renders markers, default labels, and key hints', async () => {
		let rendered: string[] = [];
		const ctx = createContext((component, done) => {
			rendered = component.render(60);
			done(undefined as never);
		});
		await selectPushIncludes(ctx, candidates, defaults);
		const text = rendered.join('\n');
		expect(text).toContain('Select push items');
		expect(text).toContain('→ [x] settings.json (default)');
		expect(text).toContain('[ ] auth.json');
		expect(text).toContain('toggle');
	});
});

describe('runCancellableOperation', () => {
	it('waits for an aborted operation to clean up before reporting cancellation', async () => {
		const result = await runCancellableOperation(
			createContext((component) => {
				component.handleInput?.('\x1b');
			}),
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

	it('returns the operation value when it completes normally', async () => {
		const result = await runCancellableOperation(
			createContext(() => undefined),
			{ phase: 'uploading' },
			() => Promise.resolve('done'),
		);

		expect(result).toEqual({ cancelled: false, value: 'done' });
	});

	it('preserves an undefined rejection reason as a failed operation', async () => {
		let rejected = false;
		let reason: unknown = 'not rejected';
		try {
			await runCancellableOperation(
				createContext(() => undefined),
				{ phase: 'preparing' },
				() => Promise.reject(undefined),
			);
		} catch (error: unknown) {
			rejected = true;
			reason = error;
		}

		expect(rejected).toBe(true);
		expect(reason).toBeUndefined();
	});
});
