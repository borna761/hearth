import { error } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { getMusicTrackCover } from '$lib/server/musicLibrary';

/**
 * Serves a track's cached cover-art derivative — extracted from the mp3's embedded ID3
 * tag and resized down to a small thumbnail at scan time (scripts/lib/music-cover.mjs,
 * scripts/lib/music-cover-resize.mjs), always re-encoded to JPEG regardless of the
 * original embedded format. Same no-session-check reasoning as api/photos/[id]: this is
 * just the household's own artwork, not household data — what's actually gated is
 * triggering playback (api/music/play), not image bytes. 404s (not a placeholder) when
 * the track has none — MusicPanel already renders its own placeholder icon on a failed
 * image load, no need for the server to draw one.
 */
export const GET: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) {
		error(400, 'Invalid track id');
	}

	const cover = await getMusicTrackCover(db, id);
	if (!cover) {
		error(404, 'No cover art for this track');
	}

	let buffer: Buffer;
	try {
		buffer = await readFile(cover.coverPath);
	} catch {
		error(503, 'Cover art unavailable — the NAS is unreachable');
	}

	return new Response(new Uint8Array(buffer), {
		headers: {
			'content-type': 'image/jpeg',
			// Not `immutable` — a rescanned file overwrites the same coverPath in place.
			'cache-control': 'public, max-age=604800'
		}
	});
};
