import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { listTracksInFolder } from '$lib/server/musicLibrary';

/** Backs the song-picker step of MusicPanel. Unlike groceries, music is intentionally
 * open to guest mode too (Alex's call) — this only reveals track titles for a folder
 * the panel already lets anyone browse. */
export const GET: RequestHandler = async ({ params }) => {
	const folderId = Number(params.id);
	if (!Number.isInteger(folderId)) {
		error(400, 'Invalid folder id');
	}

	const tracks = await listTracksInFolder(db, folderId);
	return json({ ok: true, tracks });
};
