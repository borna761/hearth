#!/usr/bin/env node
// M1's hardware gate — docs/phase-5-plan.md and CLAUDE.md: run this on the actual Pi
// before M2 starts. protobufjs@5.0.3 (a transitive dependency of the `anylist` package,
// pulled in via its ancient legacy Builder API) is pure JS and therefore cannot fail the
// way this Pi's two prior native-binary dependencies did, but it predates Node 22 by years
// and has never actually run on this board's arm64 Node until this script does.
//
// Logs in, lists the account's lists, prints the grocery list's item count, tears down.
// Nothing here writes to AnyList or to hearth.db.
//
//   node --env-file=.env scripts/anylist-smoke.mjs
//
// Reads the connection scripts/connect-anylist.mjs already stored — run that first if
// this fails with "No AnyList connection found."
//
// Deliberately plain JS, no drizzle import, no import of src/lib/server/anylist/client.ts
// — same reasoning as every other scripts/*.mjs entry point. This script exists to answer
// one narrow question (does this library run on this Node/arch at all), not to exercise
// the adapter's own logic, so it talks to the `anylist` package and better-sqlite3
// directly.

import Database from 'better-sqlite3';
import { createDecipheriv } from 'node:crypto';
import AnyList from 'anylist';

const DATABASE_URL = process.env.DATABASE_URL ?? '/var/lib/hearth/hearth.db';
// Overridable for local testing; on the Pi this is the same path client.ts defaults to —
// see docs/phase-5-plan.md §2.3 for why it can't be the library's own default.
const CREDENTIALS_FILE =
	process.env.HEARTH_ANYLIST_CREDENTIALS_FILE ?? '/var/lib/hearth/anylist-credentials';
const GROCERY_LIST_NAME = 'My Grocery List'; // DESIGN.md §2.5

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
	const row = sqlite.prepare(`SELECT secrets FROM connections WHERE provider = 'anylist'`).get();
	sqlite.close();

	if (!row) {
		throw new Error(
			'No AnyList connection found. Run `node --env-file=.env scripts/connect-anylist.mjs` first.'
		);
	}

	const { email, password } = JSON.parse(decryptSecret(row.secrets));

	console.log(`Logging in as ${email}...`);
	const client = new AnyList({ email, password, credentialsFile: CREDENTIALS_FILE });
	await client.login();
	await client.getLists();

	console.log(`\nFound ${client.lists.length} list(s):`);
	for (const list of client.lists) {
		console.log(`  - ${list.name} (${list.items.length} items)`);
	}

	const grocery = client.getListByName(GROCERY_LIST_NAME);
	if (!grocery) {
		console.warn(`\nNo list named "${GROCERY_LIST_NAME}" — check the exact name on the account.`);
	} else {
		console.log(`\n"${GROCERY_LIST_NAME}": ${grocery.items.length} item(s).`);
	}

	client.teardown();
	console.log('\nOK — protobufjs decoded a real response on this Node/arch without incident.');
	// Belt and braces: `got`'s keep-alive agent and the (now torn-down) websocket can hold
	// the event loop open a little longer than a short-lived script should wait around for.
	process.exit(0);
}

main().catch((err) => {
	console.error('\nSmoke test failed:', err);
	process.exit(1);
});
