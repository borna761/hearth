// Positions one day's timed events for the hour-grid view.
//
// v1 deliberately has no side-by-side collision layout for genuinely overlapping events —
// given how few timed events a day here actually has, true time conflicts are expected to
// be rare, and two blocks visually overlapping in that rare case is an acceptable
// simplification. What is NOT acceptable is the minimum-height floor (which exists so a
// 5-minute event isn't an invisible sliver) swallowing a later, unrelated event just
// because they happen to be close together — that's a rendering bug, not a simplification,
// and it showed up immediately against real calendar data. This module exists to fix that
// one thing without taking on full interval-graph layout.

import type { SnapshotEvent } from '$lib/server/state/snapshot';

export interface HourBlock {
	event: SnapshotEvent;
	/** Percent from the top of the displayed hour range. */
	top: number;
	/** Percent of the displayed hour range's height. */
	height: number;
}

const MIN_HEIGHT_PERCENT = 3;

/**
 * Clamps a minutes-since-midnight value to [hourStart, hourEnd] and converts it to a
 * percent of that displayed range. The one place this clamp-then-percent formula is
 * implemented — callers outside this module (e.g. the hour grid's now-line) should use
 * this rather than reimplementing it, so the two can never drift apart.
 */
export function minutesToRangePercent(minutes: number, hourStart: number, hourEnd: number): number {
	const spanMinutes = (hourEnd - hourStart) * 60;
	const clamped = Math.min(Math.max(minutes, hourStart * 60), hourEnd * 60);
	return ((clamped - hourStart * 60) / spanMinutes) * 100;
}

/** Assumes `events` is already sorted by startMinutes ascending, as buildWeekSnapshot leaves it. */
export function layoutHourColumn(
	events: SnapshotEvent[],
	hourStart: number,
	hourEnd: number
): HourBlock[] {
	const toPercent = (minutes: number) => minutesToRangePercent(minutes, hourStart, hourEnd);

	return events.map((event, i) => {
		const startMinutes = event.startMinutes ?? hourStart * 60;
		const top = toPercent(startMinutes);
		const naturalBottom = toPercent(event.endMinutes ?? event.startMinutes ?? hourStart * 60);
		const inflatedBottom = Math.max(naturalBottom, top + MIN_HEIGHT_PERCENT);

		// Only the minimum-height floor gets capped against the next event's start — a
		// genuinely long event overlapping the next one is left alone (the accepted v1
		// simplification); it is only the artificial inflation of a short event that must
		// not be allowed to swallow something unrelated *later*. When the next event shares
		// this one's exact start time, there is no later gap to protect — treat it like the
		// genuinely-overlapping case instead of collapsing this block to zero height.
		const wasInflated = inflatedBottom > naturalBottom;
		const next = events[i + 1];
		const nextStart = next?.startMinutes ?? hourStart * 60;
		const bottom =
			wasInflated && next && nextStart > startMinutes
				? Math.min(inflatedBottom, Math.max(toPercent(nextStart), top))
				: inflatedBottom;

		return { event, top, height: bottom - top };
	});
}
