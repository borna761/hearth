// Owns the one process-wide Todoist connection tasks needs — mirrors groceriesRuntime.ts's
// "process-wide singleton, exported control functions" shape exactly, for the same reason:
// so both sync/runtime.ts's background timer and the settings connect route (M2) can reach
// the same guarded cycle. No push-channel equivalent here — Todoist's REST API has no
// websocket, so there's nothing for an onGroceriesListsUpdate-style registration to do.

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { db as defaultDb } from './db';
import type * as schema from './db/schema';
import { getConnection, markConnectionStatus } from './connections';
import { connectTodoist, type TodoistClient, type TodoistCredentials } from './todoist/client';
import { resolveTasksSource } from './todoist/resolve';
import { runTasksCycle, type TasksCycleResult } from './todoist/scheduler';
import { createSingleFlight } from './sync/scheduler';

type Db = BetterSQLite3Database<typeof schema>;

interface RuntimeState {
	client: TodoistClient;
	connectionId: number;
	sourceId: number;
}

let state: RuntimeState | null = null;
let runCycleGuarded: (() => Promise<TasksCycleResult | null>) | null = null;

/**
 * Connects and resolves the tasks source once. Returns false — never throws — when
 * Todoist isn't connected yet or the token is invalid, matching every other syncable
 * source's own tolerance for "not configured yet".
 */
export async function initTasksRuntime(): Promise<boolean> {
	const connection = await getConnection<TodoistCredentials>(defaultDb, 'todoist');
	if (!connection) return false;

	try {
		const client = await connectTodoist(connection.secrets);
		const sourceId = await resolveTasksSource(defaultDb, connection.id);

		state = { client, connectionId: connection.id, sourceId };
		runCycleGuarded = createSingleFlight(() =>
			runTasksCycle(defaultDb, {
				client: state!.client,
				connectionId: state!.connectionId,
				sourceId: state!.sourceId,
				now: new Date()
			})
		);
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn('[tasks] connect failed:', message);
		await markConnectionStatus(defaultDb, connection.id, { status: 'error', lastError: message });
		return false;
	}
}

/** Triggers one cycle through the shared guard. Returns null if uninitialised or a cycle
 *  is already in flight — the next poll picks up whatever this one would have. */
export async function runTasksCycleNow(): Promise<TasksCycleResult | null> {
	if (!runCycleGuarded) return null;
	return runCycleGuarded();
}

/** The tasks `sources.id` — null before initTasksRuntime succeeds. The write route needs
 *  this to enqueue a completion against the right source. */
export function tasksSourceId(): number | null {
	return state?.sourceId ?? null;
}

export type TasksReadiness = 'ready' | 'initializing' | 'not-connected';

/** Same reasoning as groceriesRuntime.ts's groceriesReadiness — distinguishes "Todoist was
 *  never configured" from "it's configured but still starting up" for a route deciding how
 *  to respond to `tasksSourceId() === null`. Reads the `connections` row directly rather
 *  than the in-memory `state`, since a connection existing is what distinguishes the two
 *  cases regardless of whether initTasksRuntime has finished yet. */
export async function tasksReadiness(db: Db = defaultDb): Promise<TasksReadiness> {
	if (state) return 'ready';
	const connection = await getConnection(db, 'todoist');
	return connection ? 'initializing' : 'not-connected';
}
