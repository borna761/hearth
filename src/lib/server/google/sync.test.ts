import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { connections, sources, events } from '../db/schema';
import { buildSyncWindow, isEventInWindow, syncCalendar, type SyncWindow } from './sync';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;
const originalKey = process.env.SECRETS_KEY;

beforeEach(() => {
	process.env.SECRETS_KEY = randomBytes(32).toString('hex');
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
});

afterEach(() => {
	sqlite.close();
	process.env.SECRETS_KEY = originalKey;
});

const WINDOW: SyncWindow = {
	timeMin: '2026-08-01T00:00:00.000Z',
	timeMax: '2026-09-01T00:00:00.000Z',
	localMin: '2026-08-01',
	localMax: '2026-09-01'
};

/** Returns a fetch stub that replays the given JSON bodies in order. */
function queueFetch(pages: unknown[], statuses: number[] = []) {
	let i = 0;
	return vi.fn(async () => {
		const body = pages[i];
		const status = statuses[i] ?? 200;
		i += 1;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body
		} as Response;
	}) as unknown as typeof fetch;
}

async function seedSource(syncToken: string | null = null) {
	const [connection] = await db
		.insert(connections)
		.values({ provider: 'google', label: 'a@b.com', secrets: Buffer.from('x') })
		.returning();
	const [source] = await db
		.insert(sources)
		.values({
			connectionId: connection.id,
			kind: 'calendar',
			externalId: 'cal-1',
			displayName: 'Family',
			syncToken
		})
		.returning();
	return source;
}

const timedEvent = (id: string, start: string) => ({
	id,
	status: 'confirmed',
	summary: `Event ${id}`,
	start: { dateTime: start },
	end: { dateTime: start },
	updated: '2026-08-01T00:00:00.000Z'
});

describe('buildSyncWindow', () => {
	it('spans one month back and twelve forward', () => {
		const window = buildSyncWindow(new Date('2026-08-22T12:00:00Z'), 'America/Toronto');
		expect(window.timeMin.slice(0, 7)).toBe('2026-07');
		expect(window.timeMax.slice(0, 7)).toBe('2027-08');
	});

	it('expresses the bounds as local dates too, for all-day comparison', () => {
		const window = buildSyncWindow(new Date('2026-08-22T12:00:00Z'), 'America/Toronto');
		expect(window.localMin).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(window.localMax).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe('isEventInWindow', () => {
	it('accepts a timed event inside the window', () => {
		expect(
			isEventInWindow(
				{ allDay: false, startsAt: new Date('2026-08-15T12:00:00Z'), endsAt: null },
				WINDOW
			)
		).toBe(true);
	});

	it('rejects timed events wholly before or after the window', () => {
		expect(
			isEventInWindow(
				{ allDay: false, startsAt: new Date('2026-07-01T12:00:00Z'), endsAt: null },
				WINDOW
			)
		).toBe(false);
		expect(
			isEventInWindow(
				{ allDay: false, startsAt: new Date('2026-10-01T12:00:00Z'), endsAt: null },
				WINDOW
			)
		).toBe(false);
	});

	it('accepts a timed event that starts before the window but runs into it', () => {
		expect(
			isEventInWindow(
				{
					allDay: false,
					startsAt: new Date('2026-07-30T12:00:00Z'),
					endsAt: new Date('2026-08-02T12:00:00Z')
				},
				WINDOW
			)
		).toBe(true);
	});

	it('accepts an all-day event overlapping the window edge', () => {
		// A vacation starting in July and ending in August must survive the filter.
		expect(
			isEventInWindow({ allDay: true, localDate: '2026-07-28', localEndDate: '2026-08-03' }, WINDOW)
		).toBe(true);
	});

	it('rejects all-day events wholly outside the window', () => {
		expect(
			isEventInWindow({ allDay: true, localDate: '2026-06-01', localEndDate: '2026-06-05' }, WINDOW)
		).toBe(false);
		expect(
			isEventInWindow({ allDay: true, localDate: '2026-11-01', localEndDate: '2026-11-05' }, WINDOW)
		).toBe(false);
	});
});

describe('syncCalendar', () => {
	it('runs a full windowed sync when there is no stored token', async () => {
		const source = await seedSource(null);
		const fetchFn = queueFetch([
			{ items: [timedEvent('e1', '2026-08-15T12:00:00Z')], nextSyncToken: 'token-1' }
		]);

		const result = await syncCalendar(db, source, 'access', { window: WINDOW, fetchFn });

		expect(result.fullSync).toBe(true);
		expect(result.upserted).toBe(1);
		const stored = await db.select().from(events);
		expect(stored).toHaveLength(1);
		expect(stored[0].title).toBe('Event e1');
	});

	it('persists the sync token so the next run can go incremental', async () => {
		const source = await seedSource(null);
		const fetchFn = queueFetch([{ items: [], nextSyncToken: 'token-1' }]);

		await syncCalendar(db, source, 'access', { window: WINDOW, fetchFn });

		const [after] = await db.select().from(sources).where(eq(sources.id, source.id));
		expect(after.syncToken).toBe('token-1');
	});

	it('sends the stored token and no time bounds on an incremental run', async () => {
		// timeMin alongside syncToken is a 400 from Google (DESIGN.md §3.1), so the
		// incremental request must carry the token alone.
		const source = await seedSource('token-1');
		const fetchFn = queueFetch([{ items: [], nextSyncToken: 'token-2' }]);

		const result = await syncCalendar(db, source, 'access', { window: WINDOW, fetchFn });

		expect(result.fullSync).toBe(false);
		const url = new URL(vi.mocked(fetchFn).mock.calls[0][0] as string);
		expect(url.searchParams.get('syncToken')).toBe('token-1');
		expect(url.searchParams.has('timeMin')).toBe(false);
		expect(url.searchParams.has('timeMax')).toBe(false);
	});

	it('does not resend the sync token on page 2+ of a paginated incremental sync', async () => {
		// syncToken and timeMin/timeMax are already known to be mutually exclusive (Google
		// 400s). The same request object was sending syncToken unconditionally on every
		// page, including alongside pageToken on page 2 — an untested combination this
		// guards against regardless of Google's exact behavior for it.
		const source = await seedSource('token-1');
		const fetchFn = queueFetch([
			{ items: [timedEvent('e1', '2026-08-10T12:00:00Z')], nextPageToken: 'p2' },
			{ items: [timedEvent('e2', '2026-08-11T12:00:00Z')], nextSyncToken: 'token-final' }
		]);

		await syncCalendar(db, source, 'access', { window: WINDOW, fetchFn });

		const firstPageUrl = new URL(vi.mocked(fetchFn).mock.calls[0][0] as string);
		expect(firstPageUrl.searchParams.get('syncToken')).toBe('token-1');

		const secondPageUrl = new URL(vi.mocked(fetchFn).mock.calls[1][0] as string);
		expect(secondPageUrl.searchParams.get('pageToken')).toBe('p2');
		expect(secondPageUrl.searchParams.has('syncToken')).toBe(false);
	});

	it('requests expanded instances so Google handles recurrence', async () => {
		const source = await seedSource(null);
		const fetchFn = queueFetch([{ items: [], nextSyncToken: 't' }]);

		await syncCalendar(db, source, 'access', { window: WINDOW, fetchFn });

		const url = new URL(vi.mocked(fetchFn).mock.calls[0][0] as string);
		expect(url.searchParams.get('singleEvents')).toBe('true');
		expect(url.searchParams.get('showDeleted')).toBe('true');
	});

	it('follows pagination and only takes the token from the last page', async () => {
		const source = await seedSource(null);
		const fetchFn = queueFetch([
			{ items: [timedEvent('e1', '2026-08-10T12:00:00Z')], nextPageToken: 'p2' },
			{ items: [timedEvent('e2', '2026-08-11T12:00:00Z')], nextSyncToken: 'token-final' }
		]);

		const result = await syncCalendar(db, source, 'access', { window: WINDOW, fetchFn });

		expect(result.upserted).toBe(2);
		const [after] = await db.select().from(sources).where(eq(sources.id, source.id));
		expect(after.syncToken).toBe('token-final');
	});

	it('deletes an event that comes back cancelled', async () => {
		const source = await seedSource(null);
		await syncCalendar(db, source, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([
				{ items: [timedEvent('e1', '2026-08-15T12:00:00Z')], nextSyncToken: 't1' }
			])
		});
		expect(await db.select().from(events)).toHaveLength(1);

		const [withToken] = await db.select().from(sources).where(eq(sources.id, source.id));
		const result = await syncCalendar(db, withToken, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([{ items: [{ id: 'e1', status: 'cancelled' }], nextSyncToken: 't2' }])
		});

		expect(result.deleted).toBe(1);
		expect(await db.select().from(events)).toHaveLength(0);
	});

	it('recovers from an expired sync token by falling back to a full sync', async () => {
		// 410 GONE means the token is too old; the only correct recovery is to discard it
		// and re-sync the window (DESIGN.md §3.1).
		const source = await seedSource('stale-token');
		const fetchFn = queueFetch(
			[
				{ error: { message: 'Sync token is no longer valid' } },
				{ items: [timedEvent('e1', '2026-08-15T12:00:00Z')], nextSyncToken: 'fresh' }
			],
			[410, 200]
		);

		const result = await syncCalendar(db, source, 'access', { window: WINDOW, fetchFn });

		expect(result.fullSync).toBe(true);
		expect(result.upserted).toBe(1);
		const [after] = await db.select().from(sources).where(eq(sources.id, source.id));
		expect(after.syncToken).toBe('fresh');
	});

	it('drops events outside the window that an incremental sync may return', async () => {
		// Editing a long-running recurring event can return far-future instances; the
		// window is enforced on write rather than trusted from the response.
		const source = await seedSource('token-1');
		const fetchFn = queueFetch([
			{
				items: [
					timedEvent('inside', '2026-08-15T12:00:00Z'),
					timedEvent('outside', '2030-01-01T12:00:00Z')
				],
				nextSyncToken: 'token-2'
			}
		]);

		const result = await syncCalendar(db, source, 'access', { window: WINDOW, fetchFn });

		expect(result.upserted).toBe(1);
		const stored = await db.select().from(events);
		expect(stored.map((e) => e.id)).toEqual(['inside']);
	});

	it('updates an existing event rather than duplicating it', async () => {
		const source = await seedSource(null);
		await syncCalendar(db, source, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([
				{ items: [timedEvent('e1', '2026-08-15T12:00:00Z')], nextSyncToken: 't1' }
			])
		});

		const [withToken] = await db.select().from(sources).where(eq(sources.id, source.id));
		await syncCalendar(db, withToken, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([
				{
					items: [{ ...timedEvent('e1', '2026-08-15T12:00:00Z'), summary: 'Renamed' }],
					nextSyncToken: 't2'
				}
			])
		});

		const stored = await db.select().from(events);
		expect(stored).toHaveLength(1);
		expect(stored[0].title).toBe('Renamed');
	});

	it('stores an all-day event as dates, with no epoch', async () => {
		const source = await seedSource(null);
		const fetchFn = queueFetch([
			{
				items: [
					{
						id: 'ad1',
						status: 'confirmed',
						summary: 'Vacation',
						start: { date: '2026-08-10' },
						end: { date: '2026-08-15' },
						updated: '2026-08-01T00:00:00.000Z'
					}
				],
				nextSyncToken: 't'
			}
		]);

		await syncCalendar(db, source, 'access', { window: WINDOW, fetchFn });

		const [stored] = await db.select().from(events);
		expect(stored.allDay).toBe(true);
		expect(stored.localDate).toBe('2026-08-10');
		expect(stored.localEndDate).toBe('2026-08-14'); // exclusive 15th -> inclusive 14th
		expect(stored.startsAt).toBeNull();
	});

	it('prunes events that vanished from Google while we were not syncing', async () => {
		// If the sync token expires during an outage, Google may never mention an event
		// that was deleted in the meantime — deleted events are purged from its tombstone
		// window eventually. Without reconciliation the wall display would show a
		// cancelled dentist appointment indefinitely.
		const source = await seedSource(null);
		await syncCalendar(db, source, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([
				{
					items: [
						timedEvent('stays', '2026-08-10T12:00:00Z'),
						timedEvent('vanishes', '2026-08-11T12:00:00Z')
					],
					nextSyncToken: 't1'
				}
			])
		});
		expect(await db.select().from(events)).toHaveLength(2);

		// A later full sync simply does not mention 'vanishes'.
		const result = await syncCalendar(db, source, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([
				{ items: [timedEvent('stays', '2026-08-10T12:00:00Z')], nextSyncToken: 't2' }
			])
		});

		expect(result.pruned).toBe(1);
		const stored = await db.select().from(events);
		expect(stored.map((e) => e.id)).toEqual(['stays']);
	});

	it('prunes rows left behind as the window slides forward', async () => {
		// The window moves every night. Without this the events table grows without bound.
		const source = await seedSource(null);
		await syncCalendar(db, source, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([
				{ items: [timedEvent('august', '2026-08-15T12:00:00Z')], nextSyncToken: 't1' }
			])
		});
		expect(await db.select().from(events)).toHaveLength(1);

		const laterWindow: SyncWindow = {
			timeMin: '2026-10-01T00:00:00.000Z',
			timeMax: '2026-11-01T00:00:00.000Z',
			localMin: '2026-10-01',
			localMax: '2026-11-01'
		};
		const result = await syncCalendar(db, source, 'access', {
			window: laterWindow,
			fetchFn: queueFetch([{ items: [], nextSyncToken: 't2' }])
		});

		expect(result.pruned).toBe(1);
		expect(await db.select().from(events)).toHaveLength(0);
	});

	it('does not prune on an incremental sync, which only reports changes', async () => {
		// An incremental response mentions only what changed, so treating absence as
		// deletion would wipe the entire calendar on the first quiet poll.
		const source = await seedSource(null);
		await syncCalendar(db, source, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([
				{
					items: [timedEvent('a', '2026-08-10T12:00:00Z'), timedEvent('b', '2026-08-11T12:00:00Z')],
					nextSyncToken: 't1'
				}
			])
		});

		const [withToken] = await db.select().from(sources).where(eq(sources.id, source.id));
		const result = await syncCalendar(db, withToken, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([{ items: [], nextSyncToken: 't2' }])
		});

		expect(result.fullSync).toBe(false);
		expect(result.pruned).toBe(0);
		expect(await db.select().from(events)).toHaveLength(2);
	});

	it('scopes pruning to the calendar being synced', async () => {
		const a = await seedSource(null);
		const [connectionB] = await db
			.insert(connections)
			.values({ provider: 'todoist', label: 'x', secrets: Buffer.from('y') })
			.returning();
		const [b] = await db
			.insert(sources)
			.values({
				connectionId: connectionB.id,
				kind: 'calendar',
				externalId: 'cal-2',
				displayName: 'Other'
			})
			.returning();

		await syncCalendar(db, b, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([
				{ items: [timedEvent('keep-me', '2026-08-15T12:00:00Z')], nextSyncToken: 't' }
			])
		});

		// A full sync of calendar A returning nothing must not touch calendar B's rows.
		await syncCalendar(db, a, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([{ items: [], nextSyncToken: 't' }])
		});

		const fromB = await db.select().from(events).where(eq(events.sourceId, b.id));
		expect(fromB.map((e) => e.id)).toEqual(['keep-me']);
	});

	it('scopes events to their own source', async () => {
		const a = await seedSource(null);
		const [connectionB] = await db
			.insert(connections)
			.values({ provider: 'todoist', label: 'x', secrets: Buffer.from('y') })
			.returning();
		const [b] = await db
			.insert(sources)
			.values({
				connectionId: connectionB.id,
				kind: 'calendar',
				externalId: 'cal-2',
				displayName: 'Other'
			})
			.returning();

		await syncCalendar(db, a, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([
				{ items: [timedEvent('e1', '2026-08-15T12:00:00Z')], nextSyncToken: 't' }
			])
		});
		await syncCalendar(db, b, 'access', {
			window: WINDOW,
			fetchFn: queueFetch([
				{ items: [timedEvent('e2', '2026-08-16T12:00:00Z')], nextSyncToken: 't' }
			])
		});

		const fromA = await db.select().from(events).where(eq(events.sourceId, a.id));
		expect(fromA.map((e) => e.id)).toEqual(['e1']);
	});
});
