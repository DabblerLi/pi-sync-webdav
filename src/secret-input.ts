import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

import { createDialogContainer, formatKeyHints } from './ui.js';

function printableText(value: string): string {
	return [...value]
		.filter((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f;
		})
		.join('');
}

export async function promptSecret(
	ctx: ExtensionCommandContext,
	title: string,
): Promise<string | undefined> {
	if (ctx.mode !== 'tui') {
		return undefined;
	}
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		let characters: string[] = [];
		let complete = false;

		const finish = (result: string | undefined): void => {
			if (complete) {
				return;
			}
			complete = true;
			characters.fill('');
			characters = [];
			done(result);
		};

		const body = {
			invalidate: () => undefined,
			render: (width: number): string[] => {
				// Mirrors pi's Input: "> " prompt with an inverse-video cursor.
				const masked = '*'.repeat(characters.length);
				return [truncateToWidth(` > ${masked}\x1b[7m \x1b[27m`, width)];
			},
		};
		const container = createDialogContainer({
			body,
			boldTitle: false,
			hints: formatKeyHints(theme, [
				[keybindings.getKeys('tui.select.confirm').join('/'), 'submit'],
				[keybindings.getKeys('tui.select.cancel').join('/'), 'cancel'],
			]),
			theme,
			title,
		});

		return {
			handleInput: (data: string) => {
				if (matchesKey(data, Key.escape)) {
					finish(undefined);
					return;
				}
				if (matchesKey(data, Key.enter)) {
					finish(characters.join(''));
					return;
				}
				if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
					characters.pop();
					tui.requestRender();
					return;
				}
				if (data.startsWith('\u001b')) {
					return;
				}
				const text = printableText(data);
				if (text.length > 0) {
					characters.push(...text);
					tui.requestRender();
				}
			},
			invalidate: () => container.invalidate(),
			render: (width: number) => container.render(width),
			dispose: () => {
				characters.fill('');
				characters = [];
			},
		};
	});
}
