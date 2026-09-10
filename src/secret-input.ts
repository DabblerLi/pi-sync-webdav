import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

import { createDialogContainer, formatKeyHints } from './ui.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function printableText(value: string): string {
	return [...value]
		.filter((character) => {
			const codePoint = character.codePointAt(0);
			if (codePoint === undefined) {
				return false;
			}
			return codePoint >= 0x20 && codePoint !== 0x7f && !(codePoint >= 0x80 && codePoint <= 0x9f);
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
		let pasteBuffer = '';
		let pasting = false;

		const finish = (result: string | undefined): void => {
			if (complete) {
				return;
			}
			complete = true;
			characters.fill('');
			characters = [];
			done(result);
		};

		const appendText = (text: string): void => {
			const printable = printableText(text);
			if (printable.length === 0) {
				return;
			}
			characters.push(...printable);
			tui.requestRender();
		};

		const handlePasteChunk = (data: string): void => {
			pasteBuffer += data;
			const endIndex = pasteBuffer.indexOf(PASTE_END);
			if (endIndex === -1) {
				return;
			}
			const pasted = pasteBuffer.slice(0, endIndex);
			const remaining = pasteBuffer.slice(endIndex + PASTE_END.length);
			pasteBuffer = '';
			pasting = false;
			appendText(pasted);
			handleInput(remaining);
		};

		const handleKeyInput = (data: string): void => {
			if (keybindings.matches(data, 'tui.select.cancel')) {
				finish(undefined);
				return;
			}
			if (keybindings.matches(data, 'tui.select.confirm')) {
				finish(characters.join(''));
				return;
			}
			if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
				characters.pop();
				tui.requestRender();
				return;
			}
			if (!data.startsWith('\u001b')) {
				appendText(data);
				return;
			}
			const kittyPrintable = decodeKittyPrintable(data);
			if (kittyPrintable !== undefined) {
				appendText(kittyPrintable);
			}
		};

		const handleInput = (data: string): void => {
			if (pasting) {
				handlePasteChunk(data);
				return;
			}
			const startIndex = data.indexOf(PASTE_START);
			if (startIndex === -1) {
				handleKeyInput(data);
				return;
			}
			if (startIndex > 0) {
				handleKeyInput(data.slice(0, startIndex));
			}
			pasting = true;
			handlePasteChunk(data.slice(startIndex + PASTE_START.length));
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
			handleInput,
			invalidate: () => container.invalidate(),
			render: (width: number) => container.render(width),
			dispose: () => {
				characters.fill('');
				characters = [];
			},
		};
	});
}
