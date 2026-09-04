// Connects to a Cast device/group by host and plays a queue of tracks — the public,
// documented CASTV2 protocol via castv2-client, not a private/reverse-engineered one.
// launches DefaultMediaReceiver, the universal no-registration-needed Chromecast
// receiver (docs/phase-7-music-plan.md) — nothing Spotify/YouTube-specific.

import { Client, DefaultMediaReceiver } from 'castv2-client';
import type { PlayerState } from './playbackAction';

export interface MediaStatus {
	playerState: PlayerState;
	// A snapshot, not a live tick — the device only reports where playback was at the
	// moment of this status, same as `media`/`metadata` below.
	currentTime?: number;
	// Only present once a status broadcast reflects the queue item actually loaded — the
	// metadata this app attaches at queueLoad time (see playFolderOnSpeaker) round-trips
	// back through here so the panel can show which track is currently playing, not just
	// which folder. `contentId` is the same track URL passed in at queueLoad time — used
	// to resolve which of our own track ids is currently playing (see
	// playbackSession.ts's applyStatus), since CASTV2 only echoes back the URL, not our id.
	media?: { contentId?: string; metadata?: { title?: string }; duration?: number };
}

export interface CastTrack {
	id: number;
	url: string;
	title: string;
}

export interface MediaPlayerLike {
	queueLoad(
		items: Array<{
			media: {
				contentId: string;
				contentType: string;
				streamType: string;
				metadata: { metadataType: number; title: string };
			};
			autoplay: boolean;
		}>,
		options: Record<string, unknown>,
		callback: (err: Error | null) => void
	): void;
	play(callback: (err: Error | null) => void): void;
	pause(callback: (err: Error | null) => void): void;
	stop(callback: (err: Error | null) => void): void;
	/** `jump: 1`/`jump: -1` skips to the next/previous queued item — castv2-client has no
	 *  dedicated next()/previous() method; this is the documented CASTV2 QUEUE_UPDATE
	 *  mechanism for it. */
	queueUpdate(
		items: unknown[],
		options: { jump?: number },
		callback: (err: Error | null) => void
	): void;
	getStatus(callback: (err: Error | null, status?: MediaStatus) => void): void;
	on(event: 'status', listener: (status: MediaStatus) => void): void;
}

export interface VolumeStatus {
	level: number;
	muted: boolean;
}

export interface ClientLike {
	connect(options: { host: string; port: number }, callback: () => void): void;
	launch(app: unknown, callback: (err: Error | null, player: MediaPlayerLike) => void): void;
	close(): void;
	// Checked against node_modules/castv2-client/lib/senders/platform.js: the Client
	// doesn't expose a public 'close' event, but it does forward the raw connection's own
	// 'error' (including a heartbeat-timeout-detected dead connection — "Device timeout" —
	// even when the socket closed silently with no real socket-level error). This is the
	// only signal available for playbackSession.ts to detect an unexpected disconnect
	// after a session is already established, not just during initial connect.
	on(event: 'error', listener: (err: Error) => void): void;
	// Receiver-level volume (the speaker's own physical volume, same as its hardware
	// controls or the Google Home app's slider) — lives on the connection itself, not the
	// media player, since it's a property of the device, not of whatever's playing on it.
	getVolume(callback: (err: Error | null, volume?: VolumeStatus) => void): void;
	setVolume(
		options: { level?: number; muted?: boolean },
		callback: (err: Error | null, volume?: VolumeStatus) => void
	): void;
}

export interface CastSession {
	client: ClientLike;
	player: MediaPlayerLike;
}

function defaultCreateClient(): ClientLike {
	return new Client() as unknown as ClientLike;
}

/** castv2's own Client#close does `this.socket.destroy()` with no null check — if the
 *  connection already died on its own (the exact scenario a failure path is often reacting
 *  to), the socket is already null and that throws, which would otherwise mask the real
 *  error this function is trying to reject with. */
function safeClose(client: ClientLike): void {
	try {
		client.close();
	} catch {
		// Already gone — exactly the state this was trying to reach anyway.
	}
}

/** Loads every track in a folder as a single queue so the whole "playlist" plays through,
 *  not just the first track — castv2-client's player supports queueing multiple media
 *  items via one queueLoad call. Stays connected on success (unlike the original
 *  fire-and-forget version) so the caller can hand the session to
 *  googleCast/playbackSession.ts for later play/pause/next commands; only closes on
 *  failure, since there's nothing worth keeping open then. */
export async function playFolderOnSpeaker(
	host: string,
	port: number,
	tracks: CastTrack[],
	options: { createClient?: () => ClientLike } = {}
): Promise<CastSession> {
	const { createClient = defaultCreateClient } = options;
	const client = createClient();

	return new Promise((resolve, reject) => {
		let settled = false;
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			safeClose(client);
			reject(err);
		};
		const succeed = (player: MediaPlayerLike) => {
			if (settled) return;
			settled = true;
			resolve({ client, player });
		};

		client.on('error', (err) => fail(err));

		client.connect({ host, port }, () => {
			client.launch(DefaultMediaReceiver, (launchErr, player) => {
				if (launchErr) {
					fail(launchErr);
					return;
				}
				const items = tracks.map((track) => ({
					media: {
						contentId: track.url,
						contentType: 'audio/mpeg',
						streamType: 'BUFFERED',
						metadata: { metadataType: 0, title: track.title }
					},
					autoplay: true
				}));
				// REPEAT_ALL loops the whole queue once the last track ends, rather than
				// stopping — Alex's ask. Applied at load time since that's the only place
				// castv2-client's queueLoad accepts it.
				player.queueLoad(items, { repeatMode: 'REPEAT_ALL' }, (loadErr) => {
					if (loadErr) fail(loadErr);
					else succeed(player);
				});
			});
		});
	});
}
