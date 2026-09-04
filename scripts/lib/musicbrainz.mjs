// Looks up missing album/year/cover-art for a track by artist+title, against MusicBrainz
// (recording metadata) and the Cover Art Archive (front cover images by release id) — the
// two public, no-auth-required APIs behind Alex's original Python script. `fetchImpl` is
// injectable (this codebase's own convention for network calls — see
// googleCast/discovery.ts's resolveSpeakerHost) so tests never hit the real network.
//
// Only ever supplements metadata a track is missing (enrich-music-metadata.mjs decides
// what's missing and calls this) — never re-fetches or overwrites what's already tagged.

import { similarity } from './similarity.mjs';

const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2';
const COVER_ART_ARCHIVE_API = 'https://coverartarchive.org';
// Identifies this client to MusicBrainz, as their usage policy requires — an unidentified
// or generic User-Agent gets rate-limited more aggressively than an identified one.
const USER_AGENT = 'Hearth/1.0 (alex@example.com)';
const REQUEST_TIMEOUT_MS = 10_000;
// A 503 (temporary overload/throttling — confirmed happening in practice against the real
// API, not just theoretical) gets one retry after a short pause; anything else (a real
// network error, a 404, a malformed response) is treated as final, same as before.
const RETRY_DELAY_MS = 2000;

// Raised well above the original script's 0.6 — Alex's ask, trading fewer matches for
// fewer wrong ones. A wrong match doesn't just mislabel a song; it embeds a stranger's
// album art directly into the file, which the original script's cover-provenance had no
// way to catch or undo later.
const MIN_MATCH_SCORE = 0.82;

// MusicBrainz's max page size, and worth actually using: a well-known song typically has
// dozens of near-duplicate "recording" entries (MusicBrainz treats each release's specific
// taping as its own recording, so a hit covered/compiled onto 60+ albums can have 60+
// separate recording entries, most attached to just one obscure release each). With a
// small limit, the canonical widely-released recording — confirmed in practice for "Seven
// Nation Army": among 64 total candidates, one had 62 releases attached, but it wasn't
// anywhere in the first 10 MusicBrainz's own relevance ranking returned — may never even
// be seen, regardless of any tie-breaking done on the results actually fetched.
const MAX_CANDIDATES = 100;

// MusicBrainz's usage policy asks for no more than ~1 request/second per client. Lives
// here (module-scope, applied inside searchRecording itself) rather than in
// scan-music.mjs's loop — policy compliance for talking to MusicBrainz at all shouldn't
// depend on every caller separately remembering to pace itself. `lastRequestAt` is shared
// process-wide state, same shape as googleCast/playbackSession.ts's own `current` session
// singleton.
const MIN_REQUEST_INTERVAL_MS = 1100;
let lastRequestAt = 0;

function defaultSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRateLimit(minIntervalMs, sleepImpl) {
	const elapsed = Date.now() - lastRequestAt;
	if (elapsed < minIntervalMs) await sleepImpl(minIntervalMs - elapsed);
	lastRequestAt = Date.now();
}

/** Test-only: resets the shared inter-request pacing state so a test doesn't inherit
 *  timing left over from whatever ran before it in the same process. */
export function __resetRateLimiterForTests() {
	lastRequestAt = 0;
}

function withTimeout(fetchImpl, url, options = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	return fetchImpl(url, { ...options, signal: controller.signal }).finally(() =>
		clearTimeout(timer)
	);
}

/** One retry on a 503 or a thrown network error/timeout, after a short pause — a genuine
 *  404 or other non-503 response is returned as-is for the caller to handle. The thrown-
 *  error retry matters as much as the 503 one in practice: a larger candidate pool
 *  (MAX_CANDIDATES) means a bigger response for a popular search, and some tracks that
 *  scored well above threshold when tried again moments later had failed with what was
 *  presumably an occasional timeout, not every failure being a 503. A second failure
 *  (of either kind) propagates/returns as before — only one retry, not unbounded. */
async function fetchWithRetry(fetchImpl, url, options, sleepImpl) {
	let response;
	try {
		response = await withTimeout(fetchImpl, url, options);
	} catch {
		await sleepImpl(RETRY_DELAY_MS);
		response = await withTimeout(fetchImpl, url, options);
	}
	if (response.status === 503) {
		await sleepImpl(RETRY_DELAY_MS);
		response = await withTimeout(fetchImpl, url, options);
	}
	return response;
}

// A hyphen, en dash, or em dash — confirmed a real file in the library ("Queen –
// Bohemian Rhapsody.mp3") uses an en dash instead of a plain hyphen, which a plain
// `indexOf(' - ')` would never find, silently falling back to "Unknown" for the artist
// and searching MusicBrainz with the whole "Artist – Title" string as the title.
const SEPARATOR_PATTERN = / [-–—] /;

/**
 * "Artist - Title.mp3" -> {artist, title}. Only "Unknown" if there's truly no separator —
 * matches scan-music.mjs's own titleFromFilename fallback for a file that doesn't follow
 * the convention.
 * @param {string} filename
 */
export function parseArtistTitle(filename) {
	const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
	const match = nameWithoutExt.match(SEPARATOR_PATTERN);
	if (!match) return { artist: 'Unknown', title: nameWithoutExt };
	return {
		artist: nameWithoutExt.slice(0, match.index).trim(),
		title: nameWithoutExt.slice(match.index + match[0].length).trim()
	};
}

/**
 * Drops a trailing featuring/collaboration credit from a title before it's used to query
 * or score against MusicBrainz — confirmed in practice that a filename title like "Danza
 * Kuduro ft. Lucenzo" finds nothing at all, while the bare "Danza Kuduro" finds a perfect
 * match with 100+ releases: MusicBrainz's own canonical recording titles are almost always
 * the bare title, with collaborators recorded separately as additional artist credits, not
 * baked into the title text the way a downloaded filename often has it.
 *
 * Deliberately conservative about "with": stripped only inside parentheses (Elton John,
 * Kiki Dee's "Don't Go Breaking My Heart (with Kiki Dee)"), never as a bare suffix — "with"
 * is too common an ordinary title word ("Dancing With Myself") to treat as a collab marker
 * on its own the way "ft."/"feat."/"featuring" safely can be.
 * @param {string} title
 */
export function stripFeaturingSuffix(title) {
	return title
		.replace(/\s*[([]\s*(?:feat\.?|featuring|ft\.?|with)\b.*$/i, '')
		.replace(/\s+(?:feat\.?|featuring|ft\.?)\b.*$/i, '')
		.trim();
}

/**
 * Lower is better. Confirmed against real data for "Seven Nation Army": the genuine
 * "Elephant" album release is `status: "Official"` with `release-group.primary-type:
 * "Album"` and no `secondary-types`, while generic "Greatest Hits"/decade-compilation
 * releases carry `secondary-types: ["Compilation"]`, and stray bootlegs/radio-promo
 * releases have a non-"Official" status entirely. Without this, cover art ends up coming
 * from whichever release happens to have Cover Art Archive art at all — usually some
 * generic compilation, since original albums and random compilations are about equally
 * likely to have art uploaded, but there are far more compilations to land on by chance.
 */
function releaseQualityRank(release) {
	const isOfficial = release.status === 'Official';
	const secondaryTypes = release['release-group']?.['secondary-types'] ?? [];
	const isCompilationLike = secondaryTypes.length > 0;
	const primaryType = release['release-group']?.['primary-type'];
	const isAlbumOrSingle =
		primaryType === 'Album' || primaryType === 'Single' || primaryType === 'EP';

	if (isOfficial && isAlbumOrSingle && !isCompilationLike) return 0;
	if (isOfficial && !isCompilationLike) return 1;
	if (isOfficial) return 2;
	return 3;
}

// Comma, "&", or a standalone "x" (word boundaries, so "Xzibit" isn't split) — the common
// filename conventions for crediting a collaboration, none of which MusicBrainz recognizes
// as a literal artist name.
const MULTI_ARTIST_SEPARATOR = /\s*(?:,|&|\bx\b)\s*/i;

/**
 * Just the first credited artist from a "Artist1, Artist2" / "Artist1 & Artist2" /
 * "Artist1 x Artist2" filename credit — confirmed against the live API that MusicBrainz
 * has no artist literally named "Alan Walker, Ava Max"; used as the query's exact-phrase
 * `artist:` filter, a compound multi-artist string returns zero results outright, even
 * though the recording's own artist-credit list correctly has each artist as a separate
 * entry once a candidate is actually found (searchRecording still scores against the full,
 * unsplit artist string once results come back — only the query needs the narrower name).
 * @param {string} artist
 */
export function primaryArtistName(artist) {
	const separatorMatch = artist.match(MULTI_ARTIST_SEPARATOR);
	// A real separator has an artist name on both sides of it — a match with nothing
	// before or after it (e.g. the standalone "X" in "X Ambassadors" or "DJ X") is that
	// artist's own name, not a multi-artist credit.
	if (
		!separatorMatch ||
		separatorMatch.index === 0 ||
		separatorMatch.index + separatorMatch[0].length === artist.length
	) {
		return artist;
	}
	return artist.slice(0, separatorMatch.index).trim();
}

function scoreRecording(recording, artist, title) {
	const titleScore = similarity(title, recording.title ?? '');
	let artistScore = 0;
	for (const credit of recording['artist-credit'] ?? []) {
		artistScore = Math.max(artistScore, similarity(artist, credit.artist?.name ?? ''));
	}
	// Same 0.7/0.3 title-favoring weighting as the original script.
	return titleScore * 0.7 + artistScore * 0.3;
}

/**
 * @param {string} artist
 * @param {string} title
 * @param {{ fetchImpl?: typeof fetch, minScore?: number, minRequestIntervalMs?: number, sleepImpl?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<{ album: string, year: string, mbid: string, releaseIds: string[], score: number } | null>}
 *   `releaseIds` lists every release MusicBrainz has for the best-matching recording (same
 *   order as returned) — `album`/`year`/`mbid` describe just the first one, but a caller
 *   fetching cover art should try all of them via fetchCoverArtFromReleases: the first
 *   release is often a compilation with no image on the Cover Art Archive even when a
 *   later one (frequently the original studio album) has it.
 */
export async function searchRecording(artist, title, options = {}) {
	const {
		fetchImpl = fetch,
		minScore = MIN_MATCH_SCORE,
		minRequestIntervalMs = MIN_REQUEST_INTERVAL_MS,
		sleepImpl = defaultSleep
	} = options;
	await waitForRateLimit(minRequestIntervalMs, sleepImpl);
	// A filename-derived title often carries a "ft. X"/"feat. X" credit that MusicBrainz's
	// own canonical recording titles almost never do — cleaned once here so both the query
	// and the similarity scoring below use the same, more-likely-to-match title.
	const cleanedTitle = stripFeaturingSuffix(title);
	// The query's artist: filter needs just the first credited artist for a multi-artist
	// filename (MusicBrainz has no artist literally named the whole compound string) —
	// scoring below still uses the full, unsplit `artist` against every individual credit.
	const query = `artist:"${primaryArtistName(artist)}" AND recording:"${cleanedTitle}"`;
	const url = `${MUSICBRAINZ_API}/recording?${new URLSearchParams({ query, fmt: 'json', limit: String(MAX_CANDIDATES) })}`;

	let response;
	try {
		response = await fetchWithRetry(
			fetchImpl,
			url,
			{ headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
			sleepImpl
		);
	} catch {
		return null; // Network error, timeout — a lookup failing must not break the scan.
	}
	if (!response.ok) return null;

	const data = await response.json().catch(() => null);
	const recordings = data?.recordings ?? [];

	// Collect every recording tied for the best similarity score, not just whichever one
	// happens to come first — an exact-title-and-artist match is common among a hit song's
	// many near-duplicate recording entries, and MusicBrainz's own result ordering has no
	// relation to which one is the canonical, widely-released recording.
	let tiedForBest = [];
	let bestScore = 0;
	for (const recording of recordings) {
		const score = scoreRecording(recording, artist, cleanedTitle);
		if (score > bestScore) {
			bestScore = score;
			tiedForBest = [recording];
		} else if (score === bestScore) {
			tiedForBest.push(recording);
		}
	}
	if (tiedForBest.length === 0 || bestScore < minScore) return null;

	// Among tied candidates, prefer whichever has the most releases attached — a strong
	// proxy for "the canonical recording" (confirmed in practice: a hit's real single/album
	// recording had 62 releases where every other candidate had only 1-2), and therefore
	// far more likely to actually have art on the Cover Art Archive.
	const best = tiedForBest.reduce((a, b) =>
		(b.releases?.length ?? 0) > (a.releases?.length ?? 0) ? b : a
	);

	// Real studio albums/singles first, generic compilations and bootlegs/promos last —
	// both which release album/year describe and which order fetchCoverArtFromReleases
	// tries them in.
	const rankedReleases = [...(best.releases ?? [])].sort(
		(a, b) => releaseQualityRank(a) - releaseQualityRank(b)
	);
	const releaseIds = rankedReleases.map((release) => release.id).filter(Boolean);
	const release = rankedReleases[0];
	if (!release) return null;

	return {
		album: release.title ?? 'Unknown',
		year: release.date ? release.date.slice(0, 4) : '',
		mbid: release.id ?? '',
		releaseIds,
		score: bestScore
	};
}

/**
 * @param {string | null} mbid
 * @param {{ fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<ArrayBuffer | null>}
 */
export async function fetchCoverArt(mbid, options = {}) {
	if (!mbid) return null;
	const { fetchImpl = fetch, sleepImpl = defaultSleep } = options;

	let listResponse;
	try {
		listResponse = await fetchWithRetry(
			fetchImpl,
			`${COVER_ART_ARCHIVE_API}/release/${mbid}`,
			{ headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
			sleepImpl
		);
	} catch {
		return null;
	}
	if (!listResponse.ok) return null;

	const data = await listResponse.json().catch(() => null);
	const front = data?.images?.find((image) => image.front);
	if (!front?.image) return null;

	try {
		const imageResponse = await fetchWithRetry(
			fetchImpl,
			front.image,
			{ headers: { 'User-Agent': USER_AGENT } },
			sleepImpl
		);
		if (!imageResponse.ok) return null;
		return await imageResponse.arrayBuffer();
	} catch {
		return null;
	}
}

/**
 * Tries each release's cover art in turn, returning the first one found — the best-scoring
 * recording's *first* release (what album/year come from) is often a various-artists
 * compilation with nothing on the Cover Art Archive, even when a later release (frequently
 * the artist's own original album) has real art.
 * @param {string[]} releaseIds
 * @param {{ fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<ArrayBuffer | null>}
 */
export async function fetchCoverArtFromReleases(releaseIds, options = {}) {
	for (const releaseId of releaseIds) {
		const art = await fetchCoverArt(releaseId, options);
		if (art) return art;
	}
	return null;
}
