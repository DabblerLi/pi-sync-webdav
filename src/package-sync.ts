import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DefaultPackageManager,
	SettingsManager,
	type PackageSource,
} from '@earendil-works/pi-coding-agent';

import type { PendingPackageOperation } from './config.js';

interface DescribedPackageSource {
	readonly identity: string;
	readonly localPath: string | undefined;
	readonly source: string;
}

export interface PackageSyncPlan {
	readonly operations: readonly PendingPackageOperation[];
}

export interface PackageOperationResult {
	readonly failed: readonly PendingPackageOperation[];
	readonly failureMessage: string | undefined;
	readonly succeeded: readonly PendingPackageOperation[];
}

export interface PackageManagerForSync {
	install(source: string): Promise<void>;
	remove(source: string): Promise<void>;
}

export interface PackageSyncRuntime {
	readonly packageManager: PackageManagerForSync;
	readonly settingsManager: SettingsManager;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
		) {
			return true;
		}
	}
	return false;
}

function invalidPackageSource(): never {
	throw new Error('Invalid Pi package source');
}

function packageSourceString(value: unknown): string {
	const source = typeof value === 'string' ? value : isRecord(value) ? value.source : undefined;
	if (
		typeof source !== 'string' ||
		source.length === 0 ||
		source !== source.trim() ||
		hasControlCharacters(source)
	) {
		invalidPackageSource();
	}
	return source;
}

function splitPackageDeclarations(value: readonly PackageSource[] | undefined): readonly string[] {
	return (value ?? []).map(packageSourceString);
}

function npmIdentity(source: string): string {
	const spec = source.slice('npm:'.length).trim();
	if (spec.length === 0 || spec.includes('?') || spec.includes('#')) {
		invalidPackageSource();
	}
	const urlMatch = /https?:\/\//iu.exec(spec);
	if (urlMatch?.index !== undefined) {
		try {
			const url = new URL(spec.slice(urlMatch.index));
			if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0) {
				invalidPackageSource();
			}
		} catch {
			invalidPackageSource();
		}
	}
	const parsed = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/u);
	const name = parsed?.[1] ?? spec;
	if (name.length === 0 || /\s/u.test(name)) {
		invalidPackageSource();
	}
	return `npm:${name.toLowerCase()}`;
}

function gitRepositoryPath(path: string): string {
	const separator = path.indexOf('@');
	if (separator === -1) {
		return path;
	}
	const repositoryPath = path.slice(0, separator);
	const ref = path.slice(separator + 1);
	if (repositoryPath.length === 0 || ref.length === 0) {
		invalidPackageSource();
	}
	return repositoryPath;
}

function normalizeGitPath(path: string): string {
	const trimmed = path.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '');
	const segments = trimmed.split('/');
	if (segments.length < 2) {
		invalidPackageSource();
	}
	for (const segment of segments) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			invalidPackageSource();
		}
		if (
			segment.length === 0 ||
			decoded.length === 0 ||
			decoded === '.' ||
			decoded === '..' ||
			decoded.includes('/') ||
			decoded.includes('\\')
		) {
			invalidPackageSource();
		}
	}
	return trimmed;
}

function hostedGitIdentity(raw: string): string | undefined {
	const match = raw.match(/^(github|gitlab|bitbucket):(.+)$/u);
	if (match === null) {
		return undefined;
	}
	const host =
		match[1] === 'github' ? 'github.com' : match[1] === 'gitlab' ? 'gitlab.com' : 'bitbucket.org';
	const repositoryPath = match[2]?.split('#', 1)[0];
	if (repositoryPath === undefined || repositoryPath.length === 0) {
		invalidPackageSource();
	}
	return `git:${host}/${normalizeGitPath(repositoryPath)}`;
}

function gitIdentity(source: string): string | undefined {
	// Pi consumes the leading `git:` as a package-source prefix, so a bare
	// `git://` value falls through to Pi's local-source handling.
	if (source.startsWith('git://')) {
		return undefined;
	}
	if (
		!source.startsWith('git:') &&
		!source.startsWith('https://') &&
		!source.startsWith('http://') &&
		!source.startsWith('ssh://') &&
		!source.startsWith('git://')
	) {
		return undefined;
	}

	const raw =
		source.startsWith('git:') && !source.startsWith('git://')
			? source.slice('git:'.length)
			: source;
	if (raw.length === 0) {
		invalidPackageSource();
	}
	const hosted = hostedGitIdentity(raw);
	if (hosted !== undefined) {
		return hosted;
	}
	const scpMatch = raw.match(/^git@([^:]+):(.+)$/u);
	if (scpMatch !== null) {
		const host = scpMatch[1];
		const path = scpMatch[2];
		if (host === undefined || path === undefined || host.includes('@')) {
			invalidPackageSource();
		}
		return `git:${host.toLowerCase()}/${normalizeGitPath(gitRepositoryPath(path))}`;
	}

	if (raw.includes('://')) {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			invalidPackageSource();
		}
		if (
			url.hostname.length === 0 ||
			(url.protocol !== 'https:' &&
				url.protocol !== 'http:' &&
				url.protocol !== 'ssh:' &&
				url.protocol !== 'git:')
		) {
			invalidPackageSource();
		}
		if (
			url.password.length > 0 ||
			(url.username.length > 0 && !(url.protocol === 'ssh:' && url.username === 'git')) ||
			url.search.length > 0 ||
			url.hash.length > 0
		) {
			invalidPackageSource();
		}
		return `git:${url.host.toLowerCase()}/${normalizeGitPath(gitRepositoryPath(url.pathname))}`;
	}

	const separator = raw.indexOf('/');
	if (separator <= 0) {
		invalidPackageSource();
	}
	const host = raw.slice(0, separator);
	const path = raw.slice(separator + 1);
	if ((!host.includes('.') && host !== 'localhost') || host.includes('@') || host.includes(':')) {
		invalidPackageSource();
	}
	return `git:${host.toLowerCase()}/${normalizeGitPath(gitRepositoryPath(path))}`;
}

function resolveLocalPackagePath(source: string, agentRoot: string): string {
	let path = source;
	if (source === '~') {
		path = homedir();
	} else if (source.startsWith('~/')) {
		path = join(homedir(), source.slice(2));
	} else if (source.startsWith('file://')) {
		try {
			const url = new URL(source);
			if (
				url.username.length > 0 ||
				url.password.length > 0 ||
				url.search.length > 0 ||
				url.hash.length > 0
			) {
				invalidPackageSource();
			}
			path = fileURLToPath(url);
		} catch {
			invalidPackageSource();
		}
	}
	return isAbsolute(path) ? resolve(path) : resolve(agentRoot, path);
}

function describePackageSource(source: string, agentRoot: string): DescribedPackageSource {
	if (source.startsWith('npm:')) {
		return { identity: npmIdentity(source), localPath: undefined, source };
	}
	const git = gitIdentity(source);
	if (git !== undefined) {
		return { identity: git, localPath: undefined, source };
	}
	const localPath = resolveLocalPackagePath(source, agentRoot);
	return { identity: `local:${localPath}`, localPath, source };
}

function sourceMap(
	sources: readonly string[],
	agentRoot: string,
): ReadonlyMap<string, DescribedPackageSource> {
	const result = new Map<string, DescribedPackageSource>();
	for (const source of sources) {
		const described = describePackageSource(source, agentRoot);
		if (result.has(described.identity)) {
			throw new Error('Duplicate Pi package source');
		}
		result.set(described.identity, described);
	}
	return result;
}

async function assertLocalPackageSourcesExist(
	sources: ReadonlyMap<string, DescribedPackageSource>,
): Promise<void> {
	for (const source of sources.values()) {
		if (source.localPath === undefined) {
			continue;
		}
		try {
			await stat(source.localPath);
		} catch {
			throw new Error('A local Pi package path does not exist');
		}
	}
}

function compareOperations(left: PendingPackageOperation, right: PendingPackageOperation): number {
	const actionOrder = { install: 2, remove: 0, update: 1 } as const;
	if (left.action !== right.action) {
		return actionOrder[left.action] - actionOrder[right.action];
	}
	return left.source < right.source ? -1 : left.source > right.source ? 1 : 0;
}

export function readGlobalPackageSources(
	settingsManager: SettingsManager,
): readonly PackageSource[] {
	const errors = settingsManager.drainErrors();
	if (errors.some((entry) => entry.scope === 'global')) {
		throw new Error('Unable to read Pi settings');
	}
	return settingsManager.getGlobalSettings().packages ?? [];
}

export function createGlobalPackageSyncRuntime(agentRoot: string): PackageSyncRuntime {
	const root = resolve(agentRoot);
	const settingsManager = SettingsManager.create(root, root, { projectTrusted: false });
	return {
		packageManager: new DefaultPackageManager({ agentDir: root, cwd: root, settingsManager }),
		settingsManager,
	};
}

export async function planPackageSync(input: {
	readonly after: readonly PackageSource[] | undefined;
	readonly agentRoot: string;
	readonly before: readonly PackageSource[] | undefined;
}): Promise<PackageSyncPlan> {
	const before = sourceMap(splitPackageDeclarations(input.before), input.agentRoot);
	const after = sourceMap(splitPackageDeclarations(input.after), input.agentRoot);
	await assertLocalPackageSourcesExist(after);

	const operations: PendingPackageOperation[] = [];
	for (const [identity, previous] of before) {
		const next = after.get(identity);
		if (next === undefined) {
			operations.push({ action: 'remove', source: previous.source });
		} else if (next.source !== previous.source) {
			operations.push({ action: 'update', source: next.source });
		}
	}
	for (const [identity, next] of after) {
		if (!before.has(identity)) {
			operations.push({ action: 'install', source: next.source });
		}
	}
	return { operations: operations.sort(compareOperations) };
}

export function pendingPackageOperationsForDesiredState(input: {
	readonly agentRoot: string;
	readonly desired: readonly PackageSource[] | undefined;
	readonly pending: readonly PendingPackageOperation[] | undefined;
}): readonly PendingPackageOperation[] {
	const desired = sourceMap(splitPackageDeclarations(input.desired), input.agentRoot);
	return (input.pending ?? []).filter((operation) => {
		const pending = describePackageSource(operation.source, input.agentRoot);
		if (operation.action === 'remove') {
			return !desired.has(pending.identity);
		}
		return desired.get(pending.identity)?.source === operation.source;
	});
}

export function packageOperationQueue(input: {
	readonly pending: readonly PendingPackageOperation[];
	readonly planned: readonly PendingPackageOperation[];
}): readonly PendingPackageOperation[] {
	const seen = new Set<string>();
	return [...input.pending, ...input.planned].filter((operation) => {
		const key = `${operation.action}\u0000${operation.source}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

export async function applyPackageOperations(
	packageManager: PackageManagerForSync,
	operations: readonly PendingPackageOperation[],
): Promise<PackageOperationResult> {
	const failed: PendingPackageOperation[] = [];
	const succeeded: PendingPackageOperation[] = [];
	for (const operation of operations) {
		try {
			if (operation.action === 'remove') {
				await packageManager.remove(operation.source);
			} else {
				// install() reconciles exact npm versions, while Pi's update() skips pinned npm packages.
				await packageManager.install(operation.source);
			}
			succeeded.push(operation);
		} catch {
			failed.push(operation);
		}
	}
	return {
		failed,
		failureMessage: failed.length === 0 ? undefined : 'One or more Pi package operations failed',
		succeeded,
	};
}
