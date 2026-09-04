// Orchestrates the pieces (music-tag-writer.mjs, musicbrainz.mjs) into the actual
// "fill in whatever this track is missing" decision scan-music.mjs calls per track.
// Deliberately only ever fills gaps — never overwrites a tag that already has a value —
// per Alex's ask: an existing artist/album/year (hand-corrected, or from wherever these
// files originally came from) is trusted over a fuzzy MusicBrainz match.
//
// Artist/title always come from the filename (same source scan-music.mjs's own
// titleFromFilename uses for the DB's title column) rather than MusicBrainz's returned
// artist-credit name — no network call needed for those two fields at all. Album/year/
// cover art do need a MusicBrainz lookup, but only one is ever made per track (`search` is
// shared for whichever of the three are missing, since fetching cover art requires the
// same release id a plain album/year lookup would already need).
//
// Cover art is handed back as raw bytes rather than embedded into the file's own ID3 tags
// — scan-music.mjs writes it straight to the covers cache (the only place Hearth itself
// ever reads cover art from), same as art already embedded by someone else. That keeps
// the one genuinely irreversible part of this feature (a wrong match writing a stranger's
// image somewhere permanent) out of the original file entirely; only plain text tags ever
// get written there.
//
// Cover art is tried across every release MusicBrainz lists for the matched recording
// (fetchCoverArtFromReleases), not just the one release album/year come from — confirmed
// in practice against real data that the first release is often some various-artists
// compilation with nothing on the Cover Art Archive, even when a later release (frequently
// the artist's own original album) has real art. Album/year themselves always describe the
// first release regardless of which one the cover ends up coming from — a minor, low-stakes
// inconsistency traded for not needing to re-derive album/year from whichever release the
// image search happened to land on.

import path from 'node:path';
import { readExistingTags, applyMissingTags } from './music-tag-writer.mjs';
import { parseArtistTitle, searchRecording, fetchCoverArtFromReleases } from './musicbrainz.mjs';

/**
 * @param {string} filePath
 * @param {{
 *   readTags?: typeof readExistingTags,
 *   writeTags?: typeof applyMissingTags,
 *   parseFilename?: typeof parseArtistTitle,
 *   search?: typeof searchRecording,
 *   fetchCover?: typeof fetchCoverArtFromReleases
 * }} [deps]
 * @returns {Promise<{ wrote: boolean, searched: boolean, coverArt: ArrayBuffer | Uint8Array | null }>}
 *   `wrote` is whether artist/title/album/year tags were written to the file. `searched`
 *   tells the caller whether a MusicBrainz request was actually made, so it knows whether
 *   this track needs the rate-limit delay before moving on to the next one — most tracks,
 *   once already enriched, need no network call at all. `coverArt` is raw (unresized)
 *   cover bytes for the caller to cache, or null if none was needed/found.
 */
export async function enrichMissingMetadata(filePath, deps = {}) {
	const {
		readTags = readExistingTags,
		writeTags = applyMissingTags,
		parseFilename = parseArtistTitle,
		search = searchRecording,
		fetchCover = fetchCoverArtFromReleases
	} = deps;

	const existing = readTags(filePath);
	const { artist, title } = parseFilename(path.basename(filePath));

	const tagUpdates = {};
	if (!existing.artist) tagUpdates.artist = artist;
	if (!existing.title) tagUpdates.title = title;

	const needsAlbumOrYear = !existing.album || !existing.year;
	const needsCover = !existing.hasCoverArt;
	let searched = false;
	let coverArt = null;

	if (needsAlbumOrYear || needsCover) {
		searched = true;
		const match = await search(artist, title);
		if (match) {
			if (!existing.album) tagUpdates.album = match.album;
			if (!existing.year && match.year) tagUpdates.year = match.year;
			// Tries every release for this recording, not just the one album/year came
			// from — the first release is frequently a compilation with nothing on the
			// Cover Art Archive, even when a later one (often the original studio album)
			// has real art.
			if (needsCover) coverArt = await fetchCover(match.releaseIds);
		}
	}

	// A tag-write failure (NAS permission blip, contention) must not throw away cover art
	// already fetched above — caught locally rather than left to propagate, so the caller
	// still gets it back to cache. The unwritten tags just get retried on the next scan,
	// since existing.artist/title/etc. are still unset on disk either way.
	let wrote = false;
	if (Object.keys(tagUpdates).length > 0) {
		try {
			await writeTags(filePath, tagUpdates);
			wrote = true;
		} catch {
			// Swallowed — see comment above.
		}
	}

	return { wrote, searched, coverArt };
}
