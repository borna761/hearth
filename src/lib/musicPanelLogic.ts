// Pure decision logic pulled out of MusicPanel.svelte so it's testable without a
// component-testing setup — same reasoning musicProgress.ts already follows for the
// progress bar's interpolation math.

/** Whether the panel should jump straight to the songs of the folder that's already
 *  playing, instead of showing the top-level folder list — only while still on that
 *  default folder list (a user who's already navigated elsewhere keeps their own
 *  navigation) and only when something is actually playing. */
export function shouldAutoOpenPlayingFolder(params: {
	view: 'folders' | 'songs' | 'speakers';
	playingFolderId: number | null;
}): boolean {
	return params.view === 'folders' && params.playingFolderId !== null;
}

/** Whether the folder currently being browsed is the one already playing — if so, which
 *  speaker to use is already known, so picking a song doesn't need to ask again. */
export function isPlayingSelectedFolder(params: {
	selectedFolderId: number | null;
	playingFolderId: number | null;
	playingSpeakerId: number | null;
}): boolean {
	return (
		params.selectedFolderId !== null &&
		params.selectedFolderId === params.playingFolderId &&
		params.playingSpeakerId !== null
	);
}
