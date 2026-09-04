// Access-token lifecycle for the single Google grant (DESIGN.md §2.6).
//
// Everything that calls the Calendar API goes through getValidAccessToken, so refreshing
// happens in exactly one place and the refreshed token is always written back.

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';
import {
	getConnection,
	upsertConnection,
	markConnectionStatus,
	type ConnectionRecord
} from '../connections';
import { refreshAccessToken, isAccessTokenExpired, type GoogleOAuthConfig } from './oauth';

type Db = BetterSQLite3Database<typeof schema>;

export interface StoredGoogleSecrets {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

export async function storeGoogleTokens(
	db: Db,
	accountEmail: string,
	tokens: StoredGoogleSecrets
): Promise<number> {
	return upsertConnection(db, {
		provider: 'google',
		label: accountEmail,
		secrets: tokens
	});
}

/**
 * Same as `getValidAccessToken`, but takes an already-fetched connection instead of
 * looking one up — for callers (like the sync scheduler) that already have it, so the
 * same row isn't read from the database twice in one cycle.
 */
export async function getValidAccessTokenForConnection(
	db: Db,
	connection: ConnectionRecord<StoredGoogleSecrets>,
	config: GoogleOAuthConfig,
	options: { fetchFn?: typeof fetch; now?: number } = {}
): Promise<string> {
	const now = options.now ?? Date.now();

	if (!isAccessTokenExpired(connection.secrets.expiresAt, now)) {
		return connection.secrets.accessToken;
	}

	let refreshed;
	try {
		refreshed = await refreshAccessToken(config, connection.secrets.refreshToken, {
			fetchFn: options.fetchFn,
			now
		});
	} catch (err) {
		// Surfaced on the settings screen as the alert card DESIGN.md §11 calls for — a lost
		// refresh token needs a human to re-authorize, so it must not fail silently.
		const message = err instanceof Error ? err.message : String(err);
		await markConnectionStatus(db, connection.id, { status: 'error', lastError: message });
		throw err;
	}

	await storeGoogleTokens(db, connection.label, refreshed);
	return refreshed.accessToken;
}

export async function getValidAccessToken(
	db: Db,
	config: GoogleOAuthConfig,
	options: { fetchFn?: typeof fetch; now?: number } = {}
): Promise<string> {
	const connection = await getConnection<StoredGoogleSecrets>(db, 'google');

	if (!connection) {
		throw new Error('Google is not connected — visit /auth/google/start to authorize.');
	}

	return getValidAccessTokenForConnection(db, connection, config, options);
}
