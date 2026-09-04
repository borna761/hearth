import { describe, it, expect } from 'vitest';
import { layoutHourColumn } from './hourLayout';
import type { SnapshotEvent } from '$lib/server/state/snapshot';

const HOUR_START = 7;
const HOUR_END = 22;

function timed(id: string, startMinutes: number, endMinutes: number): SnapshotEvent {
	return {
		id,
		title: id,
		time: null,
		startMinutes,
		endMinutes,
		allDay: false,
		color: null,
		calendar: 'Test'
	};
}

describe('layoutHourColumn', () => {
	it('positions a single event by its natural start and duration', () => {
		// 09:00–10:00 within a 07:00–22:00, 900-minute span: starts at (120/900)=13.3%,
		// height (60/900)=6.7%.
		const [block] = layoutHourColumn([timed('a', 9 * 60, 10 * 60)], HOUR_START, HOUR_END);
		expect(block.top).toBeCloseTo(((2 * 60) / 900) * 100, 1);
		expect(block.height).toBeCloseTo((60 / 900) * 100, 1);
	});

	it('enforces a minimum visible height for a very short event', () => {
		const [block] = layoutHourColumn([timed('a', 9 * 60, 9 * 60 + 5)], HOUR_START, HOUR_END);
		expect(block.height).toBeGreaterThanOrEqual(3);
	});

	it('does not let the minimum height push into an unrelated later event', () => {
		// This is the real bug: a 5-minute event at 09:00 followed by an unrelated event at
		// 09:10 must not have its enforced minimum height overlap the second event just
		// because they happen to be close together with room to spare.
		const blocks = layoutHourColumn(
			[timed('short', 9 * 60, 9 * 60 + 5), timed('next', 9 * 60 + 10, 9 * 60 + 40)],
			HOUR_START,
			HOUR_END
		);
		const shortBottom = blocks[0].top + blocks[0].height;
		expect(shortBottom).toBeLessThanOrEqual(blocks[1].top);
	});

	it('does not collapse a short event to zero height when the next event shares its exact start time', () => {
		// The next-event cap exists to protect an unrelated *later* event from being
		// swallowed by the minimum-height floor. Two events sharing a start time (e.g. a
		// 5-minute reminder and a longer event both at 09:00) is a same-start collision, not
		// that scenario — toPercent(next.startMinutes) equals `top` here, so the old cap
		// collapsed the short block to exactly zero height.
		const blocks = layoutHourColumn(
			[timed('short', 9 * 60, 9 * 60 + 5), timed('same-start', 9 * 60, 9 * 60 + 30)],
			HOUR_START,
			HOUR_END
		);
		expect(blocks[0].height).toBeGreaterThanOrEqual(3);
	});

	it('still allows two genuinely overlapping events to overlap — no collision layout in v1', () => {
		// Documented simplification: real interval-graph side-by-side layout is out of
		// scope while true time conflicts are expected to be rare.
		const blocks = layoutHourColumn(
			[timed('a', 9 * 60, 10 * 60), timed('b', 9 * 60 + 30, 10 * 60 + 30)],
			HOUR_START,
			HOUR_END
		);
		const aBottom = blocks[0].top + blocks[0].height;
		expect(aBottom).toBeGreaterThan(blocks[1].top);
	});

	it('does not cap the last event of the day against a following one that does not exist', () => {
		const blocks = layoutHourColumn(
			[timed('a', 9 * 60, 9 * 60 + 5), timed('last', 21 * 60, 21 * 60 + 5)],
			HOUR_START,
			HOUR_END
		);
		const lastBlock = blocks[blocks.length - 1];
		expect(lastBlock.height).toBeGreaterThanOrEqual(3);
	});

	it('clamps an event that starts before the displayed range to the top edge', () => {
		const [block] = layoutHourColumn([timed('early', 5 * 60, 8 * 60)], HOUR_START, HOUR_END);
		expect(block.top).toBe(0);
	});

	it('clamps an event that ends after the displayed range to the bottom edge', () => {
		const [block] = layoutHourColumn([timed('late', 21 * 60, 23 * 60)], HOUR_START, HOUR_END);
		expect(block.top + block.height).toBeCloseTo(100, 1);
	});

	it('handles an empty day', () => {
		expect(layoutHourColumn([], HOUR_START, HOUR_END)).toEqual([]);
	});

	it('preserves the event alongside its layout, for the caller to render', () => {
		const event = timed('a', 9 * 60, 10 * 60);
		const [block] = layoutHourColumn([event], HOUR_START, HOUR_END);
		expect(block.event).toBe(event);
	});
});
