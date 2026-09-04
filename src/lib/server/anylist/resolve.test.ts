import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../db/schema';
import { connections, sources } from '../db/schema';
import { resolveGroceryList, GROCERY_LIST_NAME } from './resolve';

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

async function seedConnection() {
	const [connection] = await db
		.insert(connections)
		.values({ provider: 'anylist', label: 'test@example.com', secrets: Buffer.from('x') })
		.returning();
	return connection.id;
}

describe('resolveGroceryList', () => {
	it('creates a groceries source from the account list on first run', async () => {
		const connectionId = await seedConnection();
		const client = {
			findListByName: (name: string) =>
				name === GROCERY_LIST_NAME
					? { id: 'anylist-list-1', name: GROCERY_LIST_NAME, items: [] }
					: null
		};

		const sourceId = await resolveGroceryList(db, connectionId, client);

		const rows = await db.select().from(sources);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: sourceId,
			connectionId,
			kind: 'groceries',
			externalId: 'anylist-list-1',
			displayName: GROCERY_LIST_NAME
		});
	});

	it('is idempotent — a second call reuses the existing source and never calls AnyList', async () => {
		const connectionId = await seedConnection();
		let calls = 0;
		const client = {
			findListByName: (name: string) => {
				calls += 1;
				return name === GROCERY_LIST_NAME
					? { id: 'anylist-list-1', name: GROCERY_LIST_NAME, items: [] }
					: null;
			}
		};

		const first = await resolveGroceryList(db, connectionId, client);
		const second = await resolveGroceryList(db, connectionId, client);

		expect(second).toBe(first);
		expect(calls).toBe(1);
	});

	it('throws a clear error when the account has no list with the expected name', async () => {
		const connectionId = await seedConnection();
		const client = { findListByName: () => null };

		await expect(resolveGroceryList(db, connectionId, client)).rejects.toThrow(
			/no list named "My Grocery List"/
		);
	});
});
