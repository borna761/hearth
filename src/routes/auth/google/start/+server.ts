import { redirect } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import type { RequestHandler } from './$types';
import { getGoogleOAuthConfig } from '$lib/server/google/config';
import { buildAuthUrl, OAUTH_STATE_COOKIE } from '$lib/server/google/oauth';

export const GET: RequestHandler = ({ cookies, url }) => {
	const config = getGoogleOAuthConfig();
	const state = randomBytes(32).toString('base64url');

	cookies.set(OAUTH_STATE_COOKIE, state, {
		path: '/auth/google',
		httpOnly: true,
		sameSite: 'lax', // must survive the cross-site redirect back from Google
		secure: url.protocol === 'https:',
		maxAge: 600
	});

	redirect(302, buildAuthUrl(config, state));
};
