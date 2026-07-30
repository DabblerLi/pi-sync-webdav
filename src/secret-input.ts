import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

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
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
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
			invalidate: () => undefined,
			render: (width: number) => {
				const message = `${title}\n${'*'.repeat(characters.length)}\nEnter to continue • Esc to cancel`;
				return message
					.split('\n')
					.map((line) => truncateToWidth(theme.fg('text', line), Math.max(1, width)));
			},
			dispose: () => {
				characters.fill('');
				characters = [];
			},
		};
	});
}
