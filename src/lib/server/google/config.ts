import { env } from '$env/dynamic/private';
import type { GoogleOAuthConfig } from './oauth';

/**
 * Reads the OAuth client configuration from the environment (deploy/hearth.env.example).
 *
 * The client id/secret are deployment config rather than per-connection credentials, so
 * they live in the env file and not in `connections.secrets` — only the user's refresh
 * token goes in the database.
 */
export function getGoogleOAuthConfig(): GoogleOAuthConfig {
	const clientId = env.GOOGLE_CLIENT_ID;
	const clientSecret = env.GOOGLE_CLIENT_SECRET;
	const redirectUri = env.GOOGLE_REDIRECT_URI;

	if (!clientId || !clientSecret || !redirectUri) {
		throw new Error(
			'Google OAuth is not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ' +
				'GOOGLE_REDIRECT_URI in /etc/hearth/hearth.env (see deploy/hearth.env.example).'
		);
	}

	return { clientId, clientSecret, redirectUri };
}
