// The task write queue — mirrors groceriesQueue.ts's shape (optimistic apply + queued
// write in one transaction, a separate drain that talks to the real API), reduced to the
// single action tasks actually needs: complete-only, no add/uncheck/remove (docs/phase-6-
// todoist-plan.md §5). Kept as its own small module rather than folding into
// groceriesQueue.ts — groceries' real complexity (collapseCheckTogglePairs, add-id
// remapping) has no equivalent here, and forcing both domains through one generalized
// module would mean threading that irrelevant complexity through tasks' code path for
// marginal reuse (tasks.ts's own header comment makes the same call against a shared
// tasks.ts/groceries.ts module).

import { eq, and, lte, isNull, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema';
import { listItems, pendingWrites } from './db/schema';
import type { TodoistClient } from './todoist/client';
import type { PendingWritePayload } from './groceries';

type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function insertPendingWrite(
	tx: Tx,
	sourceId: number,
	payload: PendingWritePayload,
	now: Date
): void {
	tx.insert(pendingWrites)
		.values({
			sourceId,
			action: 'check',
			payload: JSON.stringify(payload),
			createdAt: now,
			nextAttemptAt: now
		})
		.run();
}

/**
 * Marks a task complete optimistically and queues the write. Returns false without
 * enqueueing anything if the task doesn't belong to this source — same protection
 * enqueueSetChecked gives groceries, against writing for an id nothing local recognizes.
 */
export function enqueueCompleteTask(db: Db, sourceId: number, taskId: string, now: Date): boolean {
	let found = false;

	db.transaction((tx) => {
		const result = tx
			.update(listItems)
			.set({ checked: true, updatedAt: now })
			.where(and(eq(listItems.id, taskId), eq(listItems.sourceId, sourceId)))
			.run();
		found = result.changes > 0;
		if (!found) return;

		insertPendingWrite(tx, sourceId, { id: taskId }, now);
	});

	return found;
}

// Same backoff shape as groceriesQueue.ts, duplicated rather than imported — see this
// file's header comment on why tasks stays a separate module.
const MAX_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

function backoffMs(attempts: number): number {
	return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS);
}

export interface TasksDrainResult {
	drained: number;
	failures: { taskId: string; error: string }[];
}

/**
 * Actually talks to Todoist for every due pending write, FIFO by enqueue order. Unlike
 * groceries' drainPendingWrites, there's no collapse step: tasks only ever produce
 * 'check' writes, so two pending writes for the same task in one pass are already
 * idempotent as-is — completing an already-completed task twice is harmless either way.
 * Never called concurrently with itself or a reconcile against the same client — the
 * caller (todoist/scheduler.ts's runTasksCycle) is what's wrapped in the single-flight
 * guard, not this function on its own.
 */
export async function drainTaskWrites(
	db: Db,
	client: Pick<TodoistClient, 'completeTask'>,
	sourceId: number,
	now: Date
): Promise<TasksDrainResult> {
	const due = await db
		.select()
		.from(pendingWrites)
		.where(
			and(
				eq(pendingWrites.sourceId, sourceId),
				or(isNull(pendingWrites.nextAttemptAt), lte(pendingWrites.nextAttemptAt, now))
			)
		)
		.orderBy(pendingWrites.id);

	let drained = 0;
	const failures: TasksDrainResult['failures'] = [];

	for (const row of due) {
		const payload = JSON.parse(row.payload) as PendingWritePayload;

		try {
			await client.completeTask(payload.id);
			await db.delete(pendingWrites).where(eq(pendingWrites.id, row.id));
			drained += 1;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			failures.push({ taskId: payload.id, error: message });
			const attempts = row.attempts + 1;
			// Nothing is ever lost, only delayed — same reasoning groceriesQueue.ts's own
			// drain uses, the row stays even past the attempts cap, just retried far less
			// often.
			await db
				.update(pendingWrites)
				.set({
					attempts,
					lastError: message,
					nextAttemptAt: new Date(now.getTime() + backoffMs(Math.min(attempts, MAX_ATTEMPTS)))
				})
				.where(eq(pendingWrites.id, row.id));
		}
	}

	return { drained, failures };
}
