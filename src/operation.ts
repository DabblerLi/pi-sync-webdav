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
