#!/usr/bin/env node
// Nightly photo resize job — DESIGN.md §6. Run by hearth-resize.timer at 03:00, inside the
// tablet's quiet hours (deploy/hearth-resize.*). Split into its own process/systemd unit
// rather than running in-process: libvips works in off-heap memory invisible to Node's own
// --max-old-space-size, so isolating it means an overrun restarts a batch job at 03:00,
// not the wall display someone might be looking at.
//
// Plain better-sqlite3, no drizzle import — same reasoning as scripts/migrate.mjs and
// scripts/seed-users.mjs: plain `node` can't import the TypeScript schema module.
//
// Also runnable on demand for local dev: `npm run photos:resize`. On the Pi, prefer
// `sudo systemctl start hearth-resize.service` over running this directly — only that path
// gets the unit's MemoryMax/CPUWeight/IOWeight caps and survives an SSH disconnect (a bare
// `node`/`npm run` in a foreground SSH session dies to SIGHUP the instant the connection
// drops, mid-run, with no trace of why).

import Database from 'better-sqlite3';
import { readdir, readFile, writeFile, copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { diffPhotos } from './lib/photo-diff.mjs';
import { resizePhoto } from './lib/photo-resize.mjs';
import { extractTakenAt } from './lib/photo-metadata.mjs';

const DATABASE_URL = process.env.DATABASE_URL ?? '/var/lib/hearth/hearth.db';
const PHOTOS_DIR = process.env.HEARTH_PHOTOS_DIR ?? '/mnt/nas/hearth/pictures';
// Guest-appropriate photos (DESIGN.md §5/§6) — a sibling of PHOTOS_DIR, same tree-walk
// tolerance, scanned into the same `photos` table with kind: 'guest' so one pipeline
// covers both; distinguished only by which directory a file came from.
const GUEST_PHOTOS_DIR = process.env.HEARTH_GUEST_PHOTOS_DIR ?? '/mnt/nas/hearth/guest-pictures';
const CACHE_DIR = process.env.HEARTH_PHOTOS_CACHE_DIR ?? '/mnt/nas/hearth/cache';
const FALLBACK_DIR = process.env.HEARTH_PHOTOS_FALLBACK_DIR ?? '/var/lib/hearth/fallback';
const FALLBACK_KEEP = Number(process.env.HEARTH_PHOTOS_FALLBACK_KEEP ?? 30);

// Written before every file is attempted, on the NAS (not the SD card — DESIGN.md §3.4's
// wear concern) so it survives a crash that takes the whole process down. journald is
// configured volatile for the same SD-card reason, so it's useless for diagnosing a run
// that died with no further explanation — this file is the actual record. A run that dies
// mid-file leaves this pointed at exactly the photo that was being processed when it did,
// rather than nothing at all.
const PROGRESS_FILE = path.join(CACHE_DIR, '.resize-progress.json');

function currentRssMb() {
	return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

async function writeProgress(data) {
	await writeFile(
		PROGRESS_FILE,
		JSON.stringify(
			{ ...data, rssMb: currentRssMb(), pid: process.pid, at: new Date().toISOString() },
			null,
			2
		)
	).catch(() => {
		// The progress file is a diagnostic aid, not load-bearing — a write failure here
		// must not take down the actual resize work.
	});
}

// DESIGN.md §6: "the library is all JPEG, confirmed... If HEIC ever enters the library the
// pipeline will silently skip those files — worth a log line rather than a silent drop."
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg']);

async function walk(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walk(full)));
		} else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
			files.push(full);
		} else {
			console.log(`[resize] skipping non-JPEG file: ${full}`);
		}
	}
	return files;
}

/** A flat, collision-safe cache filename derived from the source path — avoids mirroring
 * the NAS's directory structure into cache/, and two files with the same basename in
 * different folders can't collide. Deterministic, so reprocessing an updated photo
 * overwrites the same derivative rather than accumulating orphans. */
function cachedPathFor(sourcePath) {
	const hash = createHash('sha1').update(sourcePath).digest('hex').slice(0, 16);
	return path.join(CACHE_DIR, `${hash}.jpg`);
}

/**
 * Walks, diffs, resizes/upserts, and prunes one NAS source directory against the rows in
 * `photos` tagged with its `kind` — the family and guest libraries never see or prune
 * each other's rows, since the diff/prune queries below are both scoped to `kind`.
 */
async function processSource(db, dir, kind) {
	console.log(`[resize] walking ${dir} (${kind})`);
	let filePaths;
	try {
		filePaths = await walk(dir);
	} catch (err) {
		// Only tolerated for the guest directory — it's optional (Picsum covers guest mode
		// until it's created, screensaverPublisher.ts's own fallback), unlike PHOTOS_DIR,
		// whose absence should surface as loudly as it always has.
		if (kind === 'guest' && err.code === 'ENOENT') {
			console.log(`[resize] ${dir} doesn't exist yet — skipping guest photos this run`);
			return;
		}
		throw err;
	}

	const walked = [];
	for (const filePath of filePaths) {
		const stats = await stat(filePath);
		walked.push({ path: filePath, mtime: stats.mtimeMs, size: stats.size });
	}

	const existing = db
		.prepare('SELECT source_path, mtime, size FROM photos WHERE kind = ?')
		.all(kind)
		.map((row) => ({ sourcePath: row.source_path, mtime: row.mtime, size: row.size }));

	const { toProcess, toPrune } = diffPhotos(walked, existing);
	console.log(
		`[resize] ${kind}: ${walked.length} files on disk, ${toProcess.length} to process, ${toPrune.length} to prune`
	);

	const upsert = db.prepare(`
		INSERT INTO photos (source_path, mtime, size, cached_path, width, height, orientation, blur_hash, taken_at, kind)
		VALUES (@sourcePath, @mtime, @size, @cachedPath, @width, @height, @orientation, @blurHash, @takenAt, @kind)
		ON CONFLICT(source_path) DO UPDATE SET
			mtime = excluded.mtime,
			size = excluded.size,
			cached_path = excluded.cached_path,
			width = excluded.width,
			height = excluded.height,
			orientation = excluded.orientation,
			blur_hash = excluded.blur_hash,
			taken_at = excluded.taken_at,
			kind = excluded.kind
	`);

	for (const [index, sourcePath] of toProcess.entries()) {
		await writeProgress({ status: 'processing', kind, index, total: toProcess.length, sourcePath });
		try {
			const stats = walked.find((f) => f.path === sourcePath);
			const input = await readFile(sourcePath);
			const resized = await resizePhoto(input);
			const takenAt = await extractTakenAt(input, new Date(stats.mtime));
			const cachedPath = cachedPathFor(sourcePath);

			await writeFile(cachedPath, resized.buffer);

			upsert.run({
				sourcePath,
				mtime: stats.mtime,
				size: stats.size,
				cachedPath,
				width: resized.width,
				height: resized.height,
				orientation: resized.orientation,
				blurHash: resized.blurHash,
				takenAt: takenAt.getTime(),
				kind
			});
			console.log(
				`[resize] processed ${sourcePath} -> ${resized.orientation} ${resized.width}x${resized.height}` +
					` (${index + 1}/${toProcess.length}, ${currentRssMb()}MB RSS)`
			);
		} catch (err) {
			// One bad file (corrupt JPEG, an unreadable permission) must not take the whole
			// nightly job down — log it and keep going through the rest of the library.
			console.warn(
				`[resize] failed to process ${sourcePath}:`,
				err instanceof Error ? err.message : err
			);
		}
	}

	await writeProgress({ status: 'idle' });

	if (toPrune.length > 0) {
		const del = db.prepare('DELETE FROM photos WHERE source_path = ? AND kind = ?');
		const selectCached = db.prepare(
			'SELECT cached_path FROM photos WHERE source_path = ? AND kind = ?'
		);
		for (const sourcePath of toPrune) {
			const row = selectCached.get(sourcePath, kind);
			del.run(sourcePath, kind);
			if (row?.cached_path) {
				await unlink(row.cached_path).catch(() => {});
			}
		}
		console.log(`[resize] pruned ${toPrune.length} removed ${kind} files`);
	}
}

async function main() {
	await mkdir(CACHE_DIR, { recursive: true });
	await mkdir(FALLBACK_DIR, { recursive: true });

	const db = new Database(DATABASE_URL);
	db.pragma('foreign_keys = ON');

	await processSource(db, PHOTOS_DIR, 'family');
	await processSource(db, GUEST_PHOTOS_DIR, 'guest');

	// Refresh the fallback ring — DESIGN.md §6: keep the most recently shown derivatives
	// locally so the screensaver still works if the NAS goes away. Ordering is meaningless
	// until milestone 5 starts updating last_shown from real display events (every row is
	// NULL until then) — harmless either way, and this is ready for when that lands.
	const existingFallback = new Set(await readdir(FALLBACK_DIR).catch(() => []));
	const keepRows = db
		.prepare('SELECT cached_path FROM photos ORDER BY last_shown DESC LIMIT ?')
		.all(FALLBACK_KEEP);
	const keepNames = new Set();
	for (const row of keepRows) {
		const name = path.basename(row.cached_path);
		keepNames.add(name);
		if (!existingFallback.has(name)) {
			await copyFile(row.cached_path, path.join(FALLBACK_DIR, name)).catch((err) => {
				console.warn(`[resize] failed to refresh fallback for ${name}:`, err.message);
			});
		}
	}
	for (const name of existingFallback) {
		if (!keepNames.has(name)) {
			await unlink(path.join(FALLBACK_DIR, name)).catch(() => {});
		}
	}

	db.close();
	console.log('[resize] done');
}

main().catch((err) => {
	console.error('[resize] fatal:', err);
	process.exitCode = 1;
});
