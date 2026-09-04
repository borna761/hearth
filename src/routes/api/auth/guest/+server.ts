import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { GUEST_COOKIE, authCookieOptions } from '$lib/server/auth/session';
import { setActiveScreensaverMode } from '$lib/server/state/screensaverPublisher';

/**
 * Guest mode grants no data access at all (DESIGN.md §5's diagram treats it as a
 * screensaver variant, not a session) — GUEST_COOKIE is the per-device write gate
 * (canAccessPinFreeFeature), while setActiveScreensaverMode is the shared, durable "what
 * the one physical tablet shows" flag every display reads. Ends the moment a real PIN
 * succeeds (see the login route, which clears the cookie and flips the flag back).
 */
export const POST: RequestHandler = async ({ cookies, url }) => {
	cookies.set(GUEST_COOKIE, '1', { ...authCookieOptions(url), maxAge: 60 * 60 * 24 });
	await setActiveScreensaverMode(db, 'guest');
	return json({ ok: true });
};
