// Shrinks an embedded cover picture (scripts/lib/music-cover.mjs's extractCoverArt) down
// to a small, consistent size before it's cached — the panel only ever displays it at a
// ~40-48px thumbnail, so serving whatever size a tagging tool happened to embed (a
// yt-dlp-embedded YouTube thumbnail can be 1280x720+) would waste NAS cache space and
// Pi-to-tablet bandwidth for detail nobody sees. 100px gives a bit of headroom over the
// display size for a slightly higher-DPI look without going far past it.

import sharp from 'sharp';

// DESIGN.md §6's same reasoning for photo-resize.mjs applies here: sharp's own operation
// cache otherwise accumulates memory across many sequential calls in one long-running
// scan, and this process may share a run with photo-resize.mjs's own settings — set
// unconditionally rather than assumed inherited.
sharp.cache(false);
sharp.concurrency(1);

const MAX_SIZE = 100;
const JPEG_QUALITY = 82;

/**
 * @param {Buffer} inputBuffer
 * @returns {Promise<{ buffer: Buffer, width: number, height: number }>}
 */
export async function resizeCoverArt(inputBuffer) {
	// 'inside' preserves aspect ratio (no cropping) — the panel's own <img class="object-
	// cover"> already crops to its square slot for display, so there's no need to bake a
	// crop decision into the cached file itself. withoutEnlargement skips upscaling art
	// that's already smaller than the target.
	const { data, info } = await sharp(inputBuffer)
		.resize({ width: MAX_SIZE, height: MAX_SIZE, fit: 'inside', withoutEnlargement: true })
		.jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
		.toBuffer({ resolveWithObject: true });

	return { buffer: data, width: info.width, height: info.height };
}
