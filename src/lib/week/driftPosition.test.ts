import { describe, it, expect } from 'vitest';
import { driftOffset, DRIFT_AMPLITUDE_PX } from './driftPosition';

describe('driftOffset', () => {
	it('starts at the origin', () => {
		expect(driftOffset(0)).toEqual({ x: 0, y: 0 });
	});

	it('never exceeds the amplitude on either axis', () => {
		// Sample across a wide span of elapsed time rather than asserting one instant —
		// this is what actually verifies the bound holds everywhere, not just at t=0.
		for (let minutes = 0; minutes < 24 * 60; minutes += 7) {
			const { x, y } = driftOffset(minutes * 60_000);
			expect(Math.abs(x)).toBeLessThanOrEqual(DRIFT_AMPLITUDE_PX);
			expect(Math.abs(y)).toBeLessThanOrEqual(DRIFT_AMPLITUDE_PX);
		}
	});

	it('actually moves between two points a few minutes apart', () => {
		// A static overlay is exactly the bug this exists to prevent (DESIGN.md §7.1: burn-in
		// from bright text held in one position for months).
		const a = driftOffset(0);
		const b = driftOffset(5 * 60_000);
		expect(a).not.toEqual(b);
	});

	it('moves gradually, not in a jump, over a short interval', () => {
		// "a few pixels per minute" (§7.1) — one minute of elapsed time shouldn't teleport
		// the overlay across the whole amplitude.
		const a = driftOffset(10 * 60_000);
		const b = driftOffset(11 * 60_000);
		const distance = Math.hypot(b.x - a.x, b.y - a.y);
		expect(distance).toBeLessThan(DRIFT_AMPLITUDE_PX);
	});

	it('is deterministic — the same elapsed time always gives the same offset', () => {
		expect(driftOffset(123_456)).toEqual(driftOffset(123_456));
	});
});
