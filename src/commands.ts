import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';

import { connectionFingerprint, readConfig, writeConfig, type PluginConfig } from './config.js';
import {
	applyRestorePlan,
	listBackups,
	planRestore,
	type ApplyResult,
} from './local-transaction.js';
import {
	normalizeConnection,
	normalizeRemotePath,
	parseRemotePath,
	type NormalizedConnection,
} from './paths.js';
import type { OperationOptions, OperationProgress } from './operation.js';
import {
	RemoteStore,
	WriteCapabilityProbeCancelledError,
	type RemoteOperationOptions,
} from './remote-store.js';
import { promptSecret } from './secret-input.js';
import {
	collectLocalSelection,
	DEFAULT_PUSH_INCLUDES,
	listSelectionCandidates,
	type LocalSelection,
} from './selection.js';
import {
	applyStagedPull,
	completeUnchangedPull,
	preparePull,
	preparePush,
	publishPreparedPush,
	stagePreparedPull,
} from './sync-service.js';
import { planPush } from './sync-plan.js';
import { createWebDavGateway } from './webdav.js';
import {
	confirmDialog,
	confirmSyncPlan,
	formatPlanLines,
	runCancellableOperation,
	selectOption,
	selectPushIncludes,
} from './ui.js';

const DASHBOARD_COMMANDS = ['settings', 'status', 'diff', 'push', 'pull', 'restore'] as const;
const SUBCOMMANDS = [...DASHBOARD_COMMANDS, 'cleanup'] as const;
const SETTINGS_OPTIONS = ['Connection', 'Push selection', 'Cancel'] as const;
const PASSWORD_OPTIONS = ['Keep current password', 'Change password', 'Cancel'] as const;
const CANCEL_OPTION = 'Cancel';
const PROBE_RESIDUE_WARNING =
	'A temporary .pi-sync-webdav-probe-* folder may remain on WebDAV. Remove it manually.';
const OPTIONAL_PATH_CONFIRMATIONS = [
	{
		message: 'Session data may contain private conversation content and can be large. Continue?',
		path: 'sessions',
		title: 'Include sessions?',
	},
	{
		message: 'Authentication data is sensitive. Continue?',
		path: 'auth.json',
		title: 'Include authentication?',
	},
] as const;

type SyncWebdavSubcommand = (typeof SUBCOMMANDS)[number] | 'dashboard';

function toRemoteOperationOptions(operation: OperationOptions): RemoteOperationOptions {
	return {
		...(operation.onProgress === undefined ? {} : { onProgress: operation.onProgress }),
		...(operation.signal === undefined ? {} : { signal: operation.signal }),
		onRetry: (retry) =>
			operation.onProgress?.({
				completed: retry.attempt,
				phase: 'retrying',
				total: retry.total,
			}),
	};
}

async function runCommandOperation<T>(
	ctx: ExtensionCommandContext,
	initialProgress: OperationProgress,
	operation: (options: OperationOptions) => Promise<T>,
): Promise<{ readonly cancelled: boolean; readonly value: T | undefined }> {
	if (ctx.mode !== 'tui') {
		return { cancelled: false, value: await operation({}) };
	}
	return runCancellableOperation(ctx, initialProgress, operation);
}

function createStore(config: PluginConfig): RemoteStore {
	return new RemoteStore(
		createWebDavGateway(config.connection),
		parseRemotePath(config.connection.remotePath),
	);
}

function userVisibleError(error: unknown): string {
	return error instanceof Error && error.message.length > 0
		? error.message
		: 'The sync operation failed';
}

function applyFailureMessage(
	operation: 'Pull' | 'Restore',
	result: Exclude<ApplyResult, { readonly status: 'applied' }>,
): string {
	const failure = `${operation} failed: ${result.failureMessage}`;
	switch (result.status) {
		case 'failed':
			return failure;
		case 'rolled-back':
			return `${failure}. Earlier local changes were rolled back.`;
		case 'rollback-failed':
			return `${failure}. Local rollback did not complete.`;
	}
}

function requiresInteractiveMode(command: SyncWebdavSubcommand): boolean {
	return command !== 'status' && command !== 'diff';
}

function hasPath(paths: readonly string[], path: string): boolean {
	return paths.some((candidate) => candidate === path || candidate.startsWith(`${path}/`));
}

async function requireConfig(agentRoot: string): Promise<PluginConfig> {
	const config = await readConfig(agentRoot);
	if (config === undefined) {
		throw new Error('WebDAV sync is not configured');
	}
	return config;
}

async function confirmOptionalPaths(
	ctx: ExtensionCommandContext,
	paths: readonly string[],
	previouslyApproved: readonly string[],
): Promise<boolean> {
	for (const confirmation of OPTIONAL_PATH_CONFIRMATIONS) {
		if (
			hasPath(paths, confirmation.path) &&
			!hasPath(previouslyApproved, confirmation.path) &&
			!(await confirmDialog(ctx, confirmation.title, confirmation.message))
		) {
			return false;
		}
	}
	return true;
}

function selectionWarnings(selection: LocalSelection): readonly string[] {
	const warnings: string[] = [];
	if (selection.secretWarningPaths.length > 0) {
		warnings.push('Selected text may contain credentials.');
	}
	if (selection.skippedSymlinkPaths.length > 0) {
		warnings.push('Symbolic links were skipped.');
	}
	return warnings;
}

async function loadSelectionCandidates(
	ctx: ExtensionCommandContext,
	agentRoot: string,
	selectedPaths: PluginConfig['pushInclude'] = [],
): Promise<Awaited<ReturnType<typeof listSelectionCandidates>> | undefined> {
	const result = await runCommandOperation(ctx, { phase: 'preparing' }, (operation) =>
		listSelectionCandidates(agentRoot, selectedPaths, operation),
	);
	if (result.cancelled || result.value === undefined) {
		ctx.ui.notify('Push selection cancelled.', 'info');
		return undefined;
	}
	return result.value;
}

/** Prompts for the remote path and re-prompts on invalid input. */
async function promptRemotePath(ctx: ExtensionCommandContext): Promise<string | undefined> {
	while (true) {
		const remotePath = await ctx.ui.input('Remote path');
		if (remotePath === undefined) {
			return undefined;
		}
		try {
			normalizeRemotePath(remotePath);
		} catch (error: unknown) {
			ctx.ui.notify(userVisibleError(error), 'error');
			continue;
		}
		return remotePath;
	}
}

async function promptConnection(
	ctx: ExtensionCommandContext,
	existing: PluginConfig | undefined,
): Promise<NormalizedConnection | undefined> {
	const url = await ctx.ui.input('WebDAV URL');
	if (url === undefined) {
		return undefined;
	}
	const remotePath = await promptRemotePath(ctx);
	if (remotePath === undefined) {
		return undefined;
	}
	const username = await ctx.ui.input('Username');
	if (username === undefined) {
		return undefined;
	}

	let password: string;
	if (existing === undefined) {
		const enteredPassword = await promptSecret(ctx, 'WebDAV password');
		if (enteredPassword === undefined) {
			return undefined;
		}
		password = enteredPassword;
	} else {
		const choice = await selectOption(ctx, 'WebDAV password', PASSWORD_OPTIONS);
		if (choice === undefined || choice === CANCEL_OPTION) {
			return undefined;
		}
		if (choice === 'Keep current password') {
			password = existing.connection.password;
		} else {
			const enteredPassword = await promptSecret(ctx, 'WebDAV password');
			if (enteredPassword === undefined) {
				return undefined;
			}
			password = enteredPassword;
		}
	}

	const connection = normalizeConnection({ password, remotePath, url, username });
	if (
		connection.requiresInsecureTransportConfirmation &&
		!(await confirmDialog(
			ctx,
			'Use HTTP?',
			'HTTP sends WebDAV credentials without transport encryption. Continue?',
		))
	) {
		return undefined;
	}
	return connection;
}

async function saveConnection(
	ctx: ExtensionCommandContext,
	agentRoot: string,
	existing: PluginConfig | undefined,
	connection: NormalizedConnection,
	pushInclude: PluginConfig['pushInclude'],
): Promise<PluginConfig | undefined> {
	const store = new RemoteStore(
		createWebDavGateway(connection),
		parseRemotePath(connection.remotePath),
	);
	let cancelledProbeCleanupFailed = false;
	const validation = await runCommandOperation(ctx, { phase: 'validating' }, async (operation) => {
		try {
			const remoteOperation = toRemoteOperationOptions(operation);
			const root = await store.ensureRoot(remoteOperation);
			if (root.kind === 'foreign') {
				throw new Error('The remote root contains unrecognized files');
			}
			await store.readRawManifest(remoteOperation);
			return store.verifyWriteCapability(remoteOperation);
		} catch (error: unknown) {
			if (error instanceof WriteCapabilityProbeCancelledError) {
				cancelledProbeCleanupFailed = error.cleanupFailed;
			}
			throw error;
		}
	});
	if (validation.cancelled || validation.value === undefined) {
		if (cancelledProbeCleanupFailed) {
			ctx.ui.notify(PROBE_RESIDUE_WARNING, 'warning');
		}
		ctx.ui.notify('Connection validation cancelled.', 'info');
		return undefined;
	}
	const writeCapability = validation.value;
	const sameConnection =
		existing !== undefined &&
		connectionFingerprint(existing.connection) === connectionFingerprint(connection);
	const config: PluginConfig = {
		connection: { ...connection, readOnly: !writeCapability.canWrite },
		pushInclude,
		...(sameConnection && existing.syncState !== undefined
			? { syncState: existing.syncState }
			: {}),
		version: 1,
	};
	await writeConfig(agentRoot, config);
	if (writeCapability.cleanupFailed) {
		ctx.ui.notify(PROBE_RESIDUE_WARNING, 'warning');
	}
	ctx.ui.notify(
		writeCapability.canWrite
			? 'WebDAV connection saved.'
			: 'WebDAV connection saved in read-only mode.',
		writeCapability.canWrite ? 'info' : 'warning',
	);
	return config;
}

async function runInitialConfiguration(
	ctx: ExtensionCommandContext,
	agentRoot: string,
): Promise<void> {
	const connection = await promptConnection(ctx, undefined);
	if (connection === undefined) {
		return;
	}
	const candidates = await loadSelectionCandidates(ctx, agentRoot);
	if (candidates === undefined) {
		return;
	}
	const pushInclude = await selectPushIncludes(ctx, candidates, DEFAULT_PUSH_INCLUDES);
	if (pushInclude === undefined || !(await confirmOptionalPaths(ctx, pushInclude, []))) {
		return;
	}
	await saveConnection(ctx, agentRoot, undefined, connection, pushInclude);
}

async function runSettings(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	let config = await readConfig(agentRoot);
	if (config === undefined) {
		await runInitialConfiguration(ctx, agentRoot);
		return;
	}

	while (true) {
		const choice = await selectOption(ctx, 'WebDAV sync settings', SETTINGS_OPTIONS);
		if (choice === undefined || choice === CANCEL_OPTION) {
			return;
		}
		if (choice === 'Connection') {
			const connection = await promptConnection(ctx, config);
			if (connection !== undefined) {
				const saved = await saveConnection(ctx, agentRoot, config, connection, config.pushInclude);
				if (saved !== undefined) {
					config = saved;
				}
			}
			continue;
		}

		const candidates = await loadSelectionCandidates(ctx, agentRoot, config.pushInclude);
		if (candidates === undefined) {
			continue;
		}
		const pushInclude = await selectPushIncludes(ctx, candidates, config.pushInclude);
		if (
			pushInclude === undefined ||
			!(await confirmOptionalPaths(ctx, pushInclude, config.pushInclude))
		) {
			continue;
		}
		config = { ...config, pushInclude };
		await writeConfig(agentRoot, config);
		ctx.ui.notify('Push selection saved.', 'info');
	}
}

async function runStatus(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	const config = await requireConfig(agentRoot);
	const store = createStore(config);
	const result = await runCommandOperation(ctx, { phase: 'validating' }, async (operation) => {
		const remoteOperation = toRemoteOperationOptions(operation);
		const root = await store.inspectRoot(remoteOperation);
		let manifest;
		if (root.kind === 'managed') {
			manifest = await store.readManifest(remoteOperation);
		} else {
			await store.readRawManifest(remoteOperation);
		}
		return { manifest, root };
	});
	if (result.cancelled || result.value === undefined) {
		ctx.ui.notify('Status check cancelled.', 'info');
		return;
	}
	const { manifest, root } = result.value;
	if (root.kind === 'foreign') {
		ctx.ui.notify(
			'The remote folder contains unrecognized files; sync data is unavailable.',
			'warning',
		);
		return;
	}
	const mode = config.connection.readOnly ? ' (read-only)' : '';
	if (root.kind === 'missing') {
		ctx.ui.notify(`Remote connection OK${mode}. The remote folder does not exist yet.`, 'info');
		return;
	}
	if (manifest === undefined) {
		ctx.ui.notify(`Remote connection OK${mode}. No synced configuration yet.`, 'info');
		return;
	}
	const count = manifest.manifest.files.length;
	ctx.ui.notify(
		`Remote connection OK${mode}. A synced configuration with ${count} ${count === 1 ? 'file' : 'files'} is available.`,
		'info',
	);
}

async function runDiff(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	const config = await requireConfig(agentRoot);
	const store = createStore(config);
	const result = await runCommandOperation(ctx, { phase: 'preparing' }, async (operation) => {
		const [remote, selection] = await Promise.all([
			store.readManifest(toRemoteOperationOptions(operation)),
			collectLocalSelection({ agentRoot, includes: config.pushInclude, operation }),
		]);
		return { plan: planPush({ local: selection, remote }), selection };
	});
	if (result.cancelled || result.value === undefined) {
		ctx.ui.notify('Diff cancelled.', 'info');
		return;
	}
	const lines = formatPlanLines({
		files: result.value.plan.actions,
		warnings: selectionWarnings(result.value.selection),
	});
	ctx.ui.notify(lines.length === 0 ? 'No changes.' : lines.join('\n'), 'info');
}

async function runPush(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	const config = await requireConfig(agentRoot);
	const store = createStore(config);
	if (config.connection.readOnly) {
		ctx.ui.notify('Push is unavailable because the remote connection is read-only.', 'warning');
		return;
	}
	const prepared = await runCommandOperation(ctx, { phase: 'preparing' }, (operation) =>
		preparePush({ agentRoot, config, store }, operation),
	);
	if (prepared.cancelled || prepared.value === undefined) {
		ctx.ui.notify('Push cancelled.', 'info');
		return;
	}
	const preparation = prepared.value;
	if (
		preparation.plan.actions.length === 0 &&
		!preparation.requiresUnverifiedManifestConfirmation
	) {
		ctx.ui.notify('No changes to push.', 'info');
		return;
	}
	if (
		preparation.requiresUnverifiedManifestConfirmation &&
		!(await confirmDialog(
			ctx,
			'Overwrite unverified manifest?',
			'The current remote manifest cannot be verified. Continue with a new manifest?',
		))
	) {
		return;
	}
	if (
		preparation.plan.actions.length > 0 &&
		!(await confirmSyncPlan(ctx, 'Push these changes to WebDAV?', {
			files: preparation.plan.actions,
			warnings: selectionWarnings(preparation.selection),
		}))
	) {
		return;
	}
	const published = await runCommandOperation(ctx, { phase: 'uploading' }, (operation) =>
		publishPreparedPush(agentRoot, preparation, {
			allowUnverifiedManifest: preparation.requiresUnverifiedManifestConfirmation,
			operation,
		}),
	);
	if (published.value === undefined) {
		ctx.ui.notify('Push cancelled.', 'info');
		return;
	}
	if (published.value.previousRevisionCleanup === 'failed') {
		ctx.ui.notify('A previous remote revision remains. Run /sync-webdav cleanup.', 'warning');
	} else if (published.value.previousRevisionCleanup === 'retained') {
		ctx.ui.notify('A previous remote revision is active and was retained.', 'warning');
	}
	ctx.ui.notify(
		published.cancelled
			? 'Configuration pushed after the cancellation request.'
			: 'Configuration pushed.',
		published.cancelled ? 'warning' : 'info',
	);
}

async function runPull(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	const config = await requireConfig(agentRoot);
	const store = createStore(config);
	const prepared = await runCommandOperation(ctx, { phase: 'preparing' }, (operation) =>
		preparePull({ agentRoot, config, store }, undefined, operation),
	);
	if (prepared.cancelled || prepared.value === undefined) {
		ctx.ui.notify('Pull cancelled.', 'info');
		return;
	}
	const preparation = prepared.value;
	if (preparation.plan.actions.length === 0 && preparation.packageOperations.length === 0) {
		await completeUnchangedPull(agentRoot, preparation);
		ctx.ui.notify('No changes to pull.', 'info');
		return;
	}
	if (
		!(await confirmSyncPlan(ctx, 'Apply these changes from WebDAV?', {
			files: preparation.plan.actions,
			packages: preparation.packageOperations,
			warnings:
				preparation.packageOperations.length === 0
					? []
					: ['Package code will run with your user permissions.'],
		}))
	) {
		return;
	}
	const pulled = await runCommandOperation(ctx, { phase: 'downloading' }, async (operation) => {
		const staged = await stagePreparedPull(agentRoot, preparation, operation);
		return applyStagedPull(agentRoot, staged, undefined, operation);
	});
	if (pulled.value === undefined) {
		ctx.ui.notify('Pull cancelled.', 'info');
		return;
	}
	const result = pulled.value;
	if (result.cancelled) {
		ctx.ui.notify(
			result.packages?.failureMessage ?? 'Pull cancelled after local files were applied.',
			'warning',
		);
		return;
	}
	if (result.files.status !== 'applied') {
		ctx.ui.notify(
			pulled.cancelled
				? 'Pull cancelled before local changes completed.'
				: applyFailureMessage('Pull', result.files),
			'error',
		);
		return;
	}
	if (result.packages?.failureMessage !== undefined) {
		ctx.ui.notify(result.packages.failureMessage, 'warning');
	} else {
		ctx.ui.notify(
			pulled.cancelled
				? 'Configuration pulled after the cancellation request.'
				: 'Configuration pulled.',
			pulled.cancelled ? 'warning' : 'info',
		);
	}
	if (
		preparation.plan.actions.length > 0 &&
		(await confirmDialog(
			ctx,
			'Reload Pi?',
			'Reload Pi resources to apply the pulled configuration?',
		))
	) {
		await ctx.reload();
	}
}

async function runRestore(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	const prepared = await runCommandOperation(ctx, { phase: 'restoring' }, async (operation) => {
		const backups = await listBackups(agentRoot, operation);
		return backups.length === 0 ? undefined : planRestore(agentRoot, backups, operation);
	});
	if (prepared.cancelled) {
		ctx.ui.notify('Restore cancelled.', 'info');
		return;
	}
	if (prepared.value === undefined) {
		ctx.ui.notify('No local backups are available.', 'info');
		return;
	}
	const plan = prepared.value;
	if (!(await confirmSyncPlan(ctx, 'Restore these local backups?', { files: plan.actions }))) {
		return;
	}
	const restored = await runCommandOperation(ctx, { phase: 'restoring' }, (operation) =>
		applyRestorePlan(agentRoot, plan, operation),
	);
	if (restored.value === undefined) {
		ctx.ui.notify('Restore cancelled.', 'info');
		return;
	}
	if (restored.value.status !== 'applied') {
		ctx.ui.notify(
			restored.cancelled
				? 'Restore cancelled before local changes completed.'
				: applyFailureMessage('Restore', restored.value),
			'error',
		);
		return;
	}
	ctx.ui.notify(
		restored.cancelled
			? 'Local backups restored after the cancellation request.'
			: 'Local backups restored.',
		restored.cancelled ? 'warning' : 'info',
	);
	if (
		await confirmDialog(ctx, 'Reload Pi?', 'Reload Pi resources to apply restored configuration?')
	) {
		await ctx.reload();
	}
}

async function runCleanup(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	const config = await requireConfig(agentRoot);
	if (config.connection.readOnly) {
		ctx.ui.notify(
			'Remote cleanup is unavailable because the remote connection is read-only.',
			'warning',
		);
		return;
	}
	const store = createStore(config);
	const inspected = await runCommandOperation(ctx, { phase: 'cleaning' }, (operation) =>
		store.inspectResidue(toRemoteOperationOptions(operation)),
	);
	if (inspected.cancelled || inspected.value === undefined) {
		ctx.ui.notify('Remote cleanup cancelled.', 'info');
		return;
	}
	const residue = inspected.value;
	if (residue.candidates.length === 0) {
		ctx.ui.notify(
			residue.unknownCount === 0
				? 'No verified remote residue is available to clean.'
				: 'No verified remote residue is available to clean. Unrecognized remote items were retained.',
			'info',
		);
		return;
	}
	if (
		!(await confirmSyncPlan(ctx, 'Delete this remote residue?', {
			files: residue.candidates.map((candidate) => ({
				action: 'delete' as const,
				path: candidate.path,
			})),
			warnings: residue.unknownCount === 0 ? [] : ['Unrecognized remote items will be retained.'],
		}))
	) {
		return;
	}
	const cleaned = await runCommandOperation(ctx, { phase: 'cleaning' }, (operation) =>
		store.cleanupResidue(residue.candidates, toRemoteOperationOptions(operation)),
	);
	if (cleaned.cancelled || cleaned.value === undefined) {
		ctx.ui.notify('Remote cleanup cancelled.', 'info');
		return;
	}
	const result = cleaned.value;
	if (result.failed.length > 0 || result.retained.length > 0) {
		ctx.ui.notify(
			'Some remote residue was retained. Check that WebDAV is reachable and writable, then run /sync-webdav cleanup again.',
			'warning',
		);
		return;
	}
	ctx.ui.notify('Remote residue cleaned.', 'info');
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

async function runDashboard(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	const config = await readConfig(agentRoot);
	if (config === undefined) {
		await runSettings(ctx, agentRoot);
		return;
	}
	const entries: ReadonlyArray<{
		readonly command: SyncWebdavSubcommand | 'cancel';
		readonly label: string;
	}> = [
		...DASHBOARD_COMMANDS.filter(
			(command) => command !== 'push' || !config.connection.readOnly,
		).map((command) => ({ command, label: capitalize(command) })),
		{ command: 'cancel' as const, label: CANCEL_OPTION },
	];
	const choice = await selectOption(
		ctx,
		'WebDAV sync',
		entries.map((entry) => entry.label),
	);
	const entry = entries.find((candidate) => candidate.label === choice);
	if (entry === undefined || entry.command === 'cancel') {
		return;
	}
	await runCommand(entry.command, ctx, agentRoot);
}

async function runCommand(
	command: SyncWebdavSubcommand,
	ctx: ExtensionCommandContext,
	agentRoot: string,
): Promise<void> {
	if (requiresInteractiveMode(command) && ctx.mode !== 'tui') {
		ctx.ui.notify('This action requires an interactive terminal.', 'error');
		return;
	}
	switch (command) {
		case 'dashboard':
			await runDashboard(ctx, agentRoot);
			return;
		case 'settings':
			await runSettings(ctx, agentRoot);
			return;
		case 'status':
			await runStatus(ctx, agentRoot);
			return;
		case 'diff':
			await runDiff(ctx, agentRoot);
			return;
		case 'push':
			await runPush(ctx, agentRoot);
			return;
		case 'pull':
			await runPull(ctx, agentRoot);
			return;
		case 'restore':
			await runRestore(ctx, agentRoot);
			return;
		case 'cleanup':
			await runCleanup(ctx, agentRoot);
			return;
	}
}

export function parseSyncWebdavCommand(args: string): SyncWebdavSubcommand | undefined {
	const parts = args.trim().split(/\s+/u).filter(Boolean);
	if (parts.length === 0) {
		return 'dashboard';
	}
	if (parts.length !== 1 || !SUBCOMMANDS.includes(parts[0] as (typeof SUBCOMMANDS)[number])) {
		return undefined;
	}
	return parts[0] as SyncWebdavSubcommand;
}

export function registerSyncWebdavCommands(
	pi: ExtensionAPI,
	getRoot: () => string = getAgentDir,
): void {
	pi.registerCommand('sync-webdav', {
		description: 'Manually sync Pi configuration through WebDAV.',
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
				label: command,
				value: command,
			})),
		handler: async (args, ctx) => {
			const command = parseSyncWebdavCommand(args);
			if (command === undefined) {
				ctx.ui.notify(`Usage: /sync-webdav [${SUBCOMMANDS.join('|')}]`, 'error');
				return;
			}
			try {
				await runCommand(command, ctx, getRoot());
			} catch (error: unknown) {
				ctx.ui.notify(userVisibleError(error), 'error');
			}
		},
	});
}
