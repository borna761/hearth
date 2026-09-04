import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { users, sessions } from '../db/schema';
import {
	createSession,
	loadSession,
	touchSession,
	endSession,
	canAccessPinFreeFeature,
	authCookieOptions,
	toPageSession,
	IDLE_TIMEOUT_MS,
	SESSION_HARD_CAP_MS
} from './session';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;

beforeEach(() => {
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
});

afterEach(() => sqlite.close());

async function seedUser(over: Partial<typeof users.$inferInsert> = {}) {
	const [user] = await db
		.insert(users)
		.values({ name: 'Dana', color: '#3b82f6', pinHash: 'hash', ...over })
		.returning();
	return user;
}

describe('createSession / loadSession', () => {
	it('round-trips: a created session can be loaded back with the user it belongs to', async () => {
		const user = await seedUser({ viewMode: 'standard', isAdmin: true });
		const now = new Date('2026-08-23T12:00:00Z');
		const token = await createSession(db, user.id, now);

		const loaded = await loadSession(db, token, now);
		expect(loaded).toEqual({
			sessionId: token,
			userId: user.id,
			userName: 'Dana',
			viewMode: 'standard',
			weekView: 'agenda',
			isAdmin: true
		});
	});

	it('returns null for a token that does not exist', async () => {
		expect(await loadSession(db, 'not-a-real-token')).toBeNull();
	});

	it('rejects and deletes a session idle for longer than the timeout', async () => {
		const user = await seedUser();
		const createdAt = new Date('2026-08-23T12:00:00Z');
		const token = await createSession(db, user.id, createdAt);

		const idleTooLong = new Date(createdAt.getTime() + IDLE_TIMEOUT_MS + 1);
		expect(await loadSession(db, token, idleTooLong)).toBeNull();

		const rows = await db.select().from(sessions).where(eq(sessions.id, token));
		expect(rows).toHaveLength(0);
	});

	it('accepts a session right up to the idle boundary', async () => {
		const user = await seedUser();
		const createdAt = new Date('2026-08-23T12:00:00Z');
		const token = await createSession(db, user.id, createdAt);

		const justUnderTimeout = new Date(createdAt.getTime() + IDLE_TIMEOUT_MS - 1);
		expect(await loadSession(db, token, justUnderTimeout)).not.toBeNull();
	});

	it('rejects a session past the hard cap even with recent activity', async () => {
		const user = await seedUser();
		const createdAt = new Date('2026-08-23T00:00:00Z');
		const token = await createSession(db, user.id, createdAt);

		// Touch it just before the cap, then check just after — recent activity alone must
		// not extend a session past the hard cap.
		const justBeforeCap = new Date(createdAt.getTime() + SESSION_HARD_CAP_MS - 1000);
		await touchSession(db, token, justBeforeCap);

		const justAfterCap = new Date(createdAt.getTime() + SESSION_HARD_CAP_MS + 1000);
		expect(await loadSession(db, token, justAfterCap)).toBeNull();
	});
});

describe('touchSession', () => {
	it('extends how long the session can stay idle, without touching the hard cap', async () => {
		const user = await seedUser();
		const createdAt = new Date('2026-08-23T12:00:00Z');
		const token = await createSession(db, user.id, createdAt);

		const laterButStillFresh = new Date(createdAt.getTime() + IDLE_TIMEOUT_MS - 1000);
		await touchSession(db, token, laterButStillFresh);

		// Without the touch, this instant would be idle-expired relative to createdAt.
		const afterOriginalIdleWindow = new Date(createdAt.getTime() + IDLE_TIMEOUT_MS + 1000);
		expect(await loadSession(db, token, afterOriginalIdleWindow)).not.toBeNull();
	});
});

describe('endSession', () => {
	it('removes the session so it can no longer be loaded', async () => {
		const user = await seedUser();
		const token = await createSession(db, user.id);
		await endSession(db, token);
		expect(await loadSession(db, token)).toBeNull();
	});

	it('is a no-op for a token that does not exist', async () => {
		await expect(endSession(db, 'not-a-real-token')).resolves.not.toThrow();
	});
});

describe('canAccessPinFreeFeature', () => {
	it('allows a signed-in session regardless of the guest flag', async () => {
		const user = await seedUser();
		const session = await loadSession(db, await createSession(db, user.id));
		expect(canAccessPinFreeFeature({ session, guestMode: false })).toBe(true);
		expect(canAccessPinFreeFeature({ session, guestMode: true })).toBe(true);
	});

	it('allows no session as long as guest mode is not active — DESIGN.md §5.1: the screensaver groceries button is PIN-free in family mode', () => {
		expect(canAccessPinFreeFeature({ session: null, guestMode: false })).toBe(true);
	});

	it('blocks no session while guest mode is active', () => {
		expect(canAccessPinFreeFeature({ session: null, guestMode: true })).toBe(false);
	});
});

describe('authCookieOptions', () => {
	// Confirmed live: SvelteKit's own cookies.delete/set default `secure: true` for any
	// non-localhost host (node_modules/@sveltejs/kit's cookie.js — `url.hostname ===
	// 'localhost' && url.protocol === 'http:' ? false : true`), including a plain-HTTP LAN
	// IP like the tablet's. A Secure-flagged Set-Cookie response over plain HTTP is one a
	// browser must ignore, so a delete call that forgets to override this default doesn't
	// error — it just silently fails to clear the cookie at all. That's exactly what
	// happened to the guest cookie on the household tablet, stuck long after guest mode
	// had ended, blocking every PIN-free action. This is the one place that computation
	// happens, so every set/delete call site gets it right by construction.
	it("is not secure over the tablet's plain-HTTP LAN connection", () => {
		expect(authCookieOptions(new URL('http://192.168.1.50:8080/api/auth/login')).secure).toBe(
			false
		);
	});

	it('is secure over the Tailscale HTTPS admin path — DESIGN.md §3.2', () => {
		expect(
			authCookieOptions(new URL('https://raspberrypi.tailabc123.ts.net/api/auth/login')).secure
		).toBe(true);
	});

	it('always sets path "/", httpOnly, and sameSite "lax"', () => {
		const options = authCookieOptions(new URL('http://192.168.1.50:8080/'));
		expect(options.path).toBe('/');
		expect(options.httpOnly).toBe(true);
		expect(options.sameSite).toBe('lax');
	});
});

describe('toPageSession', () => {
	// +page.server.ts hands this straight to the client as load data — sessionId is the
	// raw session token, which the client never needs (it rides along on the httpOnly
	// cookie already) and shouldn't be duplicated onto a surface JS can read.
	it('strips sessionId from the client-facing session', () => {
		const session = {
			sessionId: 'super-secret-token',
			userId: 1,
			userName: 'Dana',
			viewMode: 'standard' as const,
			weekView: 'agenda' as const,
			isAdmin: false
		};

		expect(toPageSession(session)).toEqual({
			userId: 1,
			userName: 'Dana',
			viewMode: 'standard',
			weekView: 'agenda',
			isAdmin: false
		});
	});

	it('passes null through unchanged', () => {
		expect(toPageSession(null)).toBeNull();
	});
});
