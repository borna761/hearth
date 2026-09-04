import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema';
import { connections, sources, listItems, pendingWrites } from './db/schema';
import { reconcileGroceryList, buildGroceriesSnapshot } from './groceries';
import type { AnyListGroceryList } from './anylist/client';

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

// `category` defaults to null here rather than being required at every call site below —
// none of these tests care about it, and hand-adding it to every item literal would just
// be noise. Tests that specifically need a category should pass one explicitly; the spread
// below lets that override this default.
function fetchedList(
	items: Array<Omit<AnyListGroceryList['items'][number], 'category'> & { category?: string | null }>
): AnyListGroceryList {
	return {
		id: 'anylist-list-1',
		name: 'My Grocery List',
		items: items.map((item) => ({ category: null, ...item }))
	};
}

const NOW = new Date('2026-08-25T18:00:00Z');

describe('reconcileGroceryList', () => {
	it('upserts every fetched item into list_items', async () => {
		const sourceId = await seedSource();
		const result = await reconcileGroceryList(
			db,
			sourceId,
			fetchedList([
				{ id: 'i1', name: 'Milk', quantity: '2', checked: false },
				{ id: 'i2', name: 'Bread', quantity: null, checked: true }
			]),
			NOW
		);

		expect(result.upserted).toBe(2);
		const rows = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.id === 'i1')).toMatchObject({
			title: 'Milk',
			quantity: '2',
			checked: false,
			position: 0
		});
		expect(rows.find((r) => r.id === 'i2')).toMatchObject({
			title: 'Bread',
			quantity: null,
			checked: true,
			position: 1
		});
	});

	it('persists category alongside the rest of the item, including when it changes', async () => {
		const sourceId = await seedSource();
		await reconcileGroceryList(
			db,
			sourceId,
			fetchedList([{ id: 'i1', name: 'Milk', quantity: null, checked: false, category: 'Dairy' }]),
			NOW
		);
		let rows = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
		expect(rows[0].category).toBe('Dairy');

		await reconcileGroceryList(
			db,
			sourceId,
			fetchedList([
				{ id: 'i1', name: 'Milk', quantity: null, checked: false, category: 'Beverages' }
			]),
			NOW
		);
		rows = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
		expect(rows[0].category).toBe('Beverages');
	});

	it('updates an existing row in place rather than duplicating it', async () => {
		const sourceId = await seedSource();
		await reconcileGroceryList(
			db,
			sourceId,
			fetchedList([{ id: 'i1', name: 'Milk', quantity: '1', checked: false }]),
			NOW
		);
		await reconcileGroceryList(
			db,
			sourceId,
			fetchedList([{ id: 'i1', name: 'Milk', quantity: '2', checked: true }]),
			NOW
		);

		const rows = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ quantity: '2', checked: true });
	});

	it('prunes a row AnyList no longer has and nothing local is waiting to write', async () => {
		const sourceId = await seedSource();
		await reconcileGroceryList(
			db,
			sourceId,
			fetchedList([{ id: 'i1', name: 'Milk', quantity: null, checked: false }]),
			NOW
		);

		const result = await reconcileGroceryList(db, sourceId, fetchedList([]), NOW);

		expect(result.pruned).toBe(1);
		const rows = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
		expect(rows).toHaveLength(0);
	});

	it('does not prune a row with an outstanding pending write, even if AnyList no longer has it', async () => {
		const sourceId = await seedSource();
		await reconcileGroceryList(
			db,
			sourceId,
			fetchedList([{ id: 'i1', name: 'Milk', quantity: null, checked: false }]),
			NOW
		);
		await db.insert(pendingWrites).values({
			sourceId,
			action: 'check',
			payload: JSON.stringify({ id: 'i1' }),
			createdAt: NOW
		});

		// AnyList's fetch hasn't caught up to the in-flight write yet — the item still
		// isn't in the fetched list.
		const result = await reconcileGroceryList(db, sourceId, fetchedList([]), NOW);

		expect(result.pruned).toBe(0);
		const rows = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
		expect(rows).toHaveLength(1);
	});

	describe('replaying pending writes on top of AnyList truth', () => {
		it('inserts an add that AnyList has not picked up yet', async () => {
			const sourceId = await seedSource();
			await db.insert(pendingWrites).values({
				sourceId,
				action: 'add',
				payload: JSON.stringify({ id: 'new-1', name: 'Eggs', quantity: '12' }),
				createdAt: NOW
			});

			const result = await reconcileGroceryList(db, sourceId, fetchedList([]), NOW);

			expect(result.replayed).toBe(1);
			const rows = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ id: 'new-1', title: 'Eggs', quantity: '12', checked: false });
		});

		it('does not duplicate an add once AnyList has confirmed it', async () => {
			const sourceId = await seedSource();
			await db.insert(pendingWrites).values({
				sourceId,
				action: 'add',
				payload: JSON.stringify({ id: 'i1', name: 'Eggs' }),
				createdAt: NOW
			});

			await reconcileGroceryList(
				db,
				sourceId,
				fetchedList([{ id: 'i1', name: 'Eggs', quantity: null, checked: false }]),
				NOW
			);

			const rows = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
			expect(rows).toHaveLength(1);
		});

		it('forces checked on top of whatever AnyList just reported, so an in-flight toggle is never reverted', async () => {
			const sourceId = await seedSource();
			await db.insert(pendingWrites).values({
				sourceId,
				action: 'check',
				payload: JSON.stringify({ id: 'i1' }),
				createdAt: NOW
			});

			// The reconcile started before the check landed on AnyList's side, so the fetch
			// still shows it unchecked.
			const result = await reconcileGroceryList(
				db,
				sourceId,
				fetchedList([{ id: 'i1', name: 'Milk', quantity: null, checked: false }]),
				NOW
			);

			expect(result.replayed).toBe(1);
			const [row] = await db.select().from(listItems).where(eq(listItems.id, 'i1'));
			expect(row.checked).toBe(true);
		});

		it('forces unchecked the same way', async () => {
			const sourceId = await seedSource();
			await db.insert(pendingWrites).values({
				sourceId,
				action: 'uncheck',
				payload: JSON.stringify({ id: 'i1' }),
				createdAt: NOW
			});

			await reconcileGroceryList(
				db,
				sourceId,
				fetchedList([{ id: 'i1', name: 'Milk', quantity: null, checked: true }]),
				NOW
			);

			const [row] = await db.select().from(listItems).where(eq(listItems.id, 'i1'));
			expect(row.checked).toBe(false);
		});

		it("removes a row a pending remove targets, even if AnyList's fetch still had it", async () => {
			const sourceId = await seedSource();
			await db.insert(pendingWrites).values({
				sourceId,
				action: 'remove',
				payload: JSON.stringify({ id: 'i1' }),
				createdAt: NOW
			});

			await reconcileGroceryList(
				db,
				sourceId,
				fetchedList([{ id: 'i1', name: 'Milk', quantity: null, checked: false }]),
				NOW
			);

			const rows = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
			expect(rows).toHaveLength(0);
		});

		it('replays in enqueue order, so the last write for an item wins', async () => {
			const sourceId = await seedSource();
			await db.insert(pendingWrites).values([
				{
					sourceId,
					action: 'check',
					payload: JSON.stringify({ id: 'i1' }),
					createdAt: NOW
				},
				{
					sourceId,
					action: 'uncheck',
					payload: JSON.stringify({ id: 'i1' }),
					createdAt: NOW
				}
			]);

			await reconcileGroceryList(
				db,
				sourceId,
				fetchedList([{ id: 'i1', name: 'Milk', quantity: null, checked: false }]),
				NOW
			);

			const [row] = await db.select().from(listItems).where(eq(listItems.id, 'i1'));
			expect(row.checked).toBe(false);
		});
	});
});

describe('buildGroceriesSnapshot', () => {
	it('returns null when AnyList has never been connected', async () => {
		expect(await buildGroceriesSnapshot(db)).toBeNull();
	});

	it('counts only unchecked items, but returns every item', async () => {
		const sourceId = await seedSource();
		await reconcileGroceryList(
			db,
			sourceId,
			fetchedList([
				{ id: 'i1', name: 'Milk', quantity: null, checked: false },
				{ id: 'i2', name: 'Bread', quantity: null, checked: true },
				{ id: 'i3', name: 'Eggs', quantity: '12', checked: false }
			]),
			NOW
		);

		const snapshot = await buildGroceriesSnapshot(db);
		expect(snapshot?.items).toHaveLength(3);
		expect(snapshot?.count).toBe(2);
	});

	it("includes each item's category in the snapshot", async () => {
		const sourceId = await seedSource();
		await reconcileGroceryList(
			db,
			sourceId,
			fetchedList([
				{ id: 'i1', name: 'Milk', quantity: null, checked: false, category: 'Dairy' },
				{ id: 'i2', name: 'Bread', quantity: null, checked: false }
			]),
			NOW
		);

		const snapshot = await buildGroceriesSnapshot(db);

		expect(snapshot?.items.find((item) => item.id === 'i1')?.category).toBe('Dairy');
		expect(snapshot?.items.find((item) => item.id === 'i2')?.category).toBeNull();
	});

	it('marks an item pending only while it has an outstanding write — M4', async () => {
		const sourceId = await seedSource();
		await reconcileGroceryList(
			db,
			sourceId,
			fetchedList([
				{ id: 'i1', name: 'Milk', quantity: null, checked: false },
				{ id: 'i2', name: 'Bread', quantity: null, checked: false }
			]),
			NOW
		);
		await db.insert(pendingWrites).values({
			sourceId,
			action: 'check',
			payload: JSON.stringify({ id: 'i1' }),
			createdAt: NOW,
			nextAttemptAt: NOW
		});

		const snapshot = await buildGroceriesSnapshot(db);

		expect(snapshot?.items.find((item) => item.id === 'i1')?.pending).toBe(true);
		expect(snapshot?.items.find((item) => item.id === 'i2')?.pending).toBe(false);
	});

	it('is stale when the connection is in error, not stale when ok', async () => {
		const sourceId = await seedSource();
		await reconcileGroceryList(db, sourceId, fetchedList([]), NOW);
		expect((await buildGroceriesSnapshot(db))?.stale).toBe(false);

		const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
		await db
			.update(connections)
			.set({ status: 'error' })
			.where(eq(connections.id, source.connectionId));

		expect((await buildGroceriesSnapshot(db))?.stale).toBe(true);
	});
});
