// Fuzzy string matching for MusicBrainz search results (musicbrainz.mjs) — a title/artist
// parsed from a filename ("Artist - Title.mp3") rarely matches the canonical MusicBrainz
// spelling exactly (remaster tags, punctuation, capitalization), so an exact-match search
// would miss most real results. Levenshtein edit distance normalized by the longer
// string's length, not the original Python script's difflib.SequenceMatcher — a different
// algorithm, but the same 0 (unrelated) to 1 (identical) shape, case-insensitive.

function levenshteinDistance(a, b) {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const distances = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
	for (let j = 1; j < cols; j++) distances[0][j] = j;

	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			distances[i][j] = Math.min(
				distances[i - 1][j] + 1,
				distances[i][j - 1] + 1,
				distances[i - 1][j - 1] + cost
			);
		}
	}
	return distances[rows - 1][cols - 1];
}

/** @returns {number} 0 (unrelated) to 1 (identical), case-insensitive. */
export function similarity(a, b) {
	const left = a.toLowerCase();
	const right = b.toLowerCase();
	const maxLength = Math.max(left.length, right.length);
	if (maxLength === 0) return 1;
	return 1 - levenshteinDistance(left, right) / maxLength;
}
