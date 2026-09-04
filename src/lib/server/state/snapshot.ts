// The state the tablet renders — DESIGN.md §3 ("It receives state over SSE and renders")
// and §7.3's week view.
//
// The server does all the formatting. §5.3 establishes that the server owns decisions and
// "the client stays dumb"; that matters more than it looks here, because an Android
// tablet takes its timezone from the network, and if it formatted times itself the wall
// display could silently disagree with the household zone.

import { and, eq, gte, lte, or, isNull, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';
import { events, sources } from '../db/schema';
import {
	addDaysToLocalDate,
	localDateInZone,
	localMinutesInZone,
	weekdayAbbrev
} from '$lib/datetime';
import { formatMinutes, type TimeFormat } from '$lib/week/format';
import { DEFAULT_QUIET_HOURS, type QuietHours } from '../settings';

type Db = BetterSQLite3Database<typeof schema>;

export interface SnapshotEvent {
	id: string;
	title: string;
	/** Pre-formatted in the household zone; null for all-day events. */
	time: string | null;
	/**
	 * Minutes since local midnight (0–1439); null for all-day events. Lets the client rank
	 * events and find "the next one" against its own wall clock without ever parsing the
	 * formatted `time` string or handling a timezone itself.
	 */
	startMinutes: number | null;
	/**
	 * Minutes since local midnight the event ends at; null for all-day events. Sizes an
	 * event's block by duration in the grid view. Clamped to 23:59 if the event runs past
	 * midnight — a grid column only spans one day, so there is no sensible height for a
	 * block that would need to extend into tomorrow's column.
	 */
	endMinutes: number | null;
	allDay: boolean;
	color: string | null;
	/** Group label if the calendar belongs to one (e.g. 'Football'), else its own name. */
	calendar: string;
}

export interface SnapshotDay {
	date: string;
	weekday: string;
	isToday: boolean;
	events: SnapshotEvent[];
}

export interface WeekSnapshot {
	timeZone: string;
	today: string;
	/**
	 * Hours (0–23) the hour grid should display, derived from quiet hours so the client
	 * never hardcodes its own copy of the same boundary the SSE publisher already uses to
	 * suppress pushes — one source of truth instead of two that could drift apart.
	 */
	displayHours: { start: number; end: number };
	days: SnapshotDay[];
}

export async function buildWeekSnapshot(
	db: Db,
	options: {
		now: Date;
		timeZone: string;
		quietHours?: QuietHours;
		/** Household's clock preference (settings' time_format) — default 24h. */
		timeFormat?: TimeFormat;
		/**
		 * Restricts the result to these source ids (DESIGN.md §4/§7.5's visibility matrix,
		 * resolved by the caller via visibility.ts). Omitted entirely — not just an empty
		 * array — means "no per-user filtering", so this stays independently testable
		 * without visibility fixtures in every existing test that doesn't care about it. An
		 * explicit empty array is a real, valid case: a user with everything hidden.
		 */
		visibleSourceIds?: number[];
	}
): Promise<WeekSnapshot> {
	const { now, timeZone } = options;
	const quietHours = options.quietHours ?? DEFAULT_QUIET_HOURS;
	const timeFormat = options.timeFormat ?? '24h';
	const today = localDateInZone(now, timeZone);
	// A rolling window from today, not a fixed Mon–Sun block: DESIGN.md §7.3 frames the
	// week view as "a kitchen glance", and a fixed calendar week is mostly in the past by
	// Thursday or Friday — dead space on a screen whose whole point is what's coming up.
	const weekStart = today;
	const weekEnd = addDaysToLocalDate(weekStart, 6);

	// Fetch a deliberately generous UTC range and bucket by local date afterwards, rather
	// than converting local midnight into a UTC instant. That inverse conversion is the
	// DST-hazardous direction; this one is not, and two days of slack costs nothing at
	// this volume.
	const rangeStart = new Date(`${addDaysToLocalDate(weekStart, -2)}T00:00:00Z`);
	const rangeEnd = new Date(`${addDaysToLocalDate(weekEnd, 2)}T23:59:59Z`);

	const conditions = [
		eq(sources.enabled, true),
		or(
			// Timed events, by instant.
			and(gte(events.startsAt, rangeStart), lte(events.startsAt, rangeEnd)),
			// All-day events overlapping the week, by plain string comparison.
			and(
				eq(events.allDay, true),
				lte(events.localDate, weekEnd),
				or(gte(events.localEndDate, weekStart), isNull(events.localEndDate))
			)
		)
	];
	if (options.visibleSourceIds !== undefined) {
		conditions.push(inArray(sources.id, options.visibleSourceIds));
	}

	const rows = await db
		.select({
			id: events.id,
			title: events.title,
			startsAt: events.startsAt,
			endsAt: events.endsAt,
			allDay: events.allDay,
			localDate: events.localDate,
			localEndDate: events.localEndDate,
			color: sources.color,
			displayName: sources.displayName,
			groupLabel: sources.groupLabel
		})
		.from(events)
		.innerJoin(sources, eq(events.sourceId, sources.id))
		.where(and(...conditions));

	const byDate = new Map<string, SnapshotEvent[]>();
	for (let i = 0; i < 7; i += 1) {
		byDate.set(addDaysToLocalDate(weekStart, i), []);
	}

	for (const row of rows) {
		const entry: SnapshotEvent = {
			id: row.id,
			title: row.title,
			time: null,
			startMinutes: null,
			endMinutes: null,
			allDay: row.allDay,
			color: row.color,
			// A grouped calendar shows its group's name — §4 collapses four football feeds
			// into one row rather than letting them compete for space.
			calendar: row.groupLabel ?? row.displayName
		};

		if (row.allDay && row.localDate) {
			// Repeated on every day it covers, which is the entire point of local_end_date.
			const last = row.localEndDate ?? row.localDate;
			for (const [date, list] of byDate) {
				if (row.localDate <= date && date <= last) list.push({ ...entry });
			}
			continue;
		}

		if (row.startsAt) {
			const date = localDateInZone(row.startsAt, timeZone);
			const list = byDate.get(date);
			if (list) {
				let endMinutes = localMinutesInZone(row.startsAt, timeZone);
				if (row.endsAt) {
					const endDate = localDateInZone(row.endsAt, timeZone);
					if (endDate === date) {
						endMinutes = localMinutesInZone(row.endsAt, timeZone);
					} else if (endDate > date) {
						// Runs past midnight; clamp rather than let it wrap to a smaller
						// number that would look like it ends before it starts.
						endMinutes = 24 * 60 - 1;
					}
				}

				const startMinutes = localMinutesInZone(row.startsAt, timeZone);
				list.push({
					...entry,
					time: formatMinutes(startMinutes, timeFormat),
					startMinutes,
					endMinutes
				});
			}
		}
	}

	const days: SnapshotDay[] = [];
	for (let i = 0; i < 7; i += 1) {
		const date = addDaysToLocalDate(weekStart, i);
		const list = byDate.get(date) ?? [];
		// All-day first — they are the day's context — then chronological. startMinutes,
		// not the formatted `time` string, which is lexicographically wrong at the 10:00
		// boundary ("09:15" sorts after "10:00" as plain text).
		list.sort((a, b) => {
			if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
			if (a.allDay) return a.title.localeCompare(b.title);
			return (a.startMinutes ?? 0) - (b.startMinutes ?? 0);
		});

		days.push({ date, weekday: weekdayAbbrev(date), isToday: date === today, events: list });
	}

	// The grid shows the complement of the dark window — waking hours start when quiet
	// hours end, and end when quiet hours begin.
	const displayHours = {
		start: Math.ceil(quietHours.endMinutes / 60),
		end: Math.floor(quietHours.startMinutes / 60)
	};

	// Deliberately carries no wall-clock timestamp. The broadcaster decides whether to push
	// by comparing serialised payloads, and a "generated at" field would differ on every
	// tick, so an unchanged week would be pushed to the display all day for nothing. The
	// only time-driven field here is `today`, which changes once, at midnight.
	return { timeZone, today, displayHours, days };
}
