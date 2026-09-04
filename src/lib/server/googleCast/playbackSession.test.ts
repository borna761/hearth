import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClientLike, MediaPlayerLike, MediaStatus, VolumeStatus, CastTrack } from './client';
import type { DiscoveredCastDevice } from './discovery';
import {
	startPlaybackSession,
	refreshPlaybackStatus,
	setPlaybackVolume,
	skipQueue,
	stopPlayback,
	togglePlayback,
	getPlaybackSession,
	getPlaybackStatusSnapshot,
	clearPlaybackSession,
	stopIfOutsideMusicHours
} from './playbackSession';

const CAST_NAME = 'Test Speaker';
const TRACKS: CastTrack[] = [{ id: 1, url: 'http://a/1.mp3', title: 'Song' }];

function fakeClient(
	volume: VolumeStatus = { level: 0.5, muted: false }
): ClientLike & { emitError(err: Error): void } {
	const errorListeners: Array<(err: Error) => void> = [];
	return {
		close: vi.fn(),
		on: vi.fn((event: string, listener: (err: Error) => void) => {
			if (event === 'error') errorListeners.push(listener);
		}),
		getVolume: vi.fn((callback: (err: Error | null, volume?: VolumeStatus) => void) => {
			callback(null, volume);
		}),
		setVolume: vi.fn(
			(
				options: { level?: number; muted?: boolean },
				callback: (err: Error | null, volume?: VolumeStatus) => void
			) => {
				if (options.level !== undefined) volume.level = options.level;
				if (options.muted !== undefined) volume.muted = options.muted;
				callback(null, volume);
			}
		),
		emitError(err: Error) {
			errorListeners.forEach((l) => l(err));
		}
	} as unknown as ClientLike & { emitError(err: Error): void };
}

function fakePlayer(
	getStatusResult: MediaStatus | null = null
): MediaPlayerLike & { emitStatus(status: MediaStatus): void } {
	const listeners: Array<(status: MediaStatus) => void> = [];
	return {
		on: vi.fn((event: string, listener: (status: MediaStatus) => void) => {
			if (event === 'status') listeners.push(listener);
		}),
		getStatus: vi.fn((callback: (err: Error | null, status?: MediaStatus) => void) => {
			callback(null, getStatusResult ?? undefined);
		}),
		play: vi.fn((callback: (err: Error | null) => void) => callback(null)),
		pause: vi.fn((callback: (err: Error | null) => void) => callback(null)),
		queueUpdate: vi.fn(
			(items: unknown[], options: { jump?: number }, callback: (err: Error | null) => void) => {
				callback(null);
			}
		),
		stop: vi.fn((callback: (err: Error | null) => void) => callback(null)),
		emitStatus(status: MediaStatus) {
			listeners.forEach((l) => l(status));
		}
	} as unknown as MediaPlayerLike & { emitStatus(status: MediaStatus): void };
}

beforeEach(() => {
	clearPlaybackSession();
});

describe('playbackSession', () => {
	it('starts with no active session', () => {
		expect(getPlaybackSession()).toBeNull();
	});

	it('stores the speaker/folder and starts as PLAYING with no track title or timing yet', async () => {
		await startPlaybackSession(fakeClient(), fakePlayer(), 3, 1, CAST_NAME, TRACKS);
		expect(getPlaybackSession()).toMatchObject({
			speakerId: 3,
			folderId: 1,
			playerState: 'PLAYING',
			trackTitle: null,
			currentTime: null,
			duration: null,
			syncedAtMs: null
		});
	});

	it('fetches the receiver volume on start, from the client rather than the media player', async () => {
		const client = fakeClient({ level: 0.7, muted: false });
		await startPlaybackSession(client, fakePlayer(), 3, 1, CAST_NAME, TRACKS);
		expect(client.getVolume).toHaveBeenCalled();
		expect(getPlaybackSession()).toMatchObject({ volume: 0.7, muted: false });
	});

	it('proactively fetches the current status once starting, rather than only waiting for a broadcast', async () => {
		const player = fakePlayer({
			playerState: 'PLAYING',
			media: { metadata: { title: 'Song One' } }
		});
		await startPlaybackSession(fakeClient(), player, 3, 1, CAST_NAME, TRACKS);
		expect(player.getStatus).toHaveBeenCalled();
		expect(getPlaybackSession()?.trackTitle).toBe('Song One');
	});

	it('picks up the current track title from a later status event too', async () => {
		const player = fakePlayer();
		await startPlaybackSession(fakeClient(), player, 3, 1, CAST_NAME, TRACKS);
		player.emitStatus({ playerState: 'PLAYING', media: { metadata: { title: 'Song One' } } });
		expect(getPlaybackSession()?.trackTitle).toBe('Song One');
	});

	it("resolves which of our own tracks is playing from the status broadcast's contentId", async () => {
		const tracks: CastTrack[] = [
			{ id: 11, url: 'http://a/11.mp3', title: 'First' },
			{ id: 22, url: 'http://a/22.mp3', title: 'Second' }
		];
		const player = fakePlayer();
		await startPlaybackSession(fakeClient(), player, 3, 1, CAST_NAME, tracks);
		player.emitStatus({
			playerState: 'PLAYING',
			media: { contentId: 'http://a/22.mp3', metadata: { title: 'Second' } }
		});
		expect(getPlaybackSession()?.trackId).toBe(22);
	});

	it("leaves trackId at its last known value when a status update doesn't carry a contentId", async () => {
		const tracks: CastTrack[] = [{ id: 11, url: 'http://a/11.mp3', title: 'First' }];
		const player = fakePlayer();
		await startPlaybackSession(fakeClient(), player, 3, 1, CAST_NAME, tracks);
		player.emitStatus({ playerState: 'PLAYING', media: { contentId: 'http://a/11.mp3' } });
		player.emitStatus({ playerState: 'PLAYING' }); // e.g. a volume-only push
		expect(getPlaybackSession()?.trackId).toBe(11);
	});

	it("stays null when the broadcast's contentId doesn't match any of our tracks", async () => {
		const player = fakePlayer();
		await startPlaybackSession(fakeClient(), player, 3, 1, CAST_NAME, TRACKS);
		player.emitStatus({ playerState: 'PLAYING', media: { contentId: 'http://unknown/x.mp3' } });
		expect(getPlaybackSession()?.trackId).toBeNull();
	});

	it('records currentTime, duration, and when that snapshot was taken', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		try {
			const player = fakePlayer();
			await startPlaybackSession(fakeClient(), player, 3, 1, CAST_NAME, TRACKS);
			player.emitStatus({ playerState: 'PLAYING', currentTime: 42, media: { duration: 200 } });
			expect(getPlaybackSession()).toMatchObject({
				currentTime: 42,
				duration: 200,
				syncedAtMs: 10_000
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('updates playerState as the player emits its own status events', async () => {
		const player = fakePlayer();
		await startPlaybackSession(fakeClient(), player, 3, 1, CAST_NAME, TRACKS);
		player.emitStatus({ playerState: 'PAUSED' });
		expect(getPlaybackSession()?.playerState).toBe('PAUSED');
	});

	it('closes the previous client when a new session replaces it', async () => {
		const clientA = fakeClient();
		await startPlaybackSession(clientA, fakePlayer(), 1, 1, CAST_NAME, TRACKS);
		await startPlaybackSession(fakeClient(), fakePlayer(), 2, 2, CAST_NAME, TRACKS);
		expect(clientA.close).toHaveBeenCalledOnce();
	});

	it('starting a new session still works even if the previous client is already dead — castv2 throws (socket.destroy on a null socket) once a connection has already closed itself', async () => {
		const clientA = fakeClient();
		(clientA.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new TypeError("Cannot read properties of null (reading 'destroy')");
		});
		await startPlaybackSession(clientA, fakePlayer(), 1, 1, CAST_NAME, TRACKS);
		await expect(
			startPlaybackSession(fakeClient(), fakePlayer(), 2, 2, CAST_NAME, TRACKS)
		).resolves.toBeUndefined();
		expect(getPlaybackSession()).toMatchObject({ speakerId: 2, folderId: 2 });
	});

	it('clearPlaybackSession closes the client and nulls the session', async () => {
		const client = fakeClient();
		await startPlaybackSession(client, fakePlayer(), 1, 1, CAST_NAME, TRACKS);
		clearPlaybackSession();
		expect(client.close).toHaveBeenCalledOnce();
		expect(getPlaybackSession()).toBeNull();
	});

	it('clearPlaybackSession is a no-op when nothing is active', () => {
		expect(() => clearPlaybackSession()).not.toThrow();
	});

	it('clearPlaybackSession does not throw even if the client is already dead', async () => {
		const client = fakeClient();
		(client.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new TypeError("Cannot read properties of null (reading 'destroy')");
		});
		await startPlaybackSession(client, fakePlayer(), 1, 1, CAST_NAME, TRACKS);
		expect(() => clearPlaybackSession()).not.toThrow();
		expect(getPlaybackSession()).toBeNull();
	});

	it('a stale status event from a replaced player no longer updates the current session', async () => {
		const playerA = fakePlayer();
		await startPlaybackSession(fakeClient(), playerA, 1, 1, CAST_NAME, TRACKS);
		await startPlaybackSession(fakeClient(), fakePlayer(), 2, 2, CAST_NAME, TRACKS);
		playerA.emitStatus({ playerState: 'PAUSED' });
		expect(getPlaybackSession()?.folderId).toBe(2);
		expect(getPlaybackSession()?.playerState).toBe('PLAYING');
	});
});

describe('refreshPlaybackStatus', () => {
	it('does nothing when there is no active session', async () => {
		await expect(refreshPlaybackStatus()).resolves.toBeUndefined();
	});

	it('re-fetches status and updates the session — used after skipping to a new track', async () => {
		const player = fakePlayer({ playerState: 'PLAYING', media: { metadata: { title: 'First' } } });
		await startPlaybackSession(fakeClient(), player, 3, 1, CAST_NAME, TRACKS);
		expect(getPlaybackSession()?.trackTitle).toBe('First');

		(player.getStatus as ReturnType<typeof vi.fn>).mockImplementation(
			(callback: (err: Error | null, status?: MediaStatus) => void) => {
				callback(null, { playerState: 'PLAYING', media: { metadata: { title: 'Second' } } });
			}
		);
		await refreshPlaybackStatus();
		expect(getPlaybackSession()?.trackTitle).toBe('Second');
	});

	it('interpolates currentTime forward to now, not just the last synced snapshot', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		try {
			const player = fakePlayer();
			await startPlaybackSession(fakeClient(), player, 3, 1, CAST_NAME, TRACKS);
			player.emitStatus({ playerState: 'PLAYING', currentTime: 5, media: { duration: 200 } });

			vi.setSystemTime(70_000); // 60s later, with no further status broadcast
			expect(getPlaybackStatusSnapshot()).toMatchObject({ currentTime: 65, duration: 200 });
			// The underlying session itself is untouched — only the snapshot interpolates.
			expect(getPlaybackSession()).toMatchObject({ currentTime: 5, syncedAtMs: 10_000 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("doesn't let a status update with no currentTime reset the interpolation baseline", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		try {
			const player = fakePlayer();
			await startPlaybackSession(fakeClient(), player, 3, 1, CAST_NAME, TRACKS);
			player.emitStatus({ playerState: 'PLAYING', currentTime: 5, media: { duration: 200 } });

			// A later broadcast that only touches playerState (e.g. a volume change) — no
			// currentTime field at all.
			vi.setSystemTime(20_000);
			player.emitStatus({ playerState: 'PLAYING' });
			expect(getPlaybackSession()).toMatchObject({ currentTime: 5, syncedAtMs: 10_000 });

			// 60s after the *original* sync — if the currentTime-less update above had
			// bumped syncedAtMs to 20_000 while leaving currentTime at the stale 5, this
			// would wrongly report ~5 instead of the real 65.
			vi.setSystemTime(70_000);
			expect(getPlaybackStatusSnapshot()).toMatchObject({ currentTime: 65 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("doesn't interpolate while paused", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		try {
			const player = fakePlayer();
			await startPlaybackSession(fakeClient(), player, 3, 1, CAST_NAME, TRACKS);
			player.emitStatus({ playerState: 'PAUSED', currentTime: 5, media: { duration: 200 } });

			vi.setSystemTime(70_000);
			expect(getPlaybackStatusSnapshot()).toMatchObject({ currentTime: 5 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('returns null when there is no active session', () => {
		expect(getPlaybackStatusSnapshot()).toBeNull();
	});

	it('times out rather than hanging forever if the device never responds', async () => {
		vi.useFakeTimers();
		try {
			const player = fakePlayer();
			// getStatus never calls its callback — simulates a lost response. Starts
			// answering normally first so session setup itself doesn't hang.
			await startPlaybackSession(fakeClient(), player, 1, 1, CAST_NAME, TRACKS, {
				resolveSpeakerHost: vi.fn(),
				playFolderOnSpeaker: vi.fn()
			});
			(player.getStatus as ReturnType<typeof vi.fn>).mockImplementation(() => {});

			const promise = refreshPlaybackStatus();
			await vi.advanceTimersByTimeAsync(10_000);
			await expect(promise).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('setPlaybackVolume', () => {
	it('returns an error when there is no active session', async () => {
		const result = await setPlaybackVolume(0.5);
		expect(result).toEqual({ ok: false, reason: 'inactive' });
	});

	it('sets the level on the client and updates the session', async () => {
		const client = fakeClient({ level: 0.2, muted: false });
		await startPlaybackSession(client, fakePlayer(), 1, 1, CAST_NAME, TRACKS);
		const result = await setPlaybackVolume(0.9);
		expect(client.setVolume).toHaveBeenCalledWith({ level: 0.9 }, expect.any(Function));
		expect(result).toEqual({ ok: true });
		expect(getPlaybackSession()?.volume).toBe(0.9);
	});

	it('clears the session if setting the volume fails', async () => {
		const client = fakeClient();
		(client.setVolume as ReturnType<typeof vi.fn>).mockImplementation(
			(_options: unknown, callback: (err: Error | null) => void) => callback(new Error('boom'))
		);
		await startPlaybackSession(client, fakePlayer(), 1, 1, CAST_NAME, TRACKS);
		const result = await setPlaybackVolume(0.9);
		expect(result).toEqual({ ok: false, reason: 'error', error: 'boom' });
		expect(getPlaybackSession()).toBeNull();
	});

	it('times out rather than hanging if the device never responds', async () => {
		vi.useFakeTimers();
		try {
			const client = fakeClient();
			(client.setVolume as ReturnType<typeof vi.fn>).mockImplementation(() => {});
			await startPlaybackSession(client, fakePlayer(), 1, 1, CAST_NAME, TRACKS);

			const promise = setPlaybackVolume(0.5);
			await vi.advanceTimersByTimeAsync(10_000);
			const result = await promise;
			expect(result.ok).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not clobber a newer session if this one errors after being superseded', async () => {
		const clientA = fakeClient();
		let volumeCallback!: (err: Error | null) => void;
		(clientA.setVolume as ReturnType<typeof vi.fn>).mockImplementation(
			(_options: unknown, callback: (err: Error | null) => void) => {
				volumeCallback = callback;
			}
		);
		await startPlaybackSession(clientA, fakePlayer(), 1, 1, CAST_NAME, TRACKS);
		const pending = setPlaybackVolume(0.5);

		const clientB = fakeClient();
		await startPlaybackSession(clientB, fakePlayer(), 2, 2, CAST_NAME, TRACKS);

		volumeCallback(new Error('boom, but too late'));
		await pending;

		// Session B must survive — the stale error from A's request shouldn't close B.
		expect(getPlaybackSession()).toMatchObject({ folderId: 2 });
		expect(clientB.close).not.toHaveBeenCalled();
	});
});

describe('skipQueue', () => {
	it('returns an error when there is no active session', async () => {
		const result = await skipQueue(1);
		expect(result).toEqual({ ok: false, reason: 'inactive' });
	});

	it('sends the jump direction to the device and refreshes status afterward', async () => {
		const player = fakePlayer({
			playerState: 'PLAYING',
			media: { metadata: { title: 'Next song' } }
		});
		await startPlaybackSession(fakeClient(), player, 1, 1, CAST_NAME, TRACKS);
		const result = await skipQueue(-1);
		expect(player.queueUpdate).toHaveBeenCalledWith([], { jump: -1 }, expect.any(Function));
		expect(result).toEqual({ ok: true });
		expect(getPlaybackSession()?.trackTitle).toBe('Next song');
	});

	it('clears the session if the device rejects the skip', async () => {
		const player = fakePlayer();
		(player.queueUpdate as ReturnType<typeof vi.fn>).mockImplementation(
			(_items: unknown[], _options: unknown, callback: (err: Error | null) => void) =>
				callback(new Error('boom'))
		);
		await startPlaybackSession(fakeClient(), player, 1, 1, CAST_NAME, TRACKS);
		const result = await skipQueue(1);
		expect(result).toEqual({ ok: false, reason: 'error', error: 'boom' });
		expect(getPlaybackSession()).toBeNull();
	});

	it('does not clobber a newer session if this one errors after being superseded', async () => {
		const playerA = fakePlayer();
		let queueCallback!: (err: Error | null) => void;
		(playerA.queueUpdate as ReturnType<typeof vi.fn>).mockImplementation(
			(_items: unknown[], _options: unknown, callback: (err: Error | null) => void) => {
				queueCallback = callback;
			}
		);
		await startPlaybackSession(fakeClient(), playerA, 1, 1, CAST_NAME, TRACKS);
		const pending = skipQueue(1);

		const clientB = fakeClient();
		await startPlaybackSession(clientB, fakePlayer(), 2, 2, CAST_NAME, TRACKS);

		queueCallback(new Error('boom, but too late'));
		await pending;

		expect(getPlaybackSession()).toMatchObject({ folderId: 2 });
		expect(clientB.close).not.toHaveBeenCalled();
	});
});

describe('stopPlayback', () => {
	it('returns an error when there is no active session', async () => {
		const result = await stopPlayback();
		expect(result).toEqual({ ok: false, reason: 'inactive' });
	});

	it('stops the player and clears the session either way', async () => {
		const client = fakeClient();
		const player = fakePlayer();
		await startPlaybackSession(client, player, 1, 1, CAST_NAME, TRACKS);
		const result = await stopPlayback();
		expect(player.stop).toHaveBeenCalled();
		expect(result).toEqual({ ok: true });
		expect(getPlaybackSession()).toBeNull();
		expect(client.close).toHaveBeenCalledOnce();
	});

	it('still clears the session even if the device errors on stop', async () => {
		const player = fakePlayer();
		(player.stop as ReturnType<typeof vi.fn>).mockImplementation(
			(callback: (err: Error | null) => void) => callback(new Error('boom'))
		);
		await startPlaybackSession(fakeClient(), player, 1, 1, CAST_NAME, TRACKS);
		const result = await stopPlayback();
		expect(result).toEqual({ ok: false, reason: 'error', error: 'boom' });
		expect(getPlaybackSession()).toBeNull();
	});

	it('does not clobber a newer session if this one resolves after being superseded', async () => {
		const playerA = fakePlayer();
		let stopCallback!: (err: Error | null) => void;
		(playerA.stop as ReturnType<typeof vi.fn>).mockImplementation(
			(callback: (err: Error | null) => void) => {
				stopCallback = callback;
			}
		);
		await startPlaybackSession(fakeClient(), playerA, 1, 1, CAST_NAME, TRACKS);
		const pending = stopPlayback();

		const clientB = fakeClient();
		await startPlaybackSession(clientB, fakePlayer(), 2, 2, CAST_NAME, TRACKS);

		stopCallback(null);
		await pending;

		expect(getPlaybackSession()).toMatchObject({ folderId: 2 });
		expect(clientB.close).not.toHaveBeenCalled();
	});
});

describe('stopIfOutsideMusicHours', () => {
	it('does nothing when there is no active session', async () => {
		await stopIfOutsideMusicHours(false);
		expect(getPlaybackSession()).toBeNull();
	});

	it('leaves an active session alone while still inside the configured hours', async () => {
		const player = fakePlayer();
		await startPlaybackSession(fakeClient(), player, 1, 1, CAST_NAME, TRACKS);
		await stopIfOutsideMusicHours(true);
		expect(player.stop).not.toHaveBeenCalled();
		expect(getPlaybackSession()).not.toBeNull();
	});

	it('stops an active session once outside the configured hours', async () => {
		const client = fakeClient();
		const player = fakePlayer();
		await startPlaybackSession(client, player, 1, 1, CAST_NAME, TRACKS);
		await stopIfOutsideMusicHours(false);
		expect(player.stop).toHaveBeenCalled();
		expect(getPlaybackSession()).toBeNull();
		expect(client.close).toHaveBeenCalledOnce();
	});
});

describe('togglePlayback', () => {
	it('returns an error when there is no active session', async () => {
		const result = await togglePlayback();
		expect(result).toEqual({ ok: false, reason: 'inactive' });
	});

	it('pauses when currently playing and refreshes status afterward', async () => {
		// No getStatusResult — startPlaybackSession's own default ('PLAYING') stands,
		// matching "currently playing" for the toggle to act on.
		const player = fakePlayer();
		await startPlaybackSession(fakeClient(), player, 1, 1, CAST_NAME, TRACKS);
		(player.getStatus as ReturnType<typeof vi.fn>).mockImplementation(
			(callback: (err: Error | null, status?: MediaStatus) => void) => {
				callback(null, { playerState: 'PAUSED', currentTime: 12 });
			}
		);
		const result = await togglePlayback();
		expect(player.pause).toHaveBeenCalled();
		expect(result).toEqual({ ok: true, action: 'pause' });
		expect(getPlaybackSession()?.playerState).toBe('PAUSED');
	});

	it('plays when currently paused', async () => {
		const player = fakePlayer();
		await startPlaybackSession(fakeClient(), player, 1, 1, CAST_NAME, TRACKS);
		player.emitStatus({ playerState: 'PAUSED' });
		const result = await togglePlayback();
		expect(player.play).toHaveBeenCalled();
		expect(result).toEqual({ ok: true, action: 'play' });
	});

	it('clears the session if the device rejects the toggle', async () => {
		const player = fakePlayer();
		(player.play as ReturnType<typeof vi.fn>).mockImplementation(
			(callback: (err: Error | null) => void) => callback(new Error('boom'))
		);
		await startPlaybackSession(fakeClient(), player, 1, 1, CAST_NAME, TRACKS);
		player.emitStatus({ playerState: 'PAUSED' });
		const result = await togglePlayback();
		expect(result).toEqual({ ok: false, reason: 'error', error: 'boom' });
		expect(getPlaybackSession()).toBeNull();
	});
});

describe('reconnect on drop', () => {
	function fakeDeps(device: DiscoveredCastDevice | null, reconnectedPlayer = fakePlayer()) {
		const reconnectedClient = fakeClient();
		const resolveSpeakerHost = vi.fn().mockResolvedValue(device);
		const playFolderOnSpeaker = vi
			.fn()
			.mockResolvedValue({ client: reconnectedClient, player: reconnectedPlayer });
		return { resolveSpeakerHost, playFolderOnSpeaker, reconnectedClient, reconnectedPlayer };
	}

	it('re-resolves the speaker and reconnects when the client errors after the session started', async () => {
		const client = fakeClient();
		const { resolveSpeakerHost, playFolderOnSpeaker, reconnectedClient, reconnectedPlayer } =
			fakeDeps({ host: '192.168.1.9', port: 8009 });
		await startPlaybackSession(client, fakePlayer(), 1, 1, CAST_NAME, TRACKS, {
			resolveSpeakerHost,
			playFolderOnSpeaker
		});

		client.emitError(new Error('Device timeout'));
		await vi.waitFor(() => {
			expect(resolveSpeakerHost).toHaveBeenCalledWith(CAST_NAME, expect.any(Object));
		});
		await vi.waitFor(() => {
			expect(playFolderOnSpeaker).toHaveBeenCalledWith('192.168.1.9', 8009, TRACKS);
		});
		await vi.waitFor(() => {
			expect(getPlaybackSession()?.player).toBe(reconnectedPlayer);
		});
		expect(getPlaybackSession()).toMatchObject({
			client: reconnectedClient,
			speakerId: 1,
			folderId: 1,
			playerState: 'PLAYING'
		});
	});

	it('closes the old client once reconnected, so its heartbeat cannot keep firing stale errors', async () => {
		const client = fakeClient();
		const { resolveSpeakerHost, playFolderOnSpeaker } = fakeDeps({
			host: '192.168.1.9',
			port: 8009
		});
		await startPlaybackSession(client, fakePlayer(), 1, 1, CAST_NAME, TRACKS, {
			resolveSpeakerHost,
			playFolderOnSpeaker
		});

		client.emitError(new Error('Device timeout'));
		await vi.waitFor(() => {
			expect(playFolderOnSpeaker).toHaveBeenCalled();
		});
		await vi.waitFor(() => {
			expect(client.close).toHaveBeenCalled();
		});
	});

	it('a delayed error from the old (already-replaced) client does not tear down the reconnected session', async () => {
		const client = fakeClient();
		const { resolveSpeakerHost, playFolderOnSpeaker, reconnectedClient } = fakeDeps({
			host: '192.168.1.9',
			port: 8009
		});
		await startPlaybackSession(client, fakePlayer(), 1, 1, CAST_NAME, TRACKS, {
			resolveSpeakerHost,
			playFolderOnSpeaker
		});

		client.emitError(new Error('Device timeout'));
		await vi.waitFor(() => {
			expect(getPlaybackSession()?.client).toBe(reconnectedClient);
		});

		// The OLD client's heartbeat could still fire a delayed error even though it's
		// abandoned — this must not affect the session that already moved on.
		client.emitError(new Error('stale heartbeat timeout from the old connection'));
		expect(getPlaybackSession()).not.toBeNull();
		expect(getPlaybackSession()?.client).toBe(reconnectedClient);
	});

	it('a delayed status event from the old (already-replaced) player does not corrupt the reconnected session', async () => {
		const client = fakeClient();
		const oldPlayer = fakePlayer();
		const { resolveSpeakerHost, playFolderOnSpeaker, reconnectedPlayer } = fakeDeps({
			host: '192.168.1.9',
			port: 8009
		});
		await startPlaybackSession(client, oldPlayer, 1, 1, CAST_NAME, TRACKS, {
			resolveSpeakerHost,
			playFolderOnSpeaker
		});

		client.emitError(new Error('Device timeout'));
		await vi.waitFor(() => {
			expect(getPlaybackSession()?.player).toBe(reconnectedPlayer);
		});

		oldPlayer.emitStatus({ playerState: 'PAUSED', media: { metadata: { title: 'Stale' } } });
		expect(getPlaybackSession()?.playerState).toBe('PLAYING');
		expect(getPlaybackSession()?.trackTitle).not.toBe('Stale');
	});

	it('gives up and clears the session if the speaker cannot be found again', async () => {
		const client = fakeClient();
		const { resolveSpeakerHost, playFolderOnSpeaker } = fakeDeps(null);
		await startPlaybackSession(client, fakePlayer(), 1, 1, CAST_NAME, TRACKS, {
			resolveSpeakerHost,
			playFolderOnSpeaker
		});

		client.emitError(new Error('Device timeout'));
		await vi.waitFor(() => {
			expect(getPlaybackSession()).toBeNull();
		});
		expect(playFolderOnSpeaker).not.toHaveBeenCalled();
	});

	it('gives up and clears the session if reconnecting fails', async () => {
		const client = fakeClient();
		const resolveSpeakerHost = vi.fn().mockResolvedValue({ host: '192.168.1.9', port: 8009 });
		const playFolderOnSpeaker = vi.fn().mockRejectedValue(new Error('connect failed'));
		await startPlaybackSession(client, fakePlayer(), 1, 1, CAST_NAME, TRACKS, {
			resolveSpeakerHost,
			playFolderOnSpeaker
		});

		client.emitError(new Error('Device timeout'));
		await vi.waitFor(() => {
			expect(getPlaybackSession()).toBeNull();
		});
	});

	it('only attempts one automatic reconnect — a second drop clears the session instead of retrying again', async () => {
		const client = fakeClient();
		const { resolveSpeakerHost, playFolderOnSpeaker, reconnectedClient } = fakeDeps({
			host: '192.168.1.9',
			port: 8009
		});
		await startPlaybackSession(client, fakePlayer(), 1, 1, CAST_NAME, TRACKS, {
			resolveSpeakerHost,
			playFolderOnSpeaker
		});

		client.emitError(new Error('Device timeout'));
		await vi.waitFor(() => {
			expect(getPlaybackSession()?.client).toBe(reconnectedClient);
		});

		reconnectedClient.emitError(new Error('Device timeout again'));
		await vi.waitFor(() => {
			expect(getPlaybackSession()).toBeNull();
		});
		expect(playFolderOnSpeaker).toHaveBeenCalledOnce();
	});

	it('discards the reconnected connection if the session was replaced while reconnecting', async () => {
		const client = fakeClient();
		let resolveDevice!: (device: DiscoveredCastDevice) => void;
		const resolveSpeakerHost = vi.fn(
			() => new Promise<DiscoveredCastDevice>((resolve) => (resolveDevice = resolve))
		);
		const reconnectedClient = fakeClient();
		const playFolderOnSpeaker = vi
			.fn()
			.mockResolvedValue({ client: reconnectedClient, player: fakePlayer() });
		await startPlaybackSession(client, fakePlayer(), 1, 1, CAST_NAME, TRACKS, {
			resolveSpeakerHost,
			playFolderOnSpeaker
		});

		client.emitError(new Error('Device timeout'));
		// A brand new session starts (e.g. the user tapped play again) while the dropped
		// one is still mid-reconnect.
		const newClient = fakeClient();
		await startPlaybackSession(newClient, fakePlayer(), 2, 2, CAST_NAME, TRACKS);

		resolveDevice({ host: '192.168.1.9', port: 8009 });
		await vi.waitFor(() => {
			expect(playFolderOnSpeaker).toHaveBeenCalled();
		});
		// The stale reconnect shouldn't resurrect itself over the newer session, and its
		// now-unwanted connection should be closed rather than left dangling.
		expect(getPlaybackSession()?.folderId).toBe(2);
		expect(reconnectedClient.close).toHaveBeenCalled();
	});
});
