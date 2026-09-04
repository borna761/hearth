#!/usr/bin/env node
// docs/phase-6-todoist-plan.md M1's Pi gate. Unlike anylist-smoke.mjs, there's no native
// dependency or reverse-engineered protocol at stake here — Todoist's REST API is plain
// HTTPS, so there's nothing about running on this board's Node/arm64 to prove. What this
// does verify from the real hardware: the Pi can actually reach api.todoist.com (DNS, TLS,
// outbound HTTPS all work from behind whatever this network's firewall is), and the stored
// token is valid.
//
// Read-only. Nothing here writes to Todoist.
//
//   node --env-file=.env scripts/todoist-smoke.mjs
//
// Reads the connection scripts/connect-todoist.mjs already stored — run that first if
// this fails with "No Todoist connection found."
//
// Deliberately plain JS, no drizzle import, no import of src/lib/server/todoist/client.ts
// — same reasoning as every other scripts/*.mjs entry point: plain `node` can't import the
// TypeScript module without a build step.

import Database from 'better-sqlite3';
import { createDecipheriv } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL ?? '/var/lib/hearth/hearth.db';
const API_BASE = 'https://api.todoist.com/api/v1';

function getKey() {
	const hex = process.env.SECRETS_KEY;
	if (!hex) throw new Error('SECRETS_KEY is not set (need 64 hex chars / 32 bytes)');
	const key = Buffer.from(hex, 'hex');
	if (key.length !== 32) {
		throw new Error('SECRETS_KEY must be 32 bytes of hex (64 hex characters)');
	}
	return key;
}

/** Mirrors src/lib/server/crypto/secrets.ts's decryptSecret exactly. */
function decryptSecret(blob) {
	const iv = blob.subarray(0, 12);
	const authTag = blob.subarray(12, 28);
	const ciphertext = blob.subarray(28);
	const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
	decipher.setAuthTag(authTag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function main() {
	const sqlite = new Database(DATABASE_URL, { readonly: true });
	const row = sqlite.prepare(`SELECT secrets FROM connections WHERE provider = 'todoist'`).get();
	sqlite.close();

	if (!row) {
		throw new Error(
			'No Todoist connection found. Run `node --env-file=.env scripts/connect-todoist.mjs` first.'
		);
	}

	const { token } = JSON.parse(decryptSecret(row.secrets));

	console.log('Fetching projects...');
	const projectsRes = await fetch(`${API_BASE}/projects?limit=5`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!projectsRes.ok) {
		throw new Error(`GET /projects -> ${projectsRes.status}: ${await projectsRes.text()}`);
	}
	const projects = await projectsRes.json();
	console.log(`OK — ${projects.results.length} project(s) in this page.`);

	console.log('\nFetching overdue + due-today tasks...');
	const tasksRes = await fetch(
		`${API_BASE}/tasks/filter?query=${encodeURIComponent('overdue | today')}`,
		{ headers: { Authorization: `Bearer ${token}` } }
	);
	if (!tasksRes.ok) {
		throw new Error(`GET /tasks/filter -> ${tasksRes.status}: ${await tasksRes.text()}`);
	}
	const tasks = await tasksRes.json();
	console.log(`OK — ${tasks.results.length} task(s) overdue or due today.`);

	console.log('\nOK — the Pi can reach api.todoist.com and the stored token works.');
}

main().catch((err) => {
	console.error('\nSmoke test failed:', err);
	process.exit(1);
});
