import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './db/schema';
import {
	upsertConnection,
	getConnection,
	markConnectionStatus,
	listConnections
} from './connections';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;
const originalKey = process.env.SECRETS_KEY;

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

describe('upsertConnection / getConnection', () => {
	it('round-trips a secrets payload through encryption', async () => {
		await upsertConnection(db, {
			provider: 'google',
			label: 'alex@example.com',
			secrets: { refreshToken: 'refresh-1', accessToken: 'access-1', expiresAt: 123 }
		});

		const connection = await getConnection(db, 'google');
		expect(connection?.secrets).toEqual({
			refreshToken: 'refresh-1',
			accessToken: 'access-1',
			expiresAt: 123
		});
	});

	it('never stores the secret in plaintext', async () => {
		await upsertConnection(db, {
			provider: 'google',
			label: 'alex@example.com',
			secrets: { refreshToken: 'super-secret-value' }
		});

		const raw = sqlite.prepare('SELECT secrets FROM connections').get() as { secrets: Buffer };
		expect(raw.secrets.toString('utf8')).not.toContain('super-secret-value');
	});

	it('returns null when the provider has never been connected', async () => {
		expect(await getConnection(db, 'todoist')).toBeNull();
	});

	it('replaces the existing row rather than accumulating duplicates', async () => {
		await upsertConnection(db, { provider: 'google', label: 'a', secrets: { v: 1 } });
		await upsertConnection(db, { provider: 'google', label: 'b', secrets: { v: 2 } });

		const rows = sqlite.prepare('SELECT * FROM connections WHERE provider = ?').all('google');
		expect(rows).toHaveLength(1);
		const connection = await getConnection(db, 'google');
		expect(connection?.label).toBe('b');
		expect(connection?.secrets).toEqual({ v: 2 });
	});

	it('returns the id of the row it created', async () => {
		const id = await upsertConnection(db, { provider: 'google', label: 'g', secrets: { v: 1 } });
		const connection = await getConnection(db, 'google');
		expect(id).toBe(connection?.id);
	});

	it('returns the same id on an update, not a new one', async () => {
		const firstId = await upsertConnection(db, {
			provider: 'google',
			label: 'a',
			secrets: { v: 1 }
		});
		const secondId = await upsertConnection(db, {
			provider: 'google',
			label: 'b',
			secrets: { v: 2 }
		});
		expect(secondId).toBe(firstId);
	});

	it('keeps providers independent', async () => {
		await upsertConnection(db, { provider: 'google', label: 'g', secrets: { which: 'google' } });
		await upsertConnection(db, { provider: 'todoist', label: 't', secrets: { which: 'todoist' } });

		expect((await getConnection(db, 'google'))?.secrets).toEqual({ which: 'google' });
		expect((await getConnection(db, 'todoist'))?.secrets).toEqual({ which: 'todoist' });
	});

	it('preserves status fields across a secrets update', async () => {
		await upsertConnection(db, { provider: 'google', label: 'g', secrets: { v: 1 } });
		const created = await getConnection(db, 'google');
		await markConnectionStatus(db, created!.id, { status: 'error', lastError: 'boom' });

		// A token refresh rewrites secrets; it must not silently clear the error state that
		// the settings screen (DESIGN.md §7.5) surfaces.
		await upsertConnection(db, { provider: 'google', label: 'g', secrets: { v: 2 } });
		const after = await getConnection(db, 'google');
		expect(after?.status).toBe('error');
		expect(after?.lastError).toBe('boom');
		expect(after?.secrets).toEqual({ v: 2 });
	});
});

describe('markConnectionStatus', () => {
	it('records a success with a timestamp and clears the previous error', async () => {
		await upsertConnection(db, { provider: 'google', label: 'g', secrets: {} });
		const connection = await getConnection(db, 'google');
		await markConnectionStatus(db, connection!.id, { status: 'error', lastError: 'boom' });
		await markConnectionStatus(db, connection!.id, {
			status: 'ok',
			lastSuccess: new Date(1_700_000_000_000)
		});

		const after = await getConnection(db, 'google');
		expect(after?.status).toBe('ok');
		expect(after?.lastError).toBeNull();
		expect(after?.lastSuccess).toEqual(new Date(1_700_000_000_000));
	});

	it('records an error without destroying the last success timestamp', async () => {
		// The settings screen wants to say "last synced 3 hours ago, currently failing".
		await upsertConnection(db, { provider: 'google', label: 'g', secrets: {} });
		const connection = await getConnection(db, 'google');
		await markConnectionStatus(db, connection!.id, {
			status: 'ok',
			lastSuccess: new Date(1_700_000_000_000)
		});
		await markConnectionStatus(db, connection!.id, { status: 'error', lastError: 'network down' });

		const after = await getConnection(db, 'google');
		expect(after?.lastSuccess).toEqual(new Date(1_700_000_000_000));
		expect(after?.lastError).toBe('network down');
	});
});

describe('listConnections', () => {
	it('returns every connection without decrypting secrets — the settings screen only needs status', async () => {
		await upsertConnection(db, {
			provider: 'google',
			label: 'alex@example.com',
			secrets: { refreshToken: 'super-secret' }
		});

		const [connection] = await listConnections(db);
		expect(connection).toMatchObject({ provider: 'google', label: 'alex@example.com' });
		expect(connection).not.toHaveProperty('secrets');
	});

	it('reflects status and error fields', async () => {
		await upsertConnection(db, { provider: 'google', label: 'g', secrets: {} });
		const [before] = await listConnections(db);
		await markConnectionStatus(db, before.id, { status: 'error', lastError: 'boom' });

		const [after] = await listConnections(db);
		expect(after.status).toBe('error');
		expect(after.lastError).toBe('boom');
	});

	it('returns an empty list when nothing is connected', async () => {
		expect(await listConnections(db)).toEqual([]);
	});
});
