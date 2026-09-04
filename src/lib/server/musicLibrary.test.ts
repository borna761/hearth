import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './db/schema';
import { musicFolders, musicTracks } from './db/schema';
import {
	listMusicFolders,
	listTracksInFolder,
	getMusicFolder,
	getMusicTrack,
	getMusicTrackCover,
	listMusicSpeakers,
	addMusicSpeaker,
	removeMusicSpeaker,
	getMusicSpeaker
} from './musicLibrary';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;

beforeEach(() => {
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
});

afterEach(() => sqlite.close());

async function seedFolder(displayName: string, folderPath: string) {
	const [folder] = await db.insert(musicFolders).values({ displayName, folderPath }).returning();
	return folder;
}

async function seedTrack(
	folderId: number,
	title: string,
	sourcePath: string,
	coverPath: string | null = null
) {
	const [track] = await db
		.insert(musicTracks)
		.values({ folderId, title, sourcePath, mtime: new Date(), size: 1000, coverPath })
		.returning();
	return track;
}

describe('listMusicFolders', () => {
	it('starts empty', async () => {
		expect(await listMusicFolders(db)).toEqual([]);
	});

	it('lists folders', async () => {
		const folder = await seedFolder('Road Trip', 'Road Trip');
		expect(await listMusicFolders(db)).toEqual([{ id: folder.id, displayName: 'Road Trip' }]);
	});
});

describe('getMusicFolder', () => {
	it('finds one by id, or returns null', async () => {
		const folder = await seedFolder('Road Trip', 'Road Trip');
		expect(await getMusicFolder(db, folder.id)).toEqual({
			id: folder.id,
			displayName: 'Road Trip'
		});
		expect(await getMusicFolder(db, folder.id + 999)).toBeNull();
	});
});

describe('listTracksInFolder', () => {
	it('lists tracks alphabetically by title, not insertion order', async () => {
		const folder = await seedFolder('Road Trip', 'Road Trip');
		await seedTrack(folder.id, 'Zebra', '/mnt/nas/music/Road Trip/z.mp3');
		await seedTrack(folder.id, 'Apple', '/mnt/nas/music/Road Trip/a.mp3');
		const tracks = await listTracksInFolder(db, folder.id);
		expect(tracks.map((t) => t.title)).toEqual(['Apple', 'Zebra']);
	});

	it('only returns tracks from the requested folder', async () => {
		const folderA = await seedFolder('A', 'A');
		const folderB = await seedFolder('B', 'B');
		await seedTrack(folderA.id, 'Song A', '/mnt/nas/music/A/song.mp3');
		await seedTrack(folderB.id, 'Song B', '/mnt/nas/music/B/song.mp3');
		expect((await listTracksInFolder(db, folderA.id)).map((t) => t.title)).toEqual(['Song A']);
	});
});

describe('getMusicTrack', () => {
	it('returns the source path needed to stream it, or null', async () => {
		const folder = await seedFolder('Road Trip', 'Road Trip');
		const track = await seedTrack(folder.id, 'Song', '/mnt/nas/music/Road Trip/song.mp3');
		expect(await getMusicTrack(db, track.id)).toMatchObject({
			id: track.id,
			title: 'Song',
			sourcePath: '/mnt/nas/music/Road Trip/song.mp3'
		});
		expect(await getMusicTrack(db, track.id + 999)).toBeNull();
	});
});

describe('getMusicTrackCover', () => {
	it('returns the cached cover path when the track has one', async () => {
		const folder = await seedFolder('Road Trip', 'Road Trip');
		const track = await seedTrack(
			folder.id,
			'Song',
			'/mnt/nas/music/Road Trip/song.mp3',
			'/mnt/nas/cache/music-covers/abc123.jpg'
		);
		expect(await getMusicTrackCover(db, track.id)).toEqual({
			coverPath: '/mnt/nas/cache/music-covers/abc123.jpg'
		});
	});

	it('returns null when the track has no cover, or does not exist', async () => {
		const folder = await seedFolder('Road Trip', 'Road Trip');
		const track = await seedTrack(folder.id, 'Song', '/mnt/nas/music/Road Trip/song.mp3');
		expect(await getMusicTrackCover(db, track.id)).toBeNull();
		expect(await getMusicTrackCover(db, track.id + 999)).toBeNull();
	});
});

describe('music speakers', () => {
	it('starts empty', async () => {
		expect(await listMusicSpeakers(db)).toEqual([]);
	});

	it('adds a speaker and lists it back', async () => {
		const speaker = await addMusicSpeaker(db, 'Kitchen');
		expect(speaker.castName).toBe('Kitchen');
		expect(await listMusicSpeakers(db)).toEqual([{ id: speaker.id, castName: 'Kitchen' }]);
	});

	it('removes a speaker', async () => {
		const speaker = await addMusicSpeaker(db, 'Kitchen');
		await removeMusicSpeaker(db, speaker.id);
		expect(await listMusicSpeakers(db)).toEqual([]);
	});

	it('getMusicSpeaker finds one by id, or returns null', async () => {
		const speaker = await addMusicSpeaker(db, 'Kitchen');
		expect(await getMusicSpeaker(db, speaker.id)).toEqual({ id: speaker.id, castName: 'Kitchen' });
		expect(await getMusicSpeaker(db, speaker.id + 999)).toBeNull();
	});
});
