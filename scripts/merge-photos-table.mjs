#!/usr/bin/env node
// One-time helper: merges a `photos` table produced elsewhere (e.g. a bulk resize run on
// another machine, against a local scratch database — see DESIGN.md §6/§2.1 for why the
// Pi Zero 2 W can struggle with a large first-run backfill) into the live database.
//
// Deliberately NOT for routine use: the live database must not be written to over a
// network mount (DESIGN.md §3.5 — SQLite's locking doesn't work reliably over CIFS/NFS),
// so this script only ever runs against a local file, on the same machine that holds it —
// in practice, that means scp-ing the source .db here first, then running this on the Pi.
//
// Plain better-sqlite3, no drizzle import — same reasoning as every other scripts/*.mjs
// entry point: plain `node` can't import the TypeScript schema module.
//
// SOURCE_PHOTOS_DIR and SOURCE_PHOTOS_CACHE_DIR, if set, are rewritten to
// HEARTH_PHOTOS_DIR/HEARTH_PHOTOS_CACHE_DIR (the Pi's own defaults if unset) in every
// merged source_path/cached_path — needed whenever the machine that ran the resize job
// mounted the NAS at a different local path than the Pi does. macOS in particular can't
// mount anything at /mnt at all (its root filesystem is read-only), so a Mac-side run
// necessarily used some other local path. Rewriting source_path matters even more than
// cached_path: it's what ON CONFLICT matches rows on, so an unrewritten one makes every
// merged row look brand new (rather than updating the Pi's matching row) and makes the
// Pi's own next nightly diff fail to recognize any of them, reprocessing the whole
// library and pruning what this merge just added.
//
// Usage: SOURCE_PHOTOS_DIR=/Volumes/Public/hearth/pictures \
//        SOURCE_PHOTOS_CACHE_DIR=/Volumes/Public/hearth/cache \
//        node scripts/merge-photos-table.mjs /path/to/source.db

import Database from 'better-sqlite3';
import { mergePhotosTable } from './lib/merge-photos.mjs';

const DATABASE_URL = process.env.DATABASE_URL ?? '/var/lib/hearth/hearth.db';
const PHOTOS_DIR = process.env.HEARTH_PHOTOS_DIR ?? '/mnt/nas/hearth/pictures';
const CACHE_DIR = process.env.HEARTH_PHOTOS_CACHE_DIR ?? '/mnt/nas/hearth/cache';
const SOURCE_PHOTOS_DIR = process.env.SOURCE_PHOTOS_DIR;
const SOURCE_CACHE_DIR = process.env.SOURCE_PHOTOS_CACHE_DIR;
const sourceDbPath = process.argv[2];

if (!sourceDbPath) {
	console.error('Usage: node scripts/merge-photos-table.mjs /path/to/source.db');
	process.exitCode = 1;
} else {
	const targetDb = new Database(DATABASE_URL);
	targetDb.pragma('foreign_keys = ON');

	const rewriteSourcePath = SOURCE_PHOTOS_DIR
		? { from: SOURCE_PHOTOS_DIR, to: PHOTOS_DIR }
		: undefined;
	const rewriteCachePath = SOURCE_CACHE_DIR ? { from: SOURCE_CACHE_DIR, to: CACHE_DIR } : undefined;
	if (rewriteSourcePath) {
		console.log(`[merge-photos] rewriting source_path: ${SOURCE_PHOTOS_DIR} -> ${PHOTOS_DIR}`);
	}
	if (rewriteCachePath) {
		console.log(`[merge-photos] rewriting cached_path: ${SOURCE_CACHE_DIR} -> ${CACHE_DIR}`);
	}

	const before = targetDb.prepare('SELECT COUNT(*) AS n FROM photos').get().n;
	const { merged } = mergePhotosTable(targetDb, sourceDbPath, {
		rewriteSourcePath,
		rewriteCachePath
	});
	const after = targetDb.prepare('SELECT COUNT(*) AS n FROM photos').get().n;

	console.log(
		`[merge-photos] ${merged} row(s) inserted or updated from ${sourceDbPath} ` +
			`(${before} -> ${after} total rows in ${DATABASE_URL})`
	);

	targetDb.close();
}
