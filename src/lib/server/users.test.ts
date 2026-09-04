import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './db/schema';
import { users } from './db/schema';
import { listPublicUsers, setUserColor, setUserWeekView } from './users';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;

beforeEach(() => {
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
});

afterEach(() => sqlite.close());

describe('listPublicUsers', () => {
	it('returns users ordered by sort_order', async () => {
		await db.insert(users).values([
			{ name: 'Dana', color: '#3b82f6', pinHash: 'hash', sortOrder: 2 },
			{ name: 'Alex', color: '#22c55e', pinHash: 'hash', sortOrder: 1 },
			{ name: 'Sam', color: '#f59e0b', pinHash: 'hash', sortOrder: 0, viewMode: 'simple' }
		]);

		const list = await listPublicUsers(db);
		expect(list.map((u) => u.name)).toEqual(['Sam', 'Alex', 'Dana']);
	});

	it('never exposes the PIN hash', async () => {
		await db.insert(users).values({ name: 'Alex', color: '#22c55e', pinHash: 'super-secret' });
		const [user] = await listPublicUsers(db);
		expect(user).not.toHaveProperty('pinHash');
		expect(JSON.stringify(user)).not.toContain('super-secret');
	});

	it('includes id, color, view mode, week view, and admin status', async () => {
		await db.insert(users).values({
			name: 'Sam',
			color: '#f59e0b',
			pinHash: 'hash',
			viewMode: 'simple',
			weekView: 'grid',
			isAdmin: false
		});
		const [user] = await listPublicUsers(db);
		expect(user).toMatchObject({
			name: 'Sam',
			color: '#f59e0b',
			viewMode: 'simple',
			weekView: 'grid',
			isAdmin: false
		});
		expect(typeof user.id).toBe('number');
	});

	it('defaults week view to agenda', async () => {
		await db.insert(users).values({ name: 'Alex', color: '#22c55e', pinHash: 'hash' });
		const [user] = await listPublicUsers(db);
		expect(user.weekView).toBe('agenda');
	});

	it('returns an empty list when no users exist', async () => {
		expect(await listPublicUsers(db)).toEqual([]);
	});
});

describe('setUserColor', () => {
	it('updates the stored color', async () => {
		const [user] = await db
			.insert(users)
			.values({ name: 'Alex', color: '#22c55e', pinHash: 'hash' })
			.returning();

		await setUserColor(db, user.id, '#ff0000');

		const [updated] = await listPublicUsers(db);
		expect(updated.color).toBe('#ff0000');
	});

	it('only touches the targeted user', async () => {
		const [a, b] = await db
			.insert(users)
			.values([
				{ name: 'Alex', color: '#22c55e', pinHash: 'hash' },
				{ name: 'Dana', color: '#3b82f6', pinHash: 'hash' }
			])
			.returning();

		await setUserColor(db, a.id, '#ff0000');

		const list = await listPublicUsers(db);
		expect(list.find((u) => u.id === a.id)?.color).toBe('#ff0000');
		expect(list.find((u) => u.id === b.id)?.color).toBe('#3b82f6');
	});
});

describe('setUserWeekView', () => {
	it('updates the stored week view', async () => {
		const [user] = await db
			.insert(users)
			.values({ name: 'Alex', color: '#22c55e', pinHash: 'hash' })
			.returning();

		await setUserWeekView(db, user.id, 'grid');

		const [updated] = await listPublicUsers(db);
		expect(updated.weekView).toBe('grid');
	});
});
