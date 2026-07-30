import {
	BorderedLoader,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';

import { connectionFingerprint, readConfig, writeConfig, type PluginConfig } from './config.js';
import { applyRestorePlan, listBackups, planRestore } from './local-transaction.js';
import { parseRemotePath, normalizeConnection, type NormalizedConnection } from './paths.js';
import { RemoteStore } from './remote-store.js';
import { promptSecret } from './secret-input.js';
import {
	collectLocalSelection,
	DEFAULT_PUSH_INCLUDES,
	listSelectionCandidates,
} from './selection.js';
import {
	applyStagedPull,
	discardStagedPull,
	preparePull,
	preparePush,
	publishPreparedPush,
	stagePreparedPull,
	type StagedPull,
} from './sync-service.js';
import { planPush } from './sync-plan.js';
import { createWebDavGateway } from './webdav.js';
import { confirmSyncPlan, formatPlanLines, selectPushIncludes } from './ui.js';

const SUBCOMMANDS = ['settings', 'status', 'diff', 'push', 'pull', 'restore'] as const;
const SETTINGS_OPTIONS = ['Connection', 'Push selection', 'Cancel'] as const;
const PASSWORD_OPTIONS = ['Keep current password', 'Change password', 'Cancel'] as const;

type SyncWebdavSubcommand = (typeof SUBCOMMANDS)[number] | 'dashboard';

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
): Promise<boolean> {
	if (hasPath(paths, 'sessions')) {
		if (
			!(await ctx.ui.confirm(
				'Include sessions?',
				'Session data may contain private conversation content. Continue?',
			))
		) {
			return false;
		}
	}
	if (hasPath(paths, 'auth.json')) {
		if (
			!(await ctx.ui.confirm(
				'Include authentication?',
				'Authentication data is sensitive. Continue?',
			))
		) {
			return false;
		}
	}
	return true;
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
		const choice = await ctx.ui.select('WebDAV password', [...PASSWORD_OPTIONS]);
		if (choice === undefined || choice === 'Cancel') {
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
		!(await ctx.ui.confirm(
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
): Promise<PluginConfig> {
	const store = new RemoteStore(
		createWebDavGateway(connection),
		parseRemotePath(connection.remotePath),
	);
	const root = await store.ensureRoot();
	if (root.kind === 'foreign') {
		throw new Error('The remote root contains unrecognized files');
	}
	const writeCapability = await store.verifyWriteCapability();
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
	const candidates = await listSelectionCandidates(agentRoot);
	const pushInclude = await selectPushIncludes(ctx, candidates, DEFAULT_PUSH_INCLUDES);
	if (pushInclude === undefined || !(await confirmOptionalPaths(ctx, pushInclude))) {
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
		const choice = await ctx.ui.select('WebDAV sync settings', [...SETTINGS_OPTIONS]);
		if (choice === undefined || choice === 'Cancel') {
			return;
		}
		if (choice === 'Connection') {
			const connection = await promptConnection(ctx, config);
			if (connection !== undefined) {
				config = await saveConnection(ctx, agentRoot, config, connection, config.pushInclude);
			}
			continue;
		}

		const candidates = await listSelectionCandidates(agentRoot);
		const pushInclude = await selectPushIncludes(ctx, candidates, config.pushInclude);
		if (pushInclude === undefined || !(await confirmOptionalPaths(ctx, pushInclude))) {
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
	const root = await store.inspectRoot();
	if (root.kind === 'managed') {
		await store.readManifest();
	}
	ctx.ui.notify(`Remote status: ${root.kind}.`, 'info');
}

async function runDiff(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	const config = await requireConfig(agentRoot);
	const store = createStore(config);
	const [remote, selection] = await Promise.all([
		store.readManifest(),
		collectLocalSelection({ agentRoot, includes: config.pushInclude }),
	]);
	const plan = planPush({ local: selection, remote });
	const lines = formatPlanLines({
		files: plan.actions,
		warnings: [
			...(selection.secretWarningPaths.length > 0
				? ['Selected text may contain credentials.']
				: []),
			...(selection.skippedSymlinkPaths.length > 0 ? ['Symbolic links were skipped.'] : []),
		],
	});
	ctx.ui.notify(lines.length === 0 ? 'No changes.' : lines.join('\n'), 'info');
}

async function runPush(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	const config = await requireConfig(agentRoot);
	if (!(await confirmOptionalPaths(ctx, config.pushInclude))) {
		return;
	}
	const store = createStore(config);
	if (config.connection.readOnly) {
		ctx.ui.notify('Push is unavailable because the remote connection is read-only.', 'warning');
		return;
	}
	const preparation = await preparePush({ agentRoot, config, store });
	if (preparation.plan.actions.length === 0) {
		ctx.ui.notify('No changes to push.', 'info');
		return;
	}
	if (
		preparation.requiresUnverifiedManifestConfirmation &&
		!(await ctx.ui.confirm(
			'Overwrite unverified manifest?',
			'The current remote manifest cannot be verified. Continue with a new manifest?',
		))
	) {
		return;
	}
	if (
		!(await confirmSyncPlan(ctx, 'Push configuration?', {
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
	const writeCapability = await store.verifyWriteCapability();
	if (!writeCapability.canWrite) {
		await writeConfig(agentRoot, {
			...config,
			connection: { ...config.connection, readOnly: true },
		});
		ctx.ui.notify('Push is unavailable because the remote connection is read-only.', 'warning');
		return;
	}
	await publishPreparedPush(agentRoot, preparation, {
		allowUnverifiedManifest: preparation.requiresUnverifiedManifestConfirmation,
	});
	ctx.ui.notify('Configuration pushed.', 'info');
}

async function stagePullWithCancellation(
	ctx: ExtensionCommandContext,
	agentRoot: string,
	preparation: Parameters<typeof stagePreparedPull>[1],
): Promise<StagedPull | undefined> {
	let cancelled = false;
	let failure: unknown;
	let failed = false;
	const staged = await ctx.ui.custom<StagedPull | undefined>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, 'Downloading configuration...');
		let completed = false;
		const finish = (result: StagedPull | undefined): void => {
			if (!completed) {
				completed = true;
				done(result);
			}
		};
		loader.onAbort = () => {
			cancelled = true;
			void operation.then(
				async (result) => {
					try {
						await discardStagedPull(agentRoot, result);
					} catch (error: unknown) {
						failure = error;
						failed = true;
					}
					finish(undefined);
				},
				() => finish(undefined),
			);
		};
		const operation = stagePreparedPull(agentRoot, preparation, loader.signal);
		void operation.then(
			(result) => {
				if (!cancelled) {
					finish(result);
				}
			},
			(error: unknown) => {
				if (!cancelled) {
					failure = error;
					failed = true;
				}
				finish(undefined);
			},
		);
		return loader;
	});
	if (failed) {
		throw failure;
	}
	return staged;
}

async function runPull(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	const config = await requireConfig(agentRoot);
	const preparation = await preparePull({ agentRoot, config, store: createStore(config) });
	if (preparation.plan.actions.length === 0 && preparation.packageOperations.length === 0) {
		ctx.ui.notify('No changes to pull.', 'info');
		return;
	}
	if (
		!(await confirmOptionalPaths(
			ctx,
			preparation.plan.actions.map((action) => action.path),
		))
	) {
		return;
	}
	if (
		!(await confirmSyncPlan(ctx, 'Pull configuration?', {
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
	const staged = await stagePullWithCancellation(ctx, agentRoot, preparation);
	if (staged === undefined) {
		ctx.ui.notify('Pull cancelled.', 'info');
		return;
	}
	const result = await applyStagedPull(agentRoot, staged);
	if (result.files.status !== 'applied') {
		ctx.ui.notify('Local changes were not applied.', 'error');
		return;
	}
	if (result.packages?.failureMessage !== undefined) {
		ctx.ui.notify(result.packages.failureMessage, 'warning');
	} else {
		ctx.ui.notify('Configuration pulled.', 'info');
	}
	if (
		preparation.plan.actions.length > 0 &&
		(await ctx.ui.confirm('Reload Pi?', 'Reload Pi resources to apply the pulled configuration?'))
	) {
		await ctx.reload();
	}
}

async function runRestore(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	const backups = await listBackups(agentRoot);
	if (backups.length === 0) {
		ctx.ui.notify('No local backups are available.', 'info');
		return;
	}
	const plan = await planRestore(agentRoot, backups);
	if (
		!(await confirmOptionalPaths(
			ctx,
			plan.actions.map((action) => action.path),
		))
	) {
		return;
	}
	if (!(await confirmSyncPlan(ctx, 'Restore local backups?', { files: plan.actions }))) {
		return;
	}
	const result = await applyRestorePlan(agentRoot, plan);
	if (result.status !== 'applied') {
		ctx.ui.notify('Local backups were not restored.', 'error');
		return;
	}
	ctx.ui.notify('Local backups restored.', 'info');
	if (await ctx.ui.confirm('Reload Pi?', 'Reload Pi resources to apply restored configuration?')) {
		await ctx.reload();
	}
}

async function runDashboard(ctx: ExtensionCommandContext, agentRoot: string): Promise<void> {
	const config = await readConfig(agentRoot);
	if (config === undefined) {
		await runSettings(ctx, agentRoot);
		return;
	}
	const options = SUBCOMMANDS.filter(
		(command) => command !== 'push' || !config.connection.readOnly,
	);
	const choice = await ctx.ui.select('WebDAV sync', [...options, 'cancel']);
	if (choice === undefined || choice === 'cancel') {
		return;
	}
	await runCommand(choice as SyncWebdavSubcommand, ctx, agentRoot);
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
