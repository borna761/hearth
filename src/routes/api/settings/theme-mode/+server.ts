import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { setSetting, SETTING_KEYS } from '$lib/server/settings';

const VALID_MODES = new Set(['auto', 'light', 'dark']);

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const value = typeof body?.value === 'string' ? body.value : '';

	if (!VALID_MODES.has(value)) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await setSetting(db, SETTING_KEYS.themeMode, value);
	return json({ ok: true });
};
