import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import {
	connections,
	sources,
	users,
	visibility,
	events,
	listItems,
	pendingWrites,
	photos,
	sessions
} from './schema';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;

beforeEach(() => {
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
});

afterEach(() => {
	sqlite.close();
});

async function seedConnection() {
	const [connection] = await db
		.insert(connections)
		.values({
			provider: 'google',
			label: 'alex@example.com',
			secrets: Buffer.from('ciphertext')
		})
		.returning();
	return connection;
}

async function seedSource(connectionId: number) {
	const [source] = await db
		.insert(sources)
		.values({
			connectionId,
			kind: 'calendar',
			externalId: 'family@group.calendar.google.com',
			displayName: 'Family'
		})
		.returning();
	return source;
}

describe('schema', () => {
	it('applies the generated migration and creates every table', () => {
		const tables = sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'"
			)
			.all()
			.map((row) => (row as { name: string }).name)
			.sort();
		expect(tables).toEqual(
			[
				'connections',
				'events',
				'list_items',
				'music_folders',
				'music_speakers',
				'music_tracks',
				'pending_writes',
				'photos',
				'sessions',
				'settings',
				'sources',
				'users',
				'visibility'
			].sort()
		);
	});

	it('round-trips a connection with an encrypted secrets blob', async () => {
		const connection = await seedConnection();
		expect(connection.status).toBe('ok'); // default applied
		expect(connection.secrets).toEqual(Buffer.from('ciphertext'));
	});

	it('enforces the (connection_id, external_id) uniqueness on sources', async () => {
		const connection = await seedConnection();
		await seedSource(connection.id);
		await expect(seedSource(connection.id)).rejects.toThrow();
	});

	it('cascades deletes from connections through sources to visibility', async () => {
		const connection = await seedConnection();
		const source = await seedSource(connection.id);
		const [user] = await db
			.insert(users)
			.values({ name: 'Sam', color: '#f59e0b', pinHash: 'hash', viewMode: 'simple' })
			.returning();
		await db.insert(visibility).values({ userId: user.id, sourceId: source.id });

		await db.delete(connections).where(eq(connections.id, connection.id));

		expect(await db.select().from(sources)).toHaveLength(0);
		expect(await db.select().from(visibility)).toHaveLength(0);
	});

	it('cascades a user delete through to their sessions', async () => {
		const [user] = await db
			.insert(users)
			.values({ name: 'Sam', color: '#f59e0b', pinHash: 'hash' })
			.returning();
		const now = new Date();
		await db.insert(sessions).values({
			id: 'sess-1',
			userId: user.id,
			createdAt: now,
			lastSeenAt: now,
			expiresAt: now
		});

		await db.delete(users).where(eq(users.id, user.id));

		expect(await db.select().from(sessions)).toHaveLength(0);
	});

	it('stores all-day events as a local date string with no epoch, and timed events with epochs', async () => {
		const connection = await seedConnection();
		const source = await seedSource(connection.id);

		await db.insert(events).values([
			{
				id: 'allday-1',
				sourceId: source.id,
				title: "Bahá'í Feast",
				allDay: true,
				localDate: '2026-08-21',
				updatedAt: new Date()
			},
			{
				id: 'timed-1',
				sourceId: source.id,
				title: 'Dentist',
				allDay: false,
				startsAt: new Date('2026-08-21T14:00:00Z'),
				endsAt: new Date('2026-08-21T14:30:00Z'),
				updatedAt: new Date()
			}
		]);

		const [allDay] = await db.select().from(events).where(eq(events.id, 'allday-1'));
		expect(allDay.localDate).toBe('2026-08-21');
		expect(allDay.startsAt).toBeNull();

		const [timed] = await db.select().from(events).where(eq(events.id, 'timed-1'));
		expect(timed.startsAt).toEqual(new Date('2026-08-21T14:00:00Z'));
		expect(timed.localDate).toBeNull();
	});

	it('queues grocery writes instead of applying them directly', async () => {
		const connection = await seedConnection();
		const source = await seedSource(connection.id);

		await db.insert(pendingWrites).values({
			sourceId: source.id,
			action: 'add',
			payload: JSON.stringify({ title: 'Milk' }),
			createdAt: new Date()
		});

		const pending = await db.select().from(pendingWrites);
		expect(pending).toHaveLength(1);
		expect(pending[0].attempts).toBe(0);
	});

	it('separates portraits from landscapes so slides can be composed', async () => {
		// A slide is one landscape or two portraits side by side — DESIGN.md §7.1, so the
		// rotation queue is read one orientation at a time.
		await db.insert(photos).values([
			{
				sourcePath: '/mnt/nas/hearth/pictures/beach.jpg',
				mtime: new Date(),
				size: 3_100_000,
				cachedPath: '/mnt/nas/hearth/cache/beach.jpg',
				width: 1280,
				height: 800,
				orientation: 'landscape'
			},
			{
				sourcePath: '/mnt/nas/hearth/pictures/sam.jpg',
				mtime: new Date(),
				size: 2_400_000,
				cachedPath: '/mnt/nas/hearth/cache/sam.jpg',
				width: 450,
				height: 800,
				orientation: 'portrait',
				lastShown: new Date('2026-08-01T00:00:00Z')
			},
			{
				sourcePath: '/mnt/nas/hearth/pictures/dana.jpg',
				mtime: new Date(),
				size: 2_500_000,
				cachedPath: '/mnt/nas/hearth/cache/dana.jpg',
				width: 600,
				height: 800,
				orientation: 'portrait'
			}
		]);

		const portraits = await db.select().from(photos).where(eq(photos.orientation, 'portrait'));
		expect(portraits).toHaveLength(2);
		expect(portraits.every((photo) => photo.height > photo.width)).toBe(true);
		expect(portraits[0].shownCount).toBe(0);
	});

	it('refuses a photo row with no orientation, so nothing lands unpairable', async () => {
		await expect(
			db.insert(photos).values({
				sourcePath: '/mnt/nas/hearth/pictures/unmeasured.jpg',
				mtime: new Date(),
				size: 1_000_000,
				cachedPath: '/mnt/nas/hearth/cache/unmeasured.jpg'
			} as unknown as typeof photos.$inferInsert)
		).rejects.toThrow();
	});

	it('defaults a photo row to kind "family" — every row scanned before this column existed', async () => {
		const [row] = await db
			.insert(photos)
			.values({
				sourcePath: '/mnt/nas/hearth/pictures/unlabeled.jpg',
				mtime: new Date(),
				size: 1_000_000,
				cachedPath: '/mnt/nas/hearth/cache/unlabeled.jpg',
				width: 1280,
				height: 800,
				orientation: 'landscape'
			})
			.returning();
		expect(row.kind).toBe('family');
	});

	it('lets an item be added and checked off through list_items', async () => {
		const connection = await seedConnection();
		const source = await seedSource(connection.id);

		await db
			.insert(listItems)
			.values({ id: 'item-1', sourceId: source.id, title: 'Milk', updatedAt: new Date() });
		const [before] = await db.select().from(listItems).where(eq(listItems.id, 'item-1'));
		expect(before.checked).toBe(false);

		await db.update(listItems).set({ checked: true }).where(eq(listItems.id, 'item-1'));
		const [after] = await db.select().from(listItems).where(eq(listItems.id, 'item-1'));
		expect(after.checked).toBe(true);
	});
});
