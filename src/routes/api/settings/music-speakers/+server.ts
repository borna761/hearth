import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { addMusicSpeaker } from '$lib/server/musicLibrary';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const castName = typeof body?.castName === 'string' ? body.castName.trim() : '';
	if (!castName) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	const speaker = await addMusicSpeaker(db, castName);
	return json({ ok: true, speaker });
};
