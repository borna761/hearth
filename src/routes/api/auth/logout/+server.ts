import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { endSession, SESSION_COOKIE, authCookieOptions } from '$lib/server/auth/session';
import { setActiveSessionToken, publishState } from '$lib/server/state/publisher';
import { setActiveScreensaverMode } from '$lib/server/state/screensaverPublisher';

export const POST: RequestHandler = async ({ locals, cookies, url }) => {
	if (locals.session) {
		await endSession(db, locals.session.sessionId);
	}
	cookies.delete(SESSION_COOKIE, authCookieOptions(url));
	// DESIGN.md §5's diagram: a session ending returns to the family screensaver, not back
	// to guest — guest mode is only entered explicitly, from the lock screen.
	await setActiveScreensaverMode(db, 'family');
	setActiveSessionToken(null);
	await publishState();
	return json({ ok: true });
};
