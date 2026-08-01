import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { OperationOptions } from './operation.js';

import {
	DefaultPackageManager,
	SettingsManager,
	type PackageSource,
} from '@earendil-works/pi-coding-agent';

interface DescribedPackageSource {
	readonly identity: string;
	readonly gitTransport: 'git' | 'http' | 'https' | 'ssh' | undefined;
	readonly localPath: string | undefined;
	readonly source: string;
}

interface DescribedGitSource {
	readonly identity: string;
	readonly transport: 'git' | 'http' | 'https' | 'ssh';
}

export type PackageOperation =
	| {
			readonly action: 'install' | 'remove' | 'update';
			readonly source: string;
	  }
	| {
			readonly action: 'replace';
			readonly previousSource: string;
			readonly source: string;
	  };

export interface PackageSyncPlan {
	readonly operations: readonly PackageOperation[];
}

export interface PackageOperationResult {
	readonly cancelled?: boolean;
	readonly failed: readonly PackageOperation[];
	readonly failureMessage: string | undefined;
	readonly succeeded: readonly PackageOperation[];
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

const MAX_PERCENT_DECODE_DEPTH = 8;
const UNSAFE_GIT_REF_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', '\\', '@']);

function decodePackageSpecPart(value: string): string {
	let decoded = value;
	for (let depth = 0; depth < MAX_PERCENT_DECODE_DEPTH; depth += 1) {
		if (!decoded.includes('%')) {
			return decoded;
		}
		try {
			decoded = decodeURIComponent(decoded);
		} catch {
			invalidPackageSource();
		}
	}
	if (decoded.includes('%')) {
		invalidPackageSource();
	}
	return decoded;
}

function assertSafeNpmVersionSpec(value: string | undefined): void {
	if (value === undefined) {
		return;
	}
	const decoded = decodePackageSpecPart(value);
	if (decoded.length === 0 || /[@:\\/]/u.test(decoded)) {
		invalidPackageSource();
	}
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
	if (parsed === null) {
		invalidPackageSource();
	}
	const name = parsed[1];
	if (name === undefined || name.length === 0 || /\s/u.test(name)) {
		invalidPackageSource();
	}
	assertSafeNpmVersionSpec(parsed[2]);
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
	assertSafeGitRef(ref);
	return repositoryPath;
}

function normalizeGitPath(path: string): string {
	const trimmed = path.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '');
	const segments = trimmed.split('/');
	if (segments.length < 2) {
		invalidPackageSource();
	}
	for (const segment of segments) {
		const decoded = decodePackageSpecPart(segment);
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

function containsUnsafeGitRefCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0);
		if (
			(code !== undefined && (code <= 0x20 || code === 0x7f)) ||
			UNSAFE_GIT_REF_CHARACTERS.has(character)
		) {
			return true;
		}
	}
	return false;
}

function assertSafeGitRef(ref: string | undefined): void {
	if (ref === undefined) {
		return;
	}
	const decoded = decodePackageSpecPart(ref);
	if (decoded.startsWith('semver:')) {
		const range = decoded.slice('semver:'.length);
		if (range.length === 0 || !/^[0-9A-Za-z*+._^~<>=| -]+$/u.test(range)) {
			invalidPackageSource();
		}
		return;
	}
	if (
		decoded.length === 0 ||
		containsUnsafeGitRefCharacter(decoded) ||
		decoded.includes('..') ||
		decoded.includes('@{') ||
		decoded.startsWith('/') ||
		decoded.endsWith('/')
	) {
		invalidPackageSource();
	}
	for (const component of decoded.split('/')) {
		if (
			component.length === 0 ||
			component === '.' ||
			component === '..' ||
			component.endsWith('.') ||
			component.endsWith('.lock')
		) {
			invalidPackageSource();
		}
	}
}

function describeHostedGitSource(raw: string): DescribedGitSource | undefined {
	const match = raw.match(/^(github|gitlab|bitbucket):(.+)$/u);
	if (match === null) {
		return undefined;
	}
	if (raw.includes('?')) {
		invalidPackageSource();
	}
	const host =
		match[1] === 'github' ? 'github.com' : match[1] === 'gitlab' ? 'gitlab.com' : 'bitbucket.org';
	const sourcePath = match[2];
	if (sourcePath === undefined) {
		invalidPackageSource();
	}
	const fragmentIndex = sourcePath.indexOf('#');
	if (fragmentIndex !== sourcePath.lastIndexOf('#')) {
		invalidPackageSource();
	}
	const repositoryPath = fragmentIndex === -1 ? sourcePath : sourcePath.slice(0, fragmentIndex);
	if (repositoryPath.length === 0) {
		invalidPackageSource();
	}
	assertSafeGitRef(fragmentIndex === -1 ? undefined : sourcePath.slice(fragmentIndex + 1));
	const identity = normalizeGitPath(repositoryPath);
	if (identity.split('/').some((segment) => /[@:?]/u.test(decodePackageSpecPart(segment)))) {
		invalidPackageSource();
	}
	return { identity: `git:${host}/${identity}`, transport: 'https' };
}

function describeGitSource(source: string): DescribedGitSource | undefined {
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
	const hosted = describeHostedGitSource(raw);
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
		return {
			identity: `git:${host.toLowerCase()}/${normalizeGitPath(gitRepositoryPath(path))}`,
			transport: 'ssh',
		};
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
		return {
			identity: `git:${url.host.toLowerCase()}/${normalizeGitPath(gitRepositoryPath(url.pathname))}`,
			transport: url.protocol.slice(0, -1) as DescribedGitSource['transport'],
		};
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
	return {
		identity: `git:${host.toLowerCase()}/${normalizeGitPath(gitRepositoryPath(path))}`,
		transport: 'https',
	};
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
		return {
			gitTransport: undefined,
			identity: npmIdentity(source),
			localPath: undefined,
			source,
		};
	}
	const git = describeGitSource(source);
	if (git !== undefined) {
		return {
			gitTransport: git.transport,
			identity: git.identity,
			localPath: undefined,
			source,
		};
	}
	const localPath = resolveLocalPackagePath(source, agentRoot);
	return {
		gitTransport: undefined,
		identity: `local:${localPath}`,
		localPath,
		source,
	};
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

function compareOperations(left: PackageOperation, right: PackageOperation): number {
	const actionOrder = { install: 3, remove: 0, replace: 1, update: 2 } as const;
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

	const operations: PackageOperation[] = [];
	for (const [identity, previous] of before) {
		const next = after.get(identity);
		if (next === undefined) {
			operations.push({ action: 'remove', source: previous.source });
		} else if (next.source !== previous.source) {
			if (
				previous.gitTransport !== undefined &&
				next.gitTransport !== undefined &&
				previous.gitTransport !== next.gitTransport
			) {
				operations.push({
					action: 'replace',
					previousSource: previous.source,
					source: next.source,
				});
			} else {
				operations.push({ action: 'update', source: next.source });
			}
		}
	}
	for (const [identity, next] of after) {
		if (!before.has(identity)) {
			operations.push({ action: 'install', source: next.source });
		}
	}
	return { operations: operations.sort(compareOperations) };
}

export async function applyPackageOperations(
	packageManager: PackageManagerForSync,
	operations: readonly PackageOperation[],
	operationOptions?: OperationOptions,
): Promise<PackageOperationResult> {
	const failed: PackageOperation[] = [];
	const succeeded: PackageOperation[] = [];
	const cancelled = (): PackageOperationResult => ({
		cancelled: true,
		failed,
		failureMessage:
			failed.length > 0 || succeeded.length < operations.length
				? 'One or more Pi package operations failed. Resolve them manually.'
				: undefined,
		succeeded,
	});
	for (const operation of operations) {
		if (operationOptions?.signal?.aborted) {
			return cancelled();
		}
		operationOptions?.onProgress?.({ phase: 'applying' });
		if (operationOptions?.signal?.aborted) {
			return cancelled();
		}
		try {
			if (operation.action === 'remove') {
				await packageManager.remove(operation.source);
			} else if (operation.action === 'replace') {
				await packageManager.remove(operation.previousSource);
				if (operationOptions?.signal?.aborted) {
					return cancelled();
				}
				await packageManager.install(operation.source);
			} else {
				// install() reconciles exact npm versions, while Pi's update() skips pinned npm packages.
				await packageManager.install(operation.source);
			}
			succeeded.push(operation);
		} catch {
			failed.push(operation);
		}
		if (operationOptions?.signal?.aborted) {
			return cancelled();
		}
	}
	return {
		failed,
		failureMessage:
			failed.length === 0
				? undefined
				: 'One or more Pi package operations failed. Resolve them manually.',
		succeeded,
	};
}
