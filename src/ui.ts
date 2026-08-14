import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import {
	CancellableLoader,
	Container,
	Key,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	type Component,
	type KeybindingsManager,
	type TUI,
} from '@earendil-works/pi-tui';

import {
	isOperationCancelled,
	type OperationOptions,
	type OperationProgress,
} from './operation.js';

import type { PackageOperation } from './package-sync.js';
import type { SafeRelativePath } from './paths.js';
import type { SelectionCandidate } from './selection.js';
import type { FileMutation } from './sync-plan.js';

export interface CancellableOperationResult<T> {
	readonly cancelled: boolean;
	readonly value: T | undefined;
}

export function formatOperationProgress(progress: OperationProgress): string {
	const count =
		progress.completed === undefined || progress.total === undefined
			? ''
			: ` (${progress.completed}/${progress.total})`;
	switch (progress.phase) {
		case 'applying':
			return `Applying configuration${count}…`;
		case 'cleaning':
			return 'Cleaning remote residue…';
		case 'downloading':
			return `Downloading configuration${count}…`;
		case 'preparing':
			return 'Preparing configuration…';
		case 'restoring':
			return `Restoring local backups${count}…`;
		case 'retrying':
			return `Retrying WebDAV request${count}…`;
		case 'uploading':
			return `Uploading configuration${count}…`;
		case 'validating':
			return 'Validating WebDAV connection…';
	}
}

type KeyHint = readonly [keys: string, description: string];

/**
 * Formats keybinding hints like pi's keyHint/rawKeyHint, but uses the theme
 * from the custom() callback because the global theme is not reliable inside
 * jiti-loaded extensions.
 */
export function formatKeyHints(theme: Theme, hints: readonly KeyHint[]): string {
	return hints
		.map(([keys, description]) => theme.fg('dim', keys) + theme.fg('muted', ` ${description}`))
		.join('  ');
}

function bindingKeys(
	keybindings: KeybindingsManager,
	binding: 'tui.select.cancel' | 'tui.select.confirm',
): string {
	return keybindings.getKeys(binding).join('/');
}

/**
 * Assembles a framed dialog with the same layout as pi's built-in selector,
 * input, and loader dialogs: border, accent title, body, key hints, border.
 */
export function createDialogContainer(input: {
	readonly body: Component | readonly Component[];
	readonly boldTitle?: boolean;
	readonly hints?: string;
	readonly theme: Theme;
	readonly title: string;
}): Container {
	const { theme } = input;
	const border = (text: string): string => theme.fg('border', text);
	const container = new Container();
	container.addChild(new DynamicBorder(border));
	container.addChild(new Spacer(1));
	container.addChild(
		new Text(
			input.boldTitle === false
				? theme.fg('accent', input.title)
				: theme.fg('accent', theme.bold(input.title)),
			1,
			0,
		),
	);
	container.addChild(new Spacer(1));
	const body = Array.isArray(input.body) ? input.body : [input.body];
	for (const child of body) {
		container.addChild(child);
	}
	if (input.hints !== undefined) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(input.hints, 1, 0));
	}
	container.addChild(new Spacer(1));
	container.addChild(new DynamicBorder(border));
	return container;
}

/** Moves a list cursor cyclically, matching pi-tui SelectList navigation. */
function moveCyclic(index: number, delta: -1 | 1, length: number): number {
	return (index + delta + length) % length;
}

/** Option rows styled like pi's ExtensionSelectorComponent, with cyclic navigation. */
class OptionListBody implements Component {
	#index = 0;

	constructor(
		private readonly keybindings: KeybindingsManager,
		private readonly onCancel: () => void,
		private readonly onSubmit: (index: number) => void,
		private readonly options: readonly string[],
		private readonly theme: Theme,
		private readonly tui: TUI,
		private readonly useVimKeys = true,
	) {}

	get index(): number {
		return this.#index;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, 'tui.select.up') || (this.useVimKeys && data === 'k')) {
			this.#index = moveCyclic(this.#index, -1, this.options.length);
			this.tui.requestRender();
		} else if (
			this.keybindings.matches(data, 'tui.select.down') ||
			(this.useVimKeys && data === 'j')
		) {
			this.#index = moveCyclic(this.#index, 1, this.options.length);
			this.tui.requestRender();
		} else if (this.keybindings.matches(data, 'tui.select.confirm') || data === '\n') {
			this.onSubmit(this.#index);
		} else if (this.keybindings.matches(data, 'tui.select.cancel')) {
			this.onCancel();
		}
	}

	invalidate(): void {
		// Stateless: rows are rebuilt from the current index on every render.
	}

	render(width: number): string[] {
		return this.options.map((option, optionIndex) => {
			const line =
				optionIndex === this.#index
					? this.theme.fg('accent', '→ ') + this.theme.fg('accent', option)
					: `  ${this.theme.fg('text', option)}`;
			return truncateToWidth(` ${line}`, width);
		});
	}
}

export async function selectOption(
	ctx: ExtensionCommandContext,
	title: string,
	options: readonly string[],
): Promise<string | undefined> {
	if (ctx.mode !== 'tui' || options.length === 0) {
		return undefined;
	}
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const list = new OptionListBody(
			keybindings,
			() => done(undefined),
			(index) => done(options[index]),
			options,
			theme,
			tui,
		);
		const container = createDialogContainer({
			body: list,
			hints: formatKeyHints(theme, [
				['↑↓', 'navigate'],
				[bindingKeys(keybindings, 'tui.select.confirm'), 'select'],
				[bindingKeys(keybindings, 'tui.select.cancel'), 'cancel'],
			]),
			theme,
			title,
		});
		return {
			handleInput: (data: string) => list.handleInput(data),
			invalidate: () => container.invalidate(),
			render: (width: number) => container.render(width),
		};
	});
}

export async function confirmDialog(
	ctx: ExtensionCommandContext,
	title: string,
	message: string,
): Promise<boolean> {
	if (ctx.mode !== 'tui') {
		return false;
	}
	return ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
		const options = ['Yes', 'No'] as const;
		const list = new OptionListBody(
			keybindings,
			() => done(false),
			(index) => done(options[index] === 'Yes'),
			options,
			theme,
			tui,
		);
		const container = createDialogContainer({
			body: [new Text(theme.fg('text', message), 1, 0), new Spacer(1), list],
			hints: formatKeyHints(theme, [
				['↑↓', 'navigate'],
				[bindingKeys(keybindings, 'tui.select.confirm'), 'select'],
				[bindingKeys(keybindings, 'tui.select.cancel'), 'cancel'],
			]),
			theme,
			title,
		});
		return {
			handleInput: (data: string) => list.handleInput(data),
			invalidate: () => container.invalidate(),
			render: (width: number) => container.render(width),
		};
	});
}

export async function runCancellableOperation<T>(
	ctx: ExtensionCommandContext,
	initialProgress: OperationProgress,
	operation: (options: OperationOptions) => Promise<T>,
): Promise<CancellableOperationResult<T>> {
	if (ctx.mode !== 'tui') {
		return { cancelled: true, value: undefined };
	}
	let didFail = false;
	let failure: unknown;
	const result = await ctx.ui.custom<CancellableOperationResult<T>>(
		(tui, theme, keybindings, done) => {
			const loader = new CancellableLoader(
				tui,
				(value) => theme.fg('accent', value),
				(value) => theme.fg('muted', value),
				formatOperationProgress(initialProgress),
			);
			const updateProgress = (progress: OperationProgress): void => {
				loader.setMessage(formatOperationProgress(progress));
				tui.requestRender();
			};
			let complete = false;
			const finish = (value: CancellableOperationResult<T>): void => {
				if (!complete) {
					complete = true;
					done(value);
				}
			};
			loader.onAbort = () => {
				loader.setMessage('Cancelling operation…');
				tui.requestRender();
			};
			void operation({ onProgress: updateProgress, signal: loader.signal }).then(
				(value) => finish({ cancelled: loader.aborted, value }),
				(error: unknown) => {
					if (!loader.aborted || !isOperationCancelled(error)) {
						didFail = true;
						failure = error;
					}
					finish({ cancelled: loader.aborted, value: undefined });
				},
			);
			const container = new Container();
			const border = (text: string): string => theme.fg('border', text);
			container.addChild(new DynamicBorder(border));
			container.addChild(loader);
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					formatKeyHints(theme, [[bindingKeys(keybindings, 'tui.select.cancel'), 'cancel']]),
					1,
					0,
				),
			);
			container.addChild(new Spacer(1));
			container.addChild(new DynamicBorder(border));
			return {
				dispose: () => loader.dispose(),
				handleInput: (data: string) => loader.handleInput(data),
				invalidate: () => container.invalidate(),
				render: (width: number) => container.render(width),
			};
		},
	);
	if (didFail) {
		throw failure;
	}
	return result;
}

function actionLabel(action: FileMutation['action']): string {
	return action.toUpperCase();
}

export interface PlanDisplayInput {
	readonly files: readonly Pick<FileMutation, 'action' | 'path'>[];
	readonly packages?: readonly PackageOperation[];
	readonly warnings?: readonly string[];
}

/** Files and package operation lines; these scroll in confirmation dialogs. */
function formatPlanEntries(
	files: PlanDisplayInput['files'],
	packages: PlanDisplayInput['packages'],
): readonly string[] {
	const lines: string[] = [];
	if (files.length > 0) {
		lines.push('Files:');
		for (const file of files) {
			lines.push(`  ${actionLabel(file.action)} ${file.path}`);
		}
	}
	if (packages !== undefined && packages.length > 0) {
		if (lines.length > 0) {
			lines.push('');
		}
		lines.push('Packages:');
		for (const operation of packages) {
			lines.push(`  ${operation.action.toUpperCase()} ${operation.source}`);
		}
	}
	return lines;
}

/** Warning lines; these stay pinned above the Yes/No options. */
function formatPlanWarnings(warnings: PlanDisplayInput['warnings']): readonly string[] {
	if (warnings === undefined || warnings.length === 0) {
		return [];
	}
	return ['⚠️ Warnings:', ...warnings.map((warning) => `  ${warning}`)];
}

export function formatPlanLines(input: PlanDisplayInput): readonly string[] {
	const entries = formatPlanEntries(input.files, input.packages);
	const warnings = formatPlanWarnings(input.warnings);
	if (entries.length === 0 || warnings.length === 0) {
		return [...entries, ...warnings];
	}
	return [...entries, '', ...warnings];
}

const VISIBLE_CANDIDATES = 12;
const VISIBLE_PLAN_LINES = 12;

/**
 * Fixed-window scrolling list of plan lines, matching the selectPushIncludes
 * pattern. j/k scroll the plan body one line and PageUp/PageDown one window;
 * the Yes/No options keep the arrow keys to themselves.
 */
class ScrollablePlanBody implements Component {
	#scrollTop = 0;

	constructor(
		private readonly lines: readonly string[],
		private readonly theme: Theme,
		private readonly tui: TUI,
	) {}

	get #visibleCount(): number {
		return Math.min(VISIBLE_PLAN_LINES, this.lines.length);
	}

	#scrollBy(delta: number): void {
		const visible = this.#visibleCount;
		this.#scrollTop = Math.max(0, Math.min(this.#scrollTop + delta, this.lines.length - visible));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.pageUp)) {
			this.#scrollBy(-this.#visibleCount);
		} else if (matchesKey(data, Key.pageDown)) {
			this.#scrollBy(this.#visibleCount);
		} else if (data === 'k') {
			this.#scrollBy(-1);
		} else if (data === 'j') {
			this.#scrollBy(1);
		}
	}

	invalidate(): void {
		// Stateless: rows are rebuilt from the scroll position on every render.
	}

	render(width: number): string[] {
		const visible = this.#visibleCount;
		const lines: string[] = [];
		for (const line of this.lines.slice(this.#scrollTop, this.#scrollTop + visible)) {
			lines.push(truncateToWidth(` ${this.theme.fg('text', line)}`, width));
		}
		if (this.lines.length > visible) {
			const position = `${this.#scrollTop + 1}-${this.#scrollTop + visible} of ${this.lines.length}`;
			lines.push(truncateToWidth(` ${this.theme.fg('dim', position)}`, width));
		}
		return lines;
	}
}

export async function confirmSyncPlan(
	ctx: ExtensionCommandContext,
	title: string,
	input: PlanDisplayInput,
): Promise<boolean> {
	if (ctx.mode !== 'tui') {
		return false;
	}
	return ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
		const entries = formatPlanEntries(input.files, input.packages);
		const warnings = formatPlanWarnings(input.warnings);
		const scrollable = new ScrollablePlanBody(entries, theme, tui);
		const options = ['Yes', 'No'] as const;
		const list = new OptionListBody(
			keybindings,
			() => done(false),
			(index) => done(options[index] === 'Yes'),
			options,
			theme,
			tui,
			false,
		);
		const body: Component[] = [scrollable];
		if (warnings.length > 0) {
			body.push(new Spacer(1));
			for (const warning of warnings) {
				body.push(new Text(theme.fg('warning', warning), 1, 0));
			}
		}
		body.push(new Spacer(1), list);
		const container = createDialogContainer({
			body,
			hints: formatKeyHints(theme, [
				['↑↓', 'choose'],
				['j/k', 'scroll'],
				['PgUp/PgDn', 'page'],
				[bindingKeys(keybindings, 'tui.select.confirm'), 'select'],
				[bindingKeys(keybindings, 'tui.select.cancel'), 'cancel'],
			]),
			theme,
			title,
		});
		return {
			handleInput: (data: string) => {
				// The option list owns the arrow keys; the plan body scrolls with
				// j/k and page keys, so the two never contend for input.
				list.handleInput(data);
				scrollable.handleInput(data);
			},
			invalidate: () => container.invalidate(),
			render: (width: number) => container.render(width),
		};
	});
}

export async function selectPushIncludes(
	ctx: ExtensionCommandContext,
	candidates: readonly SelectionCandidate[],
	selectedPaths: readonly SafeRelativePath[],
): Promise<readonly SafeRelativePath[] | undefined> {
	if (ctx.mode !== 'tui' || candidates.length === 0) {
		return undefined;
	}
	return ctx.ui.custom<readonly SafeRelativePath[] | undefined>((tui, theme, keybindings, done) => {
		const selected = new Set<SafeRelativePath>(selectedPaths);
		let index = 0;

		const finish = (): void => {
			done(
				candidates
					.filter((candidate) => selected.has(candidate.path))
					.map((candidate) => candidate.path),
			);
		};
		const render = (width: number): string[] => {
			const visibleCount = Math.min(VISIBLE_CANDIDATES, candidates.length);
			const first = Math.max(
				0,
				Math.min(index - Math.floor(visibleCount / 2), candidates.length - visibleCount),
			);
			const lines: string[] = [];
			for (const [offset, candidate] of candidates.slice(first, first + visibleCount).entries()) {
				const candidateIndex = first + offset;
				const focused = candidateIndex === index;
				const marker = selected.has(candidate.path) ? '[x]' : '[ ]';
				const cursor = focused ? '→ ' : '  ';
				const defaultLabel = candidate.defaultSelected ? ' (default)' : '';
				const text = `${cursor}${marker} ${candidate.path}${defaultLabel}`;
				lines.push(truncateToWidth(` ${theme.fg(focused ? 'accent' : 'text', text)}`, width));
			}
			if (candidates.length > visibleCount) {
				lines.push(
					truncateToWidth(
						` ${theme.fg('dim', `${first + 1}-${first + visibleCount} of ${candidates.length}`)}`,
						width,
					),
				);
			}
			return lines;
		};
		const handleInput = (data: string): void => {
			if (keybindings.matches(data, 'tui.select.cancel')) {
				done(undefined);
				return;
			}
			if (keybindings.matches(data, 'tui.select.up') || data === 'k') {
				index = moveCyclic(index, -1, candidates.length);
			} else if (keybindings.matches(data, 'tui.select.down') || data === 'j') {
				index = moveCyclic(index, 1, candidates.length);
			} else if (matchesKey(data, Key.space)) {
				const candidate = candidates[index];
				if (candidate !== undefined) {
					if (selected.has(candidate.path)) {
						selected.delete(candidate.path);
					} else {
						selected.add(candidate.path);
					}
				}
			} else if (keybindings.matches(data, 'tui.select.confirm') || data === '\n') {
				finish();
				return;
			} else {
				return;
			}
			tui.requestRender();
		};

		const container = createDialogContainer({
			body: { invalidate: () => undefined, render },
			hints: formatKeyHints(theme, [
				['↑↓', 'navigate'],
				['space', 'toggle'],
				[bindingKeys(keybindings, 'tui.select.confirm'), 'save'],
				[bindingKeys(keybindings, 'tui.select.cancel'), 'cancel'],
			]),
			theme,
			title: 'Select push items',
		});
		return {
			handleInput,
			invalidate: () => container.invalidate(),
			render: (width: number) => container.render(width),
		};
	});
}
