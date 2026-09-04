import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { sources, events } from '../db/schema';
import { upsertConnection, getConnection } from '../connections';
import { buildWeekSnapshot } from './snapshot';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;
const originalKey = process.env.SECRETS_KEY;
const TZ = 'America/Toronto';

beforeEach(async () => {
	process.env.SECRETS_KEY = randomBytes(32).toString('hex');
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
	await upsertConnection(db, { provider: 'google', label: 'a@b.com', secrets: {} });
});

afterEach(() => {
	sqlite.close();
	process.env.SECRETS_KEY = originalKey;
});

async function addSource(name: string, color = '#123456', groupLabel: string | null = null) {
	const connection = await getConnection(db, 'google');
	const [row] = await db
		.insert(sources)
		.values({
			connectionId: connection!.id,
			kind: 'calendar',
			externalId: `ext-${name}`,
			displayName: name,
			color,
			groupLabel
		})
		.returning();
	return row;
}

async function addTimed(
	sourceId: number,
	id: string,
	startsAtIso: string,
	title = id,
	endsAtIso: string = startsAtIso
) {
	await db.insert(events).values({
		id,
		sourceId,
		title,
		startsAt: new Date(startsAtIso),
		endsAt: new Date(endsAtIso),
		allDay: false,
		updatedAt: new Date()
	});
}

async function addAllDay(
	sourceId: number,
	id: string,
	localDate: string,
	localEndDate: string,
	title = id
) {
	await db.insert(events).values({
		id,
		sourceId,
		title,
		allDay: true,
		localDate,
		localEndDate,
		updatedAt: new Date()
	});
}

// A Saturday, 12:00 Toronto. The rolling window this produces is 2026-08-22..2026-08-28.
const NOW = new Date('2026-08-22T16:00:00Z');

describe('buildWeekSnapshot', () => {
	it('returns seven consecutive days starting today, not a fixed calendar week', async () => {
		// DESIGN.md §7.3 frames this as a "kitchen glance" — a fixed Mon–Sun block would be
		// mostly in the past by Thursday or Friday, so the window rolls from today instead.
		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		expect(snapshot.days).toHaveLength(7);
		expect(snapshot.days[0].date).toBe('2026-08-22');
		expect(snapshot.days[6].date).toBe('2026-08-28');
		expect(snapshot.days.map((d) => d.weekday)).toEqual([
			'Sat',
			'Sun',
			'Mon',
			'Tue',
			'Wed',
			'Thu',
			'Fri'
		]);
	});

	it('derives the display-hour window from quiet hours by default, matching the tablet dark window', async () => {
		// The hour-grid's visible-hour boundary must come from the same setting the SSE
		// publisher already uses to suppress pushes (§9.2's 22:00–07:00 dark window), not a
		// second, independently hardcoded copy that could drift from it.
		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		expect(snapshot.displayHours).toEqual({ start: 7, end: 22 });
	});

	it('recomputes the display-hour window when a custom quiet-hours setting is passed in', async () => {
		const snapshot = await buildWeekSnapshot(db, {
			now: NOW,
			timeZone: TZ,
			quietHours: { startMinutes: 23 * 60, endMinutes: 6 * 60 }
		});
		expect(snapshot.displayHours).toEqual({ start: 6, end: 23 });
	});

	it('includes every enabled source when visibleSourceIds is omitted, unchanged from before per-user filtering existed', async () => {
		const source = await addSource('Alex');
		await addTimed(source.id, 'dentist', '2026-08-23T18:30:00Z');
		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const sunday = snapshot.days.find((d) => d.date === '2026-08-23')!;
		expect(sunday.events.map((e) => e.id)).toContain('dentist');
	});

	it('filters events down to only the visible sources when visibleSourceIds is provided', async () => {
		const visible = await addSource('Alex');
		const hidden = await addSource('Football');
		await addTimed(visible.id, 'dentist', '2026-08-23T18:30:00Z');
		await addTimed(hidden.id, 'match', '2026-08-23T20:00:00Z');

		const snapshot = await buildWeekSnapshot(db, {
			now: NOW,
			timeZone: TZ,
			visibleSourceIds: [visible.id]
		});
		const sunday = snapshot.days.find((d) => d.date === '2026-08-23')!;
		expect(sunday.events.map((e) => e.id)).toEqual(['dentist']);
	});

	it('shows nothing when visibleSourceIds is an empty array — a user with everything hidden, not "show everything"', async () => {
		const source = await addSource('Alex');
		await addTimed(source.id, 'dentist', '2026-08-23T18:30:00Z');

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ, visibleSourceIds: [] });
		const sunday = snapshot.days.find((d) => d.date === '2026-08-23')!;
		expect(sunday.events).toEqual([]);
	});

	it('marks today using the household zone, and today is always the first day', async () => {
		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		expect(snapshot.today).toBe('2026-08-22');
		expect(snapshot.days[0].isToday).toBe(true);
		expect(snapshot.days.filter((d) => d.isToday).map((d) => d.date)).toEqual(['2026-08-22']);
	});

	it('places a timed event on its household-local day, not its UTC day', async () => {
		// 01:00Z on the 26th is 21:00 on the 25th in Toronto. Bucketing by the UTC date
		// would put this on the wrong day of the grid.
		const source = await addSource('Alex');
		await addTimed(source.id, 'late', '2026-08-26T01:00:00Z', 'Late thing');

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const day25 = snapshot.days.find((d) => d.date === '2026-08-25')!;
		const day26 = snapshot.days.find((d) => d.date === '2026-08-26')!;

		expect(day25.events.map((e) => e.id)).toContain('late');
		expect(day26.events.map((e) => e.id)).not.toContain('late');
	});

	it('formats times in the household zone', async () => {
		const source = await addSource('Alex');
		await addTimed(source.id, 'dentist', '2026-08-23T18:30:00Z'); // 14:30 Toronto

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const day = snapshot.days.find((d) => d.date === '2026-08-23')!;
		expect(day.events[0].time).toBe('14:30');
		expect(day.events[0].startMinutes).toBe(14 * 60 + 30);
	});

	it('defaults to 24h and honours a 12h timeFormat option', async () => {
		const source = await addSource('Alex');
		await addTimed(source.id, 'dentist', '2026-08-23T18:30:00Z'); // 14:30 Toronto

		const default24h = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		expect(default24h.days.find((d) => d.date === '2026-08-23')!.events[0].time).toBe('14:30');

		const in12h = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ, timeFormat: '12h' });
		expect(in12h.days.find((d) => d.date === '2026-08-23')!.events[0].time).toBe('2:30 PM');
		// startMinutes stays a plain number either way — the client ranks/finds "next" off
		// this, never off the formatted string.
		expect(in12h.days.find((d) => d.date === '2026-08-23')!.events[0].startMinutes).toBe(
			14 * 60 + 30
		);
	});

	it('gives all-day events no time, no startMinutes, and no endMinutes', async () => {
		const source = await addSource('Holidays');
		await addAllDay(source.id, 'holiday', '2026-08-23', '2026-08-23');

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const day = snapshot.days.find((d) => d.date === '2026-08-23')!;
		expect(day.events[0].allDay).toBe(true);
		expect(day.events[0].time).toBeNull();
		expect(day.events[0].startMinutes).toBeNull();
		expect(day.events[0].endMinutes).toBeNull();
	});

	it('gives a timed event its end minute, for sizing a grid-view block by duration', async () => {
		const source = await addSource('Alex');
		// 14:30 to 15:15 Toronto.
		await addTimed(source.id, 'meeting', '2026-08-23T18:30:00Z', 'meeting', '2026-08-23T19:15:00Z');

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const day = snapshot.days.find((d) => d.date === '2026-08-23')!;
		expect(day.events[0].startMinutes).toBe(14 * 60 + 30);
		expect(day.events[0].endMinutes).toBe(15 * 60 + 15);
	});

	it('falls back endMinutes to startMinutes when the event has no end time', async () => {
		const source = await addSource('Alex');
		await db.insert(events).values({
			id: 'no-end',
			sourceId: source.id,
			title: 'No end',
			allDay: false,
			startsAt: new Date('2026-08-23T18:30:00Z'),
			endsAt: null,
			updatedAt: new Date()
		});

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const day = snapshot.days.find((d) => d.date === '2026-08-23')!;
		expect(day.events[0].startMinutes).toBe(14 * 60 + 30);
		expect(day.events[0].endMinutes).toBe(14 * 60 + 30);
	});

	it('handles an event that runs past midnight by clamping endMinutes to end of day', async () => {
		// A grid column only spans one day; a block extending into tomorrow would need
		// negative height or wrap around to the top of the same column, both nonsensical.
		const source = await addSource('Alex');
		await addTimed(
			source.id,
			'late-party',
			'2026-08-23T23:00:00Z', // 19:00 Toronto
			'late-party',
			'2026-08-24T05:00:00Z' // 01:00 Toronto, the *next* local day
		);

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const day = snapshot.days.find((d) => d.date === '2026-08-23')!;
		expect(day.events[0].startMinutes).toBe(19 * 60);
		expect(day.events[0].endMinutes).toBe(24 * 60 - 1);
	});

	it('repeats a multi-day all-day event on every day it covers', async () => {
		// This is what events.local_end_date exists for — without it the vacation would
		// appear on its first day only.
		const source = await addSource('Family');
		await addAllDay(source.id, 'vacation', '2026-08-23', '2026-08-26', 'Vacation');

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const covered = snapshot.days
			.filter((d) => d.events.some((e) => e.id === 'vacation'))
			.map((d) => d.date);

		expect(covered).toEqual(['2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26']);
	});

	it('shows only the in-window portion of a span that starts before today', async () => {
		const source = await addSource('Family');
		await addAllDay(source.id, 'long', '2026-08-19', '2026-08-23', 'Long trip');

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const covered = snapshot.days
			.filter((d) => d.events.some((e) => e.id === 'long'))
			.map((d) => d.date);

		expect(covered).toEqual(['2026-08-22', '2026-08-23']);
	});

	it('shows only the in-window portion of a span that ends after the window', async () => {
		const source = await addSource('Family');
		await addAllDay(source.id, 'long', '2026-08-27', '2026-09-05', 'Long trip');

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const covered = snapshot.days
			.filter((d) => d.events.some((e) => e.id === 'long'))
			.map((d) => d.date);

		expect(covered).toEqual(['2026-08-27', '2026-08-28']);
	});

	it('excludes events from disabled sources', async () => {
		const source = await addSource('Todoist');
		await db.update(sources).set({ enabled: false }).where(eq(sources.id, source.id));
		await addTimed(source.id, 'hidden', '2026-08-24T18:00:00Z');

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		expect(snapshot.days.flatMap((d) => d.events)).toHaveLength(0);
	});

	it('excludes events outside the window', async () => {
		const source = await addSource('Alex');
		await addTimed(source.id, 'next-month', '2026-09-20T18:00:00Z');

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		expect(snapshot.days.flatMap((d) => d.events)).toHaveLength(0);
	});

	it('sorts all-day events before timed ones, then by time', async () => {
		const source = await addSource('Alex');
		await addTimed(source.id, 'evening', '2026-08-24T23:00:00Z', 'Evening'); // 19:00
		await addTimed(source.id, 'morning', '2026-08-24T13:00:00Z', 'Morning'); // 09:00
		await addAllDay(source.id, 'allday', '2026-08-24', '2026-08-24', 'All day');

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const day = snapshot.days.find((d) => d.date === '2026-08-24')!;
		expect(day.events.map((e) => e.id)).toEqual(['allday', 'morning', 'evening']);
	});

	it('carries the calendar colour and its group label', async () => {
		const source = await addSource('Arsenal', '#ff7537', 'Football');
		await addTimed(source.id, 'match', '2026-08-24T19:00:00Z');

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const day = snapshot.days.find((d) => d.date === '2026-08-24')!;
		expect(day.events[0].color).toBe('#ff7537');
		expect(day.events[0].calendar).toBe('Football'); // group wins over display name
	});

	it('uses the calendar’s own name when it is not grouped', async () => {
		const source = await addSource('Sam', '#fad165');
		await addTimed(source.id, 'swim', '2026-08-24T19:00:00Z');

		const snapshot = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const day = snapshot.days.find((d) => d.date === '2026-08-24')!;
		expect(day.events[0].calendar).toBe('Sam');
	});

	it('is stable across calls when nothing changed, so pushes can be deduped', async () => {
		// The broadcaster compares serialised payloads to avoid pushing no-ops to a
		// display that is already correct.
		const source = await addSource('Alex');
		await addTimed(source.id, 'x', '2026-08-24T18:00:00Z');

		const a = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		const b = await buildWeekSnapshot(db, { now: NOW, timeZone: TZ });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});
