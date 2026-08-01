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
});
