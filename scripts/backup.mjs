#!/usr/bin/env node
// Nightly backup job — DESIGN.md §3.5 and §9.2 (03:00, inside the tablet's quiet hours).
//
// Backs up via better-sqlite3's Online Backup API rather than VACUUM INTO (see
// scripts/lib/backup-online.mjs for why) — it copies the live database without stopping
// the app or needing a fully quiet moment, and — critically — writes the *copy* to the NAS
// while the live database stays on the Pi's SD card (§3.5's corruption warning: SQLite
// locking doesn't work reliably over CIFS/NFS, so hearth.db itself must never live there).
//
// Run by the hearth-backup.timer systemd unit (see deploy/hearth-backup.*).

import Database from 'better-sqlite3';
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { selectBackupsToPrune } from './lib/backup-retention.mjs';
import { verifyBackup } from './lib/backup-verify.mjs';
import { runOnlineBackup } from './lib/backup-online.mjs';

const DATABASE_URL = process.env.DATABASE_URL ?? '/var/lib/hearth/hearth.db';
const BACKUP_DIR = process.env.HEARTH_BACKUP_DIR ?? '/mnt/nas/hearth/backups';
const KEEP = Number(process.env.HEARTH_BACKUP_KEEP ?? 14);

function timestamp() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
	const destination = path.join(BACKUP_DIR, `hearth-${timestamp()}.db`);

	const db = new Database(DATABASE_URL);
	try {
		await runOnlineBackup(db, destination);
	} finally {
		db.close();
	}
	console.log(`backed up ${DATABASE_URL} -> ${destination}`);

	// A backup nobody has verified is just a file that might restore. Checked here, the
	// same night it's written, rather than trusting the backup call's success alone — an
	// interrupted or bad-state write is exactly the failure this job exists to catch early,
	// not discover for the first time during an actual disaster restore.
	const verification = verifyBackup(destination);
	if (!verification.ok) {
		throw new Error(`backup verification failed for ${destination}: ${verification.reason}`);
	}
	console.log('backup verified: integrity_check ok, users table non-empty');

	const names = await readdir(BACKUP_DIR);
	const entries = await Promise.all(
		names
			.filter((name) => name.endsWith('.db'))
			.map(async (name) => ({ name, mtimeMs: (await stat(path.join(BACKUP_DIR, name))).mtimeMs }))
	);

	const toPrune = selectBackupsToPrune(entries, KEEP);
	for (const name of toPrune) {
		await unlink(path.join(BACKUP_DIR, name));
		console.log(`pruned ${name}`);
	}
}

main().catch((err) => {
	console.error('backup failed:', err);
	process.exitCode = 1;
});
