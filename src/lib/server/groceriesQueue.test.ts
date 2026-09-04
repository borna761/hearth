import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema';
import { connections, sources, listItems, pendingWrites } from './db/schema';
import {
	enqueueAdd,
	enqueueSetChecked,
	enqueueRemove,
	collapseCheckTogglePairs,
	drainPendingWrites
} from './groceriesQueue';
import type { AnyListItem } from './anylist/client';

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

async function seedSource() {
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
	return source.id;
}

const NOW = new Date('2026-08-25T18:00:00Z');

describe('enqueueAdd', () => {
	it('applies the item optimistically and queues an add', async () => {
		const sourceId = await seedSource();

		const id = enqueueAdd(db, sourceId, { name: 'Milk', quantity: '2' }, NOW);

		const [item] = await db.select().from(listItems).where(eq(listItems.id, id));
		expect(item).toMatchObject({ title: 'Milk', quantity: '2', checked: false });

		const [pending] = await db
			.select()
			.from(pendingWrites)
			.where(eq(pendingWrites.sourceId, sourceId));
		expect(pending.action).toBe('add');
		expect(JSON.parse(pending.payload)).toEqual({ id, name: 'Milk', quantity: '2' });
		expect(pending.nextAttemptAt).toEqual(NOW);
	});

	it("generates a fresh id in the library's own 32-hex-character format on every call", async () => {
		const sourceId = await seedSource();
		const first = enqueueAdd(db, sourceId, { name: 'Milk' }, NOW);
		const second = enqueueAdd(db, sourceId, { name: 'Bread' }, NOW);
		expect(first).toMatch(/^[0-9a-f]{32}$/);
		expect(second).toMatch(/^[0-9a-f]{32}$/);
		expect(first).not.toBe(second);
	});
});

describe('enqueueSetChecked', () => {
	it('updates the item and queues a check when the item exists', async () => {
		const sourceId = await seedSource();
		const id = enqueueAdd(db, sourceId, { name: 'Milk' }, NOW);

		const found = enqueueSetChecked(db, sourceId, id, true, NOW);

		expect(found).toBe(true);
		const [item] = await db.select().from(listItems).where(eq(listItems.id, id));
		expect(item.checked).toBe(true);
		const pending = await db.select().from(pendingWrites).where(eq(pendingWrites.action, 'check'));
		expect(pending).toHaveLength(1);
	});

	it('returns false and enqueues nothing when the item does not belong to this source', async () => {
		const sourceId = await seedSource();

		const found = enqueueSetChecked(db, sourceId, 'nonexistent', true, NOW);

		expect(found).toBe(false);
		const pending = await db.select().from(pendingWrites);
		expect(pending).toHaveLength(0);
	});
});

describe('enqueueRemove', () => {
	it('deletes the local row and queues a remove', async () => {
		const sourceId = await seedSource();
		const id = enqueueAdd(db, sourceId, { name: 'Milk' }, NOW);

		enqueueRemove(db, sourceId, id, NOW);

		const items = await db.select().from(listItems).where(eq(listItems.id, id));
		expect(items).toHaveLength(0);
		const [pending] = await db
			.select()
			.from(pendingWrites)
			.where(eq(pendingWrites.action, 'remove'));
		expect(JSON.parse(pending.payload)).toEqual({ id });
	});

	it('still queues a remove even when the local row is already gone', async () => {
		const sourceId = await seedSource();

		enqueueRemove(db, sourceId, 'already-gone', NOW);

		const pending = await db.select().from(pendingWrites).where(eq(pendingWrites.action, 'remove'));
		expect(pending).toHaveLength(1);
	});
});

function row(id: number, action: 'check' | 'uncheck' | 'add' | 'remove', itemId: string) {
	return {
		id,
		sourceId: 1,
		action,
		payload: JSON.stringify({ id: itemId }),
		attempts: 0,
		lastError: null,
		createdAt: NOW,
		nextAttemptAt: NOW
	};
}

describe('collapseCheckTogglePairs', () => {
	// check/uncheck are absolute SETs, not toggles — "keep only the last row per item" is
	// the only algorithm that's always correct, regardless of what the confirmed state
	// was before the burst. An earlier version pairwise-cancelled adjacent opposite
	// actions instead (treating them like toggles), which could silently drop the
	// household's actual most recent intent under concurrent multi-session writes —
	// caught in code review. See the function's own doc comment for the full reasoning.

	it('keeps only the last action for an item, superseding an earlier opposite one', () => {
		const rows = [row(1, 'check', 'i1'), row(2, 'uncheck', 'i1')];
		const { keep, collapsed } = collapseCheckTogglePairs(rows);
		expect(keep.map((r) => r.id)).toEqual([2]);
		expect(collapsed).toEqual([1]);
	});

	it('keeps only the last of three actions for the same item', () => {
		const rows = [row(1, 'check', 'i1'), row(2, 'uncheck', 'i1'), row(3, 'check', 'i1')];
		const { keep, collapsed } = collapseCheckTogglePairs(rows);
		expect(keep.map((r) => r.id)).toEqual([3]);
		expect(collapsed.sort()).toEqual([1, 2]);
	});

	it('collapses a duplicate action (a rapid double-tap) to just the latest', () => {
		const rows = [row(1, 'check', 'i1'), row(2, 'check', 'i1')];
		const { keep, collapsed } = collapseCheckTogglePairs(rows);
		expect(keep.map((r) => r.id)).toEqual([2]);
		expect(collapsed).toEqual([1]);
	});

	it('does not let unrelated items interfere with each other', () => {
		const rows = [row(1, 'check', 'i1'), row(2, 'uncheck', 'i2'), row(3, 'uncheck', 'i1')];
		// i1: check, then uncheck -> only the uncheck (row3) survives. i2: uncheck alone -> survives.
		const { keep, collapsed } = collapseCheckTogglePairs(rows);
		expect(keep.map((r) => r.id).sort()).toEqual([2, 3]);
		expect(collapsed).toEqual([1]);
	});

	it('leaves add and remove rows untouched regardless of interleaving', () => {
		const rows = [
			row(1, 'add', 'i1'),
			row(2, 'check', 'i2'),
			row(3, 'uncheck', 'i2'),
			row(4, 'remove', 'i3')
		];
		const { keep, collapsed } = collapseCheckTogglePairs(rows);
		expect(keep.map((r) => r.id).sort()).toEqual([1, 3, 4]);
		expect(collapsed).toEqual([2]);
	});
});

function fakeItem(overrides: Partial<AnyListItem> = {}): AnyListItem {
	return {
		id: 'confirmed-id',
		name: 'Milk',
		quantity: null,
		checked: false,
		category: null,
		...overrides
	};
}

describe('drainPendingWrites', () => {
	it('drains a due add, writing the confirmed item under the id AnyList actually used', async () => {
		const sourceId = await seedSource();
		const requestedId = enqueueAdd(db, sourceId, { name: 'Milk', quantity: '2' }, NOW);
		const client = {
			addItem: async () => fakeItem({ id: requestedId, name: 'Milk', quantity: '2' }),
			setChecked: async () => {
				throw new Error('should not be called');
			},
			removeItem: async () => {
				throw new Error('should not be called');
			}
		};

		const result = await drainPendingWrites(db, client, sourceId, 'anylist-list-1', NOW);

		expect(result.drained).toBe(1);
		expect(result.failures).toEqual([]);
		const pending = await db.select().from(pendingWrites);
		expect(pending).toHaveLength(0);
	});

	it('re-keys the optimistic row when AnyList redirects an add onto an existing checked-off item (§2.4)', async () => {
		const sourceId = await seedSource();
		const requestedId = enqueueAdd(db, sourceId, { name: 'Milk' }, NOW);
		const client = {
			// AnyList reused an existing item under a different id, per §2.4.
			addItem: async () => fakeItem({ id: 'existing-id', name: 'Milk', checked: false }),
			setChecked: async () => {},
			removeItem: async () => {}
		};

		await drainPendingWrites(db, client, sourceId, 'anylist-list-1', NOW);

		const underRequestedId = await db.select().from(listItems).where(eq(listItems.id, requestedId));
		expect(underRequestedId).toHaveLength(0);
		const [confirmed] = await db.select().from(listItems).where(eq(listItems.id, 'existing-id'));
		expect(confirmed).toMatchObject({ title: 'Milk', checked: false });
	});

	it('drains a due check, calling setChecked and removing the pending row', async () => {
		const sourceId = await seedSource();
		// Inserted directly, bypassing enqueueAdd, so the item already exists locally
		// without an accompanying pending 'add' row muddying what this test is checking.
		const id = 'i1';
		await db
			.insert(listItems)
			.values({ id, sourceId, title: 'Milk', checked: false, updatedAt: NOW });
		enqueueSetChecked(db, sourceId, id, true, NOW);
		const calls: [string, boolean][] = [];
		const client = {
			addItem: async () => fakeItem(),
			setChecked: async (listId: string, itemId: string, checked: boolean) => {
				calls.push([itemId, checked]);
			},
			removeItem: async () => {}
		};

		const result = await drainPendingWrites(db, client, sourceId, 'anylist-list-1', NOW);

		expect(result.drained).toBe(1);
		expect(calls).toEqual([[id, true]]);
	});

	it('drains a due remove, calling removeItem and removing the pending row', async () => {
		const sourceId = await seedSource();
		const id = enqueueAdd(db, sourceId, { name: 'Milk' }, NOW);
		enqueueRemove(db, sourceId, id, NOW);
		const removed: string[] = [];
		const client = {
			addItem: async (listId: string, item: { id: string }) => fakeItem({ id: item.id }),
			setChecked: async () => {},
			removeItem: async (listId: string, itemId: string) => {
				removed.push(itemId);
			}
		};

		// Two pending rows now exist (the add and the remove) — both due.
		const result = await drainPendingWrites(db, client, sourceId, 'anylist-list-1', NOW);

		expect(result.drained).toBe(2);
		expect(removed).toContain(id);
	});

	it("follows an add's §2.4 id remap when a same-pass remove targets the pre-remap id", async () => {
		// The race this guards against: add "milk" (generates a fresh id), then remove it
		// again before either has drained. If AnyList's own reuse rule redirects the add
		// onto a different, already-existing item, the remove — still holding the
		// original, now-abandoned id — must follow that redirect, or the real AnyList item
		// never gets removed at all.
		const sourceId = await seedSource();
		const requestedId = enqueueAdd(db, sourceId, { name: 'Milk' }, NOW);
		enqueueRemove(db, sourceId, requestedId, NOW);
		const removedIds: string[] = [];
		const client = {
			addItem: async () => fakeItem({ id: 'existing-id', name: 'Milk' }), // reused, §2.4
			setChecked: async () => {},
			removeItem: async (listId: string, itemId: string) => {
				removedIds.push(itemId);
			}
		};

		const result = await drainPendingWrites(db, client, sourceId, 'anylist-list-1', NOW);

		expect(result.drained).toBe(2);
		expect(removedIds).toEqual(['existing-id']);
		expect(removedIds).not.toContain(requestedId);
	});

	it('backs off on failure rather than dropping the row — §6.1: nothing is ever lost', async () => {
		const sourceId = await seedSource();
		enqueueAdd(db, sourceId, { name: 'Milk' }, NOW);
		const client = {
			addItem: async () => {
				throw new Error('AnyList unreachable');
			},
			setChecked: async () => {},
			removeItem: async () => {}
		};

		const result = await drainPendingWrites(db, client, sourceId, 'anylist-list-1', NOW);

		expect(result.drained).toBe(0);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].error).toMatch(/unreachable/);

		const [pending] = await db.select().from(pendingWrites);
		expect(pending.attempts).toBe(1);
		expect(pending.lastError).toMatch(/unreachable/);
		expect(pending.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime());
	});

	it('does not attempt a row before its next_attempt_at', async () => {
		const sourceId = await seedSource();
		enqueueAdd(db, sourceId, { name: 'Milk' }, NOW);
		await db
			.update(pendingWrites)
			.set({ nextAttemptAt: new Date(NOW.getTime() + 60_000) })
			.where(eq(pendingWrites.sourceId, sourceId));
		const client = {
			addItem: async () => {
				throw new Error('should not be called yet');
			},
			setChecked: async () => {},
			removeItem: async () => {}
		};

		const result = await drainPendingWrites(db, client, sourceId, 'anylist-list-1', NOW);

		expect(result.drained).toBe(0);
		expect(result.failures).toEqual([]);
		const pending = await db.select().from(pendingWrites);
		expect(pending).toHaveLength(1); // still there, just not attempted
	});

	it('keeps a row past the attempts cap rather than deleting it', async () => {
		const sourceId = await seedSource();
		enqueueAdd(db, sourceId, { name: 'Milk' }, NOW);
		await db
			.update(pendingWrites)
			.set({ attempts: 15 })
			.where(eq(pendingWrites.sourceId, sourceId));
		const client = {
			addItem: async () => {
				throw new Error('still failing');
			},
			setChecked: async () => {},
			removeItem: async () => {}
		};

		await drainPendingWrites(db, client, sourceId, 'anylist-list-1', NOW);

		const [pending] = await db.select().from(pendingWrites);
		expect(pending.attempts).toBe(16);
		expect(pending).toBeDefined();
	});

	it('collapses a superseded check before draining, sending only the final uncheck', async () => {
		const sourceId = await seedSource();
		const id = enqueueAdd(db, sourceId, { name: 'Milk' }, NOW);
		enqueueSetChecked(db, sourceId, id, true, NOW);
		enqueueSetChecked(db, sourceId, id, false, NOW);
		const setCheckedCalls: boolean[] = [];
		const client = {
			addItem: async () => fakeItem({ id }),
			setChecked: async (listId: string, itemId: string, checked: boolean) => {
				setCheckedCalls.push(checked);
			},
			removeItem: async () => {}
		};

		const result = await drainPendingWrites(db, client, sourceId, 'anylist-list-1', NOW);

		// Only the last (uncheck) is sent — the earlier check is superseded, not "cancelled":
		// check/uncheck are absolute sets, so only the final one determines the correct state.
		expect(setCheckedCalls).toEqual([false]);
		expect(result.collapsed).toBe(1);
		const remainingWrites = await db.select().from(pendingWrites);
		expect(remainingWrites).toHaveLength(0);
	});
});
