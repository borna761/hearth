// PIN hashing and lockout — DESIGN.md §5: "Five wrong PINs triggers a 60-second lockout."
//
// Lockout state lives on the users row, not in any client-side state, so it survives
// individual page loads and can't be reset by a bad-actor simply reloading the tablet.
//
// argon2id via hash-wasm (WASM), not @node-rs/argon2 (native): the native linux-arm64-gnu
// prebuild crashes with "Illegal instruction" on the real Pi Zero 2 W. Its Cortex-A53 cores
// (CPU part 0xd03) lack the ARMv8.1 Large System Extensions atomic instructions
// (`/proc/cpuinfo`'s Features line has no `atomics`) that the prebuild assumes are always
// present on aarch64 — confirmed on the real hardware, not assumed. WASM sidesteps this
// entirely: V8 JIT-compiles it correctly for whatever the host CPU actually supports.
// Same algorithm either way, so this doesn't change DESIGN.md §5.3's "PINs are
// argon2-hashed because they will be reused from elsewhere."
import { argon2id, argon2Verify } from 'hash-wasm';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';
import { users } from '../db/schema';

type Db = BetterSQLite3Database<typeof schema>;

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

// OWASP's memory-constrained argon2id recommendation (19 MiB, t=2, p=1) rather than its
// higher-memory default — deliberate given DESIGN.md §2.1's tight, already-budgeted 463MB,
// and this only ever runs on an infrequent login attempt, not a hot path.
const ARGON2_MEMORY_KIB = 19_456;
const ARGON2_ITERATIONS = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_HASH_LENGTH = 32;
const ARGON2_SALT_BYTES = 16;

export async function hashPin(pin: string): Promise<string> {
	return argon2id({
		password: pin,
		salt: randomBytes(ARGON2_SALT_BYTES),
		parallelism: ARGON2_PARALLELISM,
		iterations: ARGON2_ITERATIONS,
		memorySize: ARGON2_MEMORY_KIB,
		hashLength: ARGON2_HASH_LENGTH,
		outputType: 'encoded'
	});
}

/** The settings screen's PIN-reset (DESIGN.md §7.5) — an admin setting a new PIN is a
 * fresh start, so this also clears any existing lockout rather than leaving someone
 * locked out under their old PIN's failure count. */
export async function setUserPin(db: Db, userId: number, pin: string): Promise<void> {
	const pinHash = await hashPin(pin);
	await db
		.update(users)
		.set({ pinHash, failedPinAttempts: 0, lockedUntil: null })
		.where(eq(users.id, userId));
}

export type VerifyPinResult =
	| { ok: true; userId: number }
	| { ok: false; reason: 'locked'; lockedUntil: Date }
	| { ok: false; reason: 'wrong'; attemptsRemaining: number };

export async function verifyPin(
	db: Db,
	userId: number,
	pin: string,
	now: Date = new Date()
): Promise<VerifyPinResult> {
	const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	if (!user) {
		throw new Error(`No such user: ${userId}`);
	}

	// A stored lockout that hasn't elapsed yet blocks every attempt, correct PIN included —
	// a lockout a correct guess could bypass isn't a lockout.
	if (user.lockedUntil && now < user.lockedUntil) {
		return { ok: false, reason: 'locked', lockedUntil: user.lockedUntil };
	}

	const correct = await argon2Verify({ password: pin, hash: user.pinHash });

	if (correct) {
		// Only write back if there's actually something to clear — an elapsed-but-still-
		// stored lockout, or a nonzero attempt count from earlier wrong guesses.
		if (user.failedPinAttempts !== 0 || user.lockedUntil !== null) {
			await db
				.update(users)
				.set({ failedPinAttempts: 0, lockedUntil: null })
				.where(eq(users.id, userId));
		}
		return { ok: true, userId };
	}

	// An elapsed lockout is a fresh window: don't carry the old count into it.
	const priorAttempts = user.lockedUntil && now >= user.lockedUntil ? 0 : user.failedPinAttempts;
	const failedPinAttempts = priorAttempts + 1;
	const lockedUntil =
		failedPinAttempts >= MAX_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_MS) : null;

	await db
		.update(users)
		.set({ failedPinAttempts: lockedUntil ? 0 : failedPinAttempts, lockedUntil })
		.where(eq(users.id, userId));

	if (lockedUntil) {
		return { ok: false, reason: 'locked', lockedUntil };
	}
	return { ok: false, reason: 'wrong', attemptsRemaining: MAX_ATTEMPTS - failedPinAttempts };
}
