import Database from 'better-sqlite3';

/**
 * Opens a backup file read-only and confirms it's not just syntactically valid SQLite but
 * the real Hearth database — `VACUUM INTO` can, in principle, still write a file that opens
 * fine but is truncated or empty if the source connection was in a bad state. `integrity_check`
 * catches structural corruption; the row-count check below catches "valid but wrong/empty,"
 * which `integrity_check` alone would not.
 *
 * @param {string} path
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyBackup(path) {
	let db;
	try {
		db = new Database(path, { readonly: true, fileMustExist: true });
	} catch (err) {
		return { ok: false, reason: `could not open: ${err.message}` };
	}

	try {
		const result = db.pragma('integrity_check');
		const first = result[0]?.integrity_check;
		if (first !== 'ok') {
			return { ok: false, reason: `integrity_check failed: ${JSON.stringify(result)}` };
		}

		const row = db.prepare('SELECT COUNT(*) AS count FROM users').get();
		if (!row || row.count < 1) {
			return { ok: false, reason: 'users table is empty — likely the wrong or a stale database' };
		}

		return { ok: true };
	} catch (err) {
		return { ok: false, reason: `query failed: ${err.message}` };
	} finally {
		db.close();
	}
}
