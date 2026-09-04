import { describe, it, expect } from 'vitest';
import { similarity } from './similarity.mjs';

describe('similarity', () => {
	it('is 1 for identical strings', () => {
		expect(similarity('Bohemian Rhapsody', 'Bohemian Rhapsody')).toBe(1);
	});

	it('is case-insensitive', () => {
		expect(similarity('QUEEN', 'queen')).toBe(1);
	});

	it('is 0 for completely different strings of the same length', () => {
		expect(similarity('aaaa', 'bbbb')).toBe(0);
	});

	it('scores a close-but-not-exact match highly', () => {
		// One extra character (remix tag) shouldn't tank the score.
		const score = similarity('Dance Monkey', 'Dance Monkey (Remix)');
		expect(score).toBeGreaterThan(0.5);
		expect(score).toBeLessThan(1);
	});

	it('scores two unrelated titles low', () => {
		expect(similarity('Bohemian Rhapsody', 'Zombie')).toBeLessThan(0.4);
	});

	it('treats two empty strings as identical', () => {
		expect(similarity('', '')).toBe(1);
	});
});
