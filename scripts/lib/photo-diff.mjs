// Diffs a NAS directory walk against the photos table's existing rows — DESIGN.md §6:
// "Walk the mounted share; diff against the photos table on (path, mtime, size)." Only
// files that are new or have genuinely changed get (re)processed; rows with no matching
// file left on disk are reported for pruning.

/**
 * @param {Array<{path: string, mtime: number, size: number}>} walked
 * @param {Array<{sourcePath: string, mtime: number, size: number}>} existing
 * @returns {{ toProcess: string[], toPrune: string[] }}
 */
export function diffPhotos(walked, existing) {
	const existingByPath = new Map(existing.map((row) => [row.sourcePath, row]));
	const walkedPaths = new Set(walked.map((file) => file.path));

	const toProcess = walked
		.filter((file) => {
			const row = existingByPath.get(file.path);
			return !row || row.mtime !== file.mtime || row.size !== file.size;
		})
		.map((file) => file.path);

	const toPrune = existing
		.filter((row) => !walkedPaths.has(row.sourcePath))
		.map((row) => row.sourcePath);

	return { toProcess, toPrune };
}
