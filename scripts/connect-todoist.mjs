#!/usr/bin/env node
// Stores the household's Todoist personal API token as an encrypted `connections` row —
// docs/phase-6-todoist-plan.md M1. Needed before scripts/todoist-smoke.mjs has anything to
// call with, since the admin-gated Settings connect form doesn't exist until a later
// milestone. Re-running this rotates the stored token without disturbing status/last_error.
// Run once, by hand, over SSH:
//
//   node --env-file=.env scripts/connect-todoist.mjs
//
// Deliberately plain JS with no build step and no drizzle import — same reasoning as every
// other scripts/*.mjs entry point, and the same AES-256-GCM envelope
// scripts/connect-anylist.mjs reimplements inline for the same reason (mirrors
// src/lib/server/crypto/secrets.ts's encryptSecret exactly; keep the two in sync by hand
// if the envelope format ever changes).

import Database from 'better-sqlite3';
import readline from 'node:readline';
import { createCipheriv, randomBytes } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL ?? '/var/lib/hearth/hearth.db';

function getKey() {
	const hex = process.env.SECRETS_KEY;
	if (!hex) throw new Error('SECRETS_KEY is not set (need 64 hex chars / 32 bytes)');
	const key = Buffer.from(hex, 'hex');
	if (key.length !== 32) {
		throw new Error('SECRETS_KEY must be 32 bytes of hex (64 hex characters)');
	}
	return key;
}

function encryptSecret(plaintext) {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
	return new Promise((resolve) => rl.question(prompt, resolve));
}

/** Masks each keystroke with '*' so the token never appears in a terminal scrollback. */
function promptHidden(prompt) {
	process.stdout.write(prompt);
	const original = rl._writeToOutput.bind(rl);
	rl._writeToOutput = (str) => original(str.replace(/[^\n]/g, '*'));
	return ask('').finally(() => {
		rl._writeToOutput = original;
	});
}

async function main() {
	console.log(`Storing a Todoist connection into ${DATABASE_URL}\n`);

	const token = (await promptHidden('Todoist personal API token: ')).trim();
	rl.close();

	if (!token) {
		throw new Error('A token is required.');
	}

	const secrets = encryptSecret(JSON.stringify({ token }));

	const sqlite = new Database(DATABASE_URL);
	sqlite.pragma('foreign_keys = ON');

	const existing = sqlite.prepare(`SELECT id FROM connections WHERE provider = 'todoist'`).get();

	if (existing) {
		// Deliberately narrow, matching connections.ts's upsertConnection: a re-run rotates
		// the token without touching status/last_error, which the settings screen reads.
		sqlite
			.prepare(`UPDATE connections SET label = ?, secrets = ? WHERE id = ?`)
			.run('personal token', secrets, existing.id);
		console.log(`\nUpdated the existing Todoist connection (#${existing.id}).`);
	} else {
		const result = sqlite
			.prepare(`INSERT INTO connections (provider, label, secrets) VALUES ('todoist', ?, ?)`)
			.run('personal token', secrets);
		console.log(`\nCreated Todoist connection #${result.lastInsertRowid}.`);
	}

	sqlite.close();
	console.log('\nNext: node --env-file=.env scripts/todoist-smoke.mjs');
}

main().catch((err) => {
	console.error(err);
	rl.close();
	process.exit(1);
});
