import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { getMusicSpeaker, listTracksInFolder } from '$lib/server/musicLibrary';
import { resolveSpeakerHost } from '$lib/server/googleCast/discovery';
import { playFolderOnSpeaker } from '$lib/server/googleCast/client';
import { startPlaybackSession } from '$lib/server/googleCast/playbackSession';
import { resolveStreamBaseUrl } from '$lib/server/musicStreamUrl';
import { orderForPlayback } from '$lib/server/shuffle';

/**
 * Unlike groceries, music is intentionally open to guest mode too (Alex's call) — which
 * speaker plays which folder is shared household routing, not household data a visitor
 * shouldn't touch, and guests get full control rather than a read-only view.
 */
export const POST: RequestHandler = async ({ request, url }) => {
	const body = await request.json().catch(() => null);
	const speakerId = typeof body?.speakerId === 'number' ? body.speakerId : null;
	const folderId = typeof body?.folderId === 'number' ? body.folderId : null;
	const trackId = typeof body?.trackId === 'number' ? body.trackId : null;
	if (speakerId === null || folderId === null) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	const speaker = await getMusicSpeaker(db, speakerId);
	if (!speaker) {
		return json({ ok: false, reason: 'not-found' }, { status: 404 });
	}

	const tracks = await listTracksInFolder(db, folderId);
	if (tracks.length === 0) {
		return json({ ok: false, reason: 'empty' }, { status: 404 });
	}

	const device = await resolveSpeakerHost(speaker.castName);
	if (!device) {
		return json(
			{ ok: false, error: `Can't find "${speaker.castName}" on the network right now.` },
			{ status: 503 }
		);
	}

	const streamBaseUrl = resolveStreamBaseUrl(url.origin, env.HEARTH_STREAM_BASE_URL);
	// Shuffled by default (Alex's ask) — listMusicTracks's alphabetical order is a stable
	// browsing order, not a playback one; a fresh shuffle each time a folder plays keeps a
	// "baby faves"-style folder from playing the same track first every time. When a
	// specific track was picked (the song-picker step of MusicPanel), it leads the queue
	// and the rest still shuffles, so playback carries on shuffled after it finishes.
	const castTracks = orderForPlayback(tracks, trackId, Math.random).map((track) => ({
		id: track.id,
		url: `${streamBaseUrl}/api/music/tracks/${track.id}`,
		title: track.title
	}));

	try {
		const { client, player } = await playFolderOnSpeaker(device.host, device.port, castTracks);
		await startPlaybackSession(client, player, speakerId, folderId, speaker.castName, castTracks);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ ok: false, error: message }, { status: 502 });
	}

	return json({ ok: true });
};
