import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { mapConcurrent } from '../src/operation.js';

describe('operation helpers', () => {
	it('bounds work and preserves input order', async () => {
		let activeTasks = 0;
		let maximumActiveTasks = 0;

		const result = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
			activeTasks += 1;
			maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
			await delay(value === 1 ? 15 : 1);
			activeTasks -= 1;
			return value * 2;
		});

		expect(result).toEqual([2, 4, 6, 8, 10]);
		expect(maximumActiveTasks).toBe(2);
	});

	it('stops starting new work after the first failure', async () => {
		const started: number[] = [];
		let inFlightFinished = false;

		await expect(
			mapConcurrent([0, 1, 2, 3], 2, async (value) => {
				started.push(value);
				if (value === 0) {
					await delay(20);
					inFlightFinished = true;
					return value;
				}
				if (value === 1) {
					throw new Error('first failure');
				}
				return value;
			}),
		).rejects.toThrow('first failure');

		expect(started).toEqual([0, 1]);
		expect(inFlightFinished).toBe(true);
	});
});
