// Slide composition for the family screensaver — DESIGN.md §7.1. Picks the next
// landscape (single slide) or pairs two portraits, tracking shown_count/last_shown so the
// rotation is fair. Module-scope singleton state (the shuffled queue, a held-over
// portrait) — the same "one physical tablet" simplification Phase 3 already made for
// activeSessionToken in state/publisher.ts.

import { sql, inArray, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema';
import { photos } from './db/schema';
import { localDateInZone } from '$lib/datetime';
import { shuffle } from './shuffle';

type Db = BetterSQLite3Database<typeof schema>;

export interface PhotoRow {
	id: number;
	cachedPath: string;
	/** For cache-busting the served URL — a reprocessed photo overwrites the same
	 * cachedPath in place, so the URL needs something that changes when the bytes do. */
	mtime: Date;
	width: number;
	height: number;
	orientation: 'landscape' | 'portrait';
	blurHash: string | null;
	takenAt: Date | null;
}

export type ScreensaverPhotoSlide =
	{ kind: 'single'; photo: PhotoRow } | { kind: 'pair'; photos: [PhotoRow, PhotoRow] };

interface RotationState {
	queue: PhotoRow[];
	heldOverPortrait: PhotoRow | null;
}

// One rotation state per kind, not a shared one filtered post-hoc — a guest-mode call and
// a family-mode call must never draw from (or exhaust) each other's queue. Mutated in
// place throughout composeNextSlide, so there's no separate "write back" step to forget.
const rotationState: Record<'family' | 'guest', RotationState> = {
	family: { queue: [], heldOverPortrait: null },
	guest: { queue: [], heldOverPortrait: null }
};

/** Test-only reset — mirrors resetWeatherCache/setActiveSessionToken(null) elsewhere. */
export function resetPhotoRotation(): void {
	rotationState.family = { queue: [], heldOverPortrait: null };
	rotationState.guest = { queue: [], heldOverPortrait: null };
}

function sameLocalDay(a: Date | null, b: Date | null, timeZone: string): boolean {
	if (!a || !b) return false;
	return localDateInZone(a, timeZone) === localDateInZone(b, timeZone);
}

async function fetchAllRows(db: Db, kind: 'family' | 'guest'): Promise<PhotoRow[]> {
	return db
		.select({
			id: photos.id,
			cachedPath: photos.cachedPath,
			mtime: photos.mtime,
			width: photos.width,
			height: photos.height,
			orientation: photos.orientation,
			blurHash: photos.blurHash,
			takenAt: photos.takenAt
		})
		.from(photos)
		.where(eq(photos.kind, kind));
}

async function markShown(db: Db, ids: number[], now: Date): Promise<void> {
	await db
		.update(photos)
		.set({ shownCount: sql`${photos.shownCount} + 1`, lastShown: now })
		.where(inArray(photos.id, ids));
}

/**
 * Composes the next slide: one landscape, or a pair of portraits (same-day preferred,
 * falling back to any other portrait, per DESIGN.md §7.1). An odd portrait with no
 * possible partner anywhere in the library is shown alone rather than held over forever —
 * "nothing is starved" applies to a permanently unpairable photo too, not just a
 * temporarily unlucky one.
 */
export async function composeNextSlide(
	db: Db,
	timeZone: string,
	randomSource: () => number = Math.random,
	now: Date = new Date(),
	kind: 'family' | 'guest' = 'family'
): Promise<ScreensaverPhotoSlide | null> {
	const state = rotationState[kind];

	// Bounded rather than an unconditional while(true) — a defensive guard against a logic
	// bug ever looping forever, not a limit expected to matter for any real library size.
	for (let guard = 0; guard < 10_000; guard++) {
		if (state.queue.length === 0) {
			const rows = await fetchAllRows(db, kind);
			if (rows.length === 0) {
				state.heldOverPortrait = null;
				return null;
			}

			const totalPortraits = rows.filter((r) => r.orientation === 'portrait').length;
			const rest = state.heldOverPortrait
				? rows.filter((r) => r.id !== state.heldOverPortrait!.id)
				: rows;

			// A held-over portrait with no other portrait anywhere in the library will never
			// find a partner, this cycle or any future one — show it alone now instead of
			// re-queuing it for another guaranteed-to-fail attempt.
			if (state.heldOverPortrait && totalPortraits <= 1) {
				const alone = state.heldOverPortrait;
				state.heldOverPortrait = null;
				state.queue = shuffle(rest, randomSource);
				await markShown(db, [alone.id], now);
				return { kind: 'single', photo: alone };
			}

			const shuffled = shuffle(rest, randomSource);
			state.queue = state.heldOverPortrait ? [state.heldOverPortrait, ...shuffled] : shuffled;
			state.heldOverPortrait = null;
		}

		const candidate = state.queue.shift()!;

		if (candidate.orientation === 'landscape') {
			await markShown(db, [candidate.id], now);
			return { kind: 'single', photo: candidate };
		}

		// Portrait: prefer a same-day partner still in the queue this cycle.
		let partnerIndex = state.queue.findIndex(
			(p) => p.orientation === 'portrait' && sameLocalDay(p.takenAt, candidate.takenAt, timeZone)
		);
		// "Falling back to the next portrait in the shuffled queue when there is no
		// same-day partner" (DESIGN.md §7.1) — any portrait beats holding over when one
		// happens to already be available this cycle.
		if (partnerIndex === -1) {
			partnerIndex = state.queue.findIndex((p) => p.orientation === 'portrait');
		}

		if (partnerIndex !== -1) {
			const [partner] = state.queue.splice(partnerIndex, 1);
			await markShown(db, [candidate.id, partner.id], now);
			return { kind: 'pair', photos: [candidate, partner] };
		}

		// No other portrait left this cycle — hold it over for the next one rather than
		// showing it alone, unless the library-wide check above already ruled that out.
		state.heldOverPortrait = candidate;
	}

	return null; // Unreachable in practice; a safety net, not an expected path.
}
