import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { resizeCoverArt } from './music-cover-resize.mjs';

/** A synthetic solid-color image — no real cover art needed, sharp can generate one
 *  in-process, same trick photo-resize.test.mjs uses for photos. */
async function syntheticImage(width, height, format = 'jpeg') {
	const pipeline = sharp({
		create: { width, height, channels: 3, background: { r: 200, g: 60, b: 60 } }
	});
	return format === 'png' ? pipeline.png().toBuffer() : pipeline.jpeg().toBuffer();
}

describe('resizeCoverArt', () => {
	it('shrinks a large embedded image down to fit within 100x100', async () => {
		const input = await syntheticImage(1280, 720);
		const result = await resizeCoverArt(input);
		expect(result.width).toBeLessThanOrEqual(100);
		expect(result.height).toBeLessThanOrEqual(100);
		// 'inside' fit preserves aspect ratio — a 16:9 source should bind on width.
		expect(result.width).toBe(100);
	});

	it("doesn't upscale art that's already smaller than the target", async () => {
		const input = await syntheticImage(50, 50);
		const result = await resizeCoverArt(input);
		expect(result.width).toBe(50);
		expect(result.height).toBe(50);
	});

	it('always outputs a JPEG, regardless of the input format', async () => {
		const input = await syntheticImage(200, 200, 'png');
		const result = await resizeCoverArt(input);
		const meta = await sharp(result.buffer).metadata();
		expect(meta.format).toBe('jpeg');
	});

	it('preserves aspect ratio rather than cropping to a square', async () => {
		const input = await syntheticImage(1280, 720);
		const result = await resizeCoverArt(input);
		expect(result.width).toBe(100);
		expect(result.height).toBe(Math.round((720 / 1280) * 100));
	});
});
