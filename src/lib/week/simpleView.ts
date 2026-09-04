// Sam's simple view (DESIGN.md §5.2) — a different presentation of the same
// WeekSnapshot data, not a separate data model or code path. Pure transform, mirroring
// nextEvent.ts/format.ts's existing pure-helper pattern.
//
// Deliberately scoped to *today only* for "next up" and "rest of today" — unlike the
// standard view's findNextEvent (which searches forward across the whole week once today
// is exhausted), spilling into tomorrow here would double up with the dedicated "Tomorrow"
// line below it and make the empty state ("Nothing scheduled today") a lie.
//
// One exception: when today AND tomorrow are both empty, the empty state pairs with a
// "Next: <weekday> · ..." line reaching further into the snapshot's week — the plain
// "Nothing scheduled today" stays true, but the display doesn't go otherwise blank for
// days just because nothing is happening in the next 48 hours.

import type { WeekSnapshot, SnapshotEvent } from '$lib/server/state/snapshot';
import { formatWeekday, formatMonthDay, formatMinutes, type TimeFormat } from './format';

export interface SimpleViewEvent {
	title: string;
	time: string;
	color: string | null;
}

export interface SimpleViewModel {
	weekday: string;
	monthDay: string;
	/** The single next (or currently ongoing) timed event today, DESIGN.md §5.2 item 2. */
	nextUp: (SimpleViewEvent & { relative: string }) | null;
	/** Up to four more, item 3. */
	restOfToday: SimpleViewEvent[];
	/** "Tomorrow · Swimming 17:00 · Piano 18:30", item 4 — null if tomorrow has nothing timed. */
	tomorrowLine: string | null;
	/**
	 * "Next: Tuesday · Piano 17:00" — a pointer past tomorrow, shown only when neither today
	 * nor tomorrow has anything, so the empty state isn't a dead end when the household's
	 * next commitment is still visible later in the snapshot's week.
	 */
	nextLine: string | null;
}

/**
 * "in 2 hours" / "in 15 minutes" / "at 16:30" / "now" — DESIGN.md §5.2's three examples,
 * generalized: relative phrasing for what's actionable soon (within 3 hours), a plain
 * clock time for anything further out today. DESIGN.md doesn't specify the exact
 * thresholds; this is a reasoned interpretation, not a literal spec.
 */
function relativePhrase(
	startMinutes: number,
	endMinutes: number,
	nowMinutes: number,
	timeFormat: TimeFormat
): string {
	if (startMinutes <= nowMinutes && nowMinutes < endMinutes) return 'now';

	const minutesUntil = startMinutes - nowMinutes;
	if (minutesUntil < 60) {
		return `in ${minutesUntil} minute${minutesUntil === 1 ? '' : 's'}`;
	}
	if (minutesUntil <= 180) {
		const hours = Math.round(minutesUntil / 60);
		return `in ${hours} hour${hours === 1 ? '' : 's'}`;
	}
	return `at ${formatMinutes(startMinutes, timeFormat)}`;
}

function toSimpleEvent(event: SnapshotEvent, timeFormat: TimeFormat): SimpleViewEvent {
	return {
		title: event.title,
		time: formatMinutes(event.startMinutes!, timeFormat),
		color: event.color
	};
}

export function buildSimpleViewModel(
	snapshot: WeekSnapshot,
	nowMinutes: number,
	timeFormat: TimeFormat = '24h'
): SimpleViewModel {
	const today = snapshot.days.find((d) => d.date === snapshot.today);
	const tomorrowDate = snapshot.days.find((d) => d.date > snapshot.today)?.date;
	const tomorrow = tomorrowDate ? snapshot.days.find((d) => d.date === tomorrowDate) : undefined;

	// Timed, not-yet-ended, in the order the server already sorts them (startMinutes asc).
	const upcoming = (today?.events ?? []).filter(
		(e) =>
			!e.allDay && e.startMinutes !== null && e.endMinutes !== null && e.endMinutes > nowMinutes
	);

	const [next, ...rest] = upcoming;

	// Capped, not the whole day — DESIGN.md's own example shows two events ("so they know
	// to pack a bag tonight"), a quick heads-up rather than an exhaustive list. A real day
	// can easily have 6-8 timed entries, which would defeat "compressed" entirely.
	const TOMORROW_LINE_LIMIT = 3;
	const tomorrowTimed = (tomorrow?.events ?? [])
		.filter((e) => !e.allDay && e.startMinutes !== null)
		.slice(0, TOMORROW_LINE_LIMIT);

	// Only look past tomorrow once today and tomorrow are both confirmed empty — otherwise
	// this would duplicate "Next up" or the tomorrow line instead of filling the real gap.
	let nextLine: string | null = null;
	if (!next && tomorrowTimed.length === 0) {
		for (const futureDay of snapshot.days) {
			if (futureDay.date <= snapshot.today || futureDay.date === tomorrowDate) continue;
			const timed = futureDay.events.find((e) => !e.allDay && e.startMinutes !== null);
			if (timed) {
				nextLine = `Next: ${formatWeekday(futureDay.date)} · ${timed.title} ${formatMinutes(timed.startMinutes!, timeFormat)}`;
				break;
			}
		}
	}

	return {
		weekday: formatWeekday(snapshot.today),
		monthDay: formatMonthDay(snapshot.today),
		nextUp: next
			? {
					...toSimpleEvent(next, timeFormat),
					relative: relativePhrase(next.startMinutes!, next.endMinutes!, nowMinutes, timeFormat)
				}
			: null,
		restOfToday: rest.slice(0, 4).map((e) => toSimpleEvent(e, timeFormat)),
		tomorrowLine:
			tomorrowTimed.length > 0
				? `Tomorrow · ${tomorrowTimed.map((e) => `${e.title} ${formatMinutes(e.startMinutes!, timeFormat)}`).join(' · ')}`
				: null,
		nextLine
	};
}
