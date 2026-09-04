import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stopPlayback } from '$lib/server/googleCast/playbackSession';

export const POST: RequestHandler = async () => {
	// Unlike groceries, music is intentionally open to guest mode too (Alex's call).
	const result = await stopPlayback();
	if (result.ok) return json(result);
	return json(result, { status: result.reason === 'inactive' ? 409 : 502 });
};
