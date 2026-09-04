import { describe, it, expect } from 'vitest';
import NodeID3 from 'node-id3';
import { readExistingTags, applyMissingTags } from './music-tag-writer.mjs';

describe('readExistingTags', () => {
	it('reports null fields and no cover art for a file with no ID3 tag at all', () => {
		expect(readExistingTags(Buffer.from('not an mp3'))).toEqual({
			artist: null,
			title: null,
			album: null,
			year: null,
			hasCoverArt: false
		});
	});

	it('reads back whatever tags are already present', () => {
		const buffer = NodeID3.create({
			artist: 'Queen',
			title: 'Bohemian Rhapsody',
			album: 'A Night at the Opera',
			year: '1975'
		});
		expect(readExistingTags(buffer)).toEqual({
			artist: 'Queen',
			title: 'Bohemian Rhapsody',
			album: 'A Night at the Opera',
			year: '1975',
			hasCoverArt: false
		});
	});

	it('detects an existing embedded cover regardless of its content', () => {
		const buffer = NodeID3.create({
			image: {
				mime: 'image/jpeg',
				type: { id: 3 },
				description: 'Cover',
				imageBuffer: Buffer.from([1, 2, 3])
			}
		});
		expect(readExistingTags(buffer).hasCoverArt).toBe(true);
	});
});

describe('applyMissingTags', () => {
	it('writes artist/title/album/year onto a file with no tags yet', async () => {
		const empty = NodeID3.create({});
		const updated = await applyMissingTags(empty, {
			artist: 'Queen',
			title: 'Bohemian Rhapsody',
			album: 'A Night at the Opera',
			year: '1975'
		});
		expect(readExistingTags(updated)).toMatchObject({
			artist: 'Queen',
			title: 'Bohemian Rhapsody',
			album: 'A Night at the Opera',
			year: '1975'
		});
	});

	it("doesn't touch a field that isn't included in the update", async () => {
		const existing = NodeID3.create({ artist: 'Queen', title: 'Bohemian Rhapsody' });
		const updated = await applyMissingTags(existing, { album: 'A Night at the Opera' });
		const tags = NodeID3.read(updated);
		expect(tags.artist).toBe('Queen');
		expect(tags.title).toBe('Bohemian Rhapsody');
		expect(tags.album).toBe('A Night at the Opera');
	});
});
