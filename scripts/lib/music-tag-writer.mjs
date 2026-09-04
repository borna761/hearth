// Reads/writes ID3 tags via node-id3 (pure JS, no native bindings — same reasoning
// hash-wasm replaced @node-rs/argon2 for this Pi). Accepts either a Buffer or a filepath
// string, since node-id3 itself does — enrich-music-metadata.mjs uses filepaths against
// real NAS files, tests use in-memory buffers so no temp files are needed.

import NodeID3 from 'node-id3';

/**
 * @param {Buffer | string} input
 * @returns {{ artist: string | null, title: string | null, album: string | null, year: string | null, hasCoverArt: boolean }}
 */
export function readExistingTags(input) {
	const tags = NodeID3.read(input) || {};
	return {
		artist: tags.artist || null,
		title: tags.title || null,
		album: tags.album || null,
		year: tags.year || null,
		hasCoverArt: Boolean(tags.image)
	};
}

/**
 * Only ever adds fields present in `updates` — node-id3's `update` (as opposed to
 * `create`/`write`) merges onto whatever tags already exist rather than replacing them,
 * which is what lets enrich-music-metadata.mjs pass only the fields it found missing.
 * Text tags only — cover art is deliberately never embedded here (see
 * enrich-music-metadata.mjs's own comment): it's cached straight to Hearth's own covers
 * folder instead, so a wrong MusicBrainz match can't permanently rewrite the original file.
 * @param {Buffer | string} input
 * @param {{ artist?: string, title?: string, album?: string, year?: string }} updates
 */
export async function applyMissingTags(input, updates) {
	const tags = {};
	if (updates.artist !== undefined) tags.artist = updates.artist;
	if (updates.title !== undefined) tags.title = updates.title;
	if (updates.album !== undefined) tags.album = updates.album;
	if (updates.year !== undefined) tags.year = updates.year;
	return NodeID3.Promise.update(tags, input);
}
