import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { setSetting, parseQuietHours, SETTING_KEYS } from '$lib/server/settings';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const value = typeof body?.value === 'string' ? body.value : '';

	// Rejects up front rather than silently falling back to the default (getQuietHours'
	// own behavior for a bad stored value) — a settings form should say "that's invalid",
	// not accept it and quietly do something else.
	if (!parseQuietHours(value)) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await setSetting(db, SETTING_KEYS.quietHours, value);
	return json({ ok: true });
};
