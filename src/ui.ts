import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

import type { PendingPackageOperation } from './config.js';
import type { SafeRelativePath } from './paths.js';
import type { SelectionCandidate } from './selection.js';
import type { FileMutation } from './sync-plan.js';

function actionLabel(action: FileMutation['action']): string {
	return action.toUpperCase();
}

export function formatPlanLines(input: {
	readonly files: readonly Pick<FileMutation, 'action' | 'path'>[];
	readonly packages?: readonly PendingPackageOperation[];
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
