import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { touchSession } from '$lib/server/auth/session';

/**
 * Keeps a session's idle-timeout window alive during genuine activity. locals.session is
 * already the freshly-expiry-checked result of hooks.server.ts's loadSession call for
 * this exact request — if it's already null, the session was already idle-expired (and
 * deleted) before this handler ever ran.
 */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.session) {
		return json({ expired: true }, { status: 401 });
	}
	await touchSession(db, locals.session.sessionId);
	return json({ ok: true });
};
