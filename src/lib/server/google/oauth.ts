// Google OAuth 2.0 authorization-code flow — DESIGN.md §2.6.
//
// Only one grant is ever needed (alex@example.com, which already has every other
// calendar shared into it), and the consent screen is in "In Production" status so the
// refresh token does not expire after seven days.

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** v1 never writes to calendars (DESIGN.md §1 non-goals), so read-only is all we ask for. */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

/**
 * Holds the CSRF state between /auth/google/start and the callback. Lives here rather
 * than in the route module because SvelteKit only allows a fixed set of exports from
 * +server.ts files.
 */
export const OAUTH_STATE_COOKIE = 'hearth_oauth_state';

const DEFAULT_EXPIRY_SKEW_MS = 60_000;

export interface GoogleOAuthConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

export interface GoogleTokens {
	accessToken: string;
	refreshToken: string;
	/** Absolute epoch ms — stored rather than a duration so it survives a restart. */
	expiresAt: number;
}

interface TokenRequestOptions {
	fetchFn?: typeof fetch;
	now?: number;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

export function buildAuthUrl(config: GoogleOAuthConfig, state: string): string {
	const url = new URL(AUTH_ENDPOINT);
	url.searchParams.set('client_id', config.clientId);
	url.searchParams.set('redirect_uri', config.redirectUri);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
	url.searchParams.set('state', state);
	// offline + consent together are what guarantee a refresh token. Google issues one
	// only on the *first* authorization otherwise, so re-running this flow later would
	// hand back an access token and nothing durable.
	url.searchParams.set('access_type', 'offline');
	url.searchParams.set('prompt', 'consent');
	return url.toString();
}

async function postToken(
	body: URLSearchParams,
	{ fetchFn = fetch }: TokenRequestOptions
): Promise<TokenResponse> {
	const response = await fetchFn(TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});

	const payload = (await response.json()) as TokenResponse;
	if (!response.ok || payload.error) {
		const detail = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
		throw new Error(`Google token request failed: ${detail}`);
	}
	if (!payload.access_token) {
		throw new Error('Google token response contained no access token');
	}
	return payload;
}

export async function exchangeCode(
	config: GoogleOAuthConfig,
	code: string,
	options: TokenRequestOptions = {}
): Promise<GoogleTokens> {
	const now = options.now ?? Date.now();
	const payload = await postToken(
		new URLSearchParams({
			code,
			client_id: config.clientId,
			client_secret: config.clientSecret,
			redirect_uri: config.redirectUri,
			grant_type: 'authorization_code'
		}),
		options
	);

	if (!payload.refresh_token) {
		// Nothing durable to store — calendars would stop working in an hour. Usually means
		// the account has authorized before and `prompt=consent` was lost from the auth URL.
		throw new Error(
			'Google returned no refresh token. Re-run the flow with prompt=consent, or revoke ' +
				'the existing grant at https://myaccount.google.com/permissions and try again.'
		);
	}

	return {
		accessToken: payload.access_token!,
		refreshToken: payload.refresh_token,
		expiresAt: now + (payload.expires_in ?? 3600) * 1000
	};
}

export async function refreshAccessToken(
	config: GoogleOAuthConfig,
	refreshToken: string,
	options: TokenRequestOptions = {}
): Promise<GoogleTokens> {
	const now = options.now ?? Date.now();
	const payload = await postToken(
		new URLSearchParams({
			refresh_token: refreshToken,
			client_id: config.clientId,
			client_secret: config.clientSecret,
			grant_type: 'refresh_token'
		}),
		options
	);

	return {
		accessToken: payload.access_token!,
		// Google omits refresh_token on a refresh. Falling back to the one we already hold
		// is what keeps the grant alive; overwriting it with undefined would silently kill
		// syncing an hour later.
		refreshToken: payload.refresh_token ?? refreshToken,
		expiresAt: now + (payload.expires_in ?? 3600) * 1000
	};
}

export function isAccessTokenExpired(
	expiresAt: number,
	now: number = Date.now(),
	skewMs: number = DEFAULT_EXPIRY_SKEW_MS
): boolean {
	return now >= expiresAt - skewMs;
}
