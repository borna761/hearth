export type PlayerState = 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED';

/** The toggle button always reflects the device's own last-known state rather than
 *  optimistic client-side state, so it stays correct even if playback was paused/resumed
 *  from outside Hearth (e.g. the Google Home app directly). */
export function nextToggleAction(playerState: PlayerState | null | undefined): 'play' | 'pause' {
	return playerState === 'PLAYING' ? 'pause' : 'play';
}
