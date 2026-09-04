import { sql, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './db/schema';
import { pendingWrites, connections } from './db/schema';

type Db = BetterSQLite3Database<typeof schema>;

export interface HealthStatus {
	status: 'ok' | 'error';
	uptimeSeconds: number;
	timestamp: Date;
	/** Displays currently attached to the SSE stream. */
	streamClients: number;
	checks: {
		database: 'ok' | 'error';
	};
	groceries: {
		/** docs/phase-5-plan.md M6: "a silently wedged queue is the failure mode most likely
		 *  to go unnoticed" — every write still applies optimistically on the tablet, so
		 *  nothing there would look wrong even if the drain has stopped entirely. */
		queueDepth: number;
		/** Null when AnyList has never been connected, or every reconcile attempt so far has
		 *  failed — same `connections.last_success` the settings screen's Connections list
		 *  already renders as "last synced", not a separate tracked value. */
		lastReconcileAt: Date | null;
	};
}

export function getHealthStatus(db: Db, options: { streamClients?: number } = {}): HealthStatus {
	let database: 'ok' | 'error' = 'ok';
	try {
		db.get(sql`SELECT 1`);
	} catch {
		database = 'error';
	}

	let queueDepth = 0;
	let lastReconcileAt: Date | null = null;
	// Deliberately its own try/catch, not nested in the one above: a closed/broken db means
	// `database` is already 'error' and these fall back to their zero/null defaults rather
	// than throwing past getHealthStatus's own caller.
	try {
		queueDepth = db.select({ id: pendingWrites.id }).from(pendingWrites).all().length;
		const [anylist] = db
			.select({ lastSuccess: connections.lastSuccess })
			.from(connections)
			.where(eq(connections.provider, 'anylist'))
			.all();
		lastReconcileAt = anylist?.lastSuccess ?? null;
	} catch {
		// Left at the defaults above.
	}

	return {
		status: database === 'ok' ? 'ok' : 'error',
		uptimeSeconds: process.uptime(),
		timestamp: new Date(),
		// Exposed because a leaked SSE connection is invisible otherwise, and on a board
		// capped at 224M (§2.1) a slow leak is exactly the failure worth being able to see
		// from the outside.
		streamClients: options.streamClients ?? 0,
		checks: { database },
		groceries: { queueDepth, lastReconcileAt }
	};
}
