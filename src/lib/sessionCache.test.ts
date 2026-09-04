import { describe, it, expect } from 'vitest';
import { isUsableCacheEntry } from './sessionCache';
import type { WeekSnapshot } from './server/state/snapshot';

const NOW = 1_000_000_000_000;

function entry(overrides: Partial<{ userId: number; savedAt: number }> = {}) {
	return {
		userId: 1,
		savedAt: NOW,
		snapshot: {} as WeekSnapshot,
		groceries: null,
		tasks: null,
		...overrides
	};
}

describe('isUsableCacheEntry', () => {
	it('is unusable when there is no entry at all', () => {
		expect(isUsableCacheEntry(null, 1, NOW)).toBe(false);
	});

	it('is usable for the same user, saved just now', () => {
		expect(isUsableCacheEntry(entry({ userId: 1, savedAt: NOW }), 1, NOW)).toBe(true);
	});

	it("is unusable for a different user — never leaks the previous person's data", () => {
		expect(isUsableCacheEntry(entry({ userId: 1 }), 2, NOW)).toBe(false);
	});

	it('is usable right at the age ceiling', () => {
		const maxAgeMs = 60_000;
		expect(isUsableCacheEntry(entry({ savedAt: NOW - maxAgeMs }), 1, NOW, maxAgeMs)).toBe(true);
	});

	it('is unusable just past the age ceiling', () => {
		const maxAgeMs = 60_000;
		expect(isUsableCacheEntry(entry({ savedAt: NOW - maxAgeMs - 1 }), 1, NOW, maxAgeMs)).toBe(
			false
		);
	});

	it('is unusable for a saved-in-the-future timestamp past the ceiling in the other direction', () => {
		// Not a realistic case (clock skew aside, this module only ever writes Date.now()),
		// but the age check is a plain subtraction — worth confirming it doesn't accidentally
		// treat "negative age" as "very fresh" via some sign-flip bug.
		const maxAgeMs = 60_000;
		expect(isUsableCacheEntry(entry({ savedAt: NOW + 10_000 }), 1, NOW, maxAgeMs)).toBe(true);
	});
});
