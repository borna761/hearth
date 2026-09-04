// Tablet sessions — DESIGN.md §5: avatar + PIN -> session, idle for 2 minutes ends it.
//
// loadSession computes expiry live from the stored timestamps on every call rather than
// relying on anything client-driven — that's what makes it the actual security boundary
// rather than just a UX nicety. Callers that want to keep a session alive during genuine
// activity call touchSession explicitly; loadSession never does that itself, so reading a
// session never has the side effect of extending it.

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';
import { sessions, users } from '../db/schema';

type Db = BetterSQLite3Database<typeof schema>;

export const SESSION_COOKIE = 'hearth_session';
/** Sticky guest-mode flag (DESIGN.md §5/§7.4) — no DB row, since guest grants no data
 * access at all; it's a screensaver variant, not a session. */
export const GUEST_COOKIE = 'hearth_guest';
/** DESIGN.md §5: "Idle for two minutes ends the session and returns to the screensaver." */
export const IDLE_TIMEOUT_MS = 2 * 60_000;
/** Not in DESIGN.md — a defensive cap independent of idle-timeout, in case something
 * keeps touching a session (e.g. a heartbeat bug) indefinitely. */
export const SESSION_HARD_CAP_MS = 12 * 60 * 60_000;

/**
 * Shared cookie options for SESSION_COOKIE/GUEST_COOKIE — every `cookies.set`/`.delete`
 * call for either one must use this, not a hand-written literal. SvelteKit's own cookie
 * handling defaults `secure: true` for any non-localhost host (@sveltejs/kit's
 * cookie.js), including the tablet's plain-HTTP LAN IP — a Secure-flagged Set-Cookie
 * response over plain HTTP is one a browser must ignore, so a call site that forgets to
 * override this default doesn't error, it just silently fails to do anything. Confirmed
 * live: `/api/auth/login`'s `cookies.delete(GUEST_COOKIE, { path: '/' })` had exactly
 * this bug — the guest cookie stayed stuck on the household tablet long after guest mode
 * had ended, silently blocking every PIN-free action (music, groceries) with a 401 that
 * looked like a network failure. Centralizing this computation is what makes forgetting
 * it on a future call site impossible rather than just unlikely.
 */
export function authCookieOptions(url: URL): {
	path: '/';
	httpOnly: true;
	sameSite: 'lax';
	secure: boolean;
} {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:'
	};
}

export interface SessionUser {
	sessionId: string;
	userId: number;
	userName: string;
	viewMode: 'standard' | 'simple';
	weekView: 'agenda' | 'grid';
	isAdmin: boolean;
}

/** The session shape safe to hand to the client as page load data — everything the
 * client actually reads (userId/viewMode/weekView/isAdmin) minus the raw session token,
 * which already rides along on the httpOnly cookie and has no reason to also be
 * readable by page JS. */
export type PageSession = Omit<SessionUser, 'sessionId'>;

export function toPageSession(session: SessionUser | null): PageSession | null {
	if (!session) return null;
	const { sessionId: _sessionId, ...pageSession } = session;
	return pageSession;
}

export async function createSession(
	db: Db,
	userId: number,
	now: Date = new Date()
): Promise<string> {
	const id = randomBytes(32).toString('base64url');
	await db.insert(sessions).values({
		id,
		userId,
		createdAt: now,
		lastSeenAt: now,
		expiresAt: new Date(now.getTime() + SESSION_HARD_CAP_MS)
	});
	return id;
}

export async function loadSession(
	db: Db,
	token: string,
	now: Date = new Date()
): Promise<SessionUser | null> {
	const [row] = await db
		.select({
			sessionId: sessions.id,
			lastSeenAt: sessions.lastSeenAt,
			expiresAt: sessions.expiresAt,
			userId: users.id,
			userName: users.name,
			viewMode: users.viewMode,
			weekView: users.weekView,
			isAdmin: users.isAdmin
		})
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(eq(sessions.id, token))
		.limit(1);

	if (!row) return null;

	const idleFor = now.getTime() - row.lastSeenAt.getTime();
	if (idleFor > IDLE_TIMEOUT_MS || now > row.expiresAt) {
		// Self-pruning: an expired session is deleted the moment anything looks it up,
		// rather than needing a separate cleanup job.
		await db.delete(sessions).where(eq(sessions.id, token));
		return null;
	}

	return {
		sessionId: row.sessionId,
		userId: row.userId,
		userName: row.userName,
		viewMode: row.viewMode,
		weekView: row.weekView,
		isAdmin: row.isAdmin
	};
}

export async function touchSession(db: Db, token: string, now: Date = new Date()): Promise<void> {
	await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, token));
}

export async function endSession(db: Db, token: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, token));
}

/**
 * Gate for every PIN-free-but-not-guest-mode feature reachable from the resting
 * screensaver — groceries (DESIGN.md §5.1: a shared household list, not per-person data)
 * and music (docs/phase-7-music-plan.md: which speaker/folder plays is shared household
 * routing, not per-person data either). A signed-in session can always use these; guest
 * mode never can; the screensaver's own family-mode buttons need them without any session
 * at all — same gate the screensaver's own data already uses.
 */
export function canAccessPinFreeFeature(locals: {
	session: SessionUser | null;
	guestMode: boolean;
}): boolean {
	return locals.session !== null || !locals.guestMode;
}
