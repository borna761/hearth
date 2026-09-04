import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { setSetting, SETTING_KEYS } from '$lib/server/settings';

/** True for any IANA zone name Node's ICU data recognizes — the same check
 * Intl.supportedValuesOf('timeZone') is built from, cheaper than importing that whole list
 * just to do a membership test. */
function isValidTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat(undefined, { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const value = typeof body?.value === 'string' ? body.value : '';

	if (!value || !isValidTimeZone(value)) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await setSetting(db, SETTING_KEYS.householdTimeZone, value);
	return json({ ok: true });
};
