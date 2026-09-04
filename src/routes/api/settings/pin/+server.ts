import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { setUserPin } from '$lib/server/auth/pin';

/** DESIGN.md §7.5's PIN reset — Alex can reset any user's PIN, the same "the admin
 * configures the whole household" pattern the visibility matrix already uses (not just
 * their own). */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const userId = Number(body?.userId);
	const pin = typeof body?.pin === 'string' ? body.pin : '';

	// Exactly 4 digits — same policy as the seed script and the lock screen's auto-submit
	// (src/lib/components/PinPad.svelte), so every PIN in the system stays that length.
	if (!Number.isInteger(userId) || !/^\d{4}$/.test(pin)) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await setUserPin(db, userId, pin);
	return json({ ok: true });
};
