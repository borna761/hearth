// Per-photo resize logic — DESIGN.md §6. Runs as part of the nightly resize job
// (scripts/resize-photos.mjs), but kept separate and pure-ish (input buffer in, derivative
// buffer + metadata out) so it's directly unit-testable against synthetic images.

import sharp from 'sharp';
import { encode } from 'blurhash';

// DESIGN.md §6: "single-threaded, sharp.concurrency(1), sharp.cache(false)". Global,
// process-wide settings — sharp's own operation cache otherwise accumulates memory across
// many sequential resizePhoto() calls in one long-running process, which is exactly what
// the nightly job does over a library of hundreds of photos. Set once at module load,
// here rather than in resize-photos.mjs, so it applies regardless of what imports this.
sharp.cache(false);
sharp.concurrency(1);

const LANDSCAPE_WIDTH = 1280;
const LANDSCAPE_HEIGHT = 800;
const PORTRAIT_WIDTH = 640;
const PORTRAIT_HEIGHT = 800;
const JPEG_QUALITY = 82;
// blurhash's own recommended component counts for a reasonable detail/size tradeoff.
const BLURHASH_COMPONENTS_X = 4;
const BLURHASH_COMPONENTS_Y = 4;

/**
 * @param {Buffer} inputBuffer
 * @returns {Promise<{
 *   buffer: Buffer,
 *   width: number,
 *   height: number,
 *   orientation: 'landscape' | 'portrait',
 *   blurHash: string
 * }>}
 */
export async function resizePhoto(inputBuffer) {
	// Apply the EXIF orientation and measure the ROTATED dimensions before deciding
	// anything — a sharp pipeline's own .metadata() still reports the pre-rotation,
	// EXIF-tagged dimensions even after .rotate() is chained (verified directly against
	// sharp's actual behavior, not assumed); only the processed output's `info` reflects
	// the true rotated size. This is the specific bug DESIGN.md §6 calls out: a phone
	// portrait stores landscape pixels tagged orientation 6, and measuring before rotation
	// would misclassify it as landscape.
	const { data: rotatedBuffer, info: rotatedInfo } = await sharp(inputBuffer)
		.rotate()
		.jpeg()
		.toBuffer({ resolveWithObject: true });

	// Square counts as landscape (DESIGN.md §8's schema comment).
	const orientation = rotatedInfo.width >= rotatedInfo.height ? 'landscape' : 'portrait';

	const resizeOptions =
		orientation === 'landscape'
			? { width: LANDSCAPE_WIDTH, height: LANDSCAPE_HEIGHT, fit: 'cover' }
			: { width: PORTRAIT_WIDTH, height: PORTRAIT_HEIGHT, fit: 'inside' };

	const { data: resizedBuffer, info: resizedInfo } = await sharp(rotatedBuffer)
		.resize(resizeOptions)
		.jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
		.toBuffer({ resolveWithObject: true });

	// blurhash needs raw pixel data, not an encoded JPEG.
	const { data: rawPixels, info: rawInfo } = await sharp(resizedBuffer)
		.raw()
		.ensureAlpha()
		.toBuffer({ resolveWithObject: true });
	const blurHash = encode(
		new Uint8ClampedArray(rawPixels),
		rawInfo.width,
		rawInfo.height,
		BLURHASH_COMPONENTS_X,
		BLURHASH_COMPONENTS_Y
	);

	return {
		buffer: resizedBuffer,
		width: resizedInfo.width,
		height: resizedInfo.height,
		orientation,
		blurHash
	};
}
