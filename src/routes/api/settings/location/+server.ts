import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { setSetting, parseHouseholdLocation, SETTING_KEYS } from '$lib/server/settings';

/** Shared by weather.ts (Open-Meteo requests) and theme.ts (sun-based auto theme) — see
 * $lib/location.ts. Rejects up front rather than silently falling back to the default,
 * same reasoning as the quiet-hours route. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const value = typeof body?.value === 'string' ? body.value : '';

	if (!parseHouseholdLocation(value)) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await setSetting(db, SETTING_KEYS.householdLocation, value);
	return json({ ok: true });
};
