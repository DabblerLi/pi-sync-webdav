import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
	getPrivatePaths,
	normalizeConnection,
	parseManifestPath,
	parsePushInclude,
	type NormalizedConnection,
	type SafeRelativePath,
} from './paths.js';

export const CONFIG_VERSION = 1 as const;

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

export interface SyncState {
	readonly connectionFingerprint: string;
	readonly managedPaths: readonly SafeRelativePath[];
}

export interface StoredConnection extends NormalizedConnection {
	readonly readOnly: boolean;
}

export interface PluginConfig {
	readonly connection: StoredConnection;
	readonly pushInclude: readonly SafeRelativePath[];
	readonly syncState?: SyncState;
	readonly version: typeof CONFIG_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
	return isRecord(error) && error.code === 'ENOENT';
}

function invalidConfig(): never {
	throw new Error('Invalid plugin configuration');
}

function assertExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): void {
	const actualKeys = Object.keys(value).sort();
	const sortedExpectedKeys = [...expectedKeys].sort();
	if (
		actualKeys.length !== sortedExpectedKeys.length ||
		actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
	) {
		invalidConfig();
	}
}

function requireString(value: unknown): string {
	if (typeof value !== 'string') {
		invalidConfig();
	}
	return value;
}

function parseConnection(value: unknown, allowDerivedFields: boolean): StoredConnection {
	if (!isRecord(value)) {
		invalidConfig();
	}
	const expectedKeys = Object.hasOwn(value, 'requiresInsecureTransportConfirmation')
		? [
				'url',
				'remotePath',
				'username',
				'password',
				'readOnly',
				'requiresInsecureTransportConfirmation',
			]
		: ['url', 'remotePath', 'username', 'password', 'readOnly'];
	if (!allowDerivedFields && expectedKeys.length !== 5) {
		invalidConfig();
	}
	assertExactKeys(value, expectedKeys);
	if (typeof value.readOnly !== 'boolean') {
		invalidConfig();
	}
	const connection = normalizeConnection({
		password: requireString(value.password),
		remotePath: requireString(value.remotePath),
		url: requireString(value.url),
		username: requireString(value.username),
	});
	if (
		Object.hasOwn(value, 'requiresInsecureTransportConfirmation') &&
		value.requiresInsecureTransportConfirmation !== connection.requiresInsecureTransportConfirmation
	) {
		invalidConfig();
	}
	return { ...connection, readOnly: value.readOnly };
}

function parseUniquePaths(
	value: unknown,
	parser: (path: unknown) => SafeRelativePath,
): readonly SafeRelativePath[] {
	if (!Array.isArray(value)) {
		invalidConfig();
	}

	const paths = value.map(parser);
	if (new Set(paths).size !== paths.length) {
		invalidConfig();
	}
	return paths;
}

function parseSyncState(value: unknown): SyncState {
	if (!isRecord(value)) {
		invalidConfig();
	}
	assertExactKeys(value, ['connectionFingerprint', 'managedPaths']);
	const connectionFingerprint = requireString(value.connectionFingerprint);
	if (!FINGERPRINT_PATTERN.test(connectionFingerprint)) {
		invalidConfig();
	}

	return {
		connectionFingerprint,
		managedPaths: parseUniquePaths(value.managedPaths, parseManifestPath),
	};
}

function validatePluginConfig(value: unknown, allowDerivedConnectionFields = false): PluginConfig {
	if (!isRecord(value)) {
		invalidConfig();
	}
	const expectedKeys = ['version', 'connection', 'pushInclude'];
	if (Object.hasOwn(value, 'syncState')) {
		expectedKeys.push('syncState');
	}
	assertExactKeys(value, expectedKeys);
	if (value.version !== CONFIG_VERSION) {
		invalidConfig();
	}

	const syncState = Object.hasOwn(value, 'syncState') ? parseSyncState(value.syncState) : undefined;
	return {
		connection: parseConnection(value.connection, allowDerivedConnectionFields),
		pushInclude: parseUniquePaths(value.pushInclude, parsePushInclude),
		...(syncState === undefined ? {} : { syncState }),
		version: CONFIG_VERSION,
	};
}

function serializeConfig(config: PluginConfig): string {
	const validated = validatePluginConfig(config, true);
	const persistedConfig = {
		connection: {
			password: validated.connection.password,
			readOnly: validated.connection.readOnly,
			remotePath: validated.connection.remotePath,
			url: validated.connection.url,
			username: validated.connection.username,
		},
		pushInclude: validated.pushInclude,
		...(validated.syncState === undefined ? {} : { syncState: validated.syncState }),
		version: validated.version,
	};
	return `${JSON.stringify(persistedConfig, null, 2)}\n`;
}

async function assertAgentRootDirectory(agentRoot: string): Promise<void> {
	let entry;
	try {
		entry = await fs.lstat(agentRoot);
	} catch (error: unknown) {
		if (isMissingPath(error)) {
			throw new Error('Pi agent directory does not exist');
		}
		throw new Error('Unable to inspect Pi agent directory');
	}

	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error('Invalid Pi agent directory');
	}
}

async function ensurePrivateDirectory(agentRoot: string): Promise<string> {
	const paths = getPrivatePaths(agentRoot);
	await assertAgentRootDirectory(resolve(agentRoot));

	try {
		const entry = await fs.lstat(paths.directory);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error('Unsafe private configuration directory');
		}
	} catch (error: unknown) {
		if (!isMissingPath(error)) {
			throw error;
		}
		await fs.mkdir(paths.directory, { mode: 0o700 });
	}

	await fs.chmod(paths.directory, 0o700);
	return paths.directory;
}

async function assertConfigFileIsSafe(configFile: string): Promise<boolean> {
	try {
		const entry = await fs.lstat(configFile);
		if (
			!entry.isFile() ||
			entry.isSymbolicLink() ||
			(process.platform !== 'win32' && (entry.mode & 0o077) !== 0)
		) {
			throw new Error('Unsafe private configuration file');
		}
		return true;
	} catch (error: unknown) {
		if (isMissingPath(error)) {
			return false;
		}
		throw error;
	}
}

export function connectionFingerprint(
	connection: Pick<NormalizedConnection, 'remotePath' | 'url' | 'username'>,
): string {
	return createHash('sha256')
		.update(JSON.stringify([connection.url, connection.remotePath, connection.username]), 'utf8')
		.digest('hex');
}

export async function readConfig(agentRoot: string): Promise<PluginConfig | undefined> {
	const root = resolve(agentRoot);
	await assertAgentRootDirectory(root);
	const paths = getPrivatePaths(root);

	let directoryEntry;
	try {
		directoryEntry = await fs.lstat(paths.directory);
	} catch (error: unknown) {
		if (isMissingPath(error)) {
			return undefined;
		}
		throw new Error('Unable to inspect private configuration directory');
	}
	if (
		!directoryEntry.isDirectory() ||
		directoryEntry.isSymbolicLink() ||
		(process.platform !== 'win32' && (directoryEntry.mode & 0o077) !== 0)
	) {
		throw new Error('Unsafe private configuration directory');
	}
	if (!(await assertConfigFileIsSafe(paths.configFile))) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(paths.configFile, 'utf8'));
	} catch (error: unknown) {
		if (error instanceof SyntaxError) {
			invalidConfig();
		}
		throw new Error('Unable to read plugin configuration');
	}
	return validatePluginConfig(parsed);
}

export async function writeConfig(agentRoot: string, config: PluginConfig): Promise<void> {
	const serializedConfig = serializeConfig(config);
	const directory = await ensurePrivateDirectory(agentRoot);
	const configFile = getPrivatePaths(agentRoot).configFile;
	await assertConfigFileIsSafe(configFile);

	const temporaryFile = join(directory, `.config-${randomUUID()}.tmp`);
	let renamed = false;
	try {
		await fs.writeFile(temporaryFile, serializedConfig, {
			encoding: 'utf8',
			flag: 'wx',
			mode: 0o600,
		});
		await fs.chmod(temporaryFile, 0o600);
		await assertConfigFileIsSafe(configFile);
		await fs.rename(temporaryFile, configFile);
		renamed = true;
		await fs.chmod(configFile, 0o600);
	} finally {
		if (!renamed) {
			await fs.rm(temporaryFile, { force: true });
		}
	}
}
