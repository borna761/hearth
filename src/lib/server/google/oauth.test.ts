import { describe, it, expect } from 'vitest';
import {
	buildAuthUrl,
	exchangeCode,
	refreshAccessToken,
	isAccessTokenExpired,
	GOOGLE_SCOPES,
	type GoogleOAuthConfig
} from './oauth';

const config: GoogleOAuthConfig = {
	clientId: 'test-client-id.apps.googleusercontent.com',
	clientSecret: 'test-client-secret',
	redirectUri: 'https://raspberrypi.tailabc123.ts.net/auth/google/callback'
};

/** A fetch stub that records its call and returns a canned JSON response. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fn = async (url: string | URL, requestInit?: RequestInit) => {
		calls.push({ url: String(url), init: requestInit ?? {} });
		return {
			ok: init.ok ?? true,
			status: init.status ?? 200,
			json: async () => body,
			text: async () => JSON.stringify(body)
		} as Response;
	};
	return { fn: fn as unknown as typeof fetch, calls };
}

describe('buildAuthUrl', () => {
	it('targets Google’s authorization endpoint', () => {
		const url = new URL(buildAuthUrl(config, 'state-abc'));
		expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
	});

	it('requests offline access and forces consent, so a refresh token is always issued', () => {
		// DESIGN.md §2.6: the refresh token must live indefinitely. Google only returns one
		// on first authorization unless consent is forced, so a re-auth would otherwise
		// silently yield no refresh token at all.
		const params = new URL(buildAuthUrl(config, 'state-abc')).searchParams;
		expect(params.get('access_type')).toBe('offline');
		expect(params.get('prompt')).toBe('consent');
	});

	it('carries the client id, redirect uri, response type and state', () => {
		const params = new URL(buildAuthUrl(config, 'state-abc')).searchParams;
		expect(params.get('client_id')).toBe(config.clientId);
		expect(params.get('redirect_uri')).toBe(config.redirectUri);
		expect(params.get('response_type')).toBe('code');
		expect(params.get('state')).toBe('state-abc');
	});

	it('requests only read-only calendar scope (v1 never writes to calendars)', () => {
		const params = new URL(buildAuthUrl(config, 'state-abc')).searchParams;
		expect(params.get('scope')).toBe('https://www.googleapis.com/auth/calendar.readonly');
		expect(GOOGLE_SCOPES).toEqual(['https://www.googleapis.com/auth/calendar.readonly']);
	});
});

describe('exchangeCode', () => {
	it('posts the authorization code to the token endpoint', async () => {
		const { fn, calls } = stubFetch({
			access_token: 'access-1',
			refresh_token: 'refresh-1',
			expires_in: 3599
		});
		await exchangeCode(config, 'auth-code-xyz', { fetchFn: fn, now: 1_000_000 });

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
		const body = new URLSearchParams(calls[0].init.body as string);
		expect(body.get('code')).toBe('auth-code-xyz');
		expect(body.get('grant_type')).toBe('authorization_code');
		expect(body.get('client_id')).toBe(config.clientId);
		expect(body.get('client_secret')).toBe(config.clientSecret);
		expect(body.get('redirect_uri')).toBe(config.redirectUri);
	});

	it('converts expires_in into an absolute expiry so it survives a restart', async () => {
		const { fn } = stubFetch({
			access_token: 'access-1',
			refresh_token: 'refresh-1',
			expires_in: 3599
		});
		const tokens = await exchangeCode(config, 'code', { fetchFn: fn, now: 1_000_000 });
		expect(tokens.expiresAt).toBe(1_000_000 + 3599 * 1000);
		expect(tokens.accessToken).toBe('access-1');
		expect(tokens.refreshToken).toBe('refresh-1');
	});

	it('throws when Google rejects the exchange', async () => {
		const { fn } = stubFetch({ error: 'invalid_grant' }, { ok: false, status: 400 });
		await expect(exchangeCode(config, 'bad-code', { fetchFn: fn, now: 0 })).rejects.toThrow(
			/invalid_grant/
		);
	});

	it('throws when the response omits a refresh token', async () => {
		// Without one there is nothing durable to store, and calendars would stop working
		// as soon as the access token expires an hour later. Fail loudly at auth time.
		const { fn } = stubFetch({ access_token: 'access-1', expires_in: 3599 });
		await expect(exchangeCode(config, 'code', { fetchFn: fn, now: 0 })).rejects.toThrow(
			/refresh token/i
		);
	});
});

describe('refreshAccessToken', () => {
	it('posts the refresh token with the refresh_token grant', async () => {
		const { fn, calls } = stubFetch({ access_token: 'access-2', expires_in: 3599 });
		await refreshAccessToken(config, 'refresh-1', { fetchFn: fn, now: 5_000 });

		const body = new URLSearchParams(calls[0].init.body as string);
		expect(body.get('grant_type')).toBe('refresh_token');
		expect(body.get('refresh_token')).toBe('refresh-1');
	});

	it('keeps the existing refresh token when Google omits it from the response', async () => {
		// Google does NOT return refresh_token on a refresh. Overwriting the stored value
		// with undefined would silently destroy the grant, and calendars would stop syncing
		// an hour later with no obvious cause. This is the failure this test exists to catch.
		const { fn } = stubFetch({ access_token: 'access-2', expires_in: 3599 });
		const tokens = await refreshAccessToken(config, 'refresh-1', { fetchFn: fn, now: 5_000 });
		expect(tokens.refreshToken).toBe('refresh-1');
		expect(tokens.accessToken).toBe('access-2');
	});

	it('adopts a rotated refresh token when Google does return one', async () => {
		const { fn } = stubFetch({
			access_token: 'access-2',
			refresh_token: 'refresh-2',
			expires_in: 3599
		});
		const tokens = await refreshAccessToken(config, 'refresh-1', { fetchFn: fn, now: 5_000 });
		expect(tokens.refreshToken).toBe('refresh-2');
	});

	it('throws when the grant has been revoked', async () => {
		const { fn } = stubFetch({ error: 'invalid_grant' }, { ok: false, status: 400 });
		await expect(refreshAccessToken(config, 'revoked', { fetchFn: fn, now: 0 })).rejects.toThrow(
			/invalid_grant/
		);
	});
});

describe('isAccessTokenExpired', () => {
	it('is false well before expiry', () => {
		expect(isAccessTokenExpired(10_000_000, 9_000_000)).toBe(false);
	});

	it('is true after expiry', () => {
		expect(isAccessTokenExpired(10_000_000, 10_000_001)).toBe(true);
	});

	it('treats a token inside the skew window as already expired', () => {
		// Refreshing slightly early avoids a request that dies in flight against a token
		// that expires mid-call.
		expect(isAccessTokenExpired(10_000_000, 9_999_999, 60_000)).toBe(true);
		expect(isAccessTokenExpired(10_000_000, 9_930_000, 60_000)).toBe(false);
	});
});
