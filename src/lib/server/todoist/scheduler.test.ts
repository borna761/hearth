import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { listItems, pendingWrites } from '../db/schema';
import { getConnection, upsertConnection } from '../connections';
import { resolveTasksSource } from './resolve';
import { runTasksCycle } from './scheduler';
import type { TodoistTask } from './client';

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
	await upsertConnection(db, {
		provider: 'todoist',
		label: 'personal token',
		secrets: { token: 't' }
	});
	const connection = await getConnection(db, 'todoist');
	const sourceId = await resolveTasksSource(db, connection!.id);
	return { connectionId: connection!.id, sourceId };
}

/** No-op write method — pending_writes is empty in every fixture that doesn't seed one,
 *  so drainTaskWrites never actually calls it, but runTasksCycle's deps type requires it
 *  regardless. */
const unusedWriteMethod = {
	completeTask: async () => {
		throw new Error('completeTask should not be called — pending_writes is empty in this test');
	}
};

function fakeClient(tasks: TodoistTask[]) {
	return {
		fetchOverdueAndDueToday: async () => tasks,
		...unusedWriteMethod
	};
}

const NOW = new Date('2026-08-25T18:00:00Z');

describe('runTasksCycle', () => {
	it('reconciles the fetched tasks and marks the connection ok', async () => {
		const { connectionId, sourceId } = await seed();
		const client = fakeClient([
			{
				id: 't1',
				title: 'Send book club reminder',
				projectId: 'p1',
				projectName: 'Personal',
				dueDate: '2026-08-25'
			}
		]);

		const result = await runTasksCycle(db, { client, connectionId, sourceId, now: NOW });

		expect(result.error).toBeNull();
		expect(result.upserted).toBe(1);
		const rows = await db.select().from(listItems);
		expect(rows).toHaveLength(1);
		const connection = await getConnection(db, 'todoist');
		expect(connection?.status).toBe('ok');
	});

	it('never throws — a failure is caught, marks the connection errored, and is reported in the result', async () => {
		const { connectionId, sourceId } = await seed();
		const client = {
			fetchOverdueAndDueToday: async () => {
				throw new Error('Todoist: /tasks/filter failed with 401: unauthorized');
			},
			...unusedWriteMethod
		};

		const result = await runTasksCycle(db, { client, connectionId, sourceId, now: NOW });

		expect(result.error).toMatch(/401/);
		const connection = await getConnection(db, 'todoist');
		expect(connection?.status).toBe('error');
	});

	it('drains due pending writes after reconciling, in the same cycle', async () => {
		const { connectionId, sourceId } = await seed();
		await db.insert(listItems).values({
			id: 't1',
			sourceId,
			title: 'Send book club reminder',
			category: 'Personal',
			projectId: 'p1',
			dueDate: '2026-08-25',
			checked: true,
			updatedAt: NOW
		});
		await db.insert(pendingWrites).values({
			sourceId,
			action: 'check',
			payload: JSON.stringify({ id: 't1' }),
			createdAt: NOW,
			nextAttemptAt: NOW
		});
		let completeTaskCalled = false;
		const client = {
			...fakeClient([]),
			completeTask: async () => {
				completeTaskCalled = true;
			}
		};

		const result = await runTasksCycle(db, { client, connectionId, sourceId, now: NOW });

		expect(completeTaskCalled).toBe(true);
		expect(result.drained).toBe(1);
		const pending = await db.select().from(pendingWrites);
		expect(pending).toHaveLength(0);
	});

	it('marks the connection errored when a drain fails, even though reconcile itself succeeded', async () => {
		const { connectionId, sourceId } = await seed();
		await db.insert(listItems).values({
			id: 't1',
			sourceId,
			title: 'Send book club reminder',
			category: 'Personal',
			projectId: 'p1',
			dueDate: '2026-08-25',
			checked: true,
			updatedAt: NOW
		});
		await db.insert(pendingWrites).values({
			sourceId,
			action: 'check',
			payload: JSON.stringify({ id: 't1' }),
			createdAt: NOW,
			nextAttemptAt: NOW
		});
		const client = {
			...fakeClient([]),
			completeTask: async () => {
				throw new Error('Todoist rejected the write');
			}
		};

		const result = await runTasksCycle(db, { client, connectionId, sourceId, now: NOW });

		expect(result.error).toMatch(/Todoist rejected the write/);
		const connection = await getConnection(db, 'todoist');
		expect(connection?.status).toBe('error');
		const [pending] = await db
			.select()
			.from(pendingWrites)
			.where(eq(pendingWrites.sourceId, sourceId));
		expect(pending.attempts).toBe(1);
	});
});
