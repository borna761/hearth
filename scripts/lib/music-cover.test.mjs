import { describe, it, expect } from 'vitest';
import { extractCoverArt } from './music-cover.mjs';

// music-metadata reads the ID3v2 tag independent of whether the rest of the file is a
// real, decodable MP3 stream — so a hand-built tag + a couple of garbage "frame" bytes is
// enough to exercise the APIC extraction path without needing a real audio fixture.

function syncsafe(n) {
	return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function buildApicFrame(mime, pictureType, description, data) {
	const content = Buffer.concat([
		Buffer.from([0x00]), // text encoding: ISO-8859-1
		Buffer.from(mime + '\0', 'latin1'),
		Buffer.from([pictureType]),
		Buffer.from(description + '\0', 'latin1'),
		data
	]);
	const header = Buffer.concat([
		Buffer.from('APIC', 'latin1'),
		Buffer.alloc(4), // frame size, big-endian (not syncsafe in ID3v2.3)
		Buffer.from([0x00, 0x00]) // flags
	]);
	header.writeUInt32BE(content.length, 4);
	return Buffer.concat([header, content]);
}

function buildId3v2Buffer(frames) {
	const framesBuf = Buffer.concat(frames);
	const header = Buffer.concat([
		Buffer.from('ID3', 'latin1'),
		Buffer.from([0x03, 0x00]), // version 2.3.0
		Buffer.from([0x00]), // flags
		syncsafe(framesBuf.length)
	]);
	// A couple of MP3 frame-sync-looking bytes after the tag, plus padding — enough for
	// music-metadata's file-type sniffing, not a real decodable stream.
	return Buffer.concat([
		header,
		framesBuf,
		Buffer.from([0xff, 0xfb, 0x90, 0x00]),
		Buffer.alloc(64)
	]);
}

describe('extractCoverArt', () => {
	it('extracts an embedded APIC picture', async () => {
		const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0x02, 0x03, 0xff, 0xd9]);
		const buffer = buildId3v2Buffer([buildApicFrame('image/jpeg', 3, '', fakeJpeg)]);

		const cover = await extractCoverArt(buffer);

		expect(cover).not.toBeNull();
		expect(cover.format).toBe('image/jpeg');
		expect(Buffer.from(cover.data)).toEqual(fakeJpeg);
	});

	it('returns null when the file has no embedded picture', async () => {
		const buffer = buildId3v2Buffer([]);
		expect(await extractCoverArt(buffer)).toBeNull();
	});

	it('returns null rather than throwing on a non-audio buffer', async () => {
		// A stray corrupt/truncated file in the library is realistic — this must degrade
		// gracefully, not take the whole nightly scan down.
		expect(await extractCoverArt(Buffer.from('not an mp3'))).toBeNull();
	});
});
