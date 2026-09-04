import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { verifyPin } from '$lib/server/auth/pin';
import {
	createSession,
	SESSION_COOKIE,
	GUEST_COOKIE,
	authCookieOptions
} from '$lib/server/auth/session';
import { setActiveSessionToken, publishState } from '$lib/server/state/publisher';
import { setActiveScreensaverMode } from '$lib/server/state/screensaverPublisher';

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	const body = await request.json().catch(() => null);
	const userId = Number(body?.userId);
	const pin = typeof body?.pin === 'string' ? body.pin : '';

	if (!Number.isInteger(userId) || !pin) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	let result;
	try {
		result = await verifyPin(db, userId, pin);
	} catch {
		// No such user — a malformed/stale client request, not a real PIN attempt.
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	if (!result.ok) {
		return json(result, { status: result.reason === 'locked' ? 423 : 401 });
	}

	const token = await createSession(db, result.userId);
	cookies.set(SESSION_COOKIE, token, {
		...authCookieOptions(url),
		maxAge: 60 * 60 * 12 // matches the session's hard cap; see session.ts
	});
	// A successful login ends guest mode's stickiness — DESIGN.md §5: "Sticky until
	// someone enters a PIN."
	cookies.delete(GUEST_COOKIE, authCookieOptions(url));
	await setActiveScreensaverMode(db, 'family');

	setActiveSessionToken(token);
	await publishState();

	return json({ ok: true });
};
