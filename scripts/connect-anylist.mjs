#!/usr/bin/env node
// Stores the household's AnyList account credentials as an encrypted `connections` row —
// docs/phase-5-plan.md M1. Needed before scripts/anylist-smoke.mjs has anything to log in
// with, since the admin-gated Settings connect form doesn't exist until M6. Re-running
// this rotates the stored password without disturbing status/last_error. Run once, by
// hand, over SSH:
//
//   node --env-file=.env scripts/connect-anylist.mjs
//
// Deliberately plain JS with no build step and no drizzle import — same reasoning as every
// other scripts/*.mjs entry point: plain `node` can't import the TypeScript schema module.
// Reimplements the AES-256-GCM envelope from src/lib/server/crypto/secrets.ts inline (iv |
// authTag | ciphertext) rather than importing that module, the same tradeoff
// scripts/seed-users.mjs makes for PIN hashing — the wire format is small and fixed, and
// importing the TypeScript module would need a build step this script doesn't otherwise
// need. Keep the two in sync by hand if the envelope format ever changes.

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

/** Mirrors src/lib/server/crypto/secrets.ts's encryptSecret exactly, so the app can
 *  decrypt what this script writes. */
function encryptSecret(plaintext) {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

// The callback-based readline module, not readline/promises — promptHidden below needs
// the _writeToOutput override, which only exists on this module's Interface. Same
// technique as scripts/seed-users.mjs's promptHidden.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
	return new Promise((resolve) => rl.question(prompt, resolve));
}

/** Masks each keystroke with '*' so the account password never appears in a terminal
 *  scrollback. */
function promptHidden(prompt) {
	process.stdout.write(prompt);
	const original = rl._writeToOutput.bind(rl);
	rl._writeToOutput = (str) => original(str.replace(/[^\n]/g, '*'));
	return ask('').finally(() => {
		rl._writeToOutput = original;
	});
}

async function main() {
	console.log(`Storing an AnyList connection into ${DATABASE_URL}\n`);

	const email = (await ask('AnyList email: ')).trim();
	const password = await promptHidden('AnyList password: ');
	rl.close();

	if (!email || !password) {
		throw new Error('Both an email and a password are required.');
	}

	const secrets = encryptSecret(JSON.stringify({ email, password }));

	const sqlite = new Database(DATABASE_URL);
	sqlite.pragma('foreign_keys = ON');

	const existing = sqlite.prepare(`SELECT id FROM connections WHERE provider = 'anylist'`).get();

	if (existing) {
		// Deliberately narrow, matching connections.ts's upsertConnection: a re-run rotates
		// the password without touching status/last_error, which the settings screen
		// (§7.5, M6) reads.
		sqlite
			.prepare(`UPDATE connections SET label = ?, secrets = ? WHERE id = ?`)
			.run(email, secrets, existing.id);
		console.log(`\nUpdated the existing AnyList connection (#${existing.id}).`);
	} else {
		const result = sqlite
			.prepare(`INSERT INTO connections (provider, label, secrets) VALUES ('anylist', ?, ?)`)
			.run(email, secrets);
		console.log(`\nCreated AnyList connection #${result.lastInsertRowid}.`);
	}

	sqlite.close();
	console.log('\nNext: node --env-file=.env scripts/anylist-smoke.mjs');
}

main().catch((err) => {
	console.error(err);
	rl.close();
	process.exit(1);
});
