import { describe, it, expect } from 'vitest';
import { shouldAutoOpenPlayingFolder, isPlayingSelectedFolder } from './musicPanelLogic';

describe('shouldAutoOpenPlayingFolder', () => {
	it('opens the playing folder when still on the default folder list', () => {
		expect(shouldAutoOpenPlayingFolder({ view: 'folders', playingFolderId: 1 })).toBe(true);
	});

	it('does nothing when nothing is playing', () => {
		expect(shouldAutoOpenPlayingFolder({ view: 'folders', playingFolderId: null })).toBe(false);
	});

	it("doesn't override navigation the user already made", () => {
		expect(shouldAutoOpenPlayingFolder({ view: 'songs', playingFolderId: 1 })).toBe(false);
		expect(shouldAutoOpenPlayingFolder({ view: 'speakers', playingFolderId: 1 })).toBe(false);
	});
});

describe('isPlayingSelectedFolder', () => {
	it('is true when browsing the folder that is playing on a known speaker', () => {
		expect(
			isPlayingSelectedFolder({ selectedFolderId: 1, playingFolderId: 1, playingSpeakerId: 2 })
		).toBe(true);
	});

	it('is false when nothing is selected yet', () => {
		expect(
			isPlayingSelectedFolder({ selectedFolderId: null, playingFolderId: 1, playingSpeakerId: 2 })
		).toBe(false);
	});

	it('is false when browsing a different folder than the one playing', () => {
		expect(
			isPlayingSelectedFolder({ selectedFolderId: 1, playingFolderId: 2, playingSpeakerId: 2 })
		).toBe(false);
	});

	it('is false when nothing is playing', () => {
		expect(
			isPlayingSelectedFolder({
				selectedFolderId: 1,
				playingFolderId: null,
				playingSpeakerId: null
			})
		).toBe(false);
	});

	it('is false when the playing speaker is unknown', () => {
		expect(
			isPlayingSelectedFolder({ selectedFolderId: 1, playingFolderId: 1, playingSpeakerId: null })
		).toBe(false);
	});
});
