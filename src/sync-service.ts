import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import { SettingsManager, type PackageSource } from '@earendil-works/pi-coding-agent';

import { connectionFingerprint, writeConfig, type PluginConfig } from './config.js';
import {
	FILE_OPERATION_CONCURRENCY,
	isOperationCancelled,
	mapConcurrent,
	type OperationOptions,
} from './operation.js';
import {
	applyPullPlan,
	createPullWorkspace,
	disposePullWorkspace,
	sealPullWorkspace,
	stageVerifiedFile,
	type ApplyResult,
	type PullWorkspace,
} from './local-transaction.js';
import type { ManifestFile, ManifestV1 } from './manifest.js';
import {
	applyPackageOperations,
	createGlobalPackageSyncRuntime,
	planPackageSync,
	readGlobalPackageSources,
	type PackageOperationResult,
	type PackageSyncRuntime,
} from './package-sync.js';
import {
	RemoteStore,
	UnverifiedRemoteManifestError,
	type PublishRevisionResult,
	type RemoteOperationOptions,
} from './remote-store.js';
import { collectLocalSelection, type LocalSelection } from './selection.js';
import { planPull, planPush, type PullPlan, type PushPlan } from './sync-plan.js';

export interface PushPreparation {
	readonly config: PluginConfig;
	readonly plan: PushPlan;
	readonly requiresUnverifiedManifestConfirmation: boolean;
	readonly selection: LocalSelection;
	readonly store: RemoteStore;
}

export interface PullPreparation {
	readonly config: PluginConfig;
	readonly downloadedSettings:
		{ readonly contents: Buffer; readonly file: ManifestFile } | undefined;
	readonly manifest: ManifestV1;
	readonly packageOperations: readonly import('./package-sync.js').PackageOperation[];
	readonly plan: PullPlan;
	readonly store: RemoteStore;
}

export interface StagedPull {
	readonly preparation: PullPreparation;
	readonly workspace: PullWorkspace;
}

export interface PullExecutionResult {
	readonly cancelled?: boolean;
	readonly files: ApplyResult;
	readonly packages: PackageOperationResult | undefined;
}

export type PackageRuntimeFactory = (agentRoot: string) => PackageSyncRuntime;

function normalizeOperationOptions(
	options: AbortSignal | OperationOptions | undefined,
): OperationOptions | undefined {
	if (options === undefined) {
		return undefined;
	}
	if ('aborted' in options && 'addEventListener' in options) {
		return { signal: options as AbortSignal };
	}
	return options;
}

function remoteOperationOptions(
	operation: OperationOptions | undefined,
): RemoteOperationOptions | undefined {
	if (operation === undefined) {
		return undefined;
	}
	return {
		...(operation.signal === undefined ? {} : { signal: operation.signal }),
		onProgress: (progress) => operation.onProgress?.(progress),
		onRetry: (retry) =>
			operation.onProgress?.({
				completed: retry.attempt,
				phase: 'retrying',
				total: retry.total,
			}),
	};
}

function configWithSyncState(
	config: PluginConfig,
	managedPaths: readonly import('./paths.js').SafeRelativePath[],
): PluginConfig {
	return {
		connection: config.connection,
		pushInclude: config.pushInclude,
		syncState: {
			connectionFingerprint: connectionFingerprint(config.connection),
			managedPaths,
		},
		version: config.version,
	};
}

function packageSourcesFromContents(contents: Buffer): readonly PackageSource[] {
	let settings: unknown;
	try {
		settings = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents));
	} catch {
		throw new Error('Unable to read Pi settings');
	}
	if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
		throw new Error('Unable to read Pi settings');
	}
	return readGlobalPackageSources(
		SettingsManager.inMemory(settings as { packages?: PackageSource[] }, { projectTrusted: false }),
	);
}

async function packageSourcesAfterPull(input: {
	readonly before: readonly PackageSource[];
	readonly manifest: ManifestV1;
	readonly operation?: OperationOptions;
	readonly plan: PullPlan;
	readonly store: RemoteStore;
}): Promise<{
	readonly after: readonly PackageSource[];
	readonly downloadedSettings:
		{ readonly contents: Buffer; readonly file: ManifestFile } | undefined;
}> {
	const settingsAction = input.plan.actions.find((action) => action.path === 'settings.json');
	if (settingsAction === undefined) {
		return { after: input.before, downloadedSettings: undefined };
	}
	if (settingsAction.action === 'delete') {
		return { after: [], downloadedSettings: undefined };
	}
	if (settingsAction.source === undefined) {
		throw new Error('Missing remote settings source');
	}
	// Package operations must be shown in the single pull confirmation. Read only the
	// settings declaration here; all other revision files remain untransferred until confirmation.
	const contents = await input.store.readRevisionFile(
		input.manifest,
		settingsAction.source,
		remoteOperationOptions(input.operation),
	);
	return {
		after: packageSourcesFromContents(contents),
		downloadedSettings: { contents, file: settingsAction.source },
	};
}

export async function preparePush(
	input: {
		readonly agentRoot: string;
		readonly config: PluginConfig;
		readonly store: RemoteStore;
	},
	operation?: OperationOptions,
): Promise<PushPreparation> {
	const root = resolve(input.agentRoot);
	const selection = await collectLocalSelection({
		agentRoot: root,
		enforceAuthPermissions: true,
		includes: input.config.pushInclude,
		...(operation === undefined ? {} : { operation }),
	});
	try {
		const remote = await input.store.readManifest(remoteOperationOptions(operation));
		return {
			config: input.config,
			plan: planPush({ local: selection, remote }),
			requiresUnverifiedManifestConfirmation: false,
			selection,
			store: input.store,
		};
	} catch (error: unknown) {
		if (!(error instanceof UnverifiedRemoteManifestError)) {
			throw error;
		}
		const rawManifest = await input.store.readRawManifest(remoteOperationOptions(operation));
		if (rawManifest === undefined) {
			throw error;
		}
		const plan = planPush({ local: selection, remote: undefined });
		return {
			config: input.config,
			plan: { ...plan, expectedRemoteManifestSha256: rawManifest.sha256 },
			requiresUnverifiedManifestConfirmation: true,
			selection,
			store: input.store,
		};
	}
}

export async function publishPreparedPush(
	agentRoot: string,
	preparation: PushPreparation,
	options: { readonly allowUnverifiedManifest: boolean; readonly operation?: OperationOptions },
): Promise<PublishRevisionResult> {
	if (preparation.requiresUnverifiedManifestConfirmation && !options.allowUnverifiedManifest) {
		throw new Error('Unverified remote manifest requires confirmation');
	}
	const published = await preparation.store.publishRevision(
		{
			allowUnverifiedManifest: options.allowUnverifiedManifest,
			expectedManifestSha256: preparation.plan.expectedRemoteManifestSha256,
			files: preparation.selection.files,
		},
		remoteOperationOptions(options.operation),
	);
	await writeConfig(
		agentRoot,
		configWithSyncState(
			preparation.config,
			published.manifest.files.map((file) => file.path),
		),
	);
	return published;
}

export async function preparePull(
	input: {
		readonly agentRoot: string;
		readonly config: PluginConfig;
		readonly store: RemoteStore;
	},
	packageRuntimeFactory: PackageRuntimeFactory = createGlobalPackageSyncRuntime,
	operation?: OperationOptions,
): Promise<PullPreparation> {
	const root = resolve(input.agentRoot);
	const manifestSnapshot = await input.store.readManifest(remoteOperationOptions(operation));
	if (manifestSnapshot === undefined) {
		throw new Error('The remote manifest does not exist');
	}
	const plan = await planPull({
		agentRoot: root,
		connectionFingerprint: connectionFingerprint(input.config.connection),
		manifest: manifestSnapshot.manifest,
		...(operation === undefined ? {} : { operation }),
		syncState: input.config.syncState,
	});
	const before = readGlobalPackageSources(packageRuntimeFactory(root).settingsManager);
	const packageSources = await packageSourcesAfterPull({
		before,
		manifest: manifestSnapshot.manifest,
		plan,
		store: input.store,
		...(operation === undefined ? {} : { operation }),
	});
	const packagePlan = await planPackageSync({
		after: packageSources.after,
		agentRoot: root,
		before,
	});
	return {
		config: input.config,
		downloadedSettings: packageSources.downloadedSettings,
		manifest: manifestSnapshot.manifest,
		packageOperations: packagePlan.operations,
		plan,
		store: input.store,
	};
}

export async function completeUnchangedPull(
	agentRoot: string,
	preparation: PullPreparation,
): Promise<void> {
	if (preparation.plan.actions.length > 0 || preparation.packageOperations.length > 0) {
		throw new Error('Pull contains pending changes');
	}
	await writeConfig(
		agentRoot,
		configWithSyncState(preparation.config, preparation.plan.nextManagedPaths),
	);
}

export async function stagePreparedPull(
	agentRoot: string,
	preparation: PullPreparation,
	options?: AbortSignal | OperationOptions,
): Promise<StagedPull> {
	const operation = normalizeOperationOptions(options);
	let workspace: PullWorkspace | undefined;
	try {
		const activeWorkspace = await createPullWorkspace(agentRoot);
		workspace = activeWorkspace;
		let completedDownloads = 0;
		await mapConcurrent(preparation.plan.downloads, FILE_OPERATION_CONCURRENCY, async (file) => {
			if (operation?.signal?.aborted) {
				throw new Error('Pull download cancelled');
			}
			const contents =
				preparation.downloadedSettings?.file.path === file.path
					? preparation.downloadedSettings.contents
					: await preparation.store.readRevisionFile(
							preparation.manifest,
							file,
							remoteOperationOptions(operation),
						);
			await stageVerifiedFile(agentRoot, activeWorkspace, file, contents, operation);
			completedDownloads += 1;
			operation?.onProgress?.({
				completed: completedDownloads,
				phase: 'downloading',
				total: preparation.plan.downloads.length,
			});
		});
		await sealPullWorkspace(agentRoot, activeWorkspace, preparation.manifest, operation);
		return { preparation, workspace: activeWorkspace };
	} catch (error: unknown) {
		if (workspace === undefined) {
			throw error;
		}
		try {
			await disposePullWorkspace(agentRoot, workspace);
		} catch {
			throw new Error('Pull download failed and workspace cleanup failed', { cause: error });
		}
		if (isOperationCancelled(error)) {
			throw new Error('Pull download cancelled');
		}
		throw error;
	}
}

export async function discardStagedPull(agentRoot: string, staged: StagedPull): Promise<void> {
	await disposePullWorkspace(agentRoot, staged.workspace);
}

export async function applyStagedPull(
	agentRoot: string,
	staged: StagedPull,
	packageRuntimeFactory: PackageRuntimeFactory = createGlobalPackageSyncRuntime,
	operation?: OperationOptions,
): Promise<PullExecutionResult> {
	try {
		const files = await applyPullPlan(
			agentRoot,
			staged.workspace,
			staged.preparation.plan,
			operation,
		);
		if (files.status !== 'applied') {
			return { files, packages: undefined };
		}
		const runtime = packageRuntimeFactory(resolve(agentRoot));
		readGlobalPackageSources(runtime.settingsManager);
		if (operation?.signal?.aborted) {
			return { cancelled: true, files, packages: undefined };
		}
		const packages = await applyPackageOperations(
			runtime.packageManager,
			staged.preparation.packageOperations,
			operation,
		);
		if (packages.cancelled || operation?.signal?.aborted) {
			return { cancelled: true, files, packages };
		}
		if (packages.failed.length > 0) {
			return { files, packages };
		}
		await writeConfig(
			agentRoot,
			configWithSyncState(staged.preparation.config, staged.preparation.plan.nextManagedPaths),
		);
		return { files, packages };
	} finally {
		await disposePullWorkspace(agentRoot, staged.workspace);
	}
}
