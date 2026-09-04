import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../db/schema';
import { users, connections, sources, events, visibility, listItems } from '../db/schema';
import { createSession } from '../auth/session';
import { publishState, publishAll, setActiveSessionToken, stateBus } from './publisher';
import { screensaverBus } from './screensaverPublisher';
import { resetWeatherCache, refreshWeather } from '../weather';
import { setSetting, SETTING_KEYS } from '../settings';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;

beforeEach(() => {
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
	// stateBus, the active-session token and the weather cache are process-wide singletons
	// (by design — one physical tablet, DESIGN.md §10) and persist across tests in this
	// file, so each test starts from a known state explicitly rather than relying on
	// whatever the previous test left behind. The screensaver mode needs no such reset —
	// it's settings-table-backed (screensaverPublisher.ts), so a fresh :memory: db each
	// test already starts unset, which reads back as 'family'.
	setActiveSessionToken(null);
	resetWeatherCache();
});

afterEach(() => {
	setActiveSessionToken(null);
	resetWeatherCache();
	sqlite.close();
});

/**
 * Reads what a brand-new subscriber would see right now, sidestepping the broadcaster's
 * own dedup bookkeeping (which persists across tests in this file) — subscribe() always
 * synchronously replays the current payload before this unsubscribes again.
 */
function currentBroadcast(): unknown {
	let received: unknown;
	const unsubscribe = stateBus.subscribe((payload) => {
		received = JSON.parse(payload);
	});
	unsubscribe?.();
	return received;
}

// Well outside the default 22:00–07:00 Toronto quiet-hours window.
const DAYTIME = new Date('2026-08-23T18:00:00Z'); // 14:00 Toronto

describe('publishState', () => {
	it('publishes a locked envelope when there is no active session', async () => {
		await publishState(DAYTIME, db);
		expect(currentBroadcast()).toEqual({
			type: 'locked',
			weather: null,
			theme: 'light',
			timeFormat: '24h'
		});
	});

	it('includes the computed theme in a locked envelope, following the sun by default', async () => {
		// DESIGN.md §5.3's own worked example: "on 21 December the sun sets at 16:21, so the
		// display is dark-themed through the whole of dinner" — 18:30 Toronto, still well
		// outside the default 22:00–07:00 quiet-hours window.
		const winterDinner = new Date('2026-12-21T23:30:00Z'); // 18:30 Toronto (EST)
		await publishState(winterDinner, db);
		expect((currentBroadcast() as { theme: string }).theme).toBe('dark');
	});

	it('honours a theme_mode override in every envelope', async () => {
		await setSetting(db, SETTING_KEYS.themeMode, 'dark');
		await publishState(DAYTIME, db);
		expect((currentBroadcast() as { theme: string }).theme).toBe('dark');
	});

	it('includes the cached weather in a locked envelope once one has been fetched', async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				current: { temperature_2m: 21, weather_code: 0 },
				hourly: { time: [], temperature_2m: [], weather_code: [] }
			})
		}) as unknown as typeof fetch;
		await refreshWeather(DAYTIME, fetchImpl, db);

		await publishState(DAYTIME, db);
		const broadcast = currentBroadcast() as { type: string; weather: { temperatureC: number } };
		expect(broadcast.type).toBe('locked');
		expect(broadcast.weather).toMatchObject({ temperatureC: 21, condition: 'Clear' });
	});

	it('publishes a week envelope once a session is active', async () => {
		const [user] = await db
			.insert(users)
			.values({ name: 'Alex', color: '#22c55e', pinHash: 'hash' })
			.returning();
		const token = await createSession(db, user.id, DAYTIME);
		setActiveSessionToken(token);

		await publishState(DAYTIME, db);
		const broadcast = currentBroadcast() as { type: string; snapshot?: { today: string } };
		expect(broadcast.type).toBe('week');
		expect(broadcast.snapshot?.today).toBeDefined();
	});

	it('treats an idle-expired active session as no session, and clears it', async () => {
		const [user] = await db
			.insert(users)
			.values({ name: 'Alex', color: '#22c55e', pinHash: 'hash' })
			.returning();
		const token = await createSession(db, user.id, DAYTIME);
		setActiveSessionToken(token);

		const wayLater = new Date(DAYTIME.getTime() + 10 * 60_000); // past the 2-min idle timeout
		await publishState(wayLater, db);
		expect(currentBroadcast()).toEqual({
			type: 'locked',
			weather: null,
			theme: 'light',
			timeFormat: '24h'
		});
	});

	it('suppresses the locked envelope during quiet hours when nobody is logged in', async () => {
		const nightTime = new Date('2026-08-23T04:00:00Z'); // 00:00 Toronto
		const outcome = await publishState(nightTime, db);
		expect(outcome).toBe('quiet-hours');
	});

	it('still publishes a real week envelope during quiet hours for an active session — logging in at night must not get stuck on "Loading…" forever', async () => {
		const nightTime = new Date('2026-08-23T04:00:00Z'); // 00:00 Toronto
		const [user] = await db
			.insert(users)
			.values({ name: 'Alex', color: '#22c55e', pinHash: 'hash' })
			.returning();
		const token = await createSession(db, user.id, nightTime);
		setActiveSessionToken(token);

		const outcome = await publishState(nightTime, db);
		expect(outcome).toBe('published');
		const broadcast = currentBroadcast() as { type: string; snapshot?: { today: string } };
		expect(broadcast.type).toBe('week');
		expect(broadcast.snapshot?.today).toBeDefined();
	});

	it('filters the broadcast week to only the active session user’s visible sources', async () => {
		const [user] = await db
			.insert(users)
			.values({ name: 'Dana', color: '#22c55e', pinHash: 'hash' })
			.returning();
		const [connection] = await db
			.insert(connections)
			.values({ provider: 'google', label: 'a@b.com', secrets: Buffer.from('x') })
			.returning();
		const [visibleSource] = await db
			.insert(sources)
			.values({
				connectionId: connection.id,
				kind: 'calendar',
				externalId: 'family',
				displayName: 'Family'
			})
			.returning();
		const [hiddenSource] = await db
			.insert(sources)
			.values({
				connectionId: connection.id,
				kind: 'calendar',
				externalId: 'football',
				displayName: 'Football'
			})
			.returning();
		await db
			.insert(visibility)
			.values({ userId: user.id, sourceId: hiddenSource.id, visible: false });
		await db.insert(events).values([
			{
				id: 'dentist',
				sourceId: visibleSource.id,
				title: 'Dentist',
				startsAt: DAYTIME,
				endsAt: DAYTIME,
				allDay: false,
				updatedAt: DAYTIME
			},
			{
				id: 'match',
				sourceId: hiddenSource.id,
				title: 'Match',
				startsAt: DAYTIME,
				endsAt: DAYTIME,
				allDay: false,
				updatedAt: DAYTIME
			}
		]);

		const token = await createSession(db, user.id, DAYTIME);
		setActiveSessionToken(token);

		await publishState(DAYTIME, db);
		const broadcast = currentBroadcast() as {
			type: string;
			snapshot: { days: { events: { id: string }[] }[] };
		};
		const eventIds = broadcast.snapshot.days.flatMap((d) => d.events.map((e) => e.id));
		expect(eventIds).toContain('dentist');
		expect(eventIds).not.toContain('match');
	});

	it('carries groceries: null in a week envelope when AnyList has never been connected', async () => {
		const [user] = await db
			.insert(users)
			.values({ name: 'Alex', color: '#22c55e', pinHash: 'hash' })
			.returning();
		const token = await createSession(db, user.id, DAYTIME);
		setActiveSessionToken(token);

		await publishState(DAYTIME, db);
		const broadcast = currentBroadcast() as { groceries: unknown };
		expect(broadcast.groceries).toBeNull();
	});

	it('includes groceries in a week envelope, unchecked-only in the count', async () => {
		const [user] = await db
			.insert(users)
			.values({ name: 'Alex', color: '#22c55e', pinHash: 'hash' })
			.returning();
		const [connection] = await db
			.insert(connections)
			.values({ provider: 'anylist', label: 'a@b.com', secrets: Buffer.from('x') })
			.returning();
		const [source] = await db
			.insert(sources)
			.values({
				connectionId: connection.id,
				kind: 'groceries',
				externalId: 'anylist-list-1',
				displayName: 'My Grocery List'
			})
			.returning();
		await db.insert(listItems).values([
			{ id: 'i1', sourceId: source.id, title: 'Milk', checked: false, updatedAt: DAYTIME },
			{ id: 'i2', sourceId: source.id, title: 'Bread', checked: true, updatedAt: DAYTIME }
		]);

		const token = await createSession(db, user.id, DAYTIME);
		setActiveSessionToken(token);

		await publishState(DAYTIME, db);
		const broadcast = currentBroadcast() as {
			groceries: { items: unknown[]; count: number; stale: boolean };
		};
		expect(broadcast.groceries.items).toHaveLength(2);
		expect(broadcast.groceries.count).toBe(1);
		expect(broadcast.groceries.stale).toBe(false);
	});

	it('marks groceries stale when the AnyList connection is in error', async () => {
		const [user] = await db
			.insert(users)
			.values({ name: 'Alex', color: '#22c55e', pinHash: 'hash' })
			.returning();
		const [connection] = await db
			.insert(connections)
			.values({
				provider: 'anylist',
				label: 'a@b.com',
				secrets: Buffer.from('x'),
				status: 'error'
			})
			.returning();
		await db.insert(sources).values({
			connectionId: connection.id,
			kind: 'groceries',
			externalId: 'anylist-list-1',
			displayName: 'My Grocery List'
		});

		const token = await createSession(db, user.id, DAYTIME);
		setActiveSessionToken(token);

		await publishState(DAYTIME, db);
		const broadcast = currentBroadcast() as { groceries: { stale: boolean } };
		expect(broadcast.groceries.stale).toBe(true);
	});

	it('never includes groceries in a locked envelope — DESIGN.md §5.1', async () => {
		const [connection] = await db
			.insert(connections)
			.values({ provider: 'anylist', label: 'a@b.com', secrets: Buffer.from('x') })
			.returning();
		await db.insert(sources).values({
			connectionId: connection.id,
			kind: 'groceries',
			externalId: 'anylist-list-1',
			displayName: 'My Grocery List'
		});

		await publishState(DAYTIME, db);
		const broadcast = currentBroadcast() as Record<string, unknown>;
		expect(broadcast.type).toBe('locked');
		expect('groceries' in broadcast).toBe(false);
	});

	it('carries tasks: null in a week envelope when Todoist has never been connected', async () => {
		const [user] = await db
			.insert(users)
			.values({ name: 'Alex', color: '#22c55e', pinHash: 'hash' })
			.returning();
		const token = await createSession(db, user.id, DAYTIME);
		setActiveSessionToken(token);

		await publishState(DAYTIME, db);
		const broadcast = currentBroadcast() as { tasks: unknown };
		expect(broadcast.tasks).toBeNull();
	});

	it("publishes only the tasks visible under the session user's taskAccess (all-but-one)", async () => {
		const [user] = await db
			.insert(users)
			.values({ name: 'Alex', color: '#22c55e', pinHash: 'hash', taskAccess: 'all-but-one' })
			.returning();
		const [connection] = await db
			.insert(connections)
			.values({ provider: 'todoist', label: 'personal token', secrets: Buffer.from('x') })
			.returning();
		const [source] = await db
			.insert(sources)
			.values({
				connectionId: connection.id,
				kind: 'tasks',
				externalId: 'todoist-tasks',
				displayName: 'Todoist tasks'
			})
			.returning();
		await setSetting(db, SETTING_KEYS.restrictedTaskProjectId, 'restricted');
		await db.insert(listItems).values([
			{
				id: 't1',
				sourceId: source.id,
				title: 'Send book club reminder',
				category: 'Personal',
				projectId: 'p1',
				dueDate: '2026-08-23',
				checked: false,
				updatedAt: DAYTIME
			},
			{
				id: 't2',
				sourceId: source.id,
				title: 'A restricted task',
				category: 'Restricted',
				projectId: 'restricted',
				dueDate: '2026-08-23',
				checked: false,
				updatedAt: DAYTIME
			}
		]);

		const token = await createSession(db, user.id, DAYTIME);
		setActiveSessionToken(token);

		await publishState(DAYTIME, db);
		const broadcast = currentBroadcast() as {
			tasks: { overdue: { id: string }[]; dueToday: { id: string }[] };
		};
		const ids = [...broadcast.tasks.overdue, ...broadcast.tasks.dueToday].map((t) => t.id);
		expect(ids).toEqual(['t1']);
	});

	it("publishes only the tasks visible under the session user's taskAccess (only-one)", async () => {
		const [user] = await db
			.insert(users)
			.values({ name: 'Simple View', color: '#22c55e', pinHash: 'hash', taskAccess: 'only-one' })
			.returning();
		const [connection] = await db
			.insert(connections)
			.values({ provider: 'todoist', label: 'personal token', secrets: Buffer.from('x') })
			.returning();
		const [source] = await db
			.insert(sources)
			.values({
				connectionId: connection.id,
				kind: 'tasks',
				externalId: 'todoist-tasks',
				displayName: 'Todoist tasks'
			})
			.returning();
		await setSetting(db, SETTING_KEYS.restrictedTaskProjectId, 'restricted');
		await db.insert(listItems).values([
			{
				id: 't1',
				sourceId: source.id,
				title: 'Send book club reminder',
				category: 'Personal',
				projectId: 'p1',
				dueDate: '2026-08-23',
				checked: false,
				updatedAt: DAYTIME
			},
			{
				id: 't2',
				sourceId: source.id,
				title: 'A restricted task',
				category: 'Restricted',
				projectId: 'restricted',
				dueDate: '2026-08-23',
				checked: false,
				updatedAt: DAYTIME
			}
		]);

		const token = await createSession(db, user.id, DAYTIME);
		setActiveSessionToken(token);

		await publishState(DAYTIME, db);
		const broadcast = currentBroadcast() as {
			tasks: { overdue: { id: string }[]; dueToday: { id: string }[] };
		};
		const ids = [...broadcast.tasks.overdue, ...broadcast.tasks.dueToday].map((t) => t.id);
		expect(ids).toEqual(['t2']);
	});

	it('never includes tasks in a locked envelope', async () => {
		const [connection] = await db
			.insert(connections)
			.values({ provider: 'todoist', label: 'personal token', secrets: Buffer.from('x') })
			.returning();
		await db.insert(sources).values({
			connectionId: connection.id,
			kind: 'tasks',
			externalId: 'todoist-tasks',
			displayName: 'Todoist tasks'
		});

		await publishState(DAYTIME, db);
		const broadcast = currentBroadcast() as Record<string, unknown>;
		expect(broadcast.type).toBe('locked');
		expect('tasks' in broadcast).toBe(false);
	});
});

function currentScreensaverBroadcast(): unknown {
	let received: unknown;
	const unsubscribe = screensaverBus.subscribe((payload) => {
		received = JSON.parse(payload);
	});
	unsubscribe?.();
	return received;
}

describe('publishAll', () => {
	// A grocery edit made PIN-free from the screensaver's own button (DESIGN.md §5.1) has
	// no active session, so publishState alone only ever sends the locked envelope (no
	// groceries field at all — see 'never includes groceries in a locked envelope' above).
	// The screensaver's own groceries widget reads from screensaverBus, which — before this
	// — only got refreshed by sync/runtime.ts's own 30s tick, so an edit could sit
	// invisible for up to that long. publishAll must push both in one call, with no active
	// session required, so an edit shows up immediately regardless of which button made it.
	it('refreshes the screensaver groceries snapshot immediately, without an active session', async () => {
		const [connection] = await db
			.insert(connections)
			.values({ provider: 'anylist', label: 'a@b.com', secrets: Buffer.from('x') })
			.returning();
		const [source] = await db
			.insert(sources)
			.values({
				connectionId: connection.id,
				kind: 'groceries',
				externalId: 'anylist-list-1',
				displayName: 'My Grocery List'
			})
			.returning();

		// Establish a first broadcast with an empty list, matching what the 30s tick would
		// already have sent before this specific edit.
		await publishAll(DAYTIME, db);
		expect(
			(currentScreensaverBroadcast() as { groceries: { items: unknown[] } }).groceries.items
		).toHaveLength(0);

		await db
			.insert(listItems)
			.values({ id: 'i1', sourceId: source.id, title: 'Milk', checked: false, updatedAt: DAYTIME });

		await publishAll(DAYTIME, db);
		const broadcast = currentScreensaverBroadcast() as {
			groceries: { items: { id: string }[] };
		};
		expect(broadcast.groceries.items.map((i) => i.id)).toEqual(['i1']);
	});
});
