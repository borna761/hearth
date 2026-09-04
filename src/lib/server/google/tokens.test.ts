import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../db/schema';
import { getConnection } from '../connections';
import { getValidAccessToken, getValidAccessTokenForConnection, storeGoogleTokens } from './tokens';
import type { GoogleOAuthConfig } from './oauth';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;
const originalKey = process.env.SECRETS_KEY;

const config: GoogleOAuthConfig = {
	clientId: 'client-id',
	clientSecret: 'client-secret',
	redirectUri: 'https://example.ts.net/auth/google/callback'
};

beforeEach(() => {
	process.env.SECRETS_KEY = randomBytes(32).toString('hex');
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
});

afterEach(() => {
	sqlite.close();
	process.env.SECRETS_KEY = originalKey;
});

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
	return vi.fn(
		async () =>
			({
				ok: init.ok ?? true,
				status: init.status ?? 200,
				json: async () => body
			}) as Response
	) as unknown as typeof fetch;
}

describe('getValidAccessToken', () => {
	it('returns the stored token without a network call while it is still valid', async () => {
		await storeGoogleTokens(db, 'alex@example.com', {
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
			expiresAt: 10_000_000
		});
		const fetchFn = stubFetch({});

		const token = await getValidAccessToken(db, config, { fetchFn, now: 9_000_000 });

		expect(token).toBe('access-1');
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('refreshes an expired token and returns the new one', async () => {
		await storeGoogleTokens(db, 'alex@example.com', {
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
			expiresAt: 10_000_000
		});
		const fetchFn = stubFetch({ access_token: 'access-2', expires_in: 3600 });

		const token = await getValidAccessToken(db, config, { fetchFn, now: 10_000_001 });

		expect(token).toBe('access-2');
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it('persists the refreshed token so the next call does not refresh again', async () => {
		await storeGoogleTokens(db, 'alex@example.com', {
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
			expiresAt: 10_000_000
		});
		const fetchFn = stubFetch({ access_token: 'access-2', expires_in: 3600 });
		await getValidAccessToken(db, config, { fetchFn, now: 10_000_001 });

		const stored = await getConnection<{ accessToken: string; expiresAt: number }>(db, 'google');
		expect(stored?.secrets.accessToken).toBe('access-2');
		expect(stored?.secrets.expiresAt).toBe(10_000_001 + 3600 * 1000);
	});

	it('keeps the refresh token when Google omits it from the refresh response', async () => {
		// Regression guard for the whole grant: losing this value means re-authorizing by
		// hand, and the failure would not show up until the next refresh an hour later.
		await storeGoogleTokens(db, 'alex@example.com', {
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
			expiresAt: 10_000_000
		});
		const fetchFn = stubFetch({ access_token: 'access-2', expires_in: 3600 });
		await getValidAccessToken(db, config, { fetchFn, now: 10_000_001 });

		const stored = await getConnection<{ refreshToken: string }>(db, 'google');
		expect(stored?.secrets.refreshToken).toBe('refresh-1');
	});

	it('throws a clear error when Google has never been connected', async () => {
		await expect(
			getValidAccessToken(db, config, { fetchFn: stubFetch({}), now: 0 })
		).rejects.toThrow(/not connected/i);
	});

	it('marks the connection as errored when the grant has been revoked', async () => {
		await storeGoogleTokens(db, 'alex@example.com', {
			accessToken: 'access-1',
			refreshToken: 'revoked',
			expiresAt: 10_000_000
		});
		const fetchFn = stubFetch({ error: 'invalid_grant' }, { ok: false, status: 400 });

		await expect(getValidAccessToken(db, config, { fetchFn, now: 10_000_001 })).rejects.toThrow(
			/invalid_grant/
		);

		// DESIGN.md §11 wants an alert card when the refresh token is lost, which needs the
		// failure recorded rather than only thrown.
		const stored = await getConnection(db, 'google');
		expect(stored?.status).toBe('error');
		expect(stored?.lastError).toMatch(/invalid_grant/);
	});
});

describe('getValidAccessTokenForConnection', () => {
	it('refreshes and persists using the connection it was given, without looking one up itself', async () => {
		await storeGoogleTokens(db, 'alex@example.com', {
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
			expiresAt: 10_000_000
		});
		const connection = await getConnection<{
			accessToken: string;
			refreshToken: string;
			expiresAt: number;
		}>(db, 'google');
		const fetchFn = stubFetch({ access_token: 'access-2', expires_in: 3600 });

		const token = await getValidAccessTokenForConnection(db, connection!, config, {
			fetchFn,
			now: 10_000_001
		});

		expect(token).toBe('access-2');
		const stored = await getConnection<{ accessToken: string }>(db, 'google');
		expect(stored?.secrets.accessToken).toBe('access-2');
	});
});

describe('storeGoogleTokens', () => {
	it('returns the connection id, so the caller can discover calendars against it', async () => {
		const id = await storeGoogleTokens(db, 'alex@example.com', {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: 1
		});
		const stored = await getConnection(db, 'google');
		expect(id).toBe(stored?.id);
	});

	it('labels the connection with the authorized account', async () => {
		await storeGoogleTokens(db, 'alex@example.com', {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: 1
		});
		const stored = await getConnection(db, 'google');
		expect(stored?.label).toBe('alex@example.com');
		expect(stored?.provider).toBe('google');
	});

	it('replaces a previous grant when the flow is re-run', async () => {
		await storeGoogleTokens(db, 'old@gmail.com', {
			accessToken: 'a1',
			refreshToken: 'r1',
			expiresAt: 1
		});
		await storeGoogleTokens(db, 'new@gmail.com', {
			accessToken: 'a2',
			refreshToken: 'r2',
			expiresAt: 2
		});

		const rows = sqlite.prepare('SELECT * FROM connections WHERE provider = ?').all('google');
		expect(rows).toHaveLength(1);
		const stored = await getConnection<{ refreshToken: string }>(db, 'google');
		expect(stored?.secrets.refreshToken).toBe('r2');
	});
});
