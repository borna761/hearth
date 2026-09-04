// Owns the one process-wide AnyList connection groceries needs — the live client, and the
// ids resolved once at startup — so both sync/runtime.ts's background timers and the
// /api/groceries routes can trigger a cycle through the same guarded path, mirroring
// state/publisher.ts's own "process-wide singleton, exported control functions" shape
// rather than leaving this trapped in sync/runtime.ts's closure where a route can't reach
// it (DESIGN.md §5.1/§7.2.1: an add should reach AnyList promptly, not wait for the next
// scheduled poll — see docs/phase-5-plan.md's M3 notes for why this exists).

import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { db as defaultDb } from './db';
import type * as schema from './db/schema';
import { sources } from './db/schema';
import { getConnection, markConnectionStatus } from './connections';
import { connectAnyList, type AnyListClient, type AnyListCredentials } from './anylist/client';
import { resolveGroceryList } from './anylist/resolve';
import { runGroceriesCycle, type GroceriesCycleResult } from './anylist/scheduler';
import { createSingleFlight } from './sync/scheduler';

type Db = BetterSQLite3Database<typeof schema>;

interface RuntimeState {
	client: AnyListClient;
	connectionId: number;
	sourceId: number;
	externalId: string;
}

let state: RuntimeState | null = null;
let runCycleGuarded: ((forceRefresh: boolean) => Promise<GroceriesCycleResult | null>) | null =
	null;

/**
 * Logs in and resolves "My Grocery List" once. Returns false — never throws — when
 * AnyList isn't connected yet, login fails, or the account is missing the expected list:
 * all normal states this app can be in, matching every other syncable source's own
 * tolerance for "not configured yet".
 */
export async function initGroceriesRuntime(): Promise<boolean> {
	const connection = await getConnection<AnyListCredentials>(defaultDb, 'anylist');
	if (!connection) return false;

	try {
		const client = await connectAnyList(connection.secrets);
		const sourceId = await resolveGroceryList(defaultDb, connection.id, client);
		const [source] = await defaultDb
			.select({ externalId: sources.externalId })
			.from(sources)
			.where(eq(sources.id, sourceId))
			.limit(1);
		if (!source) throw new Error('groceries source row vanished right after being resolved');

		state = { client, connectionId: connection.id, sourceId, externalId: source.externalId };
		// One shared guard across every trigger (the 15-min poll, a debounced push, and an
		// API route's own "drain now") — not one each — so none of them can ever run
		// concurrently with each other against the same client. docs/phase-5-plan.md §2.2.
		runCycleGuarded = createSingleFlight((forceRefresh: boolean) =>
			runGroceriesCycle(defaultDb, {
				client: state!.client,
				connectionId: state!.connectionId,
				sourceId: state!.sourceId,
				externalId: state!.externalId,
				now: new Date(),
				forceRefresh
			})
		);
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn('[groceries] connect failed:', message);
		await markConnectionStatus(defaultDb, connection.id, { status: 'error', lastError: message });
		return false;
	}
}

/** The groceries `sources.id` — null before initGroceriesRuntime succeeds. Routes need
 *  this to enqueue a write against the right source. */
export function groceriesSourceId(): number | null {
	return state?.sourceId ?? null;
}

export type GroceriesReadiness = 'ready' | 'initializing' | 'not-connected';

/**
 * Distinguishes, for a caller deciding how to respond to `groceriesSourceId() === null`,
 * "AnyList was never configured" from "it's configured but still starting up" — added
 * during code review: `initGroceriesRuntime` doesn't even run until `STARTUP_DELAY_MS`
 * after boot, then does a real login + list-resolution round trip, and every deploy
 * restarts the process (per CLAUDE.md), so a request landing in that window previously got
 * the exact same 503 a genuinely unconfigured account would — no way for a client to know
 * whether to just wait and retry. Reads the `connections` row directly rather than the
 * in-memory `state`, since a connection existing is the fact that distinguishes the two
 * cases regardless of whether `initGroceriesRuntime` has finished (or even started) yet.
 * Takes `db` as a parameter — defaulting to the real singleton, like `publishState` in
 * state/publisher.ts — rather than closing over the module import directly, so it's
 * testable against an in-memory database instead of the process's real one.
 */
export async function groceriesReadiness(db: Db = defaultDb): Promise<GroceriesReadiness> {
	if (state) return 'ready';
	const connection = await getConnection(db, 'anylist');
	return connection ? 'initializing' : 'not-connected';
}

/** How recently any cycle (poll, push, or a route's own trigger) last completed. Used to
 *  suppress a push-triggered cycle that lands immediately after one already ran — see
 *  `recentlyCycled` below. */
let lastCycleAt: number | null = null;

/**
 * Triggers one cycle through the shared guard. Returns null if uninitialised or a cycle
 * is already in flight — both harmless: the next poll, push, or trigger picks up whatever
 * this one would have. `forceRefresh` should only ever be true for the scheduled poll;
 * every other caller (a push handler, an API route after enqueueing) already has — or
 * doesn't need — fresh data and would just be spending an extra network round trip.
 */
export async function runGroceriesCycleNow(
	forceRefresh = false
): Promise<GroceriesCycleResult | null> {
	if (!runCycleGuarded) return null;
	const result = await runCycleGuarded(forceRefresh);
	if (result) lastCycleAt = Date.now();
	return result;
}

/**
 * True if a cycle completed within the last `withinMs` — added during code review. A
 * write's own route already triggers a full reconcile+drain immediately; if that drain
 * succeeds, AnyList's push channel plausibly echoes the same change back moments later
 * (unconfirmed from outside the library, but harmless either way to assume), which would
 * otherwise trigger a second full cycle — a real cost on a Pi Zero 2 W, since reconcile
 * walks every item in the list, not just the one that changed. Callers use this to skip a
 * push-triggered cycle that's almost certainly just that echo, at the cost of occasionally
 * delaying a genuine third-party change by up to this same window — bounded, and no worse
 * than the staleness the 15-minute poll already tolerates by design (docs/phase-5-plan.md
 * §2.1: push was always an optimisation, never the correctness guarantee).
 */
export function recentlyCycled(withinMs: number): boolean {
	return lastCycleAt !== null && Date.now() - lastCycleAt < withinMs;
}

/** Registers the push handler once initGroceriesRuntime has succeeded. A no-op otherwise —
 *  there's no client to listen on yet. */
export function onGroceriesListsUpdate(callback: () => void): void {
	state?.client.onListsUpdate(callback);
}
