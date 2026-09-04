import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './db/schema';
import { connections, pendingWrites, sources } from './db/schema';
import { getHealthStatus } from './health';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;

beforeEach(() => {
	sqlite = new Database(':memory:');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
});

afterEach(() => {
	sqlite.close();
});

describe('getHealthStatus', () => {
	it('reports ok with a working database', () => {
		const status = getHealthStatus(db);
		expect(status.status).toBe('ok');
		expect(status.checks.database).toBe('ok');
		expect(typeof status.uptimeSeconds).toBe('number');
		expect(status.timestamp).toBeInstanceOf(Date);
	});

	it('reports the number of attached stream clients', () => {
		expect(getHealthStatus(db, { streamClients: 2 }).streamClients).toBe(2);
	});

	it('defaults the stream client count to zero', () => {
		expect(getHealthStatus(db).streamClients).toBe(0);
	});

	it('reports degraded when the database check throws', () => {
		sqlite.close(); // subsequent queries against this handle now throw
		const status = getHealthStatus(db);
		expect(status.status).toBe('error');
		expect(status.checks.database).toBe('error');
	});

	it('reports a zero queue depth and null reconcile time when nothing is connected', () => {
		const status = getHealthStatus(db);
		expect(status.groceries.queueDepth).toBe(0);
		expect(status.groceries.lastReconcileAt).toBeNull();
	});

	it('counts pending_writes rows as the queue depth, regardless of source', async () => {
		const [connection] = await db
			.insert(connections)
			.values({ provider: 'anylist', label: 'a@b.com', secrets: Buffer.from('x') })
			.returning();
		const [source] = await db
			.insert(sources)
			.values({
				connectionId: connection.id,
				kind: 'groceries',
				externalId: 'list-1',
				displayName: 'My Grocery List'
			})
			.returning();
		await db.insert(pendingWrites).values([
			{ sourceId: source.id, action: 'add', payload: '{}', createdAt: new Date() },
			{ sourceId: source.id, action: 'check', payload: '{}', createdAt: new Date() }
		]);

		expect(getHealthStatus(db).groceries.queueDepth).toBe(2);
	});

	it("reports the anylist connection's last_success as the reconcile time", async () => {
		const now = new Date('2026-08-25T18:00:00Z');
		await db.insert(connections).values({
			provider: 'anylist',
			label: 'a@b.com',
			secrets: Buffer.from('x'),
			lastSuccess: now
		});

		expect(getHealthStatus(db).groceries.lastReconcileAt).toEqual(now);
	});
});
