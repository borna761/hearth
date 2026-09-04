#!/usr/bin/env node
// Creates the household's users interactively — DESIGN.md §13's open question #1
// ("PIN values ... set at first run rather than committed anywhere"). Run once, by hand,
// over SSH:
//   node --env-file=.env scripts/seed-users.mjs
//
// Deliberately plain JS with no build step and no drizzle schema import, same reasoning
// as scripts/migrate.mjs: plain `node` can't import the TypeScript schema module, and a
// handful of interactive inserts don't need the query builder — raw SQL against
// better-sqlite3 directly is simpler and has nothing to keep in sync with the schema file
// beyond the column names below. Hashes the PIN inline via hash-wasm rather than importing
// src/lib/server/auth/pin.ts, which also carries lockout logic that has no business in a
// one-shot seeding script. hash-wasm (WASM argon2id), not @node-rs/argon2 (native): the
// native linux-arm64-gnu prebuild crashes with "Illegal instruction" on the real Pi Zero
// 2 W — its Cortex-A53 cores lack the ARMv8.1 atomic instructions the prebuild assumes are
// always present on aarch64. See src/lib/server/auth/pin.ts for the full explanation; the
// hash parameters here match pin.ts's exactly, though hash-wasm's encoded output format is
// self-describing so that isn't strictly required for verification to work later.

import Database from 'better-sqlite3';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { argon2id } from 'hash-wasm';
import { normalizeHexColor } from './lib/color.mjs';

const DATABASE_URL = process.env.DATABASE_URL ?? '/var/lib/hearth/hearth.db';

async function hashPin(pin) {
	return argon2id({
		password: pin,
		salt: randomBytes(16),
		parallelism: 1,
		iterations: 2,
		memorySize: 19_456,
		hashLength: 32,
		outputType: 'encoded'
	});
}

// The callback-based readline module, not readline/promises: masking a PIN prompt needs
// the _writeToOutput override below, which only exists on this module's Interface.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
	return new Promise((resolve) => rl.question(prompt, resolve));
}

/** Masks each keystroke with '*' so the PIN never appears in a terminal scrollback. */
function promptHidden(prompt) {
	// Write the prompt text itself unmasked, then mask only the subsequent per-keystroke
	// echoes — question()'s own internal write of `prompt` would otherwise get masked too.
	process.stdout.write(prompt);
	const original = rl._writeToOutput.bind(rl);
	rl._writeToOutput = (str) => original(str.replace(/[^\n]/g, '*'));
	return ask('').finally(() => {
		rl._writeToOutput = original;
	});
}

async function promptPin() {
	while (true) {
		// Exactly 4, not "4+" — DESIGN.md §13 specifies "four-digit PINs", and a fixed
		// length is what lets the lock screen auto-submit on the 4th digit instead of
		// needing an explicit confirm button.
		const first = await promptHidden('  PIN (4 digits): ');
		if (!/^\d{4}$/.test(first)) {
			console.log('  A PIN must be exactly 4 digits, numbers only. Try again.');
			continue;
		}
		const second = await promptHidden('  Confirm PIN: ');
		if (first !== second) {
			console.log("  Those didn't match. Try again.");
			continue;
		}
		return first;
	}
}

/** Accepts the '#' being left off and normalizes it back in — see lib/color.mjs for why
 * that's worth guarding rather than trusting free-text input here. */
async function promptColor() {
	while (true) {
		const raw = (await ask('Color (e.g. #3b82f6): ')).trim();
		const normalized = normalizeHexColor(raw);
		if (normalized) return normalized;
		console.log('  Not a valid hex color (6 hex digits, # optional). Try again.');
	}
}

async function promptUser() {
	const name = (await ask('Name: ')).trim();
	const color = await promptColor();
	const viewModeRaw = (await ask('View mode [standard/simple] (default standard): '))
		.trim()
		.toLowerCase();
	const isAdminRaw = (await ask('Admin — can reach /settings? (y/N): ')).trim().toLowerCase();
	const pin = await promptPin();

	return {
		name,
		color,
		viewMode: viewModeRaw === 'simple' ? 'simple' : 'standard',
		isAdmin: isAdminRaw.startsWith('y') ? 1 : 0,
		pinHash: await hashPin(pin)
	};
}

async function main() {
	console.log(`Seeding users into ${DATABASE_URL}\n`);

	const sqlite = new Database(DATABASE_URL);
	sqlite.pragma('foreign_keys = ON');
	const insert = sqlite.prepare(
		`INSERT INTO users (name, color, view_mode, is_admin, pin_hash) VALUES (?, ?, ?, ?, ?)`
	);

	const created = [];
	let addAnother = true;
	while (addAnother) {
		console.log(`\n--- User ${created.length + 1} ---`);
		const user = await promptUser();
		const result = insert.run(user.name, user.color, user.viewMode, user.isAdmin, user.pinHash);
		created.push({ id: result.lastInsertRowid, ...user });

		const again = (await ask('\nAdd another user? (Y/n): ')).trim().toLowerCase();
		addAnother = again !== 'n';
	}

	console.log('\nCreated:');
	for (const user of created) {
		console.log(
			`  #${user.id}  ${user.name}  ${user.color}  ${user.viewMode}  admin=${Boolean(user.isAdmin)}`
		);
	}

	rl.close();
	sqlite.close();
}

main().catch((err) => {
	console.error(err);
	rl.close();
	process.exit(1);
});
