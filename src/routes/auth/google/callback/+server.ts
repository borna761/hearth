import { error, redirect } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { getGoogleOAuthConfig } from '$lib/server/google/config';
import { exchangeCode, OAUTH_STATE_COOKIE } from '$lib/server/google/oauth';
import { fetchPrimaryCalendarId, listGoogleCalendars } from '$lib/server/google/api';
import { storeGoogleTokens } from '$lib/server/google/tokens';
import { discoverCalendars } from '$lib/server/google/discovery';

function statesMatch(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

export const GET: RequestHandler = async ({ url, cookies }) => {
	const denied = url.searchParams.get('error');
	if (denied) {
		error(400, `Google authorization was declined: ${denied}`);
	}

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const expectedState = cookies.get(OAUTH_STATE_COOKIE);

	if (!code || !state) {
		error(400, 'Google did not return an authorization code.');
	}
	if (!expectedState || !statesMatch(state, expectedState)) {
		error(403, 'OAuth state did not match. Start again from /auth/google/start.');
	}

	cookies.delete(OAUTH_STATE_COOKIE, { path: '/auth/google' });

	const config = getGoogleOAuthConfig();
	const tokens = await exchangeCode(config, code);

	// Label the connection with the account that actually granted access, so the settings
	// screen can show which Google account is wired up (DESIGN.md §7.5).
	const accountEmail = await fetchPrimaryCalendarId(tokens.accessToken);
	const connectionId = await storeGoogleTokens(db, accountEmail, tokens);

	// Without this, storing a grant leaves `sources` empty forever — nothing else ever
	// populates it, so the sync scheduler would iterate zero calendars indefinitely.
	await discoverCalendars(db, connectionId, () => listGoogleCalendars(tokens.accessToken));

	redirect(303, '/auth/google/connected');
};
