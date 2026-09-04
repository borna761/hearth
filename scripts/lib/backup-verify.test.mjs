import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { verifyBackup } from './backup-verify.mjs';

let dir;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'hearth-backup-verify-'));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function validBackup(userCount = 1) {
	const file = path.join(dir, 'valid.db');
	const db = new Database(file);
	db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
	for (let i = 0; i < userCount; i++) {
		db.prepare('INSERT INTO users (name) VALUES (?)').run(`user-${i}`);
	}
	db.close();
	return file;
}

describe('verifyBackup', () => {
	it('passes a real, non-empty database', () => {
		expect(verifyBackup(validBackup(1))).toEqual({ ok: true });
	});

	it('fails when the users table is empty — likely the wrong or a stale database', () => {
		const file = validBackup(0);
		const result = verifyBackup(file);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/empty/);
	});

	it('fails on a file that is not a SQLite database at all', () => {
		const file = path.join(dir, 'garbage.db');
		writeFileSync(file, 'not a sqlite file');
		const result = verifyBackup(file);
		expect(result.ok).toBe(false);
	});

	it('fails when the file does not exist', () => {
		const result = verifyBackup(path.join(dir, 'missing.db'));
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/could not open/);
	});

	it('fails on a truncated/corrupt database file', () => {
		const file = validBackup(1);
		// Chop the file in half — a real database file, but no longer structurally valid,
		// the exact shape of corruption integrity_check exists to catch.
		const original = readFileSync(file);
		writeFileSync(file, original.subarray(0, Math.floor(original.length / 2)));
		const result = verifyBackup(file);
		expect(result.ok).toBe(false);
	});
});
