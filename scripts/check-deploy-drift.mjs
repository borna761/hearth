#!/usr/bin/env node
// Read-only drift check against the live Pi — catches the two failure modes that have
// silently broken things before (CLAUDE.md; scripts/deploy.sh): a var added to
// deploy/hearth.env.example that never made it into the Pi's actual /etc/hearth/hearth.env
// (which does not auto-update), and a new systemd unit shipped in deploy/ that was never
// installed/enabled on the Pi (confirmed live: hearth-music-scan.service/.timer existed in
// the repo but nowhere on the Pi). Never writes to the Pi — every remote command below is
// a read (cat/ls), nothing else.
//
//   node scripts/check-deploy-drift.mjs
//
// Config: same HEARTH_HOST/HEARTH_USER env vars as scripts/deploy.sh.
// Exits non-zero if either check finds drift, so deploy.sh can surface it without
// treating it as fatal.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvKeys, diffKeys, buildInstallUnitsCommand } from './lib/deploy-drift.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HEARTH_HOST = process.env.HEARTH_HOST ?? 'hearth.local';
const HEARTH_USER = process.env.HEARTH_USER ?? 'hearth';
const HEARTH_PATH = process.env.HEARTH_PATH ?? '/opt/hearth';
const REMOTE = `${HEARTH_USER}@${HEARTH_HOST}`;

function ssh(remoteCommand) {
	return execFileSync('ssh', [REMOTE, remoteCommand], { encoding: 'utf8' });
}

function checkEnvDrift() {
	const exampleText = readFileSync(path.join(ROOT, 'deploy/hearth.env.example'), 'utf8');
	const expected = parseEnvKeys(exampleText);

	// Only key names ever cross the wire — never values, so a real SECRETS_KEY/token can't
	// leak into this script's output.
	const liveText = ssh("grep -oE '^[A-Z_]+=' /etc/hearth/hearth.env || true");
	const live = liveText
		.split('\n')
		.map((line) => line.replace(/=$/, ''))
		.filter(Boolean);

	return diffKeys(expected, live).missing;
}

function checkSystemdUnitDrift() {
	const expected = readdirSync(path.join(ROOT, 'deploy')).filter(
		(name) => name.endsWith('.service') || name.endsWith('.timer')
	);

	const liveText = ssh("ls /etc/systemd/system | grep '^hearth' || true");
	const live = liveText.split('\n').filter(Boolean);

	return diffKeys(expected, live).missing;
}

function main() {
	console.log(`==> checking deploy drift against ${REMOTE} (read-only)`);

	const missingEnvKeys = checkEnvDrift();
	const missingUnits = checkSystemdUnitDrift();

	if (missingEnvKeys.length === 0 && missingUnits.length === 0) {
		console.log('    no drift found');
		return;
	}

	if (missingEnvKeys.length > 0) {
		console.warn(
			`    WARNING: /etc/hearth/hearth.env on the Pi is missing: ${missingEnvKeys.join(', ')}`
		);
		console.warn('      -> add these by hand: ssh ' + REMOTE + ' sudo nano /etc/hearth/hearth.env');
	}
	if (missingUnits.length > 0) {
		console.warn(`    WARNING: not installed on the Pi: ${missingUnits.join(', ')}`);
		console.warn('      -> run this on the Pi (see deploy/README.md §8):');
		const command = buildInstallUnitsCommand(missingUnits, HEARTH_PATH);
		for (const line of command.split('\n')) {
			console.warn(`         ${line}`);
		}
	}
	process.exitCode = 1;
}

main();
