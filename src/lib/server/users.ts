// The public, PIN-free view of a household member — the lock screen (DESIGN.md §7.2)
// needs names/colors/view-mode to render avatars, and must never see pin_hash.

import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema';
import { users } from './db/schema';

type Db = BetterSQLite3Database<typeof schema>;

export type TaskAccess = 'all-but-one' | 'only-one' | 'none';

export interface PublicUser {
	id: number;
	name: string;
	color: string;
	viewMode: 'standard' | 'simple';
	weekView: 'agenda' | 'grid';
	taskAccess: TaskAccess;
	/** Not sensitive — just which lock-screen avatars can also reach /settings. */
	isAdmin: boolean;
}

export async function listPublicUsers(db: Db): Promise<PublicUser[]> {
	return db
		.select({
			id: users.id,
			name: users.name,
			color: users.color,
			viewMode: users.viewMode,
			weekView: users.weekView,
			taskAccess: users.taskAccess,
			isAdmin: users.isAdmin
		})
		.from(users)
		.orderBy(users.sortOrder);
}

/** Settings screen's per-user color change (§7.5's "the admin configures the whole household"
 * pattern, same as PIN reset) — the caller validates the hex format. */
export async function setUserColor(db: Db, userId: number, color: string): Promise<void> {
	await db.update(users).set({ color }).where(eq(users.id, userId));
}

/** The agenda/grid toggle in the strip, persisted for whoever is currently logged in —
 * unlike color/PIN this isn't an admin action, since it's each person's own reading
 * preference for their own session. */
export async function setUserWeekView(
	db: Db,
	userId: number,
	weekView: 'agenda' | 'grid'
): Promise<void> {
	await db.update(users).set({ weekView }).where(eq(users.id, userId));
}

/** Settings screen's per-user task access change — same admin-configures-everyone shape
 * as setUserColor. */
export async function setUserTaskAccess(
	db: Db,
	userId: number,
	taskAccess: TaskAccess
): Promise<void> {
	await db.update(users).set({ taskAccess }).where(eq(users.id, userId));
}
