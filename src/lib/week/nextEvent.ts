// Picks the event the top strip shows as "next up" — DESIGN.md §7.3.
//
// Runs client-side against `nowMinutes` (the tablet's own wall-clock minutes-since-local-
// midnight) rather than being computed once on the server, because "next" has to keep
// advancing through the day without waiting for the next SSE push — a push only arrives
// when the calendar data itself changes, which could be hours after the shown event
// started.

import type { WeekSnapshot, SnapshotDay, SnapshotEvent } from '$lib/server/state/snapshot';

export interface NextEvent {
	day: SnapshotDay;
	event: SnapshotEvent;
}

export function findNextEvent(snapshot: WeekSnapshot, nowMinutes: number): NextEvent | null {
	for (const day of snapshot.days) {
		if (day.date < snapshot.today) continue;

		for (const event of day.events) {
			// All-day events have no "next up" moment — they're context for the whole day,
			// already visible at the top of that day's column in the grid.
			if (event.allDay || event.startMinutes === null) continue;

			const isToday = day.date === snapshot.today;
			if (isToday && event.startMinutes < nowMinutes) continue;

			return { day, event };
		}
	}

	return null;
}
