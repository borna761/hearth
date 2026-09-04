#!/usr/bin/env node
// Verifies a nightly backup (scripts/backup.mjs) by hand — for a periodic spot check, or an
// actual disaster-recovery drill, without waiting for tonight's job to run again.
//
//   node --env-file=.env scripts/verify-backup.mjs                # most recent backup
//   node --env-file=.env scripts/verify-backup.mjs path/to/one.db # a specific file
//
// Read-only: never touches the live database, never writes anything.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { verifyBackup } from './lib/backup-verify.mjs';

const BACKUP_DIR = process.env.HEARTH_BACKUP_DIR ?? '/mnt/nas/hearth/backups';

async function mostRecentBackup() {
	const names = (await readdir(BACKUP_DIR)).filter((name) => name.endsWith('.db'));
	if (names.length === 0) {
		throw new Error(`no .db files found in ${BACKUP_DIR}`);
	}
	const entries = await Promise.all(
		names.map(async (name) => ({
			name,
			mtimeMs: (await stat(path.join(BACKUP_DIR, name))).mtimeMs
		}))
	);
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return path.join(BACKUP_DIR, entries[0].name);
}

async function main() {
	const target = process.argv[2] ?? (await mostRecentBackup());
	console.log(`Verifying ${target}...`);

	const result = verifyBackup(target);
	if (!result.ok) {
		console.error(`FAILED: ${result.reason}`);
		process.exitCode = 1;
		return;
	}
	console.log('OK — integrity_check passed, users table non-empty.');
}

main().catch((err) => {
	console.error('verify-backup failed:', err);
	process.exitCode = 1;
});
