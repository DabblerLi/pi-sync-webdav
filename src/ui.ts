import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { CancellableLoader, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

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

export async function runCancellableOperation<T>(
	ctx: ExtensionCommandContext,
	initialProgress: OperationProgress,
	operation: (options: OperationOptions) => Promise<T>,
): Promise<CancellableOperationResult<T>> {
	if (ctx.mode !== 'tui') {
		return { cancelled: true, value: undefined };
	}
	let failure: unknown;
	const result = await ctx.ui.custom<CancellableOperationResult<T>>(
		(tui, theme, _keybindings, done) => {
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
						failure = error;
					}
					finish({ cancelled: loader.aborted, value: undefined });
				},
			);
			return loader;
		},
	);
	if (failure !== undefined) {
		throw failure;
	}
	return result;
}

export async function confirmPushSelection(
	ctx: ExtensionCommandContext,
	paths: readonly SafeRelativePath[],
): Promise<boolean> {
	if (ctx.mode !== 'tui') {
		return false;
	}
	return ctx.ui.confirm(
		'Save push selection?',
		paths.length === 0
			? 'No paths are selected.'
			: paths.map((path) => `INCLUDE ${path}`).join('\n'),
	);
}

function actionLabel(action: FileMutation['action']): string {
	return action.toUpperCase();
}

export function formatPlanLines(input: {
	readonly files: readonly Pick<FileMutation, 'action' | 'path'>[];
	readonly packages?: readonly PackageOperation[];
	readonly warnings?: readonly string[];
}): readonly string[] {
	return [
		...input.files.map((file) => `${actionLabel(file.action)} ${file.path}`),
		...(input.packages ?? []).map(
			(operation) => `${operation.action.toUpperCase()} PACKAGE ${operation.source}`,
		),
		...(input.warnings ?? []).map((warning) => `Warning: ${warning}`),
	];
}

export async function confirmSyncPlan(
	ctx: ExtensionCommandContext,
	title: string,
	input: Parameters<typeof formatPlanLines>[0],
): Promise<boolean> {
	if (ctx.mode !== 'tui') {
		return false;
	}
	const lines = formatPlanLines(input);
	return ctx.ui.confirm(title, lines.length === 0 ? 'No changes.' : lines.join('\n'));
}

export async function selectPushIncludes(
	ctx: ExtensionCommandContext,
	candidates: readonly SelectionCandidate[],
	selectedPaths: readonly SafeRelativePath[],
): Promise<readonly SafeRelativePath[] | undefined> {
	if (ctx.mode !== 'tui') {
		return undefined;
	}
	return ctx.ui.custom<readonly SafeRelativePath[] | undefined>(
		(tui, theme, _keybindings, done) => {
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
				const visibleCount = Math.min(12, candidates.length);
				const first = Math.max(
					0,
					Math.min(index - Math.floor(visibleCount / 2), candidates.length - visibleCount),
				);
				const lines = [theme.fg('accent', 'Select push items')];
				for (const [offset, candidate] of candidates.slice(first, first + visibleCount).entries()) {
					const candidateIndex = first + offset;
					const marker = selected.has(candidate.path) ? '[x]' : '[ ]';
					const cursor = candidateIndex === index ? '> ' : '  ';
					const defaultLabel = candidate.defaultSelected ? ' (default)' : '';
					const text = `${cursor}${marker} ${candidate.path}${defaultLabel}`;
					lines.push(
						truncateToWidth(theme.fg(candidateIndex === index ? 'accent' : 'text', text), width),
					);
				}
				if (candidates.length > visibleCount) {
					lines.push(
						theme.fg('dim', `${first + 1}-${first + visibleCount} of ${candidates.length}`),
					);
				}
				lines.push(theme.fg('dim', '↑↓ move • Space toggle • Enter save • Esc cancel'));
				return lines;
			};

			return {
				handleInput: (data: string) => {
					if (matchesKey(data, Key.escape)) {
						done(undefined);
						return;
					}
					if (matchesKey(data, Key.up)) {
						index = Math.max(0, index - 1);
					} else if (matchesKey(data, Key.down)) {
						index = Math.min(candidates.length - 1, index + 1);
					} else if (matchesKey(data, Key.space)) {
						const candidate = candidates[index];
						if (candidate !== undefined) {
							if (selected.has(candidate.path)) {
								selected.delete(candidate.path);
							} else {
								selected.add(candidate.path);
							}
						}
					} else if (matchesKey(data, Key.enter)) {
						finish();
						return;
					}
					tui.requestRender();
				},
				invalidate: () => undefined,
				render,
			};
		},
	);
}
