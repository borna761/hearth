import { describe, it, expect } from 'vitest';
import { shuffle, orderForPlayback } from './shuffle';

describe('shuffle', () => {
	it('returns every item exactly once, in a new array', () => {
		const input = [1, 2, 3, 4, 5];
		const result = shuffle(input, Math.random);
		expect(result).not.toBe(input);
		expect([...result].sort()).toEqual(input);
	});

	it('leaves an empty array empty', () => {
		expect(shuffle([], Math.random)).toEqual([]);
	});

	it('leaves a single-item array unchanged', () => {
		expect(shuffle(['only'], Math.random)).toEqual(['only']);
	});

	it('is deterministic given a fixed random source (Fisher-Yates)', () => {
		const input = ['a', 'b', 'c', 'd'];
		const result = shuffle(input, () => 0);
		// randomSource always 0 → every swap targets index 0
		expect(result).toEqual(['b', 'c', 'd', 'a']);
	});
});

describe('orderForPlayback', () => {
	const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

	it('puts the requested start item first, shuffles the rest', () => {
		const result = orderForPlayback(items, 3, () => 0);
		expect(result[0]).toEqual({ id: 3 });
		expect([...result].sort((a, b) => a.id - b.id)).toEqual(items);
	});

	it('shuffles everything when no start id is given', () => {
		const result = orderForPlayback(items, null, () => 0);
		// randomSource always 0 → same Fisher-Yates result as shuffle() on the full list
		expect(result).toEqual(shuffle(items, () => 0));
	});

	it('falls back to a full shuffle when the start id is not found', () => {
		const result = orderForPlayback(items, 999, () => 0);
		expect(result).toEqual(shuffle(items, () => 0));
	});

	it('returns just the item for a single-item list', () => {
		expect(orderForPlayback([{ id: 1 }], 1, Math.random)).toEqual([{ id: 1 }]);
	});

	it('leaves an empty list empty', () => {
		expect(orderForPlayback([], 1, Math.random)).toEqual([]);
	});
});
