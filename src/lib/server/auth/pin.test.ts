import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { users } from '../db/schema';
import { hashPin, verifyPin, setUserPin } from './pin';

// vitest can't spy on a native ESM module's live binding directly (its exports aren't
// configurable) — vi.mock's factory is the supported way to wrap one function while
// keeping the rest (argon2id) real, so "the lockout short-circuits before verifying" is
// actually verifiable rather than just inferred from the outcome.
const verifySpy = vi.fn();
vi.mock('hash-wasm', async (importOriginal) => {
	const actual = await importOriginal<typeof import('hash-wasm')>();
	return {
		...actual,
		argon2Verify: (...args: Parameters<typeof actual.argon2Verify>) => {
			verifySpy(...args);
			return actual.argon2Verify(...args);
		}
	};
});

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;

beforeEach(() => {
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
});

afterEach(() => sqlite.close());

async function seedUser(pin: string) {
	const [user] = await db
		.insert(users)
		.values({ name: 'Sam', color: '#f59e0b', pinHash: await hashPin(pin) })
		.returning();
	return user;
}

describe('hashPin', () => {
	it('produces an argon2id hash, not the plaintext PIN', async () => {
		const hash = await hashPin('1234');
		expect(hash).toMatch(/^\$argon2id\$/);
		expect(hash).not.toContain('1234');
	});
});

describe('verifyPin', () => {
	it('succeeds with the correct PIN', async () => {
		const user = await seedUser('1234');
		const result = await verifyPin(db, user.id, '1234');
		expect(result).toEqual({ ok: true, userId: user.id });
	});

	it('fails with the wrong PIN and reports attempts remaining', async () => {
		const user = await seedUser('1234');
		const result = await verifyPin(db, user.id, '0000');
		expect(result).toEqual({ ok: false, reason: 'wrong', attemptsRemaining: 4 });
	});

	it('increments the stored failure count on each wrong attempt', async () => {
		const user = await seedUser('1234');
		await verifyPin(db, user.id, '0000');
		await verifyPin(db, user.id, '0000');
		const [row] = await db.select().from(users).where(eq(users.id, user.id));
		expect(row.failedPinAttempts).toBe(2);
	});

	it('resets the failure count after a correct PIN', async () => {
		const user = await seedUser('1234');
		await verifyPin(db, user.id, '0000');
		await verifyPin(db, user.id, '0000');
		await verifyPin(db, user.id, '1234');
		const [row] = await db.select().from(users).where(eq(users.id, user.id));
		expect(row.failedPinAttempts).toBe(0);
	});

	it('locks out for 60 seconds on the 5th consecutive wrong PIN', async () => {
		const user = await seedUser('1234');
		const now = new Date('2026-08-23T12:00:00Z');
		for (let i = 0; i < 4; i += 1) {
			const r = await verifyPin(db, user.id, '0000', now);
			expect(r.ok).toBe(false);
		}
		const fifth = await verifyPin(db, user.id, '0000', now);
		expect(fifth).toEqual({
			ok: false,
			reason: 'locked',
			lockedUntil: new Date('2026-08-23T12:01:00Z')
		});
	});

	it('rejects further attempts while locked, without re-verifying the PIN', async () => {
		const user = await seedUser('1234');
		const now = new Date('2026-08-23T12:00:00Z');
		for (let i = 0; i < 5; i += 1) await verifyPin(db, user.id, '0000', now);
		verifySpy.mockClear();

		const stillLocked = new Date('2026-08-23T12:00:30Z'); // 30s into the 60s lockout
		// Even the CORRECT pin must be rejected while locked — a lockout that could be
		// bypassed by guessing right defeats the point of a lockout.
		const result = await verifyPin(db, user.id, '1234', stillLocked);

		expect(result).toEqual({
			ok: false,
			reason: 'locked',
			lockedUntil: new Date('2026-08-23T12:01:00Z')
		});
		expect(verifySpy).not.toHaveBeenCalled();
	});

	it('allows a fresh set of attempts once the lockout window has passed', async () => {
		const user = await seedUser('1234');
		const now = new Date('2026-08-23T12:00:00Z');
		for (let i = 0; i < 5; i += 1) await verifyPin(db, user.id, '0000', now);

		const afterLockout = new Date('2026-08-23T12:01:00Z');
		const result = await verifyPin(db, user.id, '1234', afterLockout);
		expect(result).toEqual({ ok: true, userId: user.id });
	});

	it('throws for a nonexistent user id', async () => {
		await expect(verifyPin(db, 999, '1234')).rejects.toThrow(/no such user/i);
	});
});

describe('setUserPin', () => {
	it('lets a user log in with the new PIN, not the old one', async () => {
		const user = await seedUser('1234');
		await setUserPin(db, user.id, '5678');

		expect(await verifyPin(db, user.id, '5678')).toEqual({ ok: true, userId: user.id });
		expect(await verifyPin(db, user.id, '1234')).toMatchObject({ ok: false, reason: 'wrong' });
	});

	it('clears any existing lockout — an admin resetting a PIN is a fresh start, not stuck behind the old lockout', async () => {
		const user = await seedUser('1234');
		const now = new Date('2026-08-23T12:00:00Z');
		for (let i = 0; i < 5; i += 1) await verifyPin(db, user.id, '0000', now);
		const [locked] = await db.select().from(users).where(eq(users.id, user.id));
		expect(locked.lockedUntil).not.toBeNull();

		await setUserPin(db, user.id, '9999');

		const [after] = await db.select().from(users).where(eq(users.id, user.id));
		expect(after.lockedUntil).toBeNull();
		expect(after.failedPinAttempts).toBe(0);
		expect(await verifyPin(db, user.id, '9999', now)).toEqual({ ok: true, userId: user.id });
	});
});
