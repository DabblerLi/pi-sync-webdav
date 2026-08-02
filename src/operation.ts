export type OperationPhase =
	| 'applying'
	| 'cleaning'
	| 'downloading'
	| 'preparing'
	| 'restoring'
	| 'retrying'
	| 'uploading'
	| 'validating';

export interface OperationProgress {
	readonly completed?: number;
	readonly phase: OperationPhase;
	readonly total?: number;
}

export interface OperationOptions {
	readonly onProgress?: (progress: OperationProgress) => void;
	readonly signal?: AbortSignal;
}

// Keep network and file work bounded so a large sync does not exhaust the
// remote server or local descriptor limits.
export const FILE_OPERATION_CONCURRENCY = 4;

export class SyncOperationCancelledError extends Error {
	constructor() {
		super('Sync operation cancelled');
		this.name = 'SyncOperationCancelledError';
	}
}

export function throwIfOperationCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new SyncOperationCancelledError();
	}
}

export function isOperationCancelled(error: unknown): boolean {
	return (
		error instanceof SyncOperationCancelledError ||
		(error instanceof Error &&
			(error.message === 'Pull download cancelled' || error.message === 'WebDAV request cancelled'))
	);
}

export async function mapConcurrent<T, R>(
	items: readonly T[],
	concurrency: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error('Invalid concurrency limit');
	}

	const results = new Array<R>(items.length);
	let nextIndex = 0;
	let failed = false;
	let firstError: unknown;

	const worker = async (): Promise<void> => {
		while (!failed) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) {
				return;
			}
			try {
				results[index] = await mapper(items[index] as T, index);
			} catch (error: unknown) {
				if (!failed) {
					failed = true;
					firstError = error;
				}
				return;
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	if (failed) {
		throw firstError;
	}
	return results;
}
