// One groceries cycle — reconcile, then drain any due pending writes — the AnyList-
// specific analog of google/sync.ts's syncCalendar. Kept separate from sync/runtime.ts's
// timer wiring so it stays testable without touching setInterval/setTimeout, the same
// split google/sync.ts and sync/scheduler.ts already use.
//
// Reconcile before drain, always, in the same pass: reconcile establishes local truth
// (including replaying whatever's still queued, docs/phase-5-plan.md §4) and drain is what
// actually talks to AnyList and corrects list_items with the confirmed result — running
// them any other order, or letting a poll and a drain touch the same AnyListClient
// concurrently, risks the library's own internal state (its cached `this.lists`) getting
// read mid-write. Both are wrapped in the one single-flight guard the caller applies to
// this whole function, not two independent ones.
//
// Never throws: like runSyncCycle, a failure is caught, marks the connection's status, and
// is reported back in the result rather than propagating — one bad cycle must not take
// down the interval that would otherwise retry it.

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';
import { markConnectionStatus } from '../connections';
import { reconcileGroceryList, type ReconcileResult } from '../groceries';
import { drainPendingWrites } from '../groceriesQueue';
import { formatFailures } from '../sync/scheduler';
import type { AnyListClient } from './client';

type Db = BetterSQLite3Database<typeof schema>;

export interface GroceriesCycleResult extends ReconcileResult {
	drained: number;
	error: string | null;
}

export interface GroceriesCycleDeps {
	client: Pick<AnyListClient, 'fetchItems' | 'refresh' | 'addItem' | 'setChecked' | 'removeItem'>;
	connectionId: number;
	sourceId: number;
	/** AnyList's own list identifier (sources.external_id) — what fetchItems keys on,
	 *  never the display name (DESIGN.md §2.5). */
	externalId: string;
	now: Date;
	/**
	 * True for the 15-minute poll (docs/phase-5-plan.md §2.1: the actual freshness
	 * guarantee, independent of whether AnyList's push channel is still alive) — false for
	 * a push, since the library has already refreshed its own cache by the time
	 * `onListsUpdate`'s callback fires, and refreshing again would be a redundant network
	 * round trip on every single item someone adds.
	 */
	forceRefresh: boolean;
}

export async function runGroceriesCycle(
	db: Db,
	deps: GroceriesCycleDeps
): Promise<GroceriesCycleResult> {
	try {
		if (deps.forceRefresh) await deps.client.refresh();
		const fetched = deps.client.fetchItems(deps.externalId);
		const reconciled = await reconcileGroceryList(db, deps.sourceId, fetched, deps.now);
		const drain = await drainPendingWrites(
			db,
			deps.client,
			deps.sourceId,
			deps.externalId,
			deps.now
		);

		// A write failing is the same signal as a read failing — §2.5: "an outage degrades
		// one card to a stale badge" — so it marks the connection the same way, even though
		// reconcile itself succeeded.
		if (drain.failures.length > 0) {
			const message = formatFailures(drain.failures, (f) => f.itemId);
			await markConnectionStatus(db, deps.connectionId, { status: 'error', lastError: message });
			return { ...reconciled, drained: drain.drained, error: message };
		}

		await markConnectionStatus(db, deps.connectionId, { status: 'ok', lastSuccess: deps.now });
		return { ...reconciled, drained: drain.drained, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await markConnectionStatus(db, deps.connectionId, { status: 'error', lastError: message });
		return { upserted: 0, pruned: 0, replayed: 0, drained: 0, error: message };
	}
}
