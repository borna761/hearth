// Backs the settings screen's "restricted project" picker with the real, complete project
// list from Todoist — not a derivation from list_items (which only ever holds projects
// with a currently-overdue/due-today task, undercounting a real account significantly; see
// client.ts's own header comment: 29 projects on the account this was built against, most
// with nothing due at any given moment). Alex has to be able to pick a project before it
// ever has a due task, not just after.

import { getConnection } from '../connections';
import { connectTodoist, type TodoistCredentials } from './client';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';

type Db = BetterSQLite3Database<typeof schema>;

export interface TodoistProjectOption {
	projectId: string;
	label: string;
}

/**
 * Empty when Todoist isn't connected or the live call fails (a revoked token, the network
 * being down) — the settings screen already renders "No Todoist projects discovered yet"
 * for an empty list, so this degrades the same way as any other "not configured" state
 * rather than needing a separate error path.
 */
export async function listTodoistProjectOptions(db: Db): Promise<TodoistProjectOption[]> {
	const connection = await getConnection<TodoistCredentials>(db, 'todoist');
	if (!connection) return [];

	try {
		const client = await connectTodoist(connection.secrets);
		const projects = await client.listProjects();
		return projects
			.map((p) => ({ projectId: p.id, label: p.name }))
			.sort((a, b) => a.label.localeCompare(b.label));
	} catch (err) {
		console.warn('[settings] listing Todoist projects failed:', err);
		return [];
	}
}
