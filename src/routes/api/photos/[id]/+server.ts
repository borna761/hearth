import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { photos } from '$lib/server/db/schema';

/**
 * Serves a photo derivative's bytes — DESIGN.md §6: "the server streams a pre-sized file
 * with a long cache header." Public, no session check, matching the rest of the
 * screensaver's content (DESIGN.md §5: the screensaver itself carries "no household data";
 * a resized family photo with no metadata attached is the same category as the weather or
 * the clock, not calendar data).
 *
 * Falls back to the local fallback-ring copy (DESIGN.md §6) if the NAS-hosted cache/
 * derivative can't be read — the whole reason that ring exists.
 */
export const GET: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id)) {
		error(400, 'Invalid photo id');
	}

	const [row] = await db.select().from(photos).where(eq(photos.id, id)).limit(1);
	if (!row) {
		error(404, 'No such photo');
	}

	const fallbackDir = env.HEARTH_PHOTOS_FALLBACK_DIR ?? '/var/lib/hearth/fallback';
	const fallbackPath = path.join(fallbackDir, path.basename(row.cachedPath));

	let buffer: Buffer;
	try {
		buffer = await readFile(row.cachedPath);
	} catch {
		buffer = await readFile(fallbackPath).catch(() => {
			error(503, 'Photo unavailable — the NAS is unreachable and no fallback copy exists');
		});
	}

	return new Response(new Uint8Array(buffer), {
		headers: {
			'content-type': 'image/jpeg',
			// Not `immutable` — a reprocessed photo overwrites the same cachedPath in place.
			// The caller busts this via a `?v=` query param derived from the row's mtime,
			// so a genuinely new URL is requested whenever the bytes actually change.
			'cache-control': 'public, max-age=604800'
		}
	});
};
