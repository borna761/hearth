// Reconciles a freshly-fetched AnyList grocery list into `list_items`, and reads that
// table back out for the SSE envelope — docs/phase-5-plan.md §4: "reconcile, then
// re-apply un-drained writes on top, then publish." AnyList is truth for anything with no
// outstanding write; an outstanding write (the `pending_writes` queue, M3) wins over
// whatever AnyList's own state currently says, so a write in flight is never visibly
// reverted for the few seconds until it actually lands.
//
// M3 is what populates `pending_writes` — until then, replay below is a genuine no-op on
// an always-empty table, not a stub standing in for logic that doesn't exist yet. Writing
// it for real now, against the queue's actual row shape, means M3 doesn't have to come
// back and restructure reconcile's control flow once it exists.

import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema';
import { connections, listItems, pendingWrites, sources } from './db/schema';
import type { AnyListGroceryList } from './anylist/client';

type Db = BetterSQLite3Database<typeof schema>;

export interface ReconcileResult {
	upserted: number;
	pruned: number;
	replayed: number;
}

/**
 * The `pending_writes.payload` JSON contract every action shares — established here since
 * M2 is what first reads it, ahead of M3 actually writing rows. `id` is always the item
 * id the write targets (the client-generated one from client.ts's generateItemId, or —
 * for an `add` that AnyList's own reuse rule redirected onto an existing item, §2.4 — the
 * id AnyList actually returned). `add` additionally carries what to create if AnyList
 * hasn't picked the item up yet by the time this reconcile runs.
 */
export interface PendingWritePayload {
	id: string;
	name?: string;
	quantity?: string | null;
}

/**
 * Reconciles one fetch's worth of AnyList data into `list_items` for a single groceries
 * source, then replays any outstanding local writes on top so an in-flight change is
 * never visibly reverted by a reconcile that started before it, landed after it.
 */
export async function reconcileGroceryList(
	db: Db,
	sourceId: number,
	fetched: AnyListGroceryList,
	now: Date
): Promise<ReconcileResult> {
	const pending = await db
		.select({ id: pendingWrites.id, action: pendingWrites.action, payload: pendingWrites.payload })
		.from(pendingWrites)
		.where(eq(pendingWrites.sourceId, sourceId))
		.orderBy(pendingWrites.id);

	// AnyList is truth for anything with no outstanding write.
	for (let index = 0; index < fetched.items.length; index += 1) {
		const item = fetched.items[index];
		await db
			.insert(listItems)
			.values({
				id: item.id,
				sourceId,
				title: item.name,
				quantity: item.quantity,
				checked: item.checked,
				category: item.category,
				position: index,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: listItems.id,
				set: {
					title: item.name,
					quantity: item.quantity,
					checked: item.checked,
					category: item.category,
					position: index,
					updatedAt: now
				}
			});
	}

	const fetchedIds = new Set(fetched.items.map((item) => item.id));
	const pendingIds = new Set(
		pending.map((row) => (JSON.parse(row.payload) as PendingWritePayload).id)
	);

	// Prune anything AnyList no longer has and nothing local still intends to write —
	// otherwise an item someone just removed reappears the moment the next poll runs, and
	// an item mid-add gets deleted before its own write has even landed. Small table (a
	// household's grocery list, not calendar events), so filtering in JS rather than
	// building a NOT IN (...) query is simpler and avoids that construct's empty-array
	// edge case entirely.
	const current = await db
		.select({ id: listItems.id })
		.from(listItems)
		.where(eq(listItems.sourceId, sourceId));
	const prunable = current.filter((row) => !fetchedIds.has(row.id) && !pendingIds.has(row.id));
	for (const row of prunable) {
		await db.delete(listItems).where(eq(listItems.id, row.id));
	}

	// Replay every outstanding write on top of what reconcile just wrote, in enqueue
	// order, so the last write for a given item wins — the same order the queue itself
	// will eventually drain in (M3).
	for (const row of pending) {
		const payload = JSON.parse(row.payload) as PendingWritePayload;
		if (row.action === 'add') {
			await db
				.insert(listItems)
				.values({
					id: payload.id,
					sourceId,
					title: payload.name ?? '',
					quantity: payload.quantity ?? null,
					checked: false,
					updatedAt: now
				})
				.onConflictDoNothing();
		} else if (row.action === 'check' || row.action === 'uncheck') {
			await db
				.update(listItems)
				.set({ checked: row.action === 'check' })
				.where(eq(listItems.id, payload.id));
		} else if (row.action === 'remove') {
			await db.delete(listItems).where(eq(listItems.id, payload.id));
		}
	}

	return { upserted: fetched.items.length, pruned: prunable.length, replayed: pending.length };
}

export interface GroceriesItemSnapshot {
	id: string;
	title: string;
	quantity: string | null;
	checked: boolean;
	category: string | null;
	/** Has an outstanding `pending_writes` row — M4's pending mark (§6.1 point 3). */
	pending: boolean;
}

export interface GroceriesSnapshot {
	items: GroceriesItemSnapshot[];
	/** Unchecked items only — DESIGN.md §7.3's "🛒 12" is what's still needed, not
	 *  everything on the list including what's already in the cart. */
	count: number;
	/** DESIGN.md §2.5: "an outage degrades one card to a stale badge, never the page." */
	stale: boolean;
}

/**
 * What the SSE envelope carries for groceries — null when AnyList has never been
 * connected (no `sources` row of kind 'groceries' exists yet), so the client can tell
 * "nothing to show" apart from "an empty list."
 */
export async function buildGroceriesSnapshot(db: Db): Promise<GroceriesSnapshot | null> {
	const [source] = await db
		.select({ id: sources.id, connectionId: sources.connectionId })
		.from(sources)
		.where(eq(sources.kind, 'groceries'))
		.limit(1);
	if (!source) return null;

	const [connection] = await db
		.select({ status: connections.status })
		.from(connections)
		.where(eq(connections.id, source.connectionId))
		.limit(1);

	const rows = await db
		.select({
			id: listItems.id,
			title: listItems.title,
			quantity: listItems.quantity,
			checked: listItems.checked,
			category: listItems.category
		})
		.from(listItems)
		.where(eq(listItems.sourceId, source.id))
		.orderBy(listItems.position);

	// Which items have an outstanding write, for M4's pending mark — same "small table,
	// filter in JS" approach reconcileGroceryList already uses rather than extracting the
	// id out of payload's JSON in SQL.
	const pendingRows = await db
		.select({ payload: pendingWrites.payload })
		.from(pendingWrites)
		.where(eq(pendingWrites.sourceId, source.id));
	const pendingIds = new Set(
		pendingRows.map((row) => (JSON.parse(row.payload) as PendingWritePayload).id)
	);

	return {
		items: rows.map((row) => ({ ...row, pending: pendingIds.has(row.id) })),
		count: rows.filter((row) => !row.checked).length,
		stale: connection?.status === 'error'
	};
}
