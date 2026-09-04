import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { resizePhoto } from './photo-resize.mjs';

/** A synthetic solid-color JPEG — no real photo needed, sharp can generate one in-process. */
async function syntheticJpeg(width, height, orientation) {
	let pipeline = sharp({
		create: { width, height, channels: 3, background: { r: 120, g: 80, b: 200 } }
	}).jpeg();
	if (orientation) pipeline = pipeline.withMetadata({ orientation });
	return pipeline.toBuffer();
}

describe('resizePhoto', () => {
	it('covers a landscape photo to the panel resolution (DESIGN.md §6)', async () => {
		const input = await syntheticJpeg(3000, 2000);
		const result = await resizePhoto(input);
		expect(result.orientation).toBe('landscape');
		expect(result.width).toBe(1280);
		expect(result.height).toBe(800);
	});

	it('fits a portrait photo inside 640x800 without cropping', async () => {
		const input = await syntheticJpeg(2000, 3000);
		const result = await resizePhoto(input);
		expect(result.orientation).toBe('portrait');
		// 'inside' fit preserves aspect ratio, so it won't be exactly 640x800 unless the
		// source aspect ratio happens to match — it must fit within, and at least one
		// dimension should hit its bound.
		expect(result.width).toBeLessThanOrEqual(640);
		expect(result.height).toBeLessThanOrEqual(800);
		expect(result.height).toBe(800); // this source is taller-than-4:5, so height is the binding side
	});

	it('treats a square photo as landscape, matching the schema comment', async () => {
		const input = await syntheticJpeg(1000, 1000);
		const result = await resizePhoto(input);
		expect(result.orientation).toBe('landscape');
	});

	it('classifies orientation from the ROTATED dimensions, not the raw stored ones', async () => {
		// A phone held in portrait writes landscape pixels (1200x900) tagged EXIF
		// orientation 6 ('rotate 90 CW') — the exact bug DESIGN.md §6 calls out: measuring
		// before rotation would see 1200x900 and misclassify this as landscape.
		const input = await syntheticJpeg(1200, 900, 6);
		const result = await resizePhoto(input);
		expect(result.orientation).toBe('portrait');
		expect(result.width).toBeLessThanOrEqual(640);
		expect(result.height).toBeLessThanOrEqual(800);
	});

	it('produces a valid JPEG buffer', async () => {
		const input = await syntheticJpeg(1600, 1000);
		const result = await resizePhoto(input);
		const meta = await sharp(result.buffer).metadata();
		expect(meta.format).toBe('jpeg');
	});

	it('produces a non-empty blurhash', async () => {
		const input = await syntheticJpeg(1600, 1000);
		const result = await resizePhoto(input);
		expect(typeof result.blurHash).toBe('string');
		expect(result.blurHash.length).toBeGreaterThan(0);
	});
});
