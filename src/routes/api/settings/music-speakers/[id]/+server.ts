import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { removeMusicSpeaker } from '$lib/server/musicLibrary';

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const id = Number(params.id);
	if (!Number.isInteger(id)) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await removeMusicSpeaker(db, id);
	return json({ ok: true });
};
