// Pulls an embedded cover image (ID3v2 APIC frame) out of an mp3's bytes, for
// scan-music.mjs to cache alongside the track — same "read the file, hand back a
// derivative" shape as photo-metadata.mjs's extractTakenAt, just for artwork instead of a
// capture date.

import { parseBuffer, selectCover } from 'music-metadata';

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ data: Buffer, format: string } | null>}
 */
export async function extractCoverArt(buffer) {
	try {
		const metadata = await parseBuffer(buffer, 'audio/mpeg');
		const cover = selectCover(metadata.common.picture);
		if (!cover) return null;
		return { data: Buffer.from(cover.data), format: cover.format };
	} catch {
		// A malformed/truncated tag, or no tag at all — realistic for a stray file in a
		// bulk-imported library, and one bad file must not take the whole nightly scan down.
		return null;
	}
}
