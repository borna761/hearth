import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { extractTakenAt } from './photo-metadata.mjs';

describe('extractTakenAt', () => {
	it('falls back to the file mtime when the photo has no EXIF at all', async () => {
		const buffer = await sharp({
			create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } }
		})
			.jpeg()
			.toBuffer();
		const mtime = new Date('2024-05-17T00:00:00Z');
		expect(await extractTakenAt(buffer, mtime)).toBe(mtime);
	});

	it('falls back to the file mtime rather than throwing on a non-image buffer', async () => {
		// A bulk-imported library realistically has a stray corrupt/truncated file at some
		// point — this must degrade gracefully, not take the whole nightly job down.
		const garbage = Buffer.from('not a real jpeg');
		const mtime = new Date('2024-05-17T00:00:00Z');
		expect(await extractTakenAt(garbage, mtime)).toBe(mtime);
	});
});
