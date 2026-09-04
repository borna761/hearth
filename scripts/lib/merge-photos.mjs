// Merges a `photos` table produced elsewhere (e.g. a one-time bulk resize run on another
// machine, against a local scratch database) into the live database — see
// scripts/merge-photos-table.mjs for why this exists and how it's used.
//
// Deliberately narrow: only touches the resize-derived columns (mtime, size, cached_path,
// width, height, orientation, blur_hash, taken_at, kind). shown_count/last_shown are real
// rotation history on the live row and must survive a merge untouched — this is a
// resize-pipeline sync, not a wholesale row replacement. New rows get those two columns'
// table defaults (0 / NULL), same as any other freshly-resized photo.

/**
 * @param {import('better-sqlite3').Database} targetDb open connection to the live database
 * @param {string} sourceDbPath path to the database file to merge from
 * @param {{
 *   rewriteCachePath?: { from: string, to: string },
 *   rewriteSourcePath?: { from: string, to: string }
 * }} [options] Both rewrite a path prefix during the merge — needed whenever the machine
 *   that ran the resize job mounted the NAS at a different local path than the Pi does
 *   (e.g. macOS can't mount anything at `/mnt` — its root filesystem is read-only — so a
 *   Mac-side run necessarily writes paths like `/Volumes/Public/...` into both columns).
 *   `rewriteSourcePath` matters even more than `rewriteCachePath`: source_path is the
 *   column ON CONFLICT matches rows on, so an unrewritten one doesn't just point the Pi's
 *   /api/photos/[id] route at the wrong path — it makes every merged row look brand new
 *   instead of updating the Pi's own existing row for that photo, AND makes the Pi's own
 *   next nightly diff walk fail to recognize any of these rows as already-processed
 *   (wrong local prefix versus what its own directory walk produces), reprocessing the
 *   whole library and pruning what this merge just added. Neither column's bytes move —
 *   this only corrects the strings stored in the database.
 * @returns {{ merged: number }}
 */
export function mergePhotosTable(targetDb, sourceDbPath, options = {}) {
	const { rewriteCachePath, rewriteSourcePath } = options;
	targetDb.prepare('ATTACH DATABASE ? AS src').run(sourceDbPath);
	try {
		const cachedPathExpr = rewriteCachePath
			? 'REPLACE(cached_path, @cacheRewriteFrom, @cacheRewriteTo)'
			: 'cached_path';
		const sourcePathExpr = rewriteSourcePath
			? 'REPLACE(source_path, @sourceRewriteFrom, @sourceRewriteTo)'
			: 'source_path';
		const result = targetDb
			.prepare(
				`
				INSERT INTO photos
					(source_path, mtime, size, cached_path, width, height, orientation, blur_hash, taken_at, kind)
				SELECT
					${sourcePathExpr}, mtime, size, ${cachedPathExpr}, width, height, orientation, blur_hash, taken_at, kind
				FROM src.photos
				WHERE 1=1 -- disambiguates INSERT...SELECT...ON CONFLICT for SQLite's parser;
				          -- without a trailing clause on the SELECT it can't tell whether
				          -- ON CONFLICT belongs to the SELECT or the INSERT, and errors.
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
			`
			)
			.run({
				cacheRewriteFrom: rewriteCachePath?.from ?? '',
				cacheRewriteTo: rewriteCachePath?.to ?? '',
				sourceRewriteFrom: rewriteSourcePath?.from ?? '',
				sourceRewriteTo: rewriteSourcePath?.to ?? ''
			});
		return { merged: result.changes };
	} finally {
		targetDb.prepare('DETACH DATABASE src').run();
	}
}
