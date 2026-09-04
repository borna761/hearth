import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	parseArtistTitle,
	stripFeaturingSuffix,
	primaryArtistName,
	searchRecording,
	fetchCoverArt,
	fetchCoverArtFromReleases,
	__resetRateLimiterForTests
} from './musicbrainz.mjs';

function fakeFetchJson(body, { status = 200 } = {}) {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body)
	});
}

// Rate limiting lives inside searchRecording itself now (musicbrainz.mjs) — every test
// below disables it (minRequestIntervalMs: 0) unless it's specifically testing the pacing
// itself, and resets the shared inter-request clock first so no test inherits timing left
// over from whatever ran before it in the same process.
beforeEach(() => {
	__resetRateLimiterForTests();
});

describe('parseArtistTitle', () => {
	it('splits "Artist - Title.mp3" on the first " - "', () => {
		expect(parseArtistTitle('Queen - Bohemian Rhapsody.mp3')).toEqual({
			artist: 'Queen',
			title: 'Bohemian Rhapsody'
		});
	});

	it('keeps everything after the first separator when the title itself contains " - "', () => {
		expect(parseArtistTitle('Artist - Title - Remix.mp3')).toEqual({
			artist: 'Artist',
			title: 'Title - Remix'
		});
	});

	it('falls back to Unknown artist when there is no separator', () => {
		expect(parseArtistTitle('JustATitle.mp3')).toEqual({ artist: 'Unknown', title: 'JustATitle' });
	});

	it('also splits on an en dash "–" — confirmed a real filename in the library uses one instead of a hyphen', () => {
		expect(parseArtistTitle('Queen – Bohemian Rhapsody.mp3')).toEqual({
			artist: 'Queen',
			title: 'Bohemian Rhapsody'
		});
	});

	it('also splits on an em dash "—"', () => {
		expect(parseArtistTitle('Queen — Bohemian Rhapsody.mp3')).toEqual({
			artist: 'Queen',
			title: 'Bohemian Rhapsody'
		});
	});
});

describe('stripFeaturingSuffix', () => {
	it('strips an unparenthesized "ft." credit', () => {
		expect(stripFeaturingSuffix('Danza Kuduro ft. Lucenzo')).toBe('Danza Kuduro');
	});

	it('strips an unparenthesized "feat." credit, case-insensitively', () => {
		expect(stripFeaturingSuffix("CAN'T HOLD US FEAT. RAY DALTON")).toBe("CAN'T HOLD US");
	});

	it('strips a parenthesized "(feat. X)" credit', () => {
		expect(stripFeaturingSuffix('Lose Control (feat. Ciara & Fat Man Scoop)')).toBe('Lose Control');
	});

	it('strips a parenthesized "(with X)" credit', () => {
		expect(stripFeaturingSuffix("Don't Go Breaking My Heart (with Kiki Dee)")).toBe(
			"Don't Go Breaking My Heart"
		);
	});

	it('leaves a bare, unparenthesized "with" alone — too common a real title word to strip blindly', () => {
		expect(stripFeaturingSuffix('Dancing With Myself')).toBe('Dancing With Myself');
	});

	it('leaves a parenthetical that has nothing to do with featuring credits alone', () => {
		expect(stripFeaturingSuffix('Sweet Dreams (Are Made Of This)')).toBe(
			'Sweet Dreams (Are Made Of This)'
		);
	});

	it("leaves a title containing 'feat' as a substring of a real word alone", () => {
		expect(stripFeaturingSuffix('Hooked On A Feeling')).toBe('Hooked On A Feeling');
	});

	it('leaves a title with no featuring credit at all unchanged', () => {
		expect(stripFeaturingSuffix('Bohemian Rhapsody')).toBe('Bohemian Rhapsody');
	});
});

describe('primaryArtistName', () => {
	it('takes the part before a comma', () => {
		expect(primaryArtistName('Alan Walker, Ava Max')).toBe('Alan Walker');
	});

	it('takes the part before the first comma when there are several artists', () => {
		expect(primaryArtistName('David Guetta, Teddy Swims, Tones and I')).toBe('David Guetta');
	});

	it('takes the part before an "&"', () => {
		expect(primaryArtistName('Tiësto & Ava Max')).toBe('Tiësto');
	});

	it('takes the part before a standalone "x"', () => {
		expect(primaryArtistName('Imagine Dragons x J.I.D')).toBe('Imagine Dragons');
	});

	it('leaves a single artist name with no separator unchanged', () => {
		expect(primaryArtistName('Queen')).toBe('Queen');
	});

	it('does not treat a bare "x" inside a word as a separator', () => {
		expect(primaryArtistName('Xzibit')).toBe('Xzibit');
	});

	it('does not treat a leading "X" as a separator when it is the whole artist name', () => {
		expect(primaryArtistName('X Ambassadors')).toBe('X Ambassadors');
	});

	it('does not treat a trailing "X" as a separator when it is the whole artist name', () => {
		expect(primaryArtistName('DJ X')).toBe('DJ X');
	});
});

describe('searchRecording', () => {
	it('queries with just the first credited artist for a multi-artist filename, but still scores against the full string', async () => {
		// Confirmed against the live API: MusicBrainz has no artist literally named "Alan
		// Walker, Ava Max" — a compound artist string used as the query's exact-phrase
		// artist filter returns zero results outright, even though the recording's own
		// artist-credit list correctly has "Alan Walker" and "Ava Max" as two separate
		// entries once a candidate is actually found.
		const fetchImpl = fakeFetchJson({
			recordings: [
				{
					title: 'FATE',
					'artist-credit': [{ artist: { name: 'Alan Walker' } }, { artist: { name: 'Ava Max' } }],
					releases: [{ title: 'Walkerworld', date: '2021', id: 'mbid-1' }]
				}
			]
		});
		const result = await searchRecording('Alan Walker, Ava Max', 'FATE', {
			fetchImpl,
			minRequestIntervalMs: 0
		});
		const [url] = fetchImpl.mock.calls[0];
		expect(decodeURIComponent(url.replace(/\+/g, ' '))).toContain('artist:"Alan Walker"');
		// A perfect title match plus a partial artist match (the full "Alan Walker, Ava
		// Max" string against each individual credit alone) clears the real 0.82 match
		// threshold comfortably, even without being a perfect 1.0 overall.
		expect(result).not.toBeNull();
		expect(result.score).toBeGreaterThan(0.82);
	});

	it('orders releases with the real studio album first, ahead of compilations/bootlegs/promos', async () => {
		// Real shape confirmed against the live API for "Seven Nation Army": the genuine
		// "Elephant" album release is Official/Album with no secondary-types, while the
		// generic hits packages are tagged Compilation and a bootleg/promo have their own
		// non-Official status — this is what actually distinguishes them.
		const fetchImpl = fakeFetchJson({
			recordings: [
				{
					title: 'Seven Nation Army',
					'artist-credit': [{ artist: { name: 'The White Stripes' } }],
					releases: [
						{
							title: 'Triple J: Hottest 100 of the Past 20 Years',
							date: '2013',
							id: 'mbid-bootleg',
							status: 'Bootleg',
							'release-group': { 'primary-type': 'Other', 'secondary-types': ['Compilation'] }
						},
						{
							title: 'The White Stripes Greatest Hits',
							date: '2020',
							id: 'mbid-compilation',
							status: 'Official',
							'release-group': { 'primary-type': 'Album', 'secondary-types': ['Compilation'] }
						},
						{
							title: 'Elephant',
							date: '2003-04-01',
							id: 'mbid-elephant',
							status: 'Official',
							'release-group': { 'primary-type': 'Album' }
						}
					]
				}
			]
		});
		const result = await searchRecording('The White Stripes', 'Seven Nation Army', {
			fetchImpl,
			minRequestIntervalMs: 0
		});
		expect(result.mbid).toBe('mbid-elephant');
		expect(result.album).toBe('Elephant');
		expect(result.releaseIds).toEqual(['mbid-elephant', 'mbid-compilation', 'mbid-bootleg']);
	});

	it('searches and scores using the title with any featuring credit stripped out', async () => {
		const fetchImpl = fakeFetchJson({
			recordings: [
				{
					title: 'Danza Kuduro',
					'artist-credit': [{ artist: { name: 'Don Omar' } }],
					releases: [{ title: 'Meet the Orphans', date: '2010', id: 'mbid-1' }]
				}
			]
		});
		const result = await searchRecording('Don Omar', 'Danza Kuduro ft. Lucenzo', {
			fetchImpl,
			minRequestIntervalMs: 0
		});
		const [url] = fetchImpl.mock.calls[0];
		expect(decodeURIComponent(url.replace(/\+/g, ' '))).toContain('recording:"Danza Kuduro"');
		expect(result.score).toBeGreaterThan(0.9);
	});

	it('returns the best-scoring match above the threshold', async () => {
		const fetchImpl = fakeFetchJson({
			recordings: [
				{
					title: 'Bohemian Rhapsody',
					'artist-credit': [{ artist: { name: 'Queen' } }],
					releases: [{ title: 'A Night at the Opera', date: '1975-11-21', id: 'mbid-1' }]
				},
				{
					title: 'Some Other Song',
					'artist-credit': [{ artist: { name: 'Someone Else' } }],
					releases: [{ title: 'Unrelated', date: '2001-01-01', id: 'mbid-2' }]
				}
			]
		});
		const result = await searchRecording('Queen', 'Bohemian Rhapsody', {
			fetchImpl,
			minRequestIntervalMs: 0
		});
		expect(result).toMatchObject({ album: 'A Night at the Opera', year: '1975', mbid: 'mbid-1' });
		expect(result.score).toBeGreaterThan(0.9);
	});

	it('prefers the recording with the most releases when several tie for the top score', async () => {
		// A well-known song typically has dozens of near-duplicate MusicBrainz "recording"
		// entries (one per obscure regional compilation it was also included on), each
		// scoring an identical exact-title-and-artist match — arbitrarily picking whichever
		// one the API happened to return first tends to land on an obscure one-release
		// entry instead of the canonical, widely-released recording.
		const fetchImpl = fakeFetchJson({
			recordings: [
				{
					title: 'Seven Nation Army',
					'artist-credit': [{ artist: { name: 'The White Stripes' } }],
					releases: [{ title: 'Some Obscure Compilation', date: '2006', id: 'mbid-obscure' }]
				},
				{
					title: 'Seven Nation Army',
					'artist-credit': [{ artist: { name: 'The White Stripes' } }],
					releases: [
						{ title: 'Elephant', date: '2003-04-01', id: 'mbid-elephant' },
						{ title: 'Greatest Hits', date: '2010', id: 'mbid-greatest-hits' }
					]
				}
			]
		});
		const result = await searchRecording('The White Stripes', 'Seven Nation Army', {
			fetchImpl,
			minRequestIntervalMs: 0
		});
		expect(result.mbid).toBe('mbid-elephant');
		expect(result.releaseIds).toEqual(['mbid-elephant', 'mbid-greatest-hits']);
	});

	it('fetches a large enough candidate pool for the release-count tie-break to have something to work with', async () => {
		const fetchImpl = fakeFetchJson({ recordings: [] });
		await searchRecording('The White Stripes', 'Seven Nation Army', {
			fetchImpl,
			minRequestIntervalMs: 0
		});
		const [url] = fetchImpl.mock.calls[0];
		const requestedLimit = Number(new URL(url).searchParams.get('limit'));
		expect(requestedLimit).toBeGreaterThanOrEqual(100);
	});

	it('lists every release for the best-matching recording, not just the first', async () => {
		const fetchImpl = fakeFetchJson({
			recordings: [
				{
					title: 'Bohemian Rhapsody',
					'artist-credit': [{ artist: { name: 'Queen' } }],
					releases: [
						{ title: 'A Compilation', date: '2001', id: 'mbid-compilation' },
						{ title: 'A Night at the Opera', date: '1975-11-21', id: 'mbid-original' }
					]
				}
			]
		});
		const result = await searchRecording('Queen', 'Bohemian Rhapsody', {
			fetchImpl,
			minRequestIntervalMs: 0
		});
		expect(result.releaseIds).toEqual(['mbid-compilation', 'mbid-original']);
	});

	it('retries once on a 503, then succeeds on the retry', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) })
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () =>
					Promise.resolve({
						recordings: [
							{
								title: 'Bohemian Rhapsody',
								'artist-credit': [{ artist: { name: 'Queen' } }],
								releases: [{ title: 'A Night at the Opera', date: '1975', id: 'mbid-1' }]
							}
						]
					})
			});
		const result = await searchRecording('Queen', 'Bohemian Rhapsody', {
			fetchImpl,
			minRequestIntervalMs: 0,
			sleepImpl: vi.fn().mockResolvedValue(undefined)
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({ album: 'A Night at the Opera', mbid: 'mbid-1' });
	});

	it("gives up (doesn't retry a second time) after two consecutive 503s", async () => {
		const fetchImpl = fakeFetchJson({}, { status: 503 });
		const result = await searchRecording('Queen', 'Bohemian Rhapsody', {
			fetchImpl,
			minRequestIntervalMs: 0,
			sleepImpl: vi.fn().mockResolvedValue(undefined)
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(result).toBeNull();
	});

	it('retries once on a thrown network error/timeout too, not just a 503', async () => {
		// A bigger candidate pool (limit=100) means a bigger response for a popular song —
		// confirmed in practice that some well-known tracks still failed after the limit
		// bump despite scoring well above threshold when tried again moments later,
		// consistent with an occasional timeout rather than every failure being a 503.
		const fetchImpl = vi
			.fn()
			.mockRejectedValueOnce(new Error('timed out'))
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () =>
					Promise.resolve({
						recordings: [
							{
								title: 'Bohemian Rhapsody',
								'artist-credit': [{ artist: { name: 'Queen' } }],
								releases: [{ title: 'A Night at the Opera', date: '1975', id: 'mbid-1' }]
							}
						]
					})
			});
		const result = await searchRecording('Queen', 'Bohemian Rhapsody', {
			fetchImpl,
			minRequestIntervalMs: 0,
			sleepImpl: vi.fn().mockResolvedValue(undefined)
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({ mbid: 'mbid-1' });
	});

	it('gives up after a second consecutive thrown error, returning null rather than throwing', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error('timed out'));
		const result = await searchRecording('Queen', 'Bohemian Rhapsody', {
			fetchImpl,
			minRequestIntervalMs: 0,
			sleepImpl: vi.fn().mockResolvedValue(undefined)
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(result).toBeNull();
	});

	it('returns null when nothing scores above the threshold', async () => {
		const fetchImpl = fakeFetchJson({
			recordings: [
				{
					title: 'Completely Unrelated',
					'artist-credit': [{ artist: { name: 'Nobody' } }],
					releases: [{ title: 'X', date: '2001', id: 'mbid-3' }]
				}
			]
		});
		const result = await searchRecording('Queen', 'Bohemian Rhapsody', {
			fetchImpl,
			minRequestIntervalMs: 0
		});
		expect(result).toBeNull();
	});

	it('returns null when the search has no results', async () => {
		const fetchImpl = fakeFetchJson({ recordings: [] });
		const result = await searchRecording('Queen', 'Bohemian Rhapsody', {
			fetchImpl,
			minRequestIntervalMs: 0
		});
		expect(result).toBeNull();
	});

	it('returns null (not throw) when the request fails', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
		const result = await searchRecording('Queen', 'Bohemian Rhapsody', {
			fetchImpl,
			minRequestIntervalMs: 0
		});
		expect(result).toBeNull();
	});

	it('returns null (not throw) on a non-OK response', async () => {
		const fetchImpl = fakeFetchJson({}, { status: 503 });
		const result = await searchRecording('Queen', 'Bohemian Rhapsody', {
			fetchImpl,
			minRequestIntervalMs: 0
		});
		expect(result).toBeNull();
	});

	it('returns null when the best match has no releases to pull an album/year from', async () => {
		const fetchImpl = fakeFetchJson({
			recordings: [
				{
					title: 'Bohemian Rhapsody',
					'artist-credit': [{ artist: { name: 'Queen' } }],
					releases: []
				}
			]
		});
		const result = await searchRecording('Queen', 'Bohemian Rhapsody', {
			fetchImpl,
			minRequestIntervalMs: 0
		});
		expect(result).toBeNull();
	});

	it('spaces consecutive requests by at least minRequestIntervalMs, regardless of caller', async () => {
		vi.useFakeTimers();
		try {
			const fetchImpl = fakeFetchJson({ recordings: [] });
			const sleepImpl = vi.fn().mockImplementation((ms) => new Promise((r) => setTimeout(r, ms)));

			const first = searchRecording('Queen', 'Bohemian Rhapsody', {
				fetchImpl,
				minRequestIntervalMs: 1000,
				sleepImpl
			});
			await vi.runAllTimersAsync();
			await first;
			expect(sleepImpl).not.toHaveBeenCalled(); // nothing to wait for yet

			const second = searchRecording('Queen', 'Another Song', {
				fetchImpl,
				minRequestIntervalMs: 1000,
				sleepImpl
			});
			await vi.runAllTimersAsync();
			await second;
			// Back-to-back calls with no real time elapsed between them — the second one
			// must have waited close to the full interval, not fired immediately.
			expect(sleepImpl).toHaveBeenCalledOnce();
			expect(sleepImpl.mock.calls[0][0]).toBeGreaterThan(900);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('fetchCoverArt', () => {
	it('downloads the front cover image bytes for a release mbid', async () => {
		const imageBytes = new Uint8Array([1, 2, 3]);
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						images: [
							{ front: false, image: 'http://example/back.jpg' },
							{ front: true, image: 'http://example/front.jpg' }
						]
					})
			})
			.mockResolvedValueOnce({
				ok: true,
				arrayBuffer: () => Promise.resolve(imageBytes.buffer)
			});

		const result = await fetchCoverArt('mbid-1', { fetchImpl });
		expect(fetchImpl).toHaveBeenLastCalledWith('http://example/front.jpg', expect.anything());
		expect(Buffer.from(result)).toEqual(Buffer.from(imageBytes));
	});

	it('returns null when there is no front-cover image', async () => {
		const fetchImpl = fakeFetchJson({
			images: [{ front: false, image: 'http://example/back.jpg' }]
		});
		expect(await fetchCoverArt('mbid-1', { fetchImpl })).toBeNull();
	});

	it('returns null for a null mbid without making a request', async () => {
		const fetchImpl = vi.fn();
		expect(await fetchCoverArt(null, { fetchImpl })).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('returns null (not throw) when the release has no cover art at all (404)', async () => {
		const fetchImpl = fakeFetchJson({}, { status: 404 });
		expect(await fetchCoverArt('mbid-1', { fetchImpl })).toBeNull();
	});

	it('retries once on a 503 from the release lookup, then succeeds', async () => {
		const imageBytes = new Uint8Array([1, 2, 3]);
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) })
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () =>
					Promise.resolve({ images: [{ front: true, image: 'http://example/front.jpg' }] })
			})
			.mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(imageBytes.buffer) });

		const result = await fetchCoverArt('mbid-1', {
			fetchImpl,
			sleepImpl: vi.fn().mockResolvedValue(undefined)
		});
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(Buffer.from(result)).toEqual(Buffer.from(imageBytes));
	});
});

describe('fetchCoverArtFromReleases', () => {
	it('tries each release in order, returning the first one with cover art', async () => {
		const imageBytes = new Uint8Array([9, 9, 9]);
		const fetchImpl = vi.fn().mockImplementation((url) => {
			if (url.includes('release/mbid-no-art')) {
				return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
			}
			if (url.includes('release/mbid-has-art')) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({ images: [{ front: true, image: 'http://example/front.jpg' }] })
				});
			}
			return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(imageBytes.buffer) });
		});

		const result = await fetchCoverArtFromReleases(['mbid-no-art', 'mbid-has-art'], { fetchImpl });
		expect(Buffer.from(result)).toEqual(Buffer.from(imageBytes));
	});

	it('returns null when none of the releases have cover art', async () => {
		const fetchImpl = fakeFetchJson({}, { status: 404 });
		const result = await fetchCoverArtFromReleases(['mbid-1', 'mbid-2'], { fetchImpl });
		expect(result).toBeNull();
	});

	it('returns null for an empty release list', async () => {
		const fetchImpl = vi.fn();
		expect(await fetchCoverArtFromReleases([], { fetchImpl })).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
