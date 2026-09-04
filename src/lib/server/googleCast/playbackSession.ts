// The one "what's currently playing" slot — module-scope singleton state, the same
// pattern this codebase uses for other single-tablet state that's fine to lose on a
// restart (state/publisher.ts's activeSessionToken — a live session ending and needing a
// fresh PIN is correct/safe default behavior, not a bug). screensaverPublisher's
// activeScreensaverMode used to be the same shape but is now settings-table-backed
// instead, precisely because losing *that* one on every deploy was a real problem: guest
// mode silently reverting to family photos overnight. A server restart loses this
// playback slot the same way the speaker itself would lose it on a power cycle — an
// accepted tradeoff for a first version (confirmed with Alex) rather than the
// meaningfully more complex work of surviving a restart.
import {
	playFolderOnSpeaker as realPlayFolderOnSpeaker,
	type CastTrack,
	type ClientLike,
	type MediaPlayerLike,
	type MediaStatus,
	type VolumeStatus
} from './client';
import { resolveSpeakerHost as realResolveSpeakerHost } from './discovery';
import { nextToggleAction, type PlayerState } from './playbackAction';
import { computeElapsedSeconds } from '$lib/musicProgress';

export interface PlaybackSession {
	client: ClientLike;
	player: MediaPlayerLike;
	speakerId: number;
	folderId: number;
	// Remembered so a dropped connection can be rebuilt from scratch — re-resolve the
	// speaker's current address (it may have changed, especially for a group) and reload
	// the same queue, rather than needing the original HTTP request's context again.
	castName: string;
	tracks: CastTrack[];
	// Caps automatic reconnection to one attempt for this session's lifetime — a speaker
	// that keeps dropping is a real problem worth surfacing (the panel goes back to "no
	// active session"), not something to retry forever against.
	reconnectAttempted: boolean;
	playerState: PlayerState;
	trackTitle: string | null;
	// Which of our own tracks (music_tracks.id) is currently loaded — resolved by matching
	// a status broadcast's media.contentId back against `tracks` above, since CASTV2 only
	// echoes back the URL it was given at queueLoad time, not our id. Lets the panel show
	// that track's cover art. Null until the first status carrying a contentId arrives, or
	// if it doesn't match anything in `tracks` (shouldn't happen in practice).
	trackId: number | null;
	// A snapshot, not a live tick (MusicPanel.svelte's musicProgress.ts interpolates the
	// gap between syncs using syncedAtMs) — this app deliberately doesn't poll the device
	// just to keep a progress bar moving.
	currentTime: number | null;
	duration: number | null;
	syncedAtMs: number | null;
	// The receiver's own volume (0-1), not a per-media-item property — fetched from the
	// client/connection, not the media player. See client.ts's VolumeStatus comment.
	volume: number | null;
	muted: boolean;
}

export type PlaybackActionResult =
	{ ok: true } | { ok: false; reason: 'inactive' } | { ok: false; reason: 'error'; error: string };

interface ReconnectDeps {
	resolveSpeakerHost: typeof realResolveSpeakerHost;
	playFolderOnSpeaker: typeof realPlayFolderOnSpeaker;
}

let current: PlaybackSession | null = null;

// A response can be lost on the wire — the device gets the command but the reply never
// arrives — and castv2-client has no built-in timeout of its own for a single request, so
// an awaited callback that never fires would otherwise hang the HTTP request forever.
const CALLBACK_TIMEOUT_MS = 5000;

/** Races a castv2-client callback-style call against a timer, so a lost response fails
 *  cleanly instead of hanging the caller indefinitely. */
function raceCallback<T>(
	attach: (callback: (err: Error | null, value?: T) => void) => void,
	timeoutMs = CALLBACK_TIMEOUT_MS
): Promise<{ err: Error | null; value?: T }> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve({ err: new Error('Device did not respond in time') });
		}, timeoutMs);
		attach((err, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ err: err ?? null, value });
		});
	});
}

/** castv2's own Client#close does `this.socket.destroy()` with no null check — if the
 *  connection already closed itself (the device dropped it, a natural disconnect), the
 *  socket is already null and that throws synchronously. Closing a session we're about to
 *  discard anyway shouldn't be able to crash the caller — confirmed live: an unguarded
 *  close() here took down the entire play/toggle/next request with an uncaught exception,
 *  which SvelteKit turned into a non-JSON 500 the panel couldn't parse, showing a generic
 *  "couldn't play" error with no indication this was the actual cause. */
function safeClose(client: ClientLike): void {
	try {
		client.close();
	} catch {
		// Already gone — exactly the state this was trying to reach anyway.
	}
}

function applyStatus(session: PlaybackSession, status: MediaStatus): void {
	session.playerState = status.playerState;
	// Only overwrite once a status actually carries the title — an intermediate update
	// (e.g. a bare playerState change) shouldn't blank out what's already known.
	if (status.media?.metadata?.title) session.trackTitle = status.media.metadata.title;
	// syncedAtMs is only meaningful paired with the currentTime it was captured alongside
	// (getPlaybackStatusSnapshot interpolates from that pair) — bumping it on a status
	// update that doesn't actually carry a currentTime (e.g. a bare playerState or volume
	// change) would pair a fresh timestamp with a stale position, understating the real
	// elapsed time on the next snapshot.
	if (status.currentTime !== undefined) {
		session.currentTime = status.currentTime;
		session.syncedAtMs = Date.now();
	}
	if (status.media?.duration !== undefined) session.duration = status.media.duration;
	if (status.media?.contentId !== undefined) {
		const track = session.tracks.find((t) => t.url === status.media?.contentId);
		session.trackId = track?.id ?? null;
	}
}

async function seedInitialState(session: PlaybackSession): Promise<void> {
	const [statusResult, volumeResult] = await Promise.all([
		raceCallback<MediaStatus>((cb) => session.player.getStatus(cb)),
		raceCallback<VolumeStatus>((cb) => session.client.getVolume(cb))
	]);
	if (!statusResult.err && statusResult.value && current === session) {
		applyStatus(session, statusResult.value);
	}
	if (!volumeResult.err && volumeResult.value && current === session) {
		session.volume = volumeResult.value.level;
		session.muted = volumeResult.value.muted;
	}
}

/** Gives up on `session` — closes its client and clears it, but only if nothing newer has
 *  already taken its place. Used everywhere a captured `session` reference might have been
 *  superseded by the time an awaited device response comes back (or never comes back at
 *  all), so a stale success/failure can't reach in and tear down whatever's playing now. */
function abandonSession(session: PlaybackSession): void {
	if (current !== session) return;
	safeClose(session.client);
	current = null;
}

/** Wires up both the passive status listener and disconnect detection against whatever
 *  `session.client`/`session.player` currently point to — called once on start, and again
 *  after a successful reconnect swaps in a fresh connection.
 *
 *  Binds to the specific client/player instances active *at the time of wiring* (not just
 *  `session` identity) — reconnecting swaps `session.client`/`session.player` in place
 *  without ever replacing `session` itself, so a `current === session` check alone can't
 *  tell a fresh connection's events apart from the abandoned old connection's. The old
 *  connection is also explicitly closed once reconnected (see attemptReconnect), but the
 *  bound check is what actually protects against a *delayed* event that arrives after
 *  that close call, from a heartbeat or in-flight message that was already queued. */
function wireConnection(session: PlaybackSession, deps: ReconnectDeps): void {
	const boundClient = session.client;
	const boundPlayer = session.player;

	boundPlayer.on('status', (status) => {
		if (current === session && session.player === boundPlayer) applyStatus(session, status);
	});

	// castv2-client's Client has no public 'close' event (checked against
	// node_modules/castv2-client/lib/senders/platform.js) — 'error' is the only signal,
	// but it does cover a silently dead connection too, via the library's own built-in
	// heartbeat timeout ("Device timeout"), not just real socket-level errors.
	boundClient.on('error', () => {
		if (current !== session || session.client !== boundClient) return;
		if (session.reconnectAttempted) {
			abandonSession(session);
			return;
		}
		session.reconnectAttempted = true;
		void attemptReconnect(session, deps);
	});
}

async function attemptReconnect(session: PlaybackSession, deps: ReconnectDeps): Promise<void> {
	const device = await deps.resolveSpeakerHost(session.castName, { timeoutMs: 5000 });
	if (!device) {
		abandonSession(session);
		return;
	}
	let reconnected;
	try {
		reconnected = await deps.playFolderOnSpeaker(device.host, device.port, session.tracks);
	} catch {
		abandonSession(session);
		return;
	}
	if (current !== session) {
		// Superseded by a newer session while this was reconnecting — nothing points to
		// this connection any more, so don't resurrect it.
		safeClose(reconnected.client);
		return;
	}
	// Tear down the old connection before swapping it out — stops its heartbeat so it
	// can't keep firing further 'error' events into thin air, and there's no reason to
	// leave two live sockets to the same device open at once.
	safeClose(session.client);
	session.client = reconnected.client;
	session.player = reconnected.player;
	session.playerState = 'PLAYING';
	wireConnection(session, deps);
	await seedInitialState(session);
}

/** Only one playback session is ever active — same household-shared-state model as
 *  groceries/tasks having no per-user concept. Starting a new one replaces (and
 *  disconnects) whatever was playing before, same as tapping a new track on a physical
 *  speaker would.
 *
 *  Awaits one `getStatus` call before returning rather than only registering the passive
 *  `status` listener and hoping a broadcast arrives — confirmed against a real speaker
 *  that a device doesn't reliably re-broadcast MEDIA_STATUS while nothing changes, so the
 *  panel could wait indefinitely for a title that already exists, just not yet delivered
 *  passively. Also fetches the receiver's current volume the same way, from the client
 *  rather than the media player.
 *
 *  `resolveSpeakerHost`/`playFolderOnSpeaker` are injectable (mirroring this codebase's
 *  own `createClient`/`createBrowser` convention elsewhere) — production always uses the
 *  real ones; tests substitute fakes to exercise the reconnect path without real mDNS or
 *  network calls. */
export async function startPlaybackSession(
	client: ClientLike,
	player: MediaPlayerLike,
	speakerId: number,
	folderId: number,
	castName: string,
	tracks: CastTrack[],
	options: Partial<ReconnectDeps> = {}
): Promise<void> {
	const deps: ReconnectDeps = {
		resolveSpeakerHost: options.resolveSpeakerHost ?? realResolveSpeakerHost,
		playFolderOnSpeaker: options.playFolderOnSpeaker ?? realPlayFolderOnSpeaker
	};
	if (current) safeClose(current.client);
	const session: PlaybackSession = {
		client,
		player,
		speakerId,
		folderId,
		castName,
		tracks,
		reconnectAttempted: false,
		playerState: 'PLAYING',
		trackTitle: null,
		trackId: null,
		currentTime: null,
		duration: null,
		syncedAtMs: null,
		volume: null,
		muted: false
	};
	current = session;
	wireConnection(session, deps);
	await seedInitialState(session);
}

export function getPlaybackSession(): PlaybackSession | null {
	return current;
}

/** What api/music/status actually hands the panel — `current` on its own only holds
 *  currentTime as of the last real device sync (session start, a passive status event, or
 *  an explicit refresh), which can be long stale by the time someone opens the panel: the
 *  device doesn't broadcast MEDIA_STATUS just because time is passing. Without this, the
 *  panel would show playback "restarting" from that stale position and only reach the
 *  real one after a real minute ticked by client-side. Interpolating forward here — the
 *  same wall-clock math musicProgress.ts's client-side ticker uses — means the position
 *  the panel receives is already correct as of "now" the moment it asks. */
export function getPlaybackStatusSnapshot(): PlaybackSession | null {
	if (!current) return null;
	if (current.currentTime === null) return current;
	return {
		...current,
		currentTime: computeElapsedSeconds({
			currentTime: current.currentTime,
			syncedAtMs: current.syncedAtMs,
			nowMs: Date.now(),
			playerState: current.playerState,
			duration: current.duration
		})
	};
}

/** Same "ask directly rather than wait for a broadcast" reasoning as startPlaybackSession
 *  — called after skipping to a new track, since that's exactly when a fresh title is
 *  needed and a passive broadcast can't be relied on to deliver it promptly. */
export async function refreshPlaybackStatus(): Promise<void> {
	const session = current;
	if (!session) return;
	const { err, value } = await raceCallback<MediaStatus>((cb) => session.player.getStatus(cb));
	if (!err && value && current === session) applyStatus(session, value);
}

/** Called both for a deliberate stop and when a control command fails against a
 *  connection that's gone stale (the device dropped it, network hiccup) — either way,
 *  there's nothing left worth keeping open. Only ever clears the *current* session, not
 *  necessarily whatever session a caller happened to capture earlier — use `abandonSession`
 *  internally when a specific (possibly superseded) session needs to be given up on. */
export function clearPlaybackSession(): void {
	if (current) safeClose(current.client);
	current = null;
}

/** Called on a periodic tick (sync/runtime.ts) with whether music is currently allowed to
 *  play (settings.ts's isMusicAllowed — inside music hours AND not inside quiet hours) —
 *  auto-stops whatever's playing the moment that stops being true, so nobody has to
 *  remember to turn it off by hand. A no-op both when nothing is playing and while still
 *  allowed. */
export async function stopIfOutsideMusicHours(musicAllowed: boolean): Promise<void> {
	if (musicAllowed) return;
	if (!current) return;
	await stopPlayback();
}

/** `level` is 0-1, the receiver's own volume — same as its hardware controls or the
 *  Google Home app's slider, not specific to whatever's currently playing. */
export async function setPlaybackVolume(level: number): Promise<PlaybackActionResult> {
	const session = current;
	if (!session) return { ok: false, reason: 'inactive' };
	const { err } = await raceCallback<VolumeStatus>((cb) => session.client.setVolume({ level }, cb));
	if (err) {
		abandonSession(session);
		return { ok: false, reason: 'error', error: err.message };
	}
	if (current === session) session.volume = level;
	return { ok: true };
}

/** Shared by the next/previous endpoints — `jump: 1` or `jump: -1`, CASTV2's own
 *  QUEUE_UPDATE mechanism for moving within the queue (see client.ts's comment: there's no
 *  dedicated next()/previous() method). Refreshes status afterward so the new track's
 *  title is known immediately rather than waiting on a broadcast that might not arrive
 *  promptly — same reasoning as startPlaybackSession's own proactive getStatus call. */
export async function skipQueue(jump: 1 | -1): Promise<PlaybackActionResult> {
	const session = current;
	if (!session) return { ok: false, reason: 'inactive' };
	const { err } = await raceCallback<void>((cb) => session.player.queueUpdate([], { jump }, cb));
	if (err) {
		abandonSession(session);
		return { ok: false, reason: 'error', error: err.message };
	}
	await refreshPlaybackStatus();
	return { ok: true };
}

/** Stops playback and ends the session either way — unlike pause, there's nothing to
 *  resume, so the connection is worth closing rather than keeping around idle. */
export async function stopPlayback(): Promise<PlaybackActionResult> {
	const session = current;
	if (!session) return { ok: false, reason: 'inactive' };
	const { err } = await raceCallback<void>((cb) => session.player.stop(cb));
	abandonSession(session);
	return err ? { ok: false, reason: 'error', error: err.message } : { ok: true };
}

/** Single toggle rather than separate play/pause functions — the panel only ever needs
 *  "do the opposite of whatever it's doing now", and deciding from the session's own
 *  last-known state (not client-supplied) keeps it correct even if playback was
 *  paused/resumed from outside Hearth. Lives here (not the route) so it shares the same
 *  timeout and stale-session guards as every other action. */
export async function togglePlayback(): Promise<
	PlaybackActionResult | { ok: true; action: 'play' | 'pause' }
> {
	const session = current;
	if (!session) return { ok: false, reason: 'inactive' };
	const action = nextToggleAction(session.playerState);
	const { err } = await raceCallback<void>((cb) =>
		action === 'pause' ? session.player.pause(cb) : session.player.play(cb)
	);
	if (err) {
		abandonSession(session);
		return { ok: false, reason: 'error', error: err.message };
	}
	// Refreshes currentTime too, not just playerState — pausing should freeze the
	// progress bar at the device's actual position, not whatever the client last knew.
	await refreshPlaybackStatus();
	return { ok: true, action };
}
