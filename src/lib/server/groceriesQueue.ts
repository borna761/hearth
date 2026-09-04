// The grocery write queue — DESIGN.md §6.1 and docs/phase-5-plan.md §4. A mutation never
// goes straight to AnyList: it's applied optimistically to `list_items` and queued in
// `pending_writes` in one transaction, so the tablet reflects it immediately regardless of
// whether AnyList is reachable, and drainPendingWrites is what actually talks to AnyList
// afterward, with exponential backoff on failure.

import { eq, and, lte, isNull, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema';
import { listItems, pendingWrites } from './db/schema';
import { generateItemId, type AnyListClient } from './anylist/client';
import type { PendingWritePayload } from './groceries';

type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The shape every enqueue* function's pending_writes insert shares — extracted during
 *  code review after all three had copy-pasted the identical block. */
function insertPendingWrite(
	tx: Tx,
	sourceId: number,
	action: (typeof pendingWrites.$inferInsert)['action'],
	payload: PendingWritePayload,
	now: Date
): void {
	tx.insert(pendingWrites)
		.values({
			sourceId,
			action,
			payload: JSON.stringify(payload),
			createdAt: now,
			nextAttemptAt: now
		})
		.run();
}

/**
 * Adds an item optimistically and queues the write. The id is generated here, up front —
 * docs/phase-5-plan.md §3 — rather than after AnyList responds, so the row the tablet
 * shows immediately and the row `drainPendingWrites` eventually confirms share one primary
 * key from the start.
 */
export function enqueueAdd(
	db: Db,
	sourceId: number,
	input: { name: string; quantity?: string | null },
	now: Date
): string {
	const id = generateItemId();
	const payload: PendingWritePayload = { id, name: input.name, quantity: input.quantity ?? null };

	db.transaction((tx) => {
		tx.insert(listItems)
			.values({
				id,
				sourceId,
				title: input.name,
				quantity: input.quantity ?? null,
				checked: false,
				updatedAt: now
			})
			.run();
		insertPendingWrite(tx, sourceId, 'add', payload, now);
	});

	return id;
}

/**
 * Checks or unchecks an existing item optimistically and queues the write. Returns false
 * without enqueueing anything if the item doesn't belong to this source — enqueueing a
 * write for an id nothing local recognises would just fail forever at AnyList's end with
 * no way for anyone to notice.
 */
export function enqueueSetChecked(
	db: Db,
	sourceId: number,
	itemId: string,
	checked: boolean,
	now: Date
): boolean {
	let found = false;

	db.transaction((tx) => {
		const result = tx
			.update(listItems)
			.set({ checked, updatedAt: now })
			.where(and(eq(listItems.id, itemId), eq(listItems.sourceId, sourceId)))
			.run();
		found = result.changes > 0;
		if (!found) return;

		insertPendingWrite(tx, sourceId, checked ? 'check' : 'uncheck', { id: itemId }, now);
	});

	return found;
}

/**
 * Removes an item optimistically and queues the write. Unlike the other two, a "not
 * found" case still enqueues the remove — client.ts's removeItem is already documented as
 * a no-op rather than an error when AnyList doesn't have the item either, so there's no
 * failure mode to protect against here, and it keeps this function correct even against a
 * stale client that thinks an item exists when the local row is already gone.
 */
export function enqueueRemove(db: Db, sourceId: number, itemId: string, now: Date): void {
	db.transaction((tx) => {
		tx.delete(listItems)
			.where(and(eq(listItems.id, itemId), eq(listItems.sourceId, sourceId)))
			.run();
		insertPendingWrite(tx, sourceId, 'remove', { id: itemId }, now);
	});
}

// docs/phase-5-plan.md §4: "Cap attempts around 10 for the backoff ceiling."
const MAX_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

/** Exponential, capped — 30s, 1m, 2m, 4m, ... up to 30 minutes between retries. */
function backoffMs(attempts: number): number {
	return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS);
}

type PendingWriteRow = typeof pendingWrites.$inferSelect;

/**
 * docs/phase-5-plan.md §4: "A check followed by an uncheck on the same item id, both
 * undrained, cancel out — drop both rather than making two round trips."
 *
 * **Corrected during code review (2026-08-25) from an earlier version that pairwise-
 * cancelled adjacent opposite actions like a toggle.** check/uncheck are absolute SETs
 * (`item.checked = X`), not toggles — for any sequence of them, only the *last* one
 * determines the correct final state, regardless of what came before it. Pairwise
 * cancellation only happens to produce the right answer when a burst is a single client's
 * own alternating toggle sequence starting from a known confirmed state; DESIGN.md §5.1
 * lets every household member write groceries with no per-item lock, so that assumption
 * isn't guaranteed. Under concurrent access, the old algorithm could cancel an even-length
 * burst down to nothing and permanently, silently drop the household's actual most recent
 * intent (the rows were hard-deleted with no retry). "Keep only the last row per item" is
 * unconditionally correct instead: it costs one real round trip in the common single-client
 * toggle-burst case (where the true confirmed state and desired end state happen to match,
 * so the round trip is technically redundant but harmless), in exchange for never losing an
 * intended state change.
 *
 * `add`/`remove` rows are left untouched — collapsing an add immediately followed by a
 * remove is a real case too, but it isn't what this milestone's spec asked for, and
 * guessing at the right behaviour (does AnyList's own reuse rule change what "cancel" even
 * means for an add?) isn't worth doing without it being asked for.
 *
 * Returns the rows to actually keep and drain, in their original relative order, plus the
 * ids of any rows this collapsed away — those get deleted outright, no AnyList call.
 */
export function collapseCheckTogglePairs(rows: PendingWriteRow[]): {
	keep: PendingWriteRow[];
	collapsed: number[];
} {
	const lastForItem = new Map<string, PendingWriteRow>();
	for (const row of rows) {
		if (row.action !== 'check' && row.action !== 'uncheck') continue;
		const { id } = JSON.parse(row.payload) as PendingWritePayload;
		lastForItem.set(id, row);
	}

	const survivingIds = new Set(Array.from(lastForItem.values(), (row) => row.id));
	const collapsed: number[] = [];
	const keep = rows.filter((row) => {
		if (row.action !== 'check' && row.action !== 'uncheck') return true;
		if (survivingIds.has(row.id)) return true;
		collapsed.push(row.id);
		return false;
	});

	return { keep, collapsed };
}

export interface DrainResult {
	drained: number;
	/** One entry per row that failed this pass — the caller (runGroceriesCycle) uses these
	 *  to decide whether the connection is still healthy, the same way runSyncCycle joins
	 *  per-calendar failures into one status message. */
	failures: { itemId: string; error: string }[];
	collapsed: number;
}

/**
 * Actually talks to AnyList for every due pending write, FIFO by enqueue order — §4: "out
 * of order drains turn a check→uncheck pair into the wrong final state." Never called
 * concurrently with itself or with a reconcile against the same client — the caller
 * (anylist/scheduler.ts's runGroceriesCycle) is what's wrapped in the single-flight guard,
 * not this function on its own.
 */
export async function drainPendingWrites(
	db: Db,
	client: Pick<AnyListClient, 'addItem' | 'setChecked' | 'removeItem'>,
	sourceId: number,
	externalId: string,
	now: Date
): Promise<DrainResult> {
	const due = await db
		.select()
		.from(pendingWrites)
		.where(
			and(
				eq(pendingWrites.sourceId, sourceId),
				or(isNull(pendingWrites.nextAttemptAt), lte(pendingWrites.nextAttemptAt, now))
			)
		)
		.orderBy(pendingWrites.id);

	const { keep, collapsed } = collapseCheckTogglePairs(due);
	for (const id of collapsed) {
		await db.delete(pendingWrites).where(eq(pendingWrites.id, id));
	}

	let drained = 0;
	const failures: DrainResult['failures'] = [];
	// If an `add` earlier in *this same pass* got redirected onto a different confirmed id
	// (§2.4), a `remove` (or check/uncheck) later in the same pass for the pre-remap id
	// must follow that redirect too — otherwise it targets an id that's already gone from
	// list_items and the real AnyList item it should have removed is never touched. Across
	// separate passes this can't happen: the tablet only ever acts on whatever id the last
	// reconcile showed it, which is already the confirmed one by then.
	const remap = new Map<string, string>();

	for (const row of keep) {
		const payload = JSON.parse(row.payload) as PendingWritePayload;
		const targetId = remap.get(payload.id) ?? payload.id;

		try {
			if (row.action === 'add') {
				const result = await client.addItem(externalId, {
					id: targetId,
					name: payload.name ?? '',
					quantity: payload.quantity
				});
				// §2.4: AnyList may have redirected this onto an existing checked-off item —
				// the confirmed id can differ from the one this app generated and showed
				// optimistically. Drop the optimistic row under the wrong id and write the
				// confirmed one under the real id, rather than waiting for the next poll.
				// One transaction, not two independent statements: the AnyList write above
				// already succeeded by this point, so if the delete lands but a later
				// statement throws, the real item must not silently vanish from list_items
				// until the next cycle — both writes commit together or neither does, and
				// either way this whole try block's catch still treats it as `add` failing.
				const wasRemapped = result.id !== targetId;
				if (wasRemapped) remap.set(payload.id, result.id);
				db.transaction((tx) => {
					if (wasRemapped) {
						tx.delete(listItems).where(eq(listItems.id, targetId)).run();
					}
					tx.insert(listItems)
						.values({
							id: result.id,
							sourceId,
							title: result.name,
							quantity: result.quantity,
							checked: result.checked,
							updatedAt: now
						})
						.onConflictDoUpdate({
							target: listItems.id,
							set: {
								title: result.name,
								quantity: result.quantity,
								checked: result.checked,
								updatedAt: now
							}
						})
						.run();
				});
			} else if (row.action === 'check' || row.action === 'uncheck') {
				await client.setChecked(externalId, targetId, row.action === 'check');
			} else {
				await client.removeItem(externalId, targetId);
			}

			await db.delete(pendingWrites).where(eq(pendingWrites.id, row.id));
			drained += 1;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			failures.push({ itemId: targetId, error: message });
			const attempts = row.attempts + 1;
			// §6.1: "nothing is ever lost, only delayed" — the row stays even past the cap,
			// just retried far less often, rather than ever being dropped.
			await db
				.update(pendingWrites)
				.set({
					attempts,
					lastError: message,
					nextAttemptAt: new Date(now.getTime() + backoffMs(Math.min(attempts, MAX_ATTEMPTS)))
				})
				.where(eq(pendingWrites.id, row.id));
		}
	}

	return { drained, failures, collapsed: collapsed.length };
}
