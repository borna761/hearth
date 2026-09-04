// Reconciles a freshly-fetched Todoist task set into `list_items`, and reads that table
// back out for the SSE envelope — the same "reconcile, then re-apply un-drained writes on
// top, then publish" shape groceries.ts established (docs/phase-5-plan.md §4). Todoist is
// truth for anything with no outstanding write; an outstanding `check` write (tasksQueue.ts,
// M3) wins over whatever Todoist's own state currently says, for the same reason groceries'
// own replay does — a completion in flight must never look reverted for the few seconds
// until it actually lands.

import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema';
import { connections, listItems, pendingWrites, sources, users } from './db/schema';
import { getHouseholdTimeZone, getRestrictedTaskProjectId } from './settings';
import { localDateInZone } from '$lib/datetime';
import type { TodoistTask } from './todoist/client';
import type { PendingWritePayload } from './groceries';
import type { TaskAccess } from './users';

type Db = BetterSQLite3Database<typeof schema>;

export interface TasksReconcileResult {
	upserted: number;
	pruned: number;
	replayed: number;
}

/**
 * Reconciles one fetch's worth of Todoist tasks into `list_items` for the tasks source,
 * then replays any outstanding local `check` writes on top — identical shape to
 * reconcileGroceryList, minus the 'add'/'remove' branches tasks never uses (§5 of the
 * plan: complete-only, no add/uncheck/remove).
 */
export async function reconcileTaskList(
	db: Db,
	sourceId: number,
	fetched: TodoistTask[],
	now: Date
): Promise<TasksReconcileResult> {
	const pending = await db
		.select({ id: pendingWrites.id, action: pendingWrites.action, payload: pendingWrites.payload })
		.from(pendingWrites)
		.where(eq(pendingWrites.sourceId, sourceId))
		.orderBy(pendingWrites.id);

	// Todoist is truth for anything with no outstanding write. A fetched task is by
	// definition still incomplete — GET /tasks/filter only ever returns active tasks.
	for (const task of fetched) {
		await db
			.insert(listItems)
			.values({
				id: task.id,
				sourceId,
				title: task.title,
				category: task.projectName,
				projectId: task.projectId,
				checked: false,
				dueDate: task.dueDate,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: listItems.id,
				set: {
					title: task.title,
					category: task.projectName,
					projectId: task.projectId,
					checked: false,
					dueDate: task.dueDate,
					updatedAt: now
				}
			});
	}

	const fetchedIds = new Set(fetched.map((task) => task.id));
	const pendingIds = new Set(
		pending.map((row) => (JSON.parse(row.payload) as PendingWritePayload).id)
	);

	// Prune anything Todoist no longer reports as overdue/due-today (completed elsewhere,
	// its due date moved out to the future, or it was deleted) unless a pending write still
	// targets it — same "small table, filter in JS" approach groceries.ts uses.
	const current = await db
		.select({ id: listItems.id })
		.from(listItems)
		.where(eq(listItems.sourceId, sourceId));
	const prunable = current.filter((row) => !fetchedIds.has(row.id) && !pendingIds.has(row.id));
	for (const row of prunable) {
		await db.delete(listItems).where(eq(listItems.id, row.id));
	}

	// Replay every outstanding write on top, in enqueue order — a task fetched as still
	// incomplete (Todoist hasn't caught up to the completion yet) must not flash back to
	// "not done" for the window until it does.
	for (const row of pending) {
		const payload = JSON.parse(row.payload) as PendingWritePayload;
		if (row.action === 'check') {
			await db.update(listItems).set({ checked: true }).where(eq(listItems.id, payload.id));
		}
	}

	return { upserted: fetched.length, pruned: prunable.length, replayed: pending.length };
}

export interface TaskItem {
	id: string;
	title: string;
	projectName: string;
	dueDate: string;
	/** Has an outstanding `pending_writes` row — same pending mark groceries shows. */
	pending: boolean;
}

export interface TasksSnapshot {
	overdue: TaskItem[];
	dueToday: TaskItem[];
	/** overdue.length + dueToday.length — the TopStrip/SimpleView badge count. */
	count: number;
	stale: boolean;
}

/**
 * What the SSE envelope carries for tasks — null when there's nothing to show at all (the
 * client's `{#if tasks}` hides the badge/button the same way it does for "Todoist never
 * connected"), for either of two reasons: no tasks source exists yet, or this user's
 * `taskAccess` is 'none'. The two aren't distinguished on purpose — nothing downstream
 * needs to tell them apart, and a badge reading "✅ 0" for someone who deliberately opted
 * out would be a worse UI than just not showing it.
 *
 * Otherwise filtered per-user against `users.taskAccess` and the single admin-designated
 * project in settings.ts's restrictedTaskProjectId — not identity, not view_mode.
 */
export async function buildTasksSnapshot(
	db: Db,
	userId: number,
	now: Date = new Date()
): Promise<TasksSnapshot | null> {
	const [source] = await db
		.select({ id: sources.id, connectionId: sources.connectionId })
		.from(sources)
		.where(eq(sources.kind, 'tasks'))
		.limit(1);
	if (!source) return null;

	const [user] = await db
		.select({ taskAccess: users.taskAccess })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	const taskAccess: TaskAccess = user?.taskAccess ?? 'all-but-one';
	if (taskAccess === 'none') return null;

	const [connection] = await db
		.select({ status: connections.status })
		.from(connections)
		.where(eq(connections.id, source.connectionId))
		.limit(1);

	const restrictedProjectId = await getRestrictedTaskProjectId(db);

	// checked=false, unlike buildGroceriesSnapshot (which shows every item regardless, so
	// someone can review/uncheck what's already in the cart): tasks are complete-only, no
	// uncheck, no reason to keep showing something once tasksQueue.ts's enqueueCompleteTask
	// has optimistically marked it done — it should disappear the moment that happens, not
	// linger until the next reconcile prunes it once Todoist confirms the close.
	const rows = await db
		.select({
			id: listItems.id,
			title: listItems.title,
			projectName: listItems.category,
			projectId: listItems.projectId,
			dueDate: listItems.dueDate
		})
		.from(listItems)
		.where(and(eq(listItems.sourceId, source.id), eq(listItems.checked, false)));

	const visible = rows
		.filter((row) => {
			// No project designated yet: 'all-but-one' shows everything (nothing to
			// exclude), 'only-one' shows nothing (can't show a project nobody picked) —
			// both safe.
			if (!restrictedProjectId) return taskAccess === 'all-but-one';
			return taskAccess === 'only-one'
				? row.projectId === restrictedProjectId
				: row.projectId !== restrictedProjectId;
		})
		// Project, then due date, then title — project groups related tasks together
		// within a section rather than interleaving them in whatever order Todoist (or
		// SQLite) happened to return, due date breaks ties inside a project (mostly
		// relevant in Overdue, where dates actually vary), and title is the final,
		// fully-deterministic tiebreak so the order never depends on row insertion order.
		.sort((a, b) => {
			const project = (a.projectName ?? '').localeCompare(b.projectName ?? '');
			if (project !== 0) return project;
			const dueDate = (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
			if (dueDate !== 0) return dueDate;
			return a.title.localeCompare(b.title);
		});

	const pendingRows = await db
		.select({ payload: pendingWrites.payload })
		.from(pendingWrites)
		.where(eq(pendingWrites.sourceId, source.id));
	const pendingIds = new Set(
		pendingRows.map((row) => (JSON.parse(row.payload) as PendingWritePayload).id)
	);

	const timeZone = await getHouseholdTimeZone(db);
	const today = localDateInZone(now, timeZone);

	const overdue: TaskItem[] = [];
	const dueToday: TaskItem[] = [];
	for (const row of visible) {
		// dueDate/projectName are NOT NULL in practice (reconcile always sets both), but the
		// columns themselves are nullable (shared with groceries, which never sets dueDate),
		// so a defensive skip here is cheaper than a non-null assertion that's wrong the one
		// time it matters.
		if (!row.dueDate) continue;
		const item: TaskItem = {
			id: row.id,
			title: row.title,
			projectName: row.projectName ?? 'Unknown',
			dueDate: row.dueDate,
			pending: pendingIds.has(row.id)
		};
		if (row.dueDate < today) overdue.push(item);
		else if (row.dueDate === today) dueToday.push(item);
		// row.dueDate > today never happens — reconcile only ever stores what Todoist's own
		// overdue|today filter returned — but isn't asserted against, for the same
		// defensive reasoning as the dueDate-null check above.
	}

	return {
		overdue,
		dueToday,
		count: overdue.length + dueToday.length,
		stale: connection?.status === 'error'
	};
}
