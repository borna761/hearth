import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { setSetting, SETTING_KEYS } from '$lib/server/settings';

const VALID_FORMATS = new Set(['12h', '24h']);

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const value = typeof body?.value === 'string' ? body.value : '';

	if (!VALID_FORMATS.has(value)) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await setSetting(db, SETTING_KEYS.timeFormat, value);
	return json({ ok: true });
};
