// Sync scheduling — DESIGN.md §3.1's two cadences, driven in-process (§10: "server
// routes host sync in-process"). Only the photo resize gets its own systemd unit (§6),
// because only that one has a memory spike worth isolating.

import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';
import { sources } from '../db/schema';
import { getConnection, markConnectionStatus, type ConnectionRecord } from '../connections';
import { getSetting, setSetting, SETTING_KEYS } from '../settings';
import { localDateInZone, localHourInZone } from '$lib/datetime';
import { buildSyncWindow, syncCalendar, type SyncResult } from '../google/sync';
import { discoverCalendars } from '../google/discovery';
import { listGoogleCalendars } from '../google/api';

type Db = BetterSQLite3Database<typeof schema>;

/** DESIGN.md §3.1: 02:00, inside quiet hours and an hour clear of the photo resize. */
const FULL_SYNC_HOUR = 2;

export interface CycleResult {
	mode: 'full' | 'incremental';
	calendars: number;
	upserted: number;
	deleted: number;
	pruned: number;
	failures: { calendar: string; error: string }[];
}

/**
 * Joins a cycle's per-item failures into one status message for `markConnectionStatus`.
 * Shared with anylist/scheduler.ts's runGroceriesCycle, which had its own near-identical
 * copy of this until code review flagged the duplication — extracted here rather than
 * left duplicated, since `sync/scheduler.ts` is already the shared home for cycle-level
 * utilities like `createSingleFlight` below.
 */
export function formatFailures<T extends { error: string }>(
	failures: T[],
	keyOf: (failure: T) => string
): string {
	return failures.map((f) => `${keyOf(f)}: ${f.error}`).join('; ');
}

type SyncFn = typeof syncCalendar;

export interface CycleDeps {
	// Takes the connection runSyncCycle already fetched, rather than looking it up again.
	getAccessToken: (connection: ConnectionRecord) => Promise<string>;
	now: Date;
	timeZone: string;
	syncFn?: SyncFn;
	fetchFn?: typeof fetch;
	// Re-fetches the account's calendar list and refreshes color/displayName/groupLabel
	// (and picks up any calendar Google added since the last discovery) — only worth the
	// extra API call on the full-sync cadence, not every five-minute incremental tick.
	// Injectable so tests don't need a real Google client.
	discoverFn?: (db: Db, connectionId: number, accessToken: string) => Promise<void>;
}

/**
 * Decides whether this cycle re-anchors the rolling window.
 *
 * Deliberately a date-stamped ledger rather than matching the clock against 02:00. An
 * exact-time match silently skips the day if the process happens to be down at 02:00, or
 * if a tick lands either side of it — whereas "is there a full sync recorded for today's
 * local date, and has 02:00 passed?" self-heals on the very next tick.
 */
async function shouldRunFullSync(db: Db, now: Date, timeZone: string): Promise<boolean> {
	const today = localDateInZone(now, timeZone);
	const lastFull = await getSetting(db, SETTING_KEYS.lastFullSyncDate);
	if (lastFull === today) return false;
	return localHourInZone(now, timeZone) >= FULL_SYNC_HOUR;
}

export async function runSyncCycle(db: Db, deps: CycleDeps): Promise<CycleResult> {
	const syncFn = deps.syncFn ?? syncCalendar;
	const discoverFn =
		deps.discoverFn ??
		((discoverDb: Db, connectionId: number, accessToken: string) =>
			discoverCalendars(discoverDb, connectionId, () => listGoogleCalendars(accessToken)));
	const connection = await getConnection(db, 'google');

	if (!connection) {
		return { mode: 'incremental', calendars: 0, upserted: 0, deleted: 0, pruned: 0, failures: [] };
	}

	const forceFull = await shouldRunFullSync(db, deps.now, deps.timeZone);
	const window = buildSyncWindow(deps.now, deps.timeZone);

	const failures: CycleResult['failures'] = [];
	let upserted = 0;
	let deleted = 0;
	let pruned = 0;
	let accessToken: string;

	try {
		accessToken = await deps.getAccessToken(connection);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await markConnectionStatus(db, connection.id, { status: 'error', lastError: message });
		return {
			mode: forceFull ? 'full' : 'incremental',
			calendars: 0,
			upserted: 0,
			deleted: 0,
			pruned: 0,
			failures: [{ calendar: '(token)', error: message }]
		};
	}

	if (forceFull) {
		// Same cadence as the full event sync, not every five-minute incremental tick —
		// color/name/grouping rarely change, and this also picks up any calendar Google
		// added since the last discovery. A failure here shouldn't cost the household its
		// event sync, so it's recorded as a failure rather than thrown.
		try {
			await discoverFn(db, connection.id, accessToken);
		} catch (err) {
			failures.push({
				calendar: '(discovery)',
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	const calendars = await db
		.select()
		.from(sources)
		.where(
			and(
				eq(sources.connectionId, connection.id),
				eq(sources.kind, 'calendar'),
				eq(sources.enabled, true)
			)
		);

	// Strictly sequential. Thirteen concurrent HTTPS requests on a 463MB board shared with
	// Pi-hole (§2.1) is not affordable, and the consequence of overcommitting there is the
	// household losing DNS — worse than a slow calendar refresh.
	for (const source of calendars) {
		try {
			const result: SyncResult = await syncFn(db, source, accessToken, {
				window,
				forceFull,
				fetchFn: deps.fetchFn
			});
			upserted += result.upserted;
			deleted += result.deleted;
			pruned += result.pruned;
		} catch (err) {
			// One bad calendar must not cost the other twelve their refresh.
			failures.push({
				calendar: source.displayName,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	if (forceFull) {
		// Stamped even when some calendars failed. The ledger's job is "don't re-run the
		// expensive full sync repeatedly today" — retrying it every five minutes because
		// one feed is broken would mean 13 full syncs × 288 ticks a day. The failed ones
		// keep their stored token, so incremental polling still works for them, and
		// tomorrow's cycle re-anchors them.
		await setSetting(db, SETTING_KEYS.lastFullSyncDate, localDateInZone(deps.now, deps.timeZone));
	}

	await markConnectionStatus(
		db,
		connection.id,
		failures.length === 0
			? { status: 'ok', lastSuccess: deps.now }
			: { status: 'error', lastError: formatFailures(failures, (f) => f.calendar) }
	);

	return {
		mode: forceFull ? 'full' : 'incremental',
		calendars: calendars.length,
		upserted,
		deleted,
		pruned,
		failures
	};
}

/**
 * Wraps a task so overlapping calls are dropped rather than queued.
 *
 * The hazard: a five-minute tick firing while the previous cycle is still going. Both
 * would read the same stored syncToken, both would fetch the same delta, and whichever
 * wrote last would leave the other's applied changes unaccounted for by the token — so
 * the next sync starts from a cursor that has already skipped past events nobody
 * recorded. Events go missing silently. Dropping the overlapping tick is correct because
 * another one is only five minutes away.
 */
/**
 * Generic over the task's arguments (not just its result) so two different call sites —
 * e.g. groceries.ts's poll (forces a fresh fetch) and its push handler (already fresh) —
 * can share one guard and genuinely never run concurrently with each other, rather than
 * each getting its own independent `running` flag that only protects against overlapping
 * with itself.
 */
export function createSingleFlight<Args extends unknown[], T>(
	task: (...args: Args) => Promise<T>
): (...args: Args) => Promise<T | null> {
	let running = false;

	return async (...args: Args) => {
		if (running) return null;
		running = true;
		try {
			return await task(...args);
		} finally {
			// finally, not after the await: a thrown cycle must not wedge the scheduler
			// until the next process restart.
			running = false;
		}
	};
}
