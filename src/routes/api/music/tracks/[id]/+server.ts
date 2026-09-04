import { error } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { getMusicTrack } from '$lib/server/musicLibrary';
import { computeRange } from '$lib/server/httpRange';

/**
 * Streams a track's audio bytes, with real Range support — the Cast receiver needs to be
 * able to seek. No session check, same reasoning api/photos/[id] already documents: the
 * household's own media is public over plain LAN HTTP the same way its own photos are;
 * what's actually gated is *triggering playback* (api/music/play), not the file bytes
 * themselves. `stat()`s the file fresh rather than trusting the scanned `size` column, in
 * case it's changed since the last nightly scan.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) {
		error(400, 'Invalid track id');
	}

	const track = await getMusicTrack(db, id);
	if (!track) {
		error(404, 'Track not found');
	}

	let size: number;
	try {
		size = (await stat(track.sourcePath)).size;
	} catch {
		error(503, "Can't reach the NAS right now");
	}

	const range = computeRange(request.headers.get('range'), size);
	if (range.status === 416) {
		return new Response(null, {
			status: 416,
			headers: { ...range.headers, 'content-type': 'audio/mpeg' }
		});
	}

	const nodeStream = createReadStream(track.sourcePath, { start: range.start, end: range.end });
	return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
		status: range.status,
		headers: { ...range.headers, 'content-type': 'audio/mpeg' }
	});
};
