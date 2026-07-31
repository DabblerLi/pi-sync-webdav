import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';

import { connectionFingerprint, readConfig, writeConfig, type PluginConfig } from './config.js';
import { applyRestorePlan, listBackups, planRestore } from './local-transaction.js';
import { parseRemotePath, normalizeConnection, type NormalizedConnection } from './paths.js';
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
} from './selection.js';
import {
	applyStagedPull,
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

const SUBCOMMANDS = ['settings', 'status', 'diff', 'push', 'pull', 'restore'] as const;
const SETTINGS_OPTIONS = ['Connection', 'Push selection', 'Cancel'] as const;
const PASSWORD_OPTIONS = ['Keep current password', 'Change password', 'Cancel'] as const;
const CLEANUP_OPTION = 'Clean remote residue';
const CANCEL_OPTION = 'Cancel';

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

function isMutatingCommand(command: SyncWebdavSubcommand): boolean {
	return (
		command === 'dashboard' ||
		command === 'settings' ||
		command === 'push' ||
		command === 'pull' ||
		command === 'restore'
	);
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
	if (hasPath(paths, 'sessions') && !hasPath(previouslyApproved, 'sessions')) {
		if (
			!(await confirmDialog(
				ctx,
				'Include sessions?',
				'Session data may contain private conversation content and can be large. Continue?',
			))
		) {
			return false;
		}
	}
	if (hasPath(paths, 'auth.json') && !hasPath(previouslyApproved, 'auth.json')) {
		if (
			!(await confirmDialog(
				ctx,
				'Include authentication?',
				'Authentication data is sensitive. Continue?',
			))
		) {
			return false;
		}
	}
	return true;
}

async function loadSelectionCandidates(
	ctx: ExtensionCommandContext,
	agentRoot: string,
): Promise<Awaited<ReturnType<typeof listSelectionCandidates>> | undefined> {
	const result = await runCommandOperation(ctx, { phase: 'preparing' }, (operation) =>
		listSelectionCandidates(agentRoot, operation),
	);
	if (result.cancelled || result.value === undefined) {
		ctx.ui.notify('Push selection cancelled.', 'info');
		return undefined;
	}
	return result.value;
}

async function promptConnection(
	ctx: ExtensionCommandContext,
	existing: PluginConfig | undefined,
): Promise<NormalizedConnection | undefined> {
	const url = await ctx.ui.input('WebDAV URL', existing?.connection.url);
	if (url === undefined) {
		return undefined;
	}
	const remotePath = await ctx.ui.input(
		'Remote path',
		existing?.connection.remotePath ?? 'pi-sync-webdav/',
	);
	if (remotePath === undefined) {
		return undefined;
	}
	const username = await ctx.ui.input('Username', existing?.connection.username);
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
			const root = await store.ensureRoot(toRemoteOperationOptions(operation));
			if (root.kind === 'foreign') {
				throw new Error('The remote root contains unrecognized files');
			}
			await store.verifyReadCapability(toRemoteOperationOptions(operation));
			return store.verifyWriteCapability(toRemoteOperationOptions(operation));
		} catch (error: unknown) {
			if (error instanceof WriteCapabilityProbeCancelledError) {
				cancelledProbeCleanupFailed = error.cleanupFailed;
			}
			throw error;
		}
	});
	if (validation.cancelled || validation.value === undefined) {
		if (cancelledProbeCleanupFailed) {
			ctx.ui.notify(
				'Remote validation residue may remain. Reopen WebDAV sync, then use dashboard cleanup.',
				'warning',
			);
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
		ctx.ui.notify('Remote validation residue may remain. Use dashboard cleanup.', 'warning');
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

		const candidates = await loadSelectionCandidates(ctx, agentRoot);
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
		await store.verifyReadCapability(remoteOperation);
		const manifest =
			root.kind === 'managed' ? await store.readManifest(remoteOperation) : undefined;
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
		warnings: [
			...(result.value.selection.secretWarningPaths.length > 0
				? ['Selected text may contain credentials.']
				: []),
			...(result.value.selection.skippedSymlinkPaths.length > 0
				? ['Symbolic links were skipped.']
				: []),
		],
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
	if (preparation.plan.actions.length === 0) {
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
		!(await confirmSyncPlan(ctx, 'Push these changes to WebDAV?', {
			files: preparation.plan.actions,
			warnings: [
				...(preparation.selection.secretWarningPaths.length > 0
					? ['Selected text may contain credentials.']
					: []),
				...(preparation.selection.skippedSymlinkPaths.length > 0
					? ['Symbolic links were skipped.']
					: []),
			],
		}))
	) {
		return;
	}
	let cancelledProbeCleanupFailed = false;
	const published = await runCommandOperation(ctx, { phase: 'validating' }, async (operation) => {
		try {
			const writeCapability = await store.verifyWriteCapability(
				toRemoteOperationOptions(operation),
			);
			if (!writeCapability.canWrite) {
				return { kind: 'read-only' as const, writeCapability };
			}
			return {
				kind: 'published' as const,
				result: await publishPreparedPush(agentRoot, preparation, {
					allowUnverifiedManifest: preparation.requiresUnverifiedManifestConfirmation,
					operation,
				}),
			};
		} catch (error: unknown) {
			if (error instanceof WriteCapabilityProbeCancelledError) {
				cancelledProbeCleanupFailed = error.cleanupFailed;
			}
			throw error;
		}
	});
	if (published.value?.kind === 'read-only') {
		await writeConfig(agentRoot, {
			...config,
			connection: { ...config.connection, readOnly: true },
		});
		if (published.value.writeCapability.cleanupFailed) {
			ctx.ui.notify('Remote validation residue may remain. Use dashboard cleanup.', 'warning');
		}
		ctx.ui.notify('Push is unavailable because the remote connection is read-only.', 'warning');
		return;
	}
	if (published.value === undefined) {
		if (cancelledProbeCleanupFailed) {
			ctx.ui.notify('Remote validation residue may remain. Use dashboard cleanup.', 'warning');
		}
		ctx.ui.notify('Push cancelled.', 'info');
		return;
	}
	if (published.value.result.previousRevisionCleanup === 'failed') {
		ctx.ui.notify('A previous remote revision remains. Use dashboard cleanup.', 'warning');
	} else if (published.value.result.previousRevisionCleanup === 'retained') {
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
				: 'Local changes were not applied.',
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
				: 'Local backups were not restored.',
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
			'Some remote residue was retained. Run dashboard cleanup again after resolving access.',
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
		readonly command: SyncWebdavSubcommand | 'cancel' | 'cleanup';
		readonly label: string;
	}> = [
		...SUBCOMMANDS.filter((command) => command !== 'push' || !config.connection.readOnly).map(
			(command) => ({ command, label: capitalize(command) }),
		),
		...(!config.connection.readOnly
			? [{ command: 'cleanup' as const, label: CLEANUP_OPTION }]
			: []),
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
	if (entry.command === 'cleanup') {
		await runCleanup(ctx, agentRoot);
		return;
	}
	await runCommand(entry.command, ctx, agentRoot);
}

async function runCommand(
	command: SyncWebdavSubcommand,
	ctx: ExtensionCommandContext,
	agentRoot: string,
): Promise<void> {
	if (isMutatingCommand(command) && ctx.mode !== 'tui') {
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
				ctx.ui.notify('Usage: /sync-webdav [settings|status|diff|push|pull|restore]', 'error');
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
