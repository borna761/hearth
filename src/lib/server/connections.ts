// Storage for external-account credentials — DESIGN.md §8's `connections` table.
//
// Every provider's secrets go through AES-256-GCM (src/lib/server/crypto/secrets.ts)
// before touching the database, because hearth.db is copied to the NAS nightly (§3.5)
// and a plaintext refresh token would be sitting in every backup.

import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { connections } from './db/schema';
import { encryptSecret, decryptSecret } from './crypto/secrets';
import type * as schema from './db/schema';

type Db = BetterSQLite3Database<typeof schema>;
// No 'unsplash' — guest mode uses Picsum instead (phase 4 milestone 3), which needs no
// key and therefore never creates a connections row at all. See DESIGN.md's changelog.
type Provider = 'google' | 'todoist' | 'anylist';

export interface ConnectionRecord<T = Record<string, unknown>> {
	id: number;
	provider: Provider;
	label: string;
	secrets: T;
	status: string;
	lastSuccess: Date | null;
	lastError: string | null;
}

export async function upsertConnection(
	db: Db,
	input: { provider: Provider; label: string; secrets: unknown }
): Promise<number> {
	const secrets = encryptSecret(JSON.stringify(input.secrets));
	const existing = await db
		.select({ id: connections.id })
		.from(connections)
		.where(eq(connections.provider, input.provider))
		.limit(1);

	if (existing.length > 0) {
		// Deliberately narrow: a token refresh rewrites secrets many times a day and must
		// not reset status/lastError, which the settings screen (§7.5) reads.
		await db
			.update(connections)
			.set({ label: input.label, secrets })
			.where(eq(connections.id, existing[0].id));
		return existing[0].id;
	}

	const [row] = await db
		.insert(connections)
		.values({
			provider: input.provider,
			label: input.label,
			secrets
		})
		.returning({ id: connections.id });
	return row.id;
}

export async function getConnection<T = Record<string, unknown>>(
	db: Db,
	provider: Provider
): Promise<ConnectionRecord<T> | null> {
	const rows = await db
		.select()
		.from(connections)
		.where(eq(connections.provider, provider))
		.limit(1);
	if (rows.length === 0) return null;

	const row = rows[0];
	return {
		id: row.id,
		provider: row.provider,
		label: row.label,
		secrets: JSON.parse(decryptSecret(row.secrets as Buffer)) as T,
		status: row.status,
		lastSuccess: row.lastSuccess,
		lastError: row.lastError
	};
}

export interface ConnectionSummary {
	id: number;
	provider: Provider;
	label: string;
	status: string;
	lastSuccess: Date | null;
	lastError: string | null;
}

/** For the settings screen (DESIGN.md §7.5) — status only, secrets never decrypted here. */
export async function listConnections(db: Db): Promise<ConnectionSummary[]> {
	return db
		.select({
			id: connections.id,
			provider: connections.provider,
			label: connections.label,
			status: connections.status,
			lastSuccess: connections.lastSuccess,
			lastError: connections.lastError
		})
		.from(connections);
}

export async function markConnectionStatus(
	db: Db,
	id: number,
	update: { status: 'ok' | 'error'; lastSuccess?: Date; lastError?: string }
): Promise<void> {
	await db
		.update(connections)
		.set({
			status: update.status,
			// A success clears the error; a failure leaves lastSuccess alone so the UI can
			// still say how stale the data is.
			lastError: update.status === 'ok' ? null : (update.lastError ?? null),
			...(update.lastSuccess ? { lastSuccess: update.lastSuccess } : {})
		})
		.where(eq(connections.id, id));
}
