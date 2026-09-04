const DEFAULT_KEEP = 14; // DESIGN.md §3.5: 14 nightly backups kept on the NAS

/**
 * Given the backups currently on disk, returns the names of the ones to delete —
 * everything except the `keep` most recently modified.
 *
 * @param {{ name: string, mtimeMs: number }[]} entries
 * @param {number} [keep]
 * @returns {string[]}
 */
export function selectBackupsToPrune(entries, keep = DEFAULT_KEEP) {
	return [...entries]
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(keep)
		.map((entry) => entry.name)
		.sort();
}
