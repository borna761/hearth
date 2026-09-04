import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { verifyPin } from '$lib/server/auth/pin';
import { createSession, SESSION_COOKIE, authCookieOptions } from '$lib/server/auth/session';

/**
 * Deliberately separate from /api/auth/login, not a shared code path: settings is
 * reachable from a phone over Tailscale (DESIGN.md §7.5), and that login must never
 * touch setActiveSessionToken/publishState — doing so would make checking settings from a
 * phone silently change what the one physical kitchen tablet is currently showing to
 * everyone in the room. This creates a real, valid session (so locals.session is
 * populated on later requests) with no side effect on the shared display at all.
 *
 * Not admin-gated here — any correct PIN creates a session. Authorization (isAdmin) is
 * the settings page's own concern; a non-admin user's correct PIN succeeds at
 * authentication and then sees "not authorized", which is the honest behavior given
 * there's no separate settings-only credential in this system.
 */
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
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	if (!result.ok) {
		return json(result, { status: result.reason === 'locked' ? 423 : 401 });
	}

	const token = await createSession(db, result.userId);
	cookies.set(SESSION_COOKIE, token, { ...authCookieOptions(url), maxAge: 60 * 60 * 12 });

	return json({ ok: true });
};
