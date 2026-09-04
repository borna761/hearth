// Fisher-Yates, injectable random source for determinism in tests — shared between
// photos.ts's slide rotation and the music play route's shuffle-by-default ordering.
export function shuffle<T>(items: T[], randomSource: () => number): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(randomSource() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

/** Builds a playback queue that starts on a specific track and shuffles the rest — the
 *  "pick a song, then keep shuffling" flow. `startId: null` (or an id no longer in
 *  `items`, e.g. the track was removed from the NAS between listing and playing) falls
 *  back to shuffling the whole list, same as the folder's existing shuffle-all play. */
export function orderForPlayback<T extends { id: number }>(
	items: T[],
	startId: number | null,
	randomSource: () => number
): T[] {
	const startItem = startId === null ? undefined : items.find((item) => item.id === startId);
	if (!startItem) return shuffle(items, randomSource);
	const rest = items.filter((item) => item.id !== startId);
	return [startItem, ...shuffle(rest, randomSource)];
}
