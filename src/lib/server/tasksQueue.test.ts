import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema';
import { connections, sources, listItems, pendingWrites } from './db/schema';
import { enqueueCompleteTask, drainTaskWrites } from './tasksQueue';

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
		.values({ provider: 'todoist', label: 'personal token', secrets: Buffer.from('x') })
		.returning();
	const [source] = await db
		.insert(sources)
		.values({
			connectionId: connection.id,
			kind: 'tasks',
			externalId: 'todoist-tasks',
			displayName: 'Todoist tasks'
		})
		.returning();
	return source.id;
}

async function seedTask(sourceId: number, id = 't1') {
	await db.insert(listItems).values({
		id,
		sourceId,
		title: 'Send book club reminder',
		category: 'Personal',
		projectId: 'p1',
		dueDate: '2026-08-25',
		checked: false,
		updatedAt: NOW
	});
}

const NOW = new Date('2026-08-25T18:00:00Z');

describe('enqueueCompleteTask', () => {
	it('marks the task checked and enqueues a check write', async () => {
		const sourceId = await seedSource();
		await seedTask(sourceId);

		const found = enqueueCompleteTask(db, sourceId, 't1', NOW);

		expect(found).toBe(true);
		const [row] = await db.select().from(listItems).where(eq(listItems.id, 't1'));
		expect(row.checked).toBe(true);
		const [write] = await db
			.select()
			.from(pendingWrites)
			.where(eq(pendingWrites.sourceId, sourceId));
		expect(write.action).toBe('check');
		expect(JSON.parse(write.payload)).toEqual({ id: 't1' });
	});

	it('returns false and enqueues nothing for an id that does not belong to this source', async () => {
		const sourceId = await seedSource();

		const found = enqueueCompleteTask(db, sourceId, 'nonexistent', NOW);

		expect(found).toBe(false);
		const writes = await db
			.select()
			.from(pendingWrites)
			.where(eq(pendingWrites.sourceId, sourceId));
		expect(writes).toHaveLength(0);
	});
});

describe('drainTaskWrites', () => {
	it('completes a due write against the client and deletes the row on success', async () => {
		const sourceId = await seedSource();
		await seedTask(sourceId);
		enqueueCompleteTask(db, sourceId, 't1', NOW);
		const completed: string[] = [];
		const client = { completeTask: async (id: string) => void completed.push(id) };

		const result = await drainTaskWrites(db, client, sourceId, NOW);

		expect(result).toEqual({ drained: 1, failures: [] });
		expect(completed).toEqual(['t1']);
		const writes = await db
			.select()
			.from(pendingWrites)
			.where(eq(pendingWrites.sourceId, sourceId));
		expect(writes).toHaveLength(0);
	});

	it('leaves a failed write in place with bumped attempts and a later nextAttemptAt', async () => {
		const sourceId = await seedSource();
		await seedTask(sourceId);
		enqueueCompleteTask(db, sourceId, 't1', NOW);
		const client = {
			completeTask: async () => {
				throw new Error('Todoist: complete t1 failed with 500: server error');
			}
		};

		const result = await drainTaskWrites(db, client, sourceId, NOW);

		expect(result.drained).toBe(0);
		expect(result.failures).toEqual([{ taskId: 't1', error: expect.stringContaining('500') }]);
		const [write] = await db
			.select()
			.from(pendingWrites)
			.where(eq(pendingWrites.sourceId, sourceId));
		expect(write.attempts).toBe(1);
		expect(write.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime());
	});

	it('drains two pending check writes for the same task without error — already idempotent, no collapse needed', async () => {
		const sourceId = await seedSource();
		await seedTask(sourceId);
		enqueueCompleteTask(db, sourceId, 't1', NOW);
		// A second device/session enqueueing the same completion before either drains —
		// the row is already checked, so this still finds it and enqueues a second write.
		enqueueCompleteTask(db, sourceId, 't1', NOW);
		let calls = 0;
		const client = { completeTask: async () => void calls++ };

		const result = await drainTaskWrites(db, client, sourceId, NOW);

		expect(result).toEqual({ drained: 2, failures: [] });
		expect(calls).toBe(2);
		const writes = await db
			.select()
			.from(pendingWrites)
			.where(eq(pendingWrites.sourceId, sourceId));
		expect(writes).toHaveLength(0);
	});

	it('only drains writes whose nextAttemptAt has arrived', async () => {
		const sourceId = await seedSource();
		await seedTask(sourceId);
		enqueueCompleteTask(db, sourceId, 't1', NOW);
		await db
			.update(pendingWrites)
			.set({ nextAttemptAt: new Date(NOW.getTime() + 60_000) })
			.where(eq(pendingWrites.sourceId, sourceId));
		const client = {
			completeTask: async () => {
				throw new Error('should not be called — not due yet');
			}
		};

		const result = await drainTaskWrites(db, client, sourceId, NOW);

		expect(result).toEqual({ drained: 0, failures: [] });
	});
});
