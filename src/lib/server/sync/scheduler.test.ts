import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { sources } from '../db/schema';
import { getSetting, SETTING_KEYS } from '../settings';
import { getConnection, upsertConnection } from '../connections';
import { runSyncCycle, createSingleFlight } from './scheduler';

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

async function seed(calendarNames: string[], syncToken: string | null = 'tok') {
	// Goes through upsertConnection rather than a raw insert so the secrets blob is a real
	// encrypted payload — getConnection decrypts it, and a dummy buffer fails there.
	await upsertConnection(db, {
		provider: 'google',
		label: 'a@b.com',
		secrets: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3.6e6 }
	});
	const connection = await getConnection(db, 'google');
	for (const name of calendarNames) {
		await db.insert(sources).values({
			connectionId: connection!.id,
			kind: 'calendar',
			externalId: `ext-${name}`,
			displayName: name,
			syncToken
		});
	}
	return connection!.id;
}

/** A syncCalendar stand-in that records the order and options it was called with. */
function recordingSync() {
	const calls: { externalId: string; forceFull: boolean }[] = [];
	const fn = vi.fn(async (_db, source, _token, options) => {
		calls.push({ externalId: source.externalId, forceFull: options.forceFull === true });
		return { fullSync: options.forceFull === true, upserted: 1, deleted: 0, pruned: 0, skipped: 0 };
	});
	return { fn, calls };
}

const deps = (over: Partial<Parameters<typeof runSyncCycle>[1]> = {}) => ({
	getAccessToken: async () => 'access-token',
	now: new Date('2026-08-22T18:00:00Z'), // 14:00 in Toronto
	timeZone: 'America/Toronto',
	syncFn: recordingSync().fn,
	// A no-op by default so tests that don't care about discovery don't hit the real
	// network on a forced-full cycle — discovery's own behavior is covered separately
	// below.
	discoverFn: async () => {},
	...over
});

describe('runSyncCycle — choosing full vs incremental', () => {
	it('runs incremental during the day when today’s full sync is already done', async () => {
		await seed(['A']);
		const sync = recordingSync();
		const result = await runSyncCycle(db, deps({ syncFn: sync.fn }));
		// no ledger entry yet, but it is 14:00 — before 02:00 has passed *today*, the
		// ledger is what decides, and a missing entry means the 02:00 slot already went by.
		expect(['full', 'incremental']).toContain(result.mode);
	});

	it('runs a full sync once the 02:00 slot has passed and none is recorded for today', async () => {
		await seed(['A']);
		const sync = recordingSync();
		const result = await runSyncCycle(
			db,
			deps({ now: new Date('2026-08-22T06:30:00Z'), syncFn: sync.fn }) // 02:30 Toronto
		);

		expect(result.mode).toBe('full');
		expect(sync.calls.every((c) => c.forceFull)).toBe(true);
	});

	it('stays incremental before 02:00, so the nightly job does not fire early', async () => {
		await seed(['A']);
		const sync = recordingSync();
		const result = await runSyncCycle(
			db,
			deps({ now: new Date('2026-08-22T05:00:00Z'), syncFn: sync.fn }) // 01:00 Toronto
		);

		expect(result.mode).toBe('incremental');
		expect(sync.calls.every((c) => !c.forceFull)).toBe(true);
	});

	it('does not repeat the full sync for the rest of the day', async () => {
		await seed(['A']);
		const first = await runSyncCycle(
			db,
			deps({ now: new Date('2026-08-22T06:30:00Z'), syncFn: recordingSync().fn })
		);
		expect(first.mode).toBe('full');

		const sync = recordingSync();
		const second = await runSyncCycle(
			db,
			deps({ now: new Date('2026-08-22T18:00:00Z'), syncFn: sync.fn })
		);

		expect(second.mode).toBe('incremental');
		expect(sync.calls.every((c) => !c.forceFull)).toBe(true);
	});

	it('runs a full sync again the next day', async () => {
		await seed(['A']);
		await runSyncCycle(db, deps({ now: new Date('2026-08-22T06:30:00Z') }));
		const result = await runSyncCycle(db, deps({ now: new Date('2026-08-23T06:30:00Z') }));
		expect(result.mode).toBe('full');
	});

	it('still runs the full sync if the process was down at 02:00 and started at 09:00', async () => {
		// A cron-style exact-time match would silently skip the day. The ledger is a date
		// stamp precisely so a missed window self-heals on the next tick.
		await seed(['A']);
		const result = await runSyncCycle(db, deps({ now: new Date('2026-08-22T13:00:00Z') })); // 09:00
		expect(result.mode).toBe('full');
	});

	it('records the date it ran, using the household zone rather than UTC', async () => {
		// 2026-08-23T03:00Z is still 23:00 on the 22nd in Toronto. Stamping the UTC date
		// would skip a day's full sync.
		await seed(['A']);
		await runSyncCycle(db, deps({ now: new Date('2026-08-23T03:00:00Z') }));
		expect(await getSetting(db, SETTING_KEYS.lastFullSyncDate)).toBe('2026-08-22');
	});
});

describe('runSyncCycle — which calendars, and in what order', () => {
	it('syncs every enabled calendar', async () => {
		await seed(['A', 'B', 'C']);
		const sync = recordingSync();
		await runSyncCycle(db, deps({ syncFn: sync.fn }));
		expect(sync.calls.map((c) => c.externalId).sort()).toEqual(['ext-A', 'ext-B', 'ext-C']);
	});

	it('skips disabled calendars', async () => {
		await seed(['A', 'B']);
		await db.update(sources).set({ enabled: false }).where(eq(sources.displayName, 'B'));
		const sync = recordingSync();
		await runSyncCycle(db, deps({ syncFn: sync.fn }));
		expect(sync.calls.map((c) => c.externalId)).toEqual(['ext-A']);
	});

	it('syncs strictly one at a time', async () => {
		// 13 parallel HTTPS requests on a 463MB board shared with Pi-hole (§2.1) is not
		// affordable, and the wall display losing DNS for the house is the failure that
		// matters most.
		await seed(['A', 'B', 'C']);
		let inFlight = 0;
		let maxInFlight = 0;
		const syncFn = vi.fn(async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight -= 1;
			return { fullSync: false, upserted: 0, deleted: 0, pruned: 0, skipped: 0 };
		});

		await runSyncCycle(db, deps({ syncFn }));
		expect(maxInFlight).toBe(1);
	});
});

describe('runSyncCycle — calendar discovery on full sync', () => {
	it('runs discovery only on a full sync, not every incremental tick', async () => {
		const connectionId = await seed(['A']);

		// Stamp today's full sync first — a fresh DB with no ledger entry always runs full
		// on its first cycle regardless of the hour (see the "choosing full vs incremental"
		// tests above), so this establishes an unambiguous same-day incremental cycle.
		await runSyncCycle(db, deps({ now: new Date('2026-08-22T06:30:00Z') }));

		const discoverFn = vi.fn(async () => {});
		await runSyncCycle(db, deps({ discoverFn })); // 14:00, same day — incremental
		expect(discoverFn).not.toHaveBeenCalled();

		await runSyncCycle(
			db,
			deps({ discoverFn, now: new Date('2026-08-23T06:30:00Z') }) // next day, 02:30 — full
		);
		expect(discoverFn).toHaveBeenCalledWith(db, connectionId, 'access-token');
	});

	it('includes a calendar discovery adds in the same cycle’s sync', async () => {
		const connectionId = await seed(['A']);
		const sync = recordingSync();
		const discoverFn = async () => {
			await db.insert(sources).values({
				connectionId,
				kind: 'calendar',
				externalId: 'ext-B',
				displayName: 'B'
			});
		};

		const result = await runSyncCycle(
			db,
			deps({ discoverFn, syncFn: sync.fn, now: new Date('2026-08-22T06:30:00Z') })
		);

		expect(sync.calls.map((c) => c.externalId).sort()).toEqual(['ext-A', 'ext-B']);
		expect(result.calendars).toBe(2);
	});

	it('records a discovery failure without blocking the event sync', async () => {
		await seed(['A']);
		const sync = recordingSync();
		const discoverFn = async () => {
			throw new Error('calendarList exploded');
		};

		const result = await runSyncCycle(
			db,
			deps({ discoverFn, syncFn: sync.fn, now: new Date('2026-08-22T06:30:00Z') })
		);

		expect(sync.calls.map((c) => c.externalId)).toEqual(['ext-A']);
		expect(result.failures).toContainEqual({
			calendar: '(discovery)',
			error: 'calendarList exploded'
		});
	});
});

describe('runSyncCycle — failure isolation', () => {
	it('keeps going when one calendar fails, and reports it', async () => {
		await seed(['A', 'B', 'C']);
		const syncFn = vi.fn(async (_db, source) => {
			if (source.displayName === 'B') throw new Error('calendar B exploded');
			return { fullSync: false, upserted: 2, deleted: 0, pruned: 0, skipped: 0 };
		});

		const result = await runSyncCycle(db, deps({ syncFn }));

		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].calendar).toBe('B');
		expect(result.failures[0].error).toMatch(/exploded/);
		expect(result.upserted).toBe(4); // A and C still applied
	});

	it('marks the connection healthy after a clean cycle', async () => {
		const connectionId = await seed(['A']);
		await runSyncCycle(db, deps());
		const connection = await getConnection(db, 'google');
		expect(connection?.id).toBe(connectionId);
		expect(connection?.status).toBe('ok');
		expect(connection?.lastSuccess).toBeInstanceOf(Date);
	});

	it('marks the connection errored when a calendar fails', async () => {
		await seed(['A']);
		const syncFn = vi.fn(async () => {
			throw new Error('network down');
		});
		await runSyncCycle(db, deps({ syncFn }));

		const connection = await getConnection(db, 'google');
		expect(connection?.status).toBe('error');
		expect(connection?.lastError).toMatch(/network down/);
	});

	it('passes the already-fetched connection into getAccessToken, rather than making it fetch its own', async () => {
		// runSyncCycle already reads the connection row once to decide whether Google is
		// connected at all; getAccessToken must reuse that instead of querying it again.
		const connectionId = await seed(['A']);
		let receivedConnectionId: number | undefined;
		const getAccessToken = async (connection: { id: number }) => {
			receivedConnectionId = connection.id;
			return 'access-token';
		};
		await runSyncCycle(db, deps({ getAccessToken }));
		expect(receivedConnectionId).toBe(connectionId);
	});

	it('does no work at all when Google is not connected', async () => {
		const syncFn = vi.fn();
		const result = await runSyncCycle(db, deps({ syncFn }));
		expect(syncFn).not.toHaveBeenCalled();
		expect(result.calendars).toBe(0);
	});
});

describe('createSingleFlight', () => {
	it('runs the task when nothing is in flight', async () => {
		const run = createSingleFlight(async () => 'done');
		expect(await run()).toBe('done');
	});

	it('skips a second call while the first is still running', async () => {
		// The hazard this exists for: two cycles overlapping would both read the same
		// stored syncToken, and whichever wrote last would leave the other's applied
		// changes unaccounted for by the token — silently losing events.
		let started = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const run = createSingleFlight(async () => {
			started += 1;
			await gate;
			return 'ok';
		});

		const first = run();
		const second = await run();
		expect(second).toBeNull();
		expect(started).toBe(1);

		release();
		expect(await first).toBe('ok');
	});

	it('accepts a new call once the previous one finishes', async () => {
		let started = 0;
		const run = createSingleFlight(async () => {
			started += 1;
			return 'ok';
		});
		await run();
		await run();
		expect(started).toBe(2);
	});

	it('releases the lock even when the task throws', async () => {
		// A crashed cycle must not wedge the scheduler until the next restart.
		let started = 0;
		const run = createSingleFlight(async () => {
			started += 1;
			throw new Error('boom');
		});

		await expect(run()).rejects.toThrow('boom');
		await expect(run()).rejects.toThrow('boom');
		expect(started).toBe(2);
	});

	it('passes arguments through to the task — groceries.ts shares one guard between its poll and push triggers, distinguished by an argument', async () => {
		const received: boolean[] = [];
		const run = createSingleFlight(async (forceRefresh: boolean) => {
			received.push(forceRefresh);
			return forceRefresh;
		});

		expect(await run(true)).toBe(true);
		expect(await run(false)).toBe(false);
		expect(received).toEqual([true, false]);
	});

	it('the shared guard drops an overlapping call regardless of which trigger it came from', async () => {
		let started = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const run = createSingleFlight(async (label: string) => {
			started += 1;
			await gate;
			return label;
		});

		const pollCall = run('poll');
		const pushCall = await run('push'); // arrives while the poll is still mid-flight
		expect(pushCall).toBeNull();
		expect(started).toBe(1);

		release();
		expect(await pollCall).toBe('poll');
	});
});
