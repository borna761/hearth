#!/usr/bin/env node
// docs/phase-7-music-plan.md's Pi gate for the two new dependencies (castv2-client,
// bonjour-service) — both pure JavaScript by dependency-tree inspection, but "low risk"
// isn't "proven." This exercises the full discovery -> connect -> launch -> queueLoad
// chain against a real speaker from the real Pi/network, not just that the libraries
// import cleanly.
//
// NOT a no-op: this will actually start audio playing on the named speaker/group, using
// one real track from the already-scanned library (run `npm run music:scan` first if the
// library is empty).
//
//   node --env-file=.env scripts/cast-smoke.mjs "Kitchen"
//
// HEARTH_STREAM_BASE_URL defaults to the Pi's own production address — override for local
// testing (e.g. http://localhost:5173 against `npm run dev`).
//
// Deliberately plain JS, no drizzle import — same reasoning as every other
// scripts/*.mjs entry point: plain `node` can't import the TypeScript schema module.

import Database from 'better-sqlite3';
import Bonjour from 'bonjour-service';
import { Client, DefaultMediaReceiver } from 'castv2-client';

const DATABASE_URL = process.env.DATABASE_URL ?? '/var/lib/hearth/hearth.db';
const STREAM_BASE_URL = process.env.HEARTH_STREAM_BASE_URL ?? 'http://hearth.local:8080';
const DISCOVERY_TIMEOUT_MS = 5000;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Mirrors src/lib/server/googleCast/discovery.ts's resolveSpeakerHost exactly. */
async function resolveHost(castName) {
	const bonjour = new Bonjour();
	const browser = bonjour.find({ type: 'googlecast', protocol: 'tcp' });
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			browser.stop();
			bonjour.destroy();
			resolve(result);
		};
		browser.on('up', (service) => {
			if (service.txt?.fn !== castName) return;
			const addresses = service.addresses ?? [];
			const host = addresses.find((addr) => IPV4_PATTERN.test(addr)) ?? addresses[0];
			if (!host) return;
			finish({ host, port: service.port });
		});
		setTimeout(() => finish(null), DISCOVERY_TIMEOUT_MS);
	});
}

async function main() {
	const castName = process.argv[2];
	if (!castName) {
		throw new Error('Usage: node scripts/cast-smoke.mjs "<Cast friendly name>"');
	}

	const db = new Database(DATABASE_URL, { readonly: true });
	const track = db.prepare('SELECT id, title FROM music_tracks LIMIT 1').get();
	db.close();
	if (!track) {
		throw new Error('No tracks in the library yet — run `npm run music:scan` first.');
	}

	console.log(
		`[cast-smoke] discovering "${castName}" via mDNS (up to ${DISCOVERY_TIMEOUT_MS}ms)...`
	);
	const device = await resolveHost(castName);
	if (!device) {
		throw new Error(
			`Could not find "${castName}" on the network. Check the name matches exactly what's in the Google Home app.`
		);
	}
	console.log(`[cast-smoke] found "${castName}" at ${device.host}:${device.port}`);

	const trackUrl = `${STREAM_BASE_URL}/api/music/tracks/${track.id}`;
	console.log(`[cast-smoke] connecting and playing "${track.title}" (${trackUrl})...`);

	const client = new Client();
	await new Promise((resolve, reject) => {
		client.on('error', reject);
		client.connect({ host: device.host, port: device.port }, () => {
			client.launch(DefaultMediaReceiver, (err, player) => {
				if (err) return reject(err);
				player.queueLoad(
					[
						{
							media: { contentId: trackUrl, contentType: 'audio/mpeg', streamType: 'BUFFERED' },
							autoplay: true
						}
					],
					{},
					(loadErr) => (loadErr ? reject(loadErr) : resolve())
				);
			});
		});
	});
	client.close();

	console.log(
		'[cast-smoke] OK — playback started (closing the sender; playback continues on the device).'
	);
}

main().catch((err) => {
	console.error('[cast-smoke] failed:', err);
	process.exitCode = 1;
});
