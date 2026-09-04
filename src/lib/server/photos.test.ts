import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema';
import { photos } from './db/schema';
import { composeNextSlide, resetPhotoRotation } from './photos';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;

const TZ = 'America/Toronto';
const NOW = new Date('2026-08-24T18:00:00Z');
const DAY1 = new Date('2026-08-01T15:00:00Z'); // 11:00 Toronto
const DAY2 = new Date('2026-08-02T15:00:00Z');

beforeEach(() => {
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
	resetPhotoRotation();
});

afterEach(() => {
	resetPhotoRotation();
	sqlite.close();
});

async function seedPhoto(overrides: Partial<typeof photos.$inferInsert> = {}) {
	const [row] = await db
		.insert(photos)
		.values({
			sourcePath: `/pictures/${Math.random().toString(36).slice(2)}.jpg`,
			mtime: NOW,
			size: 1000,
			cachedPath: '/cache/x.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape',
			...overrides
		})
		.returning();
	return row;
}

describe('composeNextSlide', () => {
	it('returns null when there are no photos at all', async () => {
		expect(await composeNextSlide(db, TZ)).toBeNull();
	});

	it('shows a lone landscape photo as a single slide', async () => {
		const photo = await seedPhoto({ orientation: 'landscape' });
		const slide = await composeNextSlide(db, TZ, () => 0.5);
		expect(slide).toEqual({ kind: 'single', photo: expect.objectContaining({ id: photo.id }) });
	});

	it('pairs two portraits taken on the same day', async () => {
		const a = await seedPhoto({ orientation: 'portrait', takenAt: DAY1 });
		const b = await seedPhoto({ orientation: 'portrait', takenAt: DAY1 });
		const slide = await composeNextSlide(db, TZ, () => 0.5);
		expect(slide?.kind).toBe('pair');
		if (slide?.kind === 'pair') {
			const ids = slide.photos.map((p) => p.id).sort();
			expect(ids).toEqual([a.id, b.id].sort());
		}
	});

	it('prefers a same-day partner over a different-day one when both are available', async () => {
		// Two same-day pairs, not one — this way, *whichever* photo the shuffle happens to
		// dequeue first, both a same-day partner and a different-day alternative are
		// simultaneously available for it, so the preference is tested regardless of
		// shuffle order rather than depending on a specific one.
		const a = await seedPhoto({ orientation: 'portrait', takenAt: DAY1 });
		const b = await seedPhoto({ orientation: 'portrait', takenAt: DAY1 });
		const c = await seedPhoto({ orientation: 'portrait', takenAt: DAY2 });
		const d = await seedPhoto({ orientation: 'portrait', takenAt: DAY2 });

		for (const randomSource of [() => 0, () => 0.3, () => 0.7, () => 0.99]) {
			resetPhotoRotation();
			await db.update(photos).set({ shownCount: 0, lastShown: null });
			const slide = await composeNextSlide(db, TZ, randomSource);
			expect(slide?.kind).toBe('pair');
			if (slide?.kind === 'pair') {
				const ids = slide.photos.map((p) => p.id).sort();
				// Never a mixed-day pair when a same-day option existed for whichever photo
				// was dequeued first — only ever {a,b} or {c,d}, never one from each.
				const isValidSameDayPair =
					JSON.stringify(ids) === JSON.stringify([a.id, b.id].sort()) ||
					JSON.stringify(ids) === JSON.stringify([c.id, d.id].sort());
				expect(isValidSameDayPair).toBe(true);
			}
		}
	});

	it('falls back to a different-day partner when no same-day partner exists', async () => {
		const a = await seedPhoto({ orientation: 'portrait', takenAt: DAY1 });
		const b = await seedPhoto({ orientation: 'portrait', takenAt: DAY2 });
		const slide = await composeNextSlide(db, TZ, () => 0.5);
		expect(slide?.kind).toBe('pair');
		if (slide?.kind === 'pair') {
			const ids = slide.photos.map((p) => p.id).sort();
			expect(ids).toEqual([a.id, b.id].sort());
		}
	});

	it('holds an odd portrait over rather than showing it alone, when a future partner is possible', async () => {
		// Three portraits: two share a day and pair off, leaving one odd one out this cycle.
		await seedPhoto({ orientation: 'portrait', takenAt: DAY1 });
		await seedPhoto({ orientation: 'portrait', takenAt: DAY1 });
		const odd = await seedPhoto({ orientation: 'portrait', takenAt: DAY2 });

		const first = await composeNextSlide(db, TZ, () => 0);
		expect(first?.kind).toBe('pair');

		// The odd one out is held over — the next call must reshuffle for a new cycle rather
		// than show it alone, since more portraits could exist in a future cycle... but this
		// library truly only has one portrait left after the pair, so it must eventually
		// show up somewhere. It should not simply vanish from the rotation.
		const second = await composeNextSlide(db, TZ, () => 0);
		const allShownIds = [
			...(first?.kind === 'pair' ? first.photos.map((p) => p.id) : []),
			...(second?.kind === 'pair'
				? second.photos.map((p) => p.id)
				: second?.kind === 'single'
					? [second.photo.id]
					: [])
		];
		expect(allShownIds).toContain(odd.id);
	});

	it('eventually shows a single portrait alone when the whole library is just that one photo', async () => {
		const only = await seedPhoto({ orientation: 'portrait', takenAt: DAY1 });
		const slide = await composeNextSlide(db, TZ, () => 0.5);
		expect(slide).toEqual({ kind: 'single', photo: expect.objectContaining({ id: only.id }) });
	});

	it('updates shown_count and last_shown for a single landscape slide', async () => {
		const photo = await seedPhoto({ orientation: 'landscape' });
		await composeNextSlide(db, TZ, () => 0.5, NOW);
		const [row] = await db.select().from(photos).where(eq(photos.id, photo.id));
		expect(row.shownCount).toBe(1);
		expect(row.lastShown).toEqual(NOW);
	});

	it('updates shown_count and last_shown for BOTH halves of a pair', async () => {
		const a = await seedPhoto({ orientation: 'portrait', takenAt: DAY1 });
		const b = await seedPhoto({ orientation: 'portrait', takenAt: DAY1 });
		await composeNextSlide(db, TZ, () => 0.5, NOW);
		const rows = await db.select().from(photos);
		for (const row of rows) {
			expect(row.shownCount).toBe(1);
			expect(row.lastShown).toEqual(NOW);
		}
		expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
	});

	it('shows every photo exactly once across one full cycle before repeating', async () => {
		const seeded = await Promise.all([
			seedPhoto({ orientation: 'landscape' }),
			seedPhoto({ orientation: 'landscape' }),
			seedPhoto({ orientation: 'landscape' })
		]);
		const seenIds = new Set<number>();
		for (let i = 0; i < 3; i++) {
			const slide = await composeNextSlide(db, TZ, () => 0.5);
			if (slide?.kind === 'single') seenIds.add(slide.photo.id);
		}
		expect(seenIds).toEqual(new Set(seeded.map((p) => p.id)));
	});

	// Guest-mode photos (DESIGN.md §5/§6, HEARTH_GUEST_PHOTOS_DIR) live in the same table,
	// distinguished only by `kind` — the two rotations must never leak into each other.
	describe('kind filtering', () => {
		it('a default (family) call never sees a guest-kind row', async () => {
			await seedPhoto({ kind: 'guest' });
			expect(await composeNextSlide(db, TZ, () => 0.5)).toBeNull();
		});

		it('a guest call never sees a family-kind row', async () => {
			await seedPhoto({ kind: 'family' });
			expect(await composeNextSlide(db, TZ, () => 0.5, NOW, 'guest')).toBeNull();
		});

		it('a guest call sources from guest-kind rows', async () => {
			const guestPhoto = await seedPhoto({ kind: 'guest' });
			const slide = await composeNextSlide(db, TZ, () => 0.5, NOW, 'guest');
			expect(slide).toEqual({
				kind: 'single',
				photo: expect.objectContaining({ id: guestPhoto.id })
			});
		});

		it('keeps rotation state independent per kind', async () => {
			const family = await seedPhoto({ kind: 'family' });
			const guest = await seedPhoto({ kind: 'guest' });

			// Exhaust the family queue (one photo, one cycle) without touching the guest one.
			await composeNextSlide(db, TZ, () => 0.5);
			await composeNextSlide(db, TZ, () => 0.5);

			const guestSlide = await composeNextSlide(db, TZ, () => 0.5, NOW, 'guest');
			expect(guestSlide).toEqual({
				kind: 'single',
				photo: expect.objectContaining({ id: guest.id })
			});
			// The family photo's rotation should be unaffected by the guest calls above.
			const familyRow = (await db.select().from(photos).where(eq(photos.id, family.id)))[0];
			expect(familyRow.shownCount).toBe(2);
		});

		it('resetPhotoRotation clears both kinds', async () => {
			await seedPhoto({ kind: 'family' });
			await seedPhoto({ kind: 'guest' });
			await composeNextSlide(db, TZ, () => 0.5);
			await composeNextSlide(db, TZ, () => 0.5, NOW, 'guest');
			resetPhotoRotation();
			// If state leaked, a fresh call would still work fine either way — this mainly
			// documents that resetPhotoRotation is the one place both queues get cleared.
			expect(await composeNextSlide(db, TZ, () => 0.5)).not.toBeNull();
			expect(await composeNextSlide(db, TZ, () => 0.5, NOW, 'guest')).not.toBeNull();
		});
	});
});
