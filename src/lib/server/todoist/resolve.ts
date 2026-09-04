// Resolves the one `sources` row (kind: 'tasks') this connection needs — simpler than
// anylist/resolve.ts's own resolveGroceryList, since there's no "which list does the
// household mean" question here. Per-user task access is a users.taskAccess column plus a
// single admin-designated project (settings.ts's restrictedTaskProjectId), not a
// per-project sources row — one row per connection stays enough.

import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';
import { sources } from '../db/schema';

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Idempotent: once a `sources` row exists for this connection, returns its id without
 * touching Todoist at all.
 */
export async function resolveTasksSource(db: Db, connectionId: number): Promise<number> {
	const [existing] = await db
		.select({ id: sources.id })
		.from(sources)
		.where(and(eq(sources.connectionId, connectionId), eq(sources.kind, 'tasks')))
		.limit(1);
	if (existing) return existing.id;

	const [row] = await db
		.insert(sources)
		.values({
			connectionId,
			kind: 'tasks',
			// Todoist has no single "external id" analogous to AnyList's list id — this
			// source represents the whole account's task set, not one list — but
			// sources.externalId is NOT NULL with a unique constraint alongside
			// connectionId, so it needs some stable value. The connection can only ever
			// have one 'tasks' source (this function is the only thing that creates one,
			// and it's idempotent), so a fixed literal is unambiguous.
			externalId: 'todoist-tasks',
			displayName: 'Todoist tasks'
		})
		.returning({ id: sources.id });
	return row.id;
}
