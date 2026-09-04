// One tasks cycle — reconcile, then drain any due pending writes, the same shape
// anylist/scheduler.ts's runGroceriesCycle uses for groceries. Kept separate from
// sync/runtime.ts's timer wiring for the same testability reason anylist/scheduler.ts is.
//
// Never throws: a failure is caught, marks the connection's status, and is reported back
// in the result rather than propagating — one bad cycle must not take down the interval
// that would otherwise retry it.

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';
import { markConnectionStatus } from '../connections';
import { reconcileTaskList, type TasksReconcileResult } from '../tasks';
import { drainTaskWrites } from '../tasksQueue';
import { formatFailures } from '../sync/scheduler';
import type { TodoistClient } from './client';

type Db = BetterSQLite3Database<typeof schema>;

export interface TasksCycleResult extends TasksReconcileResult {
	drained: number;
	error: string | null;
}

export interface TasksCycleDeps {
	client: Pick<TodoistClient, 'fetchOverdueAndDueToday' | 'completeTask'>;
	connectionId: number;
	sourceId: number;
	now: Date;
}

export async function runTasksCycle(db: Db, deps: TasksCycleDeps): Promise<TasksCycleResult> {
	try {
		const fetched = await deps.client.fetchOverdueAndDueToday();
		const reconciled = await reconcileTaskList(db, deps.sourceId, fetched, deps.now);
		const drain = await drainTaskWrites(db, deps.client, deps.sourceId, deps.now);

		// A write failing is the same signal as a read failing — matches
		// anylist/scheduler.ts's runGroceriesCycle: an outage degrades one card to a stale
		// badge, even though reconcile itself succeeded.
		if (drain.failures.length > 0) {
			const message = formatFailures(drain.failures, (f) => f.taskId);
			await markConnectionStatus(db, deps.connectionId, { status: 'error', lastError: message });
			return { ...reconciled, drained: drain.drained, error: message };
		}

		await markConnectionStatus(db, deps.connectionId, { status: 'ok', lastSuccess: deps.now });
		return { ...reconciled, drained: drain.drained, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await markConnectionStatus(db, deps.connectionId, { status: 'error', lastError: message });
		return { upserted: 0, pruned: 0, replayed: 0, drained: 0, error: message };
	}
}
