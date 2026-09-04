import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './db/schema';
import { connections, sources, users, visibility } from './db/schema';
import { getVisibleSourceIds, getVisibilityRows, setVisibilityForRow } from './visibility';

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

async function seedUser(name: string) {
	const [user] = await db
		.insert(users)
		.values({ name, color: '#3b82f6', pinHash: 'hash' })
		.returning();
	return user;
}

async function seedSource(
	externalId: string,
	options: {
		enabled?: boolean;
		groupLabel?: string | null;
		kind?: 'calendar' | 'tasks' | 'groceries';
	} = {}
) {
	const [connection] = await db
		.insert(connections)
		.values({ provider: 'google', label: 'a@b.com', secrets: Buffer.from('x') })
		.returning();
	const [source] = await db
		.insert(sources)
		.values({
			connectionId: connection.id,
			kind: options.kind ?? 'calendar',
			externalId,
			displayName: externalId,
			enabled: options.enabled ?? true,
			groupLabel: options.groupLabel ?? null
		})
		.returning();
	return source;
}

describe('getVisibleSourceIds', () => {
	it('treats a source with no visibility row as visible — the seed matrix is "a seed, not a fixture" (DESIGN.md §4)', async () => {
		const user = await seedUser('Alex');
		const source = await seedSource('family@group.calendar.google.com');

		expect(await getVisibleSourceIds(db, user.id)).toEqual([source.id]);
	});

	it('excludes a source explicitly hidden for this user', async () => {
		const user = await seedUser('Dana');
		const source = await seedSource('football@group.calendar.google.com');
		await db.insert(visibility).values({ userId: user.id, sourceId: source.id, visible: false });

		expect(await getVisibleSourceIds(db, user.id)).toEqual([]);
	});

	it('includes a source explicitly marked visible (not just relying on the default)', async () => {
		const user = await seedUser('Alex');
		const source = await seedSource('family@group.calendar.google.com');
		await db.insert(visibility).values({ userId: user.id, sourceId: source.id, visible: true });

		expect(await getVisibleSourceIds(db, user.id)).toEqual([source.id]);
	});

	it('never includes a source disabled at the policy level, regardless of per-user visibility', async () => {
		const user = await seedUser('Alex');
		const source = await seedSource('todoist@group.calendar.google.com', { enabled: false });
		await db.insert(visibility).values({ userId: user.id, sourceId: source.id, visible: true });

		expect(await getVisibleSourceIds(db, user.id)).toEqual([]);
	});

	it('keeps each user independent — hiding a source for one user does not affect another', async () => {
		const alex = await seedUser('Alex');
		const dana = await seedUser('Dana');
		const source = await seedSource('football@group.calendar.google.com');
		await db.insert(visibility).values({ userId: dana.id, sourceId: source.id, visible: false });

		expect(await getVisibleSourceIds(db, dana.id)).toEqual([]);
		expect(await getVisibleSourceIds(db, alex.id)).toEqual([source.id]);
	});

	it('handles a mix of enabled/disabled and visible/hidden across several sources', async () => {
		const user = await seedUser('Alex');
		const family = await seedSource('family@group.calendar.google.com');
		const football = await seedSource('football@group.calendar.google.com');
		const disabled = await seedSource('todoist@group.calendar.google.com', { enabled: false });
		await db.insert(visibility).values({ userId: user.id, sourceId: football.id, visible: false });

		expect((await getVisibleSourceIds(db, user.id)).sort()).toEqual([family.id].sort());
		expect(await getVisibleSourceIds(db, user.id)).not.toContain(disabled.id);
	});

	it('returns an empty list for a user with no enabled sources at all', async () => {
		const user = await seedUser('Alex');
		expect(await getVisibleSourceIds(db, user.id)).toEqual([]);
	});
});

describe('getVisibilityRows', () => {
	it('lists one row per ungrouped source', async () => {
		const family = await seedSource('family@group.calendar.google.com');
		const rows = await getVisibilityRows(db);
		expect(rows).toEqual([
			{
				key: `source:${family.id}`,
				label: 'family@group.calendar.google.com',
				sourceIds: [family.id]
			}
		]);
	});

	it('collapses sources sharing a group label into one row — DESIGN.md §4/§7.5’s football feeds', async () => {
		const arsenal = await seedSource('arsenal', { groupLabel: 'Football' });
		const barcelona = await seedSource('barcelona', { groupLabel: 'Football' });
		const rows = await getVisibilityRows(db);

		expect(rows).toHaveLength(1);
		expect(rows[0].label).toBe('Football');
		expect(rows[0].sourceIds.sort()).toEqual([arsenal.id, barcelona.id].sort());
	});

	it('excludes sources disabled at the policy level', async () => {
		await seedSource('todoist', { enabled: false });
		expect(await getVisibilityRows(db)).toEqual([]);
	});

	it('excludes non-calendar sources — the matrix is about calendars, not groceries/tasks', async () => {
		await seedSource('grocery-list', { kind: 'groceries' });
		expect(await getVisibilityRows(db)).toEqual([]);
	});
});

describe('setVisibilityForRow', () => {
	it('sets visibility for every source id in the row at once', async () => {
		const user = await seedUser('Dana');
		const arsenal = await seedSource('arsenal', { groupLabel: 'Football' });
		const barcelona = await seedSource('barcelona', { groupLabel: 'Football' });

		await setVisibilityForRow(db, user.id, [arsenal.id, barcelona.id], false);

		expect(await getVisibleSourceIds(db, user.id)).toEqual([]);
	});

	it('updates an existing row rather than duplicating it', async () => {
		const user = await seedUser('Alex');
		const family = await seedSource('family');

		await setVisibilityForRow(db, user.id, [family.id], false);
		await setVisibilityForRow(db, user.id, [family.id], true);

		expect(await getVisibleSourceIds(db, user.id)).toEqual([family.id]);
		const rows = await db.select().from(visibility);
		expect(rows).toHaveLength(1);
	});
});
