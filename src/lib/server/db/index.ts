import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';
import { env } from '$env/dynamic/private';

if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

export function openDatabase(path: string) {
	const client = new Database(path);
	// SQLite doesn't enforce FKs by default, and cascade deletes (visibility,
	// sources, events, ...) depend on it. journal_mode=WAL + synchronous=NORMAL
	// per DESIGN.md §3.4, for SD card longevity on the Pi.
	client.pragma('foreign_keys = ON');
	client.pragma('journal_mode = WAL');
	client.pragma('synchronous = NORMAL');
	return drizzle(client, { schema });
}

export const db = openDatabase(env.DATABASE_URL);
