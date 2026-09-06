#!/usr/bin/env node
// Produces a scrubbed snapshot of this repo for a public copy — the reusable version of
// the one-off pass done to seed github.com/borna761/hearth. Two-piece design on purpose:
// this file and scripts/lib/scrub-rules.mjs are the generic engine (safe to publish,
// contain no actual personal data); the real substitutions live in
// scripts/scrub-rules.data.mjs, which is gitignored and never committed — see
// scripts/scrub-rules.data.example.mjs for its shape and how to create your own.
//
//   node scripts/scrub-for-public.mjs /path/to/output/dir
//
// Copies every git-tracked file (via `git ls-files`, so .gitignore is respected
// automatically — node_modules/build/.svelte-kit/local.db etc. are never touched) into
// the output directory, running each through the rules file. Prints a per-rule hit count
// at the end — a rule with 0 hits usually means the private repo's wording moved on and
// that rule no longer matches anything, which is exactly the kind of drift worth noticing
// before trusting the output. This only ever writes to the output directory; the private
// repo you run it from is never modified.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyScrubRules } from './lib/scrub-rules.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RULES_PATH = path.join(ROOT, 'scripts/scrub-rules.data.mjs');

async function loadRules() {
	if (!existsSync(RULES_PATH)) {
		throw new Error(
			`${RULES_PATH} doesn't exist. Copy scripts/scrub-rules.data.example.mjs to ` +
				`scripts/scrub-rules.data.mjs and fill in your real values — see that file's ` +
				`header for the format. It's gitignored on purpose; never commit it.`
		);
	}
	return (await import(RULES_PATH)).default;
}

function isProbablyBinary(buffer) {
	// A NUL byte in the first 8KB is the standard heuristic (same one git itself uses) —
	// none of this repo's tracked files are binary today, but a future image/font
	// shouldn't get mangled by text substitution if one is ever added.
	return buffer.subarray(0, 8000).includes(0);
}

async function main() {
	const outDir = process.argv[2];
	if (!outDir) {
		console.error('Usage: node scripts/scrub-for-public.mjs /path/to/output/dir');
		process.exitCode = 1;
		return;
	}

	const rules = await loadRules();
	const hitCounts = new Map(rules.map((rule) => [rule, 0]));

	const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);

	let changedFiles = 0;
	for (const relPath of files) {
		const srcPath = path.join(ROOT, relPath);
		const destPath = path.join(outDir, relPath);
		mkdirSync(path.dirname(destPath), { recursive: true });

		const buffer = readFileSync(srcPath);
		if (isProbablyBinary(buffer)) {
			writeFileSync(destPath, buffer);
			continue;
		}

		const original = buffer.toString('utf8');
		let text = original;
		for (const rule of rules) {
			const before = text;
			text = applyScrubRules(text, [rule]);
			if (text !== before) hitCounts.set(rule, hitCounts.get(rule) + 1);
		}

		writeFileSync(destPath, text);
		if (text !== original) changedFiles++;
	}

	console.log(`==> scrubbed ${files.length} files (${changedFiles} changed) into ${outDir}`);
	console.log('==> per-rule file hit counts (0 means the rule matched nothing — check it):');
	for (const rule of rules) {
		const count = hitCounts.get(rule);
		const flag = count === 0 ? '  <-- no matches, may be stale' : '';
		console.log(`    ${String(count).padStart(3)}  ${rule.from} -> ${rule.to}${flag}`);
	}
}

await main();
