import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setPlaybackVolume } from '$lib/server/googleCast/playbackSession';

// Unlike groceries, music is intentionally open to guest mode too (Alex's call).
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const level = typeof body?.level === 'number' ? body.level : null;
	if (level === null || level < 0 || level > 1) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	const result = await setPlaybackVolume(level);
	if (result.ok) return json(result);
	return json(result, { status: result.reason === 'inactive' ? 409 : 502 });
};
