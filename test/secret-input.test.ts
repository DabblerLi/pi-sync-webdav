import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, KeybindingsManager, TUI } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { promptSecret } from '../src/secret-input.js';

const themeStub = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as unknown as Theme;

const keybindings = {
	getKeys: (binding: string) => (binding === 'tui.select.confirm' ? ['!'] : ['?']),
	matches: (data: string, binding: string) =>
		binding === 'tui.select.confirm' ? data === '!' : data === '?',
} as unknown as KeybindingsManager;

interface DrivenComponent extends Component {
	dispose?(): void;
	handleInput?(data: string): void;
}

function createContext(drive: (component: DrivenComponent) => void): ExtensionCommandContext {
	const custom = vi.fn(
		async (
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (value: never) => void,
			) => DrivenComponent,
		) =>
			new Promise((resolve) => {
				const component = factory(
					{ requestRender: vi.fn() } as unknown as TUI,
					themeStub,
					keybindings,
					(value: never) => {
						component.dispose?.();
						resolve(value);
					},
				);
				drive(component);
			}),
	);
	return { mode: 'tui', ui: { custom } } as unknown as ExtensionCommandContext;
}

describe('promptSecret', () => {
	it('uses configured submit bindings and renders only a masked value', async () => {
		let rendered = '';
		const ctx = createContext((component) => {
			component.handleInput?.('secret');
			rendered = component.render(60).join('\n');
			component.handleInput?.('!');
		});

		await expect(promptSecret(ctx, 'WebDAV password')).resolves.toBe('secret');
		expect(rendered).toContain('******');
		expect(rendered).not.toContain('secret');
		expect(rendered).toContain('! submit');
		expect(rendered).toContain('? cancel');
	});

	it('uses the configured cancel binding without returning entered text', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.('secret');
			component.handleInput?.('?');
		});

		await expect(promptSecret(ctx, 'WebDAV password')).resolves.toBeUndefined();
	});

	it('accepts a bracketed paste as literal text', async () => {
		let rendered = '';
		const ctx = createContext((component) => {
			component.handleInput?.('\x1b[200~p@ss!word\x1b[201~');
			rendered = component.render(60).join('\n');
			component.handleInput?.('!');
		});

		await expect(promptSecret(ctx, 'WebDAV password')).resolves.toBe('p@ss!word');
		expect(rendered).toContain('*********');
		expect(rendered).not.toContain('200~');
	});

	it('accepts a bracketed paste split across input chunks', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.('\x1b[200~hun');
			component.handleInput?.('ter');
			component.handleInput?.('2\x1b[201~');
			component.handleInput?.('!');
		});

		await expect(promptSecret(ctx, 'WebDAV password')).resolves.toBe('hunter2');
	});

	it('drops line breaks without losing the rest of a pasted value', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.('\x1b[200~first\r');
			component.handleInput?.('\nsecond\n\x1b[201~');
			component.handleInput?.('!');
		});

		await expect(promptSecret(ctx, 'WebDAV password')).resolves.toBe('firstsecond');
	});

	it('inserts printable kitty CSI-u input', async () => {
		const ctx = createContext((component) => {
			component.handleInput?.('\x1b[97u');
			component.handleInput?.('!');
		});

		await expect(promptSecret(ctx, 'WebDAV password')).resolves.toBe('a');
	});
});
