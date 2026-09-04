import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema';
import { connections, sources, listItems, pendingWrites, users } from './db/schema';
import { reconcileTaskList, buildTasksSnapshot } from './tasks';
import { setRestrictedTaskProjectId } from './settings';
import type { TodoistTask } from './todoist/client';
import type { TaskAccess } from './users';

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

async function seedUser(taskAccess?: TaskAccess) {
	const [user] = await db
		.insert(users)
		.values({
			name: 'Test User',
			color: '#000000',
			pinHash: 'hash',
			...(taskAccess ? { taskAccess } : {})
		})
		.returning();
	return user.id;
}

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

function task(overrides: Partial<TodoistTask> = {}): TodoistTask {
	return {
		id: 't1',
		title: 'Send book club reminder',
		projectId: 'p1',
		projectName: 'Personal',
		dueDate: '2026-08-25',
		...overrides
	};
}

const NOW = new Date('2026-08-25T18:00:00Z');

describe('reconcileTaskList', () => {
	it('upserts every fetched task, storing project name, project id, and due date', async () => {
		const sourceId = await seedSource();
		const result = await reconcileTaskList(db, sourceId, [task()], NOW);

		expect(result.upserted).toBe(1);
		const [row] = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
		expect(row).toMatchObject({
			id: 't1',
			title: 'Send book club reminder',
			category: 'Personal',
			projectId: 'p1',
			dueDate: '2026-08-25',
			checked: false
		});
	});

	it('updates an existing row in place rather than duplicating it', async () => {
		const sourceId = await seedSource();
		await reconcileTaskList(db, sourceId, [task({ dueDate: '2026-08-20' })], NOW);
		await reconcileTaskList(db, sourceId, [task({ dueDate: '2026-08-25' })], NOW);

		const rows = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
		expect(rows).toHaveLength(1);
		expect(rows[0].dueDate).toBe('2026-08-25');
	});

	it('prunes a task Todoist no longer reports as overdue/due-today, unless a write is pending', async () => {
		const sourceId = await seedSource();
		await reconcileTaskList(db, sourceId, [task()], NOW);

		const result = await reconcileTaskList(db, sourceId, [], NOW);

		expect(result.pruned).toBe(1);
		const rows = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
		expect(rows).toHaveLength(0);
	});

	it('does not prune a task with an outstanding pending write', async () => {
		const sourceId = await seedSource();
		await reconcileTaskList(db, sourceId, [task()], NOW);
		await db.insert(pendingWrites).values({
			sourceId,
			action: 'check',
			payload: JSON.stringify({ id: 't1' }),
			createdAt: NOW
		});

		const result = await reconcileTaskList(db, sourceId, [], NOW);

		expect(result.pruned).toBe(0);
		const rows = await db.select().from(listItems).where(eq(listItems.sourceId, sourceId));
		expect(rows).toHaveLength(1);
	});

	it('forces checked=true on top of what Todoist just reported, so an in-flight completion is never reverted', async () => {
		const sourceId = await seedSource();
		await db.insert(pendingWrites).values({
			sourceId,
			action: 'check',
			payload: JSON.stringify({ id: 't1' }),
			createdAt: NOW
		});

		// Reconcile started before the completion landed on Todoist's side, so the fetch
		// still reports the task as active/overdue.
		const result = await reconcileTaskList(db, sourceId, [task()], NOW);

		expect(result.replayed).toBe(1);
		const [row] = await db.select().from(listItems).where(eq(listItems.id, 't1'));
		expect(row.checked).toBe(true);
	});
});

describe('buildTasksSnapshot', () => {
	it('returns null when Todoist has never been connected', async () => {
		const userId = await seedUser();
		expect(await buildTasksSnapshot(db, userId, NOW)).toBeNull();
	});

	it('splits into overdue and due-today against the household timezone', async () => {
		const userId = await seedUser();
		const sourceId = await seedSource();
		await reconcileTaskList(
			db,
			sourceId,
			[
				task({ id: 't1', dueDate: '2026-08-20' }), // overdue
				task({ id: 't2', dueDate: '2026-08-25' }) // due today, per NOW below
			],
			NOW
		);

		const snapshot = await buildTasksSnapshot(db, userId, NOW);

		expect(snapshot?.overdue.map((t) => t.id)).toEqual(['t1']);
		expect(snapshot?.dueToday.map((t) => t.id)).toEqual(['t2']);
		expect(snapshot?.count).toBe(2);
	});

	it('sorts by project, then due date, then title', async () => {
		const userId = await seedUser();
		const sourceId = await seedSource();
		await reconcileTaskList(
			db,
			sourceId,
			[
				task({ id: 't1', projectName: 'Zebra', title: 'Z task', dueDate: '2026-08-20' }),
				task({ id: 't2', projectName: 'Apple', title: 'B task', dueDate: '2026-08-19' }),
				task({ id: 't3', projectName: 'Apple', title: 'A task', dueDate: '2026-08-19' }),
				task({ id: 't4', projectName: 'Apple', title: 'A task', dueDate: '2026-08-18' })
			],
			NOW
		);

		const snapshot = await buildTasksSnapshot(db, userId, NOW);

		// Apple/08-18/A, Apple/08-19/A, Apple/08-19/B, Zebra/08-20/Z
		expect(snapshot?.overdue.map((t) => t.id)).toEqual(['t4', 't3', 't2', 't1']);
	});

	it("'all-but-one' shows everything except the configured restricted project", async () => {
		const userId = await seedUser('all-but-one');
		const sourceId = await seedSource();
		await setRestrictedTaskProjectId(db, 'restricted');
		await reconcileTaskList(
			db,
			sourceId,
			[
				task({ id: 't1', projectId: 'p1', dueDate: '2026-08-25' }),
				task({ id: 't2', projectId: 'restricted', dueDate: '2026-08-25' })
			],
			NOW
		);

		const snapshot = await buildTasksSnapshot(db, userId, NOW);
		const ids = [...(snapshot?.overdue ?? []), ...(snapshot?.dueToday ?? [])].map((t) => t.id);

		expect(ids).toEqual(['t1']);
	});

	it("'only-one' shows only the configured restricted project", async () => {
		const userId = await seedUser('only-one');
		const sourceId = await seedSource();
		await setRestrictedTaskProjectId(db, 'restricted');
		await reconcileTaskList(
			db,
			sourceId,
			[
				task({ id: 't1', projectId: 'p1', dueDate: '2026-08-25' }),
				task({ id: 't2', projectId: 'restricted', dueDate: '2026-08-25' })
			],
			NOW
		);

		const snapshot = await buildTasksSnapshot(db, userId, NOW);
		const ids = [...(snapshot?.overdue ?? []), ...(snapshot?.dueToday ?? [])].map((t) => t.id);

		expect(ids).toEqual(['t2']);
	});

	it("'none' returns null, even with a real connection and matching tasks — hides the badge entirely, not just a zero count", async () => {
		const userId = await seedUser('none');
		const sourceId = await seedSource();
		await reconcileTaskList(db, sourceId, [task({ id: 't1', dueDate: '2026-08-25' })], NOW);

		expect(await buildTasksSnapshot(db, userId, NOW)).toBeNull();
	});

	it("'all-but-one' shows everything before a restricted project is configured", async () => {
		const userId = await seedUser('all-but-one');
		const sourceId = await seedSource();
		await reconcileTaskList(db, sourceId, [task({ id: 't1', dueDate: '2026-08-25' })], NOW);

		const snapshot = await buildTasksSnapshot(db, userId, NOW);

		expect(snapshot?.count).toBe(1);
	});

	it("'only-one' shows nothing before a restricted project is configured", async () => {
		const userId = await seedUser('only-one');
		const sourceId = await seedSource();
		await reconcileTaskList(db, sourceId, [task({ id: 't1', dueDate: '2026-08-25' })], NOW);

		const snapshot = await buildTasksSnapshot(db, userId, NOW);

		expect(snapshot?.count).toBe(0);
	});

	it('marks a task pending only while it has an outstanding write', async () => {
		const userId = await seedUser();
		const sourceId = await seedSource();
		await reconcileTaskList(
			db,
			sourceId,
			[task({ id: 't1', dueDate: '2026-08-25' }), task({ id: 't2', dueDate: '2026-08-25' })],
			NOW
		);
		await db.insert(pendingWrites).values({
			sourceId,
			action: 'check',
			payload: JSON.stringify({ id: 't1' }),
			createdAt: NOW
		});

		const snapshot = await buildTasksSnapshot(db, userId, NOW);
		const all = [...(snapshot?.overdue ?? []), ...(snapshot?.dueToday ?? [])];

		expect(all.find((t) => t.id === 't1')?.pending).toBe(true);
		expect(all.find((t) => t.id === 't2')?.pending).toBe(false);
	});

	it('excludes a checked task, even though it still has a due date that would otherwise show it', async () => {
		const userId = await seedUser();
		const sourceId = await seedSource();
		await reconcileTaskList(
			db,
			sourceId,
			[task({ id: 't1', dueDate: '2026-08-25' }), task({ id: 't2', dueDate: '2026-08-25' })],
			NOW
		);
		await db.update(listItems).set({ checked: true }).where(eq(listItems.id, 't1'));

		const snapshot = await buildTasksSnapshot(db, userId, NOW);
		const ids = [...(snapshot?.overdue ?? []), ...(snapshot?.dueToday ?? [])].map((t) => t.id);

		expect(ids).toEqual(['t2']);
	});

	it('is stale when the connection is in error, not stale when ok', async () => {
		const userId = await seedUser();
		const sourceId = await seedSource();
		await reconcileTaskList(db, sourceId, [], NOW);
		expect((await buildTasksSnapshot(db, userId, NOW))?.stale).toBe(false);

		const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
		await db
			.update(connections)
			.set({ status: 'error' })
			.where(eq(connections.id, source.connectionId));

		expect((await buildTasksSnapshot(db, userId, NOW))?.stale).toBe(true);
	});
});
