import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { setSetting, parseMusicHours, SETTING_KEYS } from '$lib/server/settings';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const value = typeof body?.value === 'string' ? body.value : null;
	if (value === null) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	// Unlike quiet-hours, an empty value is legitimate here — it clears the restriction,
	// leaving music available at all times (getMusicHours' own default).
	if (value !== '') {
		const parsed = parseMusicHours(value);
		// A zero-width window parses fine but leaves music permanently unavailable with no
		// error shown anywhere — the settings form defaults both time fields to the same
		// value, so this is far more likely to be an unnoticed mistake than someone
		// deliberately asking for "never". Reject it here rather than silently accepting a
		// value that getMusicHours would otherwise treat as unrestricted on the next read.
		if (!parsed || parsed.startMinutes === parsed.endMinutes) {
			return json({ ok: false, reason: 'invalid' }, { status: 400 });
		}
	}

	await setSetting(db, SETTING_KEYS.musicHours, value);
	return json({ ok: true });
};
