import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { mergePhotosTable } from './merge-photos.mjs';

// Minimal, hand-written schema matching src/lib/server/db/schema.ts's `photos` table —
// deliberately not importing the real (TypeScript) schema module, same reasoning as every
// other scripts/lib helper in this project: these run under plain `node` in production,
// which can't import .ts.
const CREATE_PHOTOS_TABLE = `
	CREATE TABLE photos (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		source_path TEXT NOT NULL UNIQUE,
		mtime INTEGER NOT NULL,
		size INTEGER NOT NULL,
		cached_path TEXT NOT NULL,
		width INTEGER NOT NULL,
		height INTEGER NOT NULL,
		orientation TEXT NOT NULL,
		blur_hash TEXT,
		taken_at INTEGER,
		shown_count INTEGER NOT NULL DEFAULT 0,
		last_shown INTEGER,
		kind TEXT NOT NULL DEFAULT 'family'
	)
`;

let dir;
let targetPath;
let sourcePath;
let targetDb;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'merge-photos-test-'));
	targetPath = path.join(dir, 'target.db');
	sourcePath = path.join(dir, 'source.db');

	targetDb = new Database(targetPath);
	targetDb.exec(CREATE_PHOTOS_TABLE);

	const sourceDb = new Database(sourcePath);
	sourceDb.exec(CREATE_PHOTOS_TABLE);
	sourceDb.close();
});

afterEach(() => {
	targetDb.close();
	rmSync(dir, { recursive: true, force: true });
});

function insertInto(dbPath, row) {
	const db = new Database(dbPath);
	db.prepare(
		`INSERT INTO photos
			(source_path, mtime, size, cached_path, width, height, orientation, blur_hash, taken_at, shown_count, last_shown, kind)
			VALUES (@sourcePath, @mtime, @size, @cachedPath, @width, @height, @orientation, @blurHash, @takenAt, @shownCount, @lastShown, @kind)`
	).run({
		shownCount: 0,
		lastShown: null,
		blurHash: null,
		takenAt: null,
		kind: 'family',
		...row
	});
	db.close();
}

describe('mergePhotosTable', () => {
	it('inserts a row from the source that has no match in the target', () => {
		insertInto(sourcePath, {
			sourcePath: '/pictures/a.jpg',
			mtime: 100,
			size: 500,
			cachedPath: '/cache/a.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape'
		});

		const { merged } = mergePhotosTable(targetDb, sourcePath);

		expect(merged).toBe(1);
		const row = targetDb
			.prepare('SELECT * FROM photos WHERE source_path = ?')
			.get('/pictures/a.jpg');
		expect(row).toMatchObject({
			cached_path: '/cache/a.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape',
			shown_count: 0,
			last_shown: null
		});
	});

	it('updates resize-derived columns on an existing row, but preserves shown_count and last_shown', () => {
		insertInto(targetPath, {
			sourcePath: '/pictures/a.jpg',
			mtime: 100,
			size: 500,
			cachedPath: '/cache/old.jpg',
			width: 640,
			height: 800,
			orientation: 'portrait',
			shownCount: 7,
			lastShown: 12345
		});
		insertInto(sourcePath, {
			sourcePath: '/pictures/a.jpg',
			mtime: 200,
			size: 999,
			cachedPath: '/cache/new.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape'
		});

		mergePhotosTable(targetDb, sourcePath);

		const row = targetDb
			.prepare('SELECT * FROM photos WHERE source_path = ?')
			.get('/pictures/a.jpg');
		expect(row).toMatchObject({
			mtime: 200,
			size: 999,
			cached_path: '/cache/new.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape',
			// Real rotation history — must survive the merge untouched.
			shown_count: 7,
			last_shown: 12345
		});
	});

	it('leaves a target row with no counterpart in the source untouched', () => {
		insertInto(targetPath, {
			sourcePath: '/pictures/only-on-pi.jpg',
			mtime: 1,
			size: 1,
			cachedPath: '/cache/only-on-pi.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape'
		});

		const { merged } = mergePhotosTable(targetDb, sourcePath);

		expect(merged).toBe(0);
		const row = targetDb
			.prepare('SELECT * FROM photos WHERE source_path = ?')
			.get('/pictures/only-on-pi.jpg');
		expect(row).toBeDefined();
	});

	it('merges several rows in one call', () => {
		for (const name of ['a', 'b', 'c']) {
			insertInto(sourcePath, {
				sourcePath: `/pictures/${name}.jpg`,
				mtime: 1,
				size: 1,
				cachedPath: `/cache/${name}.jpg`,
				width: 1280,
				height: 800,
				orientation: 'landscape'
			});
		}

		const { merged } = mergePhotosTable(targetDb, sourcePath);

		expect(merged).toBe(3);
		const count = targetDb.prepare('SELECT COUNT(*) AS n FROM photos').get();
		expect(count.n).toBe(3);
	});

	it('rewrites the cached_path prefix when the resize machine mounted the NAS elsewhere', () => {
		// The real case: macOS can't mount anything at /mnt (read-only root filesystem), so
		// a Mac-side resize run writes a Mac-local mount path into cached_path — the Pi's
		// /api/photos/[id] route needs the Pi's own mount path instead.
		insertInto(sourcePath, {
			sourcePath: '/pictures/a.jpg',
			mtime: 1,
			size: 1,
			cachedPath: '/Users/alex/nas-mount/hearth/cache/abc123.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape'
		});

		mergePhotosTable(targetDb, sourcePath, {
			rewriteCachePath: {
				from: '/Users/alex/nas-mount/hearth/cache',
				to: '/mnt/nas/hearth/cache'
			}
		});

		const row = targetDb
			.prepare('SELECT cached_path FROM photos WHERE source_path = ?')
			.get('/pictures/a.jpg');
		expect(row.cached_path).toBe('/mnt/nas/hearth/cache/abc123.jpg');
	});

	it('leaves cached_path alone when no rewrite is requested', () => {
		insertInto(sourcePath, {
			sourcePath: '/pictures/a.jpg',
			mtime: 1,
			size: 1,
			cachedPath: '/mnt/nas/hearth/cache/abc123.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape'
		});

		mergePhotosTable(targetDb, sourcePath);

		const row = targetDb
			.prepare('SELECT cached_path FROM photos WHERE source_path = ?')
			.get('/pictures/a.jpg');
		expect(row.cached_path).toBe('/mnt/nas/hearth/cache/abc123.jpg');
	});

	it('rewrites source_path too, and matches an existing row once rewritten', () => {
		// The bug this guards against: source_path is what ON CONFLICT matches rows on. An
		// unrewritten source_path doesn't just point at the wrong file — it makes the merge
		// treat every row as brand new instead of updating the Pi's existing one, and makes
		// the Pi's own next nightly diff fail to recognize any of them (wrong local prefix
		// versus what its own directory walk produces).
		insertInto(targetPath, {
			sourcePath: '/mnt/nas/hearth/pictures/a.jpg',
			mtime: 1,
			size: 1,
			cachedPath: '/mnt/nas/hearth/cache/old.jpg',
			width: 640,
			height: 800,
			orientation: 'portrait',
			shownCount: 3,
			lastShown: 999
		});
		insertInto(sourcePath, {
			sourcePath: '/Volumes/Public/hearth/pictures/a.jpg',
			mtime: 2,
			size: 2,
			cachedPath: '/Volumes/Public/hearth/cache/new.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape'
		});

		const { merged } = mergePhotosTable(targetDb, sourcePath, {
			rewriteSourcePath: {
				from: '/Volumes/Public/hearth/pictures',
				to: '/mnt/nas/hearth/pictures'
			},
			rewriteCachePath: {
				from: '/Volumes/Public/hearth/cache',
				to: '/mnt/nas/hearth/cache'
			}
		});

		// Matched the existing row and updated it in place, not a second insert.
		expect(merged).toBe(1);
		const rows = targetDb.prepare('SELECT * FROM photos').all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			source_path: '/mnt/nas/hearth/pictures/a.jpg',
			cached_path: '/mnt/nas/hearth/cache/new.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape',
			shown_count: 3,
			last_shown: 999
		});
	});

	// The bug this guards against: a scratch db produced by a local guest-photos resize
	// run (HEARTH_GUEST_PHOTOS_DIR, resize-photos.mjs) tags every row kind: 'guest'. If the
	// merge silently dropped that column, every merged row would fall back to the schema's
	// own default ('family') on insert — a guest photo would end up visible in the family
	// rotation, and vice versa on an update, defeating the entire point of the kind column.
	it('carries the kind column through on both insert and update', () => {
		insertInto(targetPath, {
			sourcePath: '/pictures/existing-guest.jpg',
			mtime: 1,
			size: 1,
			cachedPath: '/cache/existing-guest.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape',
			kind: 'guest'
		});
		insertInto(sourcePath, {
			sourcePath: '/pictures/new-guest.jpg',
			mtime: 1,
			size: 1,
			cachedPath: '/cache/new-guest.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape',
			kind: 'guest'
		});
		insertInto(sourcePath, {
			sourcePath: '/pictures/existing-guest.jpg',
			mtime: 2,
			size: 2,
			cachedPath: '/cache/existing-guest-reprocessed.jpg',
			width: 1280,
			height: 800,
			orientation: 'landscape',
			kind: 'guest'
		});

		mergePhotosTable(targetDb, sourcePath);

		const rows = targetDb
			.prepare('SELECT source_path, kind FROM photos ORDER BY source_path')
			.all();
		expect(rows).toEqual([
			{ source_path: '/pictures/existing-guest.jpg', kind: 'guest' },
			{ source_path: '/pictures/new-guest.jpg', kind: 'guest' }
		]);
	});
});
