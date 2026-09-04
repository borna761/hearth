import { describe, it, expect, vi } from 'vitest';
import { enrichMissingMetadata } from './enrich-music-metadata.mjs';

const FILE_PATH = '/mnt/nas/hearth/music/iconic/Queen - Bohemian Rhapsody.mp3';

function deps(overrides = {}) {
	return {
		readTags: vi.fn().mockReturnValue({
			artist: null,
			title: null,
			album: null,
			year: null,
			hasCoverArt: false
		}),
		writeTags: vi.fn().mockResolvedValue(true),
		search: vi.fn().mockResolvedValue(null),
		fetchCover: vi.fn().mockResolvedValue(null),
		...overrides
	};
}

describe('enrichMissingMetadata', () => {
	it('does nothing when every field is already present', async () => {
		const d = deps({
			readTags: vi.fn().mockReturnValue({
				artist: 'Queen',
				title: 'Bohemian Rhapsody',
				album: 'A Night at the Opera',
				year: '1975',
				hasCoverArt: true
			})
		});
		const result = await enrichMissingMetadata(FILE_PATH, d);
		expect(result).toEqual({ wrote: false, searched: false, coverArt: null });
		expect(d.search).not.toHaveBeenCalled();
		expect(d.writeTags).not.toHaveBeenCalled();
	});

	it('fills in artist/title from the filename without hitting MusicBrainz, when that is all that is missing', async () => {
		const d = deps({
			readTags: vi.fn().mockReturnValue({
				artist: null,
				title: null,
				album: 'A Night at the Opera',
				year: '1975',
				hasCoverArt: true
			})
		});
		const result = await enrichMissingMetadata(FILE_PATH, d);
		expect(d.search).not.toHaveBeenCalled();
		expect(result).toEqual({ wrote: true, searched: false, coverArt: null });
		expect(d.writeTags).toHaveBeenCalledWith(FILE_PATH, {
			artist: 'Queen',
			title: 'Bohemian Rhapsody'
		});
	});

	it('searches MusicBrainz, writes album/year as tags, and hands back raw cover art bytes to cache separately', async () => {
		const coverBytes = new Uint8Array([1, 2, 3]);
		const d = deps({
			search: vi.fn().mockResolvedValue({
				album: 'A Night at the Opera',
				year: '1975',
				mbid: 'mbid-1',
				releaseIds: ['mbid-1', 'mbid-2'],
				score: 0.95
			}),
			fetchCover: vi.fn().mockResolvedValue(coverBytes)
		});
		const result = await enrichMissingMetadata(FILE_PATH, d);
		expect(d.search).toHaveBeenCalledWith('Queen', 'Bohemian Rhapsody');
		expect(d.fetchCover).toHaveBeenCalledWith(['mbid-1', 'mbid-2']);
		expect(result.wrote).toBe(true);
		expect(result.coverArt).toBe(coverBytes);
		// Cover art is never embedded into the file's own ID3 tags — the caller writes it
		// straight to the covers cache instead, so the original mp3 is only ever touched
		// for plain text tags.
		expect(d.writeTags).toHaveBeenCalledWith(FILE_PATH, {
			artist: 'Queen',
			title: 'Bohemian Rhapsody',
			album: 'A Night at the Opera',
			year: '1975'
		});
	});

	it('still searches MusicBrainz for cover art alone, even when album/year are already known', async () => {
		const d = deps({
			readTags: vi.fn().mockReturnValue({
				artist: 'Queen',
				title: 'Bohemian Rhapsody',
				album: 'A Night at the Opera',
				year: '1975',
				hasCoverArt: false
			}),
			search: vi.fn().mockResolvedValue({
				album: 'X',
				year: '1975',
				mbid: 'mbid-1',
				releaseIds: ['mbid-1'],
				score: 0.95
			}),
			fetchCover: vi.fn().mockResolvedValue(new Uint8Array([1]))
		});
		const result = await enrichMissingMetadata(FILE_PATH, d);
		expect(d.search).toHaveBeenCalled();
		// Nothing to write as tags — artist/title/album/year were already all known.
		expect(d.writeTags).not.toHaveBeenCalled();
		expect(result.wrote).toBe(false);
		expect(result.coverArt).not.toBeNull();
	});

	it('leaves album/year/cover alone when MusicBrainz has no match, but still fills artist/title', async () => {
		const d = deps();
		const result = await enrichMissingMetadata(FILE_PATH, d);
		expect(result.wrote).toBe(true);
		expect(result.coverArt).toBeNull();
		expect(d.writeTags).toHaveBeenCalledWith(FILE_PATH, {
			artist: 'Queen',
			title: 'Bohemian Rhapsody'
		});
	});

	it('does nothing at all when nothing is missing and MusicBrainz would have nothing to add anyway', async () => {
		const d = deps({
			readTags: vi.fn().mockReturnValue({
				artist: 'Queen',
				title: 'Bohemian Rhapsody',
				album: null,
				year: null,
				hasCoverArt: true
			}),
			search: vi.fn().mockResolvedValue(null)
		});
		const result = await enrichMissingMetadata(FILE_PATH, d);
		expect(d.search).toHaveBeenCalled(); // album/year missing, so a lookup is still attempted
		expect(result).toEqual({ wrote: false, searched: true, coverArt: null });
		expect(d.writeTags).not.toHaveBeenCalled();
	});

	it('never overwrites a field that already has a value', async () => {
		const d = deps({
			readTags: vi.fn().mockReturnValue({
				artist: 'Queen (Remastered Credit)',
				title: 'Bohemian Rhapsody',
				album: null,
				year: null,
				hasCoverArt: false
			}),
			search: vi.fn().mockResolvedValue({
				album: 'A Night at the Opera',
				year: '1975',
				mbid: 'mbid-1',
				releaseIds: ['mbid-1'],
				score: 0.95
			})
		});
		const result = await enrichMissingMetadata(FILE_PATH, d);
		expect(result.wrote).toBe(true);
		const [, updates] = d.writeTags.mock.calls[0];
		expect(updates.artist).toBeUndefined();
	});

	it("doesn't cache cover art the fetch couldn't find", async () => {
		const d = deps({
			search: vi.fn().mockResolvedValue({
				album: 'X',
				year: '1975',
				mbid: 'mbid-1',
				releaseIds: ['mbid-1'],
				score: 0.95
			}),
			fetchCover: vi.fn().mockResolvedValue(null)
		});
		const result = await enrichMissingMetadata(FILE_PATH, d);
		expect(result.coverArt).toBeNull();
	});

	it('still hands back already-fetched cover art even if writing the text tags fails', async () => {
		const coverBytes = new Uint8Array([1, 2, 3]);
		const d = deps({
			search: vi.fn().mockResolvedValue({
				album: 'A Night at the Opera',
				year: '1975',
				mbid: 'mbid-1',
				releaseIds: ['mbid-1'],
				score: 0.95
			}),
			fetchCover: vi.fn().mockResolvedValue(coverBytes),
			writeTags: vi.fn().mockRejectedValue(new Error('NAS write failed'))
		});
		const result = await enrichMissingMetadata(FILE_PATH, d);
		expect(result.coverArt).toBe(coverBytes);
		// The write genuinely didn't happen — reported honestly as not written, so the
		// still-missing tags get retried on a later scan.
		expect(result.wrote).toBe(false);
	});
});
