// Client-side interpolation for the music panel's progress bar. The server only reports
// a snapshot of elapsed time (from the Cast device's own status), not a live tick — this
// fills the gap between real syncs (on open, and after play/pause/next) with wall-clock
// math instead, per the deliberate choice not to add periodic polling for this feature.

export type PlayerState = 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED';

export function computeElapsedSeconds(params: {
	currentTime: number | null;
	syncedAtMs: number | null;
	nowMs: number;
	playerState: PlayerState;
	duration: number | null;
}): number {
	const { currentTime, syncedAtMs, nowMs, playerState, duration } = params;
	if (currentTime === null || syncedAtMs === null) return 0;
	const elapsed =
		playerState === 'PLAYING' ? currentTime + (nowMs - syncedAtMs) / 1000 : currentTime;
	return duration !== null ? Math.min(elapsed, duration) : elapsed;
}

export function formatTrackTime(totalSeconds: number | null): string {
	const seconds = Math.max(0, Math.floor(totalSeconds ?? 0));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	const paddedS = String(s).padStart(2, '0');
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${paddedS}`;
	return `${m}:${paddedS}`;
}
