import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

declare const normalizedUrlBrand: unique symbol;
declare const remotePathBrand: unique symbol;
declare const safeRelativePathBrand: unique symbol;

export type NormalizedUrl = string & { readonly [normalizedUrlBrand]: true };
export type RemotePath = string & { readonly [remotePathBrand]: true };
export type SafeRelativePath = string & { readonly [safeRelativePathBrand]: true };

export const PRIVATE_DIRECTORY_NAME = 'pi-sync-webdav';
export const CONFIG_FILE_NAME = 'config.json';

const DRIVE_PREFIX_PATTERN = /^[a-zA-Z]:/u;
const WINDOWS_FORBIDDEN_PATH_CHARACTER_PATTERN = /[<>:"|?*]/u;
const WINDOWS_RESERVED_DEVICE_NAME_PATTERN =
	/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;
const PERMANENTLY_EXCLUDED_TOP_LEVEL_NAMES = new Set(['npm', 'git', PRIVATE_DIRECTORY_NAME]);
const RECURSIVELY_EXCLUDED_NAMES = new Set(['logs', 'node_modules']);

export interface ConnectionInput {
	readonly password: string;
	readonly remotePath: string;
	readonly url: string;
	readonly username: string;
}

export interface NormalizedConnection {
	readonly password: string;
	readonly remotePath: RemotePath;
	readonly requiresInsecureTransportConfirmation: boolean;
	readonly url: NormalizedUrl;
	readonly username: string;
}

export interface PrivatePaths {
	readonly backupsDirectory: string;
	readonly configFile: string;
	readonly directory: string;
	readonly workspaceDirectory: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, message: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || !value.isWellFormed()) {
		throw new Error(message);
	}
}

interface PathNode {
	readonly children: Map<string, PathNode>;
	terminal: boolean;
}

function pathNode(): PathNode {
	return { children: new Map(), terminal: false };
}

export function assertNoPathCollisions(
	paths: readonly SafeRelativePath[],
	errorMessage: string,
	caseInsensitive = true,
): void {
	const root = pathNode();
	for (const path of paths) {
		let node = root;
		const components = path
			.split('/')
			.map((component) => (caseInsensitive ? component.toLocaleLowerCase('en-US') : component));
		for (const component of components) {
			if (node.terminal) {
				throw new Error(errorMessage);
			}
			let child = node.children.get(component);
			if (child === undefined) {
				child = pathNode();
				node.children.set(component, child);
			}
			node = child;
		}
		if (node.terminal || node.children.size > 0) {
			throw new Error(errorMessage);
		}
		node.terminal = true;
	}
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

function assertWindowsSafeLocalPath(path: string, errorMessage: string): void {
	for (const segment of path.split('/')) {
		const trimmedSegment = segment.replace(/[ .]+$/u, '');
		if (
			trimmedSegment.length === 0 ||
			trimmedSegment !== segment ||
			WINDOWS_FORBIDDEN_PATH_CHARACTER_PATTERN.test(segment) ||
			WINDOWS_RESERVED_DEVICE_NAME_PATTERN.test(trimmedSegment)
		) {
			throw new Error(errorMessage);
		}
	}
}

function parseLogicalRelativePath(
	value: unknown,
	errorMessage: string,
	allowSingleTrailingSlash = false,
): string {
	assertNonEmptyString(value, errorMessage);
	if (
		hasControlCharacters(value) ||
		value.startsWith('/') ||
		value.includes('\\') ||
		win32.isAbsolute(value) ||
		DRIVE_PREFIX_PATTERN.test(value)
	) {
		throw new Error(errorMessage);
	}

	let canonical = value;
	if (allowSingleTrailingSlash && canonical.endsWith('/')) {
		canonical = canonical.slice(0, -1);
		if (canonical.endsWith('/')) {
			throw new Error(errorMessage);
		}
	}

	if (canonical.length === 0) {
		throw new Error(errorMessage);
	}

	const segments = canonical.split('/');
	if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		throw new Error(errorMessage);
	}

	return canonical;
}

function normalizeWebDavUrl(value: unknown): NormalizedUrl {
	assertNonEmptyString(value, 'Invalid WebDAV URL');
	if (hasControlCharacters(value)) {
		throw new Error('Invalid WebDAV URL');
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Invalid WebDAV URL');
	}

	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username.length > 0 ||
		url.password.length > 0 ||
		url.search.length > 0 ||
		url.hash.length > 0 ||
		url.hostname.length === 0
	) {
		throw new Error('Invalid WebDAV URL');
	}

	url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
	return url.toString() as NormalizedUrl;
}

export function normalizeRemotePath(value: unknown): RemotePath {
	return parseLogicalRelativePath(value, 'Invalid remote path', true) as RemotePath;
}

export function parseRemotePath(value: unknown): RemotePath {
	return parseLogicalRelativePath(value, 'Invalid remote path') as RemotePath;
}

function resolveAgentRoot(agentRoot: string): string {
	assertNonEmptyString(agentRoot, 'Invalid Pi agent directory');
	return resolve(agentRoot);
}

function isTargetWithinRoot(agentRoot: string, target: string): boolean {
	const targetRelativePath = relative(agentRoot, target);
	return (
		targetRelativePath.length > 0 &&
		targetRelativePath !== '..' &&
		!targetRelativePath.startsWith(`..${sep}`) &&
		!isAbsolute(targetRelativePath)
	);
}

function toRelativeComponents(agentRoot: string, target: string): string[] {
	const targetRelativePath = relative(agentRoot, target);
	if (!isTargetWithinRoot(agentRoot, target)) {
		throw new Error('Unsafe local target');
	}
	return targetRelativePath.split(sep);
}

async function assertSafeAgentRootDirectory(agentRoot: string): Promise<void> {
	let entry;
	try {
		entry = await lstat(agentRoot);
	} catch {
		throw new Error('Unsafe local target');
	}
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error('Unsafe local target');
	}
}

async function assertNoSymlinksBelowAgentRoot(agentRoot: string, target: string): Promise<void> {
	let currentPath = agentRoot;
	const components = toRelativeComponents(agentRoot, target);

	for (let index = 0; index < components.length; index += 1) {
		const component = components[index];
		if (component === undefined) {
			throw new Error('Unsafe local target');
		}
		currentPath = join(currentPath, component);

		let entry;
		try {
			entry = await lstat(currentPath);
		} catch (error: unknown) {
			if (isMissingPath(error)) {
				return;
			}
			throw new Error('Unable to inspect local target');
		}

		if (entry.isSymbolicLink()) {
			throw new Error('Unsafe local target');
		}
		if (index < components.length - 1 && !entry.isDirectory()) {
			throw new Error('Unsafe local target');
		}
	}
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
	return isRecord(error) && error.code === 'ENOENT';
}

export function normalizeConnection(input: ConnectionInput): NormalizedConnection {
	if (!isRecord(input)) {
		throw new Error('Invalid connection');
	}
	assertNonEmptyString(input.username, 'Invalid Basic Auth username');
	if (input.username.includes(':') || hasControlCharacters(input.username)) {
		throw new Error('Invalid Basic Auth username');
	}
	assertNonEmptyString(input.password, 'Invalid Basic Auth password');

	const url = normalizeWebDavUrl(input.url);
	return {
		password: input.password,
		remotePath: normalizeRemotePath(input.remotePath),
		requiresInsecureTransportConfirmation: url.startsWith('http://'),
		url,
		username: input.username,
	};
}

export function parseManifestPath(value: unknown): SafeRelativePath {
	const path = parseLogicalRelativePath(value, 'Invalid manifest path');
	assertWindowsSafeLocalPath(path, 'Invalid manifest path');
	if (isPermanentlyExcluded(path)) {
		throw new Error('Invalid manifest path');
	}
	return path as SafeRelativePath;
}

export function parsePushInclude(value: unknown): SafeRelativePath {
	const path = parseLogicalRelativePath(value, 'Invalid push include');
	assertWindowsSafeLocalPath(path, 'Invalid push include');
	if (path.includes('/') || isPermanentlyExcluded(path)) {
		throw new Error('Invalid push include');
	}
	return path as SafeRelativePath;
}

export function isPermanentlyExcluded(path: string): boolean {
	const components = path.split('/').map((component) => component.toLocaleLowerCase('en-US'));
	return (
		PERMANENTLY_EXCLUDED_TOP_LEVEL_NAMES.has(components[0] ?? '') ||
		components.some((component) => RECURSIVELY_EXCLUDED_NAMES.has(component))
	);
}

export function encodeRemotePath(path: RemotePath | SafeRelativePath): string {
	const canonical = parseRemotePath(path);
	return canonical
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

export function resolveLocalTarget(agentRoot: string, relativePath: SafeRelativePath): string {
	const root = resolveAgentRoot(agentRoot);
	const canonicalPath = parseManifestPath(relativePath);
	const target = resolve(root, ...canonicalPath.split('/'));
	if (!isTargetWithinRoot(root, target)) {
		throw new Error('Unsafe local target');
	}
	return target;
}

export async function assertSafeLocalTarget(
	agentRoot: string,
	relativePath: SafeRelativePath,
): Promise<string> {
	const root = resolveAgentRoot(agentRoot);
	const target = resolveLocalTarget(root, relativePath);
	await assertSafeAgentRootDirectory(root);
	await assertNoSymlinksBelowAgentRoot(root, target);
	return target;
}

export function getPrivatePaths(agentRoot: string): PrivatePaths {
	const root = resolveAgentRoot(agentRoot);
	const directory = join(root, PRIVATE_DIRECTORY_NAME);
	return {
		backupsDirectory: join(directory, 'backups'),
		configFile: join(directory, CONFIG_FILE_NAME),
		directory,
		workspaceDirectory: join(directory, 'workspace'),
	};
}
