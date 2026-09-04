import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { listItems, pendingWrites } from '../db/schema';
import { getConnection, upsertConnection } from '../connections';
import { resolveGroceryList } from './resolve';
import { runGroceriesCycle } from './scheduler';
import type { AnyListGroceryList } from './client';

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

async function seed() {
	// Goes through upsertConnection rather than a raw insert so the secrets blob is a real
	// encrypted payload — getConnection decrypts it, and a dummy buffer fails there. Same
	// reasoning as sync/scheduler.test.ts's own seed() helper.
	await upsertConnection(db, {
		provider: 'anylist',
		label: 'a@b.com',
		secrets: { email: 'a@b.com', password: 'pw' }
	});
	const connection = await getConnection(db, 'anylist');
	const sourceId = await resolveGroceryList(db, connection!.id, {
		findListByName: () => ({ id: 'anylist-list-1', name: 'My Grocery List', items: [] })
	});
	return { connectionId: connection!.id, sourceId };
}

/** No-op write methods — pending_writes is empty in every fixture that uses this, so
 *  drainPendingWrites never actually calls them, but runGroceriesCycle's deps type
 *  requires them regardless. */
const unusedWriteMethods = {
	addItem: async () => {
		throw new Error('addItem should not be called — pending_writes is empty in this test');
	},
	setChecked: async () => {
		throw new Error('setChecked should not be called — pending_writes is empty in this test');
	},
	removeItem: async () => {
		throw new Error('removeItem should not be called — pending_writes is empty in this test');
	}
};

function fakeClient(list: AnyListGroceryList, refreshCalls: { count: number } = { count: 0 }) {
	return {
		fetchItems: () => list,
		refresh: async () => {
			refreshCalls.count += 1;
		},
		...unusedWriteMethods
	};
}

const NOW = new Date('2026-08-25T18:00:00Z');

describe('runGroceriesCycle', () => {
	it('reconciles the fetched list and marks the connection ok', async () => {
		const { connectionId, sourceId } = await seed();
		const client = fakeClient({
			id: 'anylist-list-1',
			name: 'My Grocery List',
			items: [{ id: 'i1', name: 'Milk', quantity: null, checked: false, category: null }]
		});

		const result = await runGroceriesCycle(db, {
			client,
			connectionId,
			sourceId,
			externalId: 'anylist-list-1',
			now: NOW,
			forceRefresh: false
		});

		expect(result.error).toBeNull();
		expect(result.upserted).toBe(1);
		const rows = await db.select().from(listItems);
		expect(rows).toHaveLength(1);
		const connection = await getConnection(db, 'anylist');
		expect(connection?.status).toBe('ok');
	});

	it('calls refresh only when forceRefresh is true — the poll path, not the push path', async () => {
		const { connectionId, sourceId } = await seed();
		const refreshCalls = { count: 0 };
		const client = fakeClient(
			{ id: 'anylist-list-1', name: 'My Grocery List', items: [] },
			refreshCalls
		);

		await runGroceriesCycle(db, {
			client,
			connectionId,
			sourceId,
			externalId: 'anylist-list-1',
			now: NOW,
			forceRefresh: false
		});
		expect(refreshCalls.count).toBe(0);

		await runGroceriesCycle(db, {
			client,
			connectionId,
			sourceId,
			externalId: 'anylist-list-1',
			now: NOW,
			forceRefresh: true
		});
		expect(refreshCalls.count).toBe(1);
	});

	it('never throws — a failure is caught, marks the connection errored, and is reported in the result', async () => {
		const { connectionId, sourceId } = await seed();
		const client = {
			fetchItems: () => {
				throw new Error('AnyList: no list with id "anylist-list-1" on this account');
			},
			refresh: async () => {},
			...unusedWriteMethods
		};

		const result = await runGroceriesCycle(db, {
			client,
			connectionId,
			sourceId,
			externalId: 'anylist-list-1',
			now: NOW,
			forceRefresh: false
		});

		expect(result.error).toMatch(/no list with id/);
		const connection = await getConnection(db, 'anylist');
		expect(connection?.status).toBe('error');
		expect(connection?.lastError).toMatch(/no list with id/);
	});

	it('marks the connection errored when refresh itself fails', async () => {
		const { connectionId, sourceId } = await seed();
		const client = {
			fetchItems: () => {
				throw new Error('should not be reached');
			},
			refresh: async () => {
				throw new Error('network down');
			},
			...unusedWriteMethods
		};

		const result = await runGroceriesCycle(db, {
			client,
			connectionId,
			sourceId,
			externalId: 'anylist-list-1',
			now: NOW,
			forceRefresh: true
		});

		expect(result.error).toMatch(/network down/);
	});

	it('drains due pending writes after reconciling, in the same cycle', async () => {
		const { connectionId, sourceId } = await seed();
		await db.insert(pendingWrites).values({
			sourceId,
			action: 'add',
			payload: JSON.stringify({ id: 'new-1', name: 'Eggs' }),
			createdAt: NOW,
			nextAttemptAt: NOW
		});
		let addItemCalled = false;
		const client = {
			...fakeClient({ id: 'anylist-list-1', name: 'My Grocery List', items: [] }),
			addItem: async () => {
				addItemCalled = true;
				return { id: 'new-1', name: 'Eggs', quantity: null, checked: false, category: null };
			}
		};

		const result = await runGroceriesCycle(db, {
			client,
			connectionId,
			sourceId,
			externalId: 'anylist-list-1',
			now: NOW,
			forceRefresh: false
		});

		expect(addItemCalled).toBe(true);
		expect(result.drained).toBe(1);
		const pending = await db.select().from(pendingWrites);
		expect(pending).toHaveLength(0);
	});

	it('marks the connection errored when a drain fails, even though reconcile itself succeeded', async () => {
		const { connectionId, sourceId } = await seed();
		await db.insert(pendingWrites).values({
			sourceId,
			action: 'add',
			payload: JSON.stringify({ id: 'new-1', name: 'Eggs' }),
			createdAt: NOW,
			nextAttemptAt: NOW
		});
		const client = {
			...fakeClient({ id: 'anylist-list-1', name: 'My Grocery List', items: [] }),
			addItem: async () => {
				throw new Error('AnyList rejected the write');
			}
		};

		const result = await runGroceriesCycle(db, {
			client,
			connectionId,
			sourceId,
			externalId: 'anylist-list-1',
			now: NOW,
			forceRefresh: false
		});

		expect(result.error).toMatch(/AnyList rejected the write/);
		const connection = await getConnection(db, 'anylist');
		expect(connection?.status).toBe('error');
		// Still there for the next cycle to retry — §6.1: nothing is ever lost.
		const [pending] = await db
			.select()
			.from(pendingWrites)
			.where(eq(pendingWrites.sourceId, sourceId));
		expect(pending.attempts).toBe(1);
	});
});
