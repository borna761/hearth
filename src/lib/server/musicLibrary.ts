// Reads for the music folders/tracks/speakers populated by scripts/scan-music.mjs
// (docs/phase-7-music-plan.md) — the app itself never touches the NAS filesystem, same
// separation as photos.ts.

import { eq, asc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema';
import { musicFolders, musicTracks, musicSpeakers } from './db/schema';

type Db = BetterSQLite3Database<typeof schema>;

export interface MusicFolder {
	id: number;
	displayName: string;
}

export interface MusicTrack {
	id: number;
	title: string;
}

export interface MusicSpeaker {
	id: number;
	castName: string;
}

export async function listMusicFolders(db: Db): Promise<MusicFolder[]> {
	return db
		.select({ id: musicFolders.id, displayName: musicFolders.displayName })
		.from(musicFolders)
		.orderBy(asc(musicFolders.displayName));
}

export async function getMusicFolder(db: Db, id: number): Promise<MusicFolder | null> {
	const [row] = await db
		.select({ id: musicFolders.id, displayName: musicFolders.displayName })
		.from(musicFolders)
		.where(eq(musicFolders.id, id))
		.limit(1);
	return row ?? null;
}

// Alphabetical by title, not insertion order — see db/schema.ts's musicTracks comment on
// why there's no explicit position column.
export async function listTracksInFolder(db: Db, folderId: number): Promise<MusicTrack[]> {
	return db
		.select({ id: musicTracks.id, title: musicTracks.title })
		.from(musicTracks)
		.where(eq(musicTracks.folderId, folderId))
		.orderBy(asc(musicTracks.title));
}

export interface StreamableTrack {
	id: number;
	title: string;
	sourcePath: string;
}

export async function getMusicTrack(db: Db, id: number): Promise<StreamableTrack | null> {
	const [row] = await db
		.select({ id: musicTracks.id, title: musicTracks.title, sourcePath: musicTracks.sourcePath })
		.from(musicTracks)
		.where(eq(musicTracks.id, id))
		.limit(1);
	return row ?? null;
}

export async function getMusicTrackCover(
	db: Db,
	id: number
): Promise<{ coverPath: string } | null> {
	const [row] = await db
		.select({ coverPath: musicTracks.coverPath })
		.from(musicTracks)
		.where(eq(musicTracks.id, id))
		.limit(1);
	if (!row?.coverPath) return null;
	return { coverPath: row.coverPath };
}

export async function listMusicSpeakers(db: Db): Promise<MusicSpeaker[]> {
	return db
		.select({ id: musicSpeakers.id, castName: musicSpeakers.castName })
		.from(musicSpeakers)
		.orderBy(asc(musicSpeakers.castName));
}

export async function addMusicSpeaker(db: Db, castName: string): Promise<MusicSpeaker> {
	const [row] = await db
		.insert(musicSpeakers)
		.values({ castName })
		.returning({ id: musicSpeakers.id, castName: musicSpeakers.castName });
	return row;
}

export async function removeMusicSpeaker(db: Db, id: number): Promise<void> {
	await db.delete(musicSpeakers).where(eq(musicSpeakers.id, id));
}

export async function getMusicSpeaker(db: Db, id: number): Promise<MusicSpeaker | null> {
	const [row] = await db
		.select({ id: musicSpeakers.id, castName: musicSpeakers.castName })
		.from(musicSpeakers)
		.where(eq(musicSpeakers.id, id))
		.limit(1);
	return row ?? null;
}
