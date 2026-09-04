#!/usr/bin/env node
// Nightly music-library scan — docs/phase-7-music-plan.md. Mirrors resize-photos.mjs's
// walk-and-diff shape — the original NAS path is the servable path for the audio itself
// (no resize/derivative step for that), and the app never touches the NAS filesystem at
// request time, same separation as photos. A track's cover art is cached the same way
// resize-photos.mjs caches its resized JPEGs — either found already embedded in the mp3's
// own ID3 tag, or, if there was none, fetched fresh from MusicBrainz/the Cover Art Archive
// (enrich-music-metadata.mjs) and cached directly without ever touching the original file.
// Artist/title/album/year *do* get filled in on the file itself (never overwritten) when
// missing, since those are only useful there — Hearth doesn't read them from anywhere but
// the filename.
//
// One level of folder under HEARTH_MUSIC_DIR is one playlist; the audio files directly
// inside it are that playlist's tracks. Reuses diffPhotos from photo-diff.mjs as-is
// rather than duplicating it — its (path, mtime, size) diff logic has nothing
// photo-specific about it.
//
// Plain better-sqlite3, no drizzle import — same reasoning as every other scripts/*.mjs:
// plain `node` can't import the TypeScript schema module.
//
// Also runnable on demand: `npm run music:scan`.

import Database from 'better-sqlite3';
import { readdir, readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { diffPhotos } from './lib/photo-diff.mjs';
import { extractCoverArt } from './lib/music-cover.mjs';
import { resizeCoverArt } from './lib/music-cover-resize.mjs';
import { enrichMissingMetadata } from './lib/enrich-music-metadata.mjs';

const DATABASE_URL = process.env.DATABASE_URL ?? '/var/lib/hearth/hearth.db';
const MUSIC_DIR = process.env.HEARTH_MUSIC_DIR ?? '/mnt/nas/hearth/music';
const COVERS_DIR = process.env.HEARTH_MUSIC_COVERS_DIR ?? '/mnt/nas/hearth/cache/music-covers';

const AUDIO_EXTENSIONS = new Set(['.mp3']);

function titleFromFilename(filePath) {
	return path.basename(filePath, path.extname(filePath));
}

/** Same flat, collision-safe naming as resize-photos.mjs's cachedPathFor — reprocessing a
 *  track overwrites the same derivative rather than accumulating orphans. Always .jpg —
 *  resizeCoverArt re-encodes to JPEG regardless of the embedded picture's original format.
 *
 *  Hashes the path *relative to MUSIC_DIR*, not the full absolute sourcePath — the Mac's
 *  HEARTH_MUSIC_DIR (/Volumes/Public/...) and the Pi's (/mnt/nas/...) are two different
 *  mount points for the same NAS share, so hashing the full path would give the same
 *  logical track two different, unrelated cache filenames depending on which machine
 *  scanned it — silently doubling up cover files on the shared covers cache for no reason. */
function coverPathFor(sourcePath) {
	const relativePath = path.relative(MUSIC_DIR, sourcePath);
	const hash = createHash('sha1').update(relativePath).digest('hex').slice(0, 16);
	return path.join(COVERS_DIR, `${hash}.jpg`);
}

async function walk() {
	const topEntries = await readdir(MUSIC_DIR, { withFileTypes: true }).catch((err) => {
		if (err.code === 'ENOENT') return [];
		throw err;
	});
	const folders = [];
	for (const entry of topEntries) {
		if (!entry.isDirectory()) continue;
		const folderAbsPath = path.join(MUSIC_DIR, entry.name);
		const fileEntries = await readdir(folderAbsPath, { withFileTypes: true });
		const tracks = [];
		for (const fileEntry of fileEntries) {
			if (!fileEntry.isFile()) continue;
			const filePath = path.join(folderAbsPath, fileEntry.name);
			if (!AUDIO_EXTENSIONS.has(path.extname(fileEntry.name).toLowerCase())) {
				console.log(`[music] skipping non-audio file: ${filePath}`);
				continue;
			}
			const stats = await stat(filePath);
			tracks.push({ path: filePath, mtime: stats.mtimeMs, size: stats.size });
		}
		folders.push({ folderPath: entry.name, tracks });
	}
	return folders;
}

async function main() {
	const db = new Database(DATABASE_URL);
	db.pragma('foreign_keys = ON');

	await mkdir(COVERS_DIR, { recursive: true });

	console.log(`[music] walking ${MUSIC_DIR}`);
	const folders = await walk();

	const folderUpsert = db.prepare(`
		INSERT INTO music_folders (display_name, folder_path) VALUES (@displayName, @folderPath)
		ON CONFLICT(folder_path) DO UPDATE SET display_name = excluded.display_name
	`);
	const selectFolderId = db.prepare('SELECT id FROM music_folders WHERE folder_path = ?');
	const folderIdByPath = new Map();
	for (const folder of folders) {
		folderUpsert.run({ displayName: folder.folderPath, folderPath: folder.folderPath });
		folderIdByPath.set(folder.folderPath, selectFolderId.get(folder.folderPath).id);
	}

	// Prune folders no longer on disk — cascades to their tracks (music_tracks.folder_id
	// has ON DELETE CASCADE). The cascade only removes the DB rows, so each track's cached
	// cover file has to be unlinked explicitly first — the per-track prune loop below can't
	// do it, since a folder that's gone entirely never appears in `folders` for that loop
	// to run over.
	const discoveredPaths = new Set(folders.map((f) => f.folderPath));
	const foldersToDelete = db
		.prepare('SELECT id, folder_path FROM music_folders')
		.all()
		.filter((row) => !discoveredPaths.has(row.folder_path));
	if (foldersToDelete.length > 0) {
		const selectCoverPathsForFolder = db.prepare(
			'SELECT cover_path FROM music_tracks WHERE folder_id = ? AND cover_path IS NOT NULL'
		);
		const deleteFolder = db.prepare('DELETE FROM music_folders WHERE id = ?');
		for (const row of foldersToDelete) {
			for (const { cover_path: coverPath } of selectCoverPathsForFolder.all(row.id)) {
				await unlink(coverPath).catch(() => {});
			}
			deleteFolder.run(row.id);
		}
		console.log(`[music] pruned ${foldersToDelete.length} removed folder(s)`);
	}

	const trackUpsert = db.prepare(`
		INSERT INTO music_tracks (folder_id, source_path, mtime, size, title, cover_path)
		VALUES (@folderId, @sourcePath, @mtime, @size, @title, @coverPath)
		ON CONFLICT(source_path) DO UPDATE SET
			mtime = excluded.mtime, size = excluded.size, title = excluded.title,
			folder_id = excluded.folder_id, cover_path = excluded.cover_path
	`);
	const selectCoverPath = db.prepare('SELECT cover_path FROM music_tracks WHERE source_path = ?');
	const deleteTrack = db.prepare('DELETE FROM music_tracks WHERE source_path = ?');

	let totalProcessed = 0;
	let totalPruned = 0;
	for (const folder of folders) {
		const folderId = folderIdByPath.get(folder.folderPath);
		const walked = folder.tracks.map((t) => ({ path: t.path, mtime: t.mtime, size: t.size }));
		const existingRows = db
			.prepare('SELECT source_path, mtime, size, cover_path FROM music_tracks WHERE folder_id = ?')
			.all(folderId);
		const existing = existingRows.map((row) => ({
			sourcePath: row.source_path,
			mtime: row.mtime,
			size: row.size
		}));

		const { toProcess: newOrChanged, toPrune } = diffPhotos(walked, existing);

		// A transient MusicBrainz/Cover Art Archive failure during a track's one-time
		// initial scan would otherwise leave it stuck forever — diffPhotos only reprocesses
		// files that are new or have changed, and once a track has *any* row (cover_path
		// null or not), its file never changes again on its own. Retrying every still-
		// uncovered track on every run (unattended, nightly, no one to manually nudge it
		// the way local testing did) means a bad night eventually self-heals rather than
		// requiring intervention.
		const walkedPaths = new Set(walked.map((f) => f.path));
		const stillMissingCover = existingRows
			.filter((row) => row.cover_path === null && walkedPaths.has(row.source_path))
			.map((row) => row.source_path);
		const toProcess = [...new Set([...newOrChanged, ...stillMissingCover])];
		for (const filePath of toProcess) {
			// Raw (unresized) cover bytes fetched fresh from MusicBrainz, if enrichment
			// needed to — takes priority below over re-extracting from the file, since a
			// freshly-fetched cover was never written into the file in the first place.
			let coverBytes = null;
			let wroteTags = false;
			try {
				// Rate-limiting for MusicBrainz's usage policy happens inside
				// enrichMissingMetadata/searchRecording itself, not here — it's a property
				// of talking to MusicBrainz at all, not of this particular loop.
				const result = await enrichMissingMetadata(filePath);
				coverBytes = result.coverArt;
				wroteTags = result.wrote;
			} catch (err) {
				// A lookup failure (MusicBrainz/Cover Art Archive unreachable, a malformed
				// tag) must not take the whole nightly job down — the track still gets
				// scanned in with whatever metadata it already had.
				console.warn(
					`[music] failed to enrich metadata for ${filePath}:`,
					err instanceof Error ? err.message : err
				);
			}

			// Only re-stat when enrichment actually rewrote the file's tags — that's the
			// only thing that could have changed its mtime/size since the pre-loop `walked`
			// entry was captured. Storing stale (pre-write) values here would make the file
			// look "changed" again on every future scan, triggering a repeat MusicBrainz
			// lookup for it forever; re-statting unconditionally would just be an extra NAS
			// round-trip for the common case where nothing was written at all.
			const walkedEntry = walked.find((f) => f.path === filePath);
			let stats = { mtimeMs: walkedEntry.mtime, size: walkedEntry.size };
			if (wroteTags) {
				try {
					const fresh = await stat(filePath);
					stats = { mtimeMs: fresh.mtimeMs, size: fresh.size };
				} catch {
					// File vanished mid-run — fall back to what we already knew about it.
				}
			}

			let coverPath = null;
			try {
				// Only read the file's own embedded art if nothing was already fetched
				// above — a fresh MusicBrainz cover never gets embedded into the file, so
				// there'd be nothing new to find there anyway (see
				// enrich-music-metadata.mjs).
				if (!coverBytes) {
					const buffer = await readFile(filePath);
					coverBytes = (await extractCoverArt(buffer))?.data ?? null;
				}
				if (coverBytes) {
					const resized = await resizeCoverArt(coverBytes);
					coverPath = coverPathFor(filePath);
					await writeFile(coverPath, resized.buffer);
				}
			} catch (err) {
				// A stray unreadable file must not take the whole nightly job down — the
				// track still gets scanned in (with title/duration), just without artwork.
				console.warn(
					`[music] failed to extract cover art from ${filePath}:`,
					err instanceof Error ? err.message : err
				);
			}
			trackUpsert.run({
				folderId,
				sourcePath: filePath,
				mtime: stats.mtimeMs,
				size: stats.size,
				title: titleFromFilename(filePath),
				coverPath
			});
			totalProcessed++;
		}
		for (const sourcePath of toPrune) {
			const existingCoverPath = selectCoverPath.get(sourcePath)?.cover_path;
			if (existingCoverPath) await unlink(existingCoverPath).catch(() => {});
			deleteTrack.run(sourcePath);
			totalPruned++;
		}
	}

	console.log(
		`[music] ${folders.length} folder(s), ${totalProcessed} track(s) processed, ${totalPruned} pruned`
	);
	db.close();
	console.log('[music] done');
}

main().catch((err) => {
	console.error('[music] fatal:', err);
	process.exitCode = 1;
});
