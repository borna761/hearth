// better-sqlite3's Online Backup API (Database#backup), not VACUUM INTO — VACUUM INTO
// throws SQLITE_BUSY outright if any other connection has a write transaction open at the
// moment it starts, which turned out to be effectively always true on this Pi: the main
// server process runs continuously (calendar sync alone ticks every
// HEARTH_SYNC_INTERVAL_MINUTES), so there was rarely a fully quiet instant for it to grab.
// Confirmed live: even with no other nightly job running, a manual VACUUM INTO burned
// through 5 retries over ~37s and still failed.
//
// The Online Backup API instead copies the source page-by-page (sqlite3_backup_step) and,
// per its own C source, treats SQLITE_BUSY as "this step made no progress" rather than an
// error — it just retries that page on the next tick until the writer clears, indefinitely.
// It's the primitive SQLite itself documents for backing up a live, actively-written
// database, which VACUUM INTO was never actually designed for.
export async function runOnlineBackup(db, destination) {
	await db.backup(destination);
}
