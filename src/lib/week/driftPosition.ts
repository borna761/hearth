// Screensaver overlay drift — DESIGN.md §7.1: "drifts slowly around the screen, a few
// pixels per minute: static bright text held in one position for months causes image
// retention on an LCD."
//
// Two sinusoids on deliberately different, non-integer-ratio periods rather than one
// circular path — a single period would retrace the exact same points every cycle, which
// is still "static" from the LCD's point of view over a long enough span.

export interface DriftOffset {
	x: number;
	y: number;
}

export const DRIFT_AMPLITUDE_PX = 24;
const PERIOD_X_MS = 47 * 60_000;
const PERIOD_Y_MS = 71 * 60_000;

export function driftOffset(elapsedMs: number): DriftOffset {
	const x = Math.sin((2 * Math.PI * elapsedMs) / PERIOD_X_MS) * DRIFT_AMPLITUDE_PX;
	const y = Math.sin((2 * Math.PI * elapsedMs) / PERIOD_Y_MS) * DRIFT_AMPLITUDE_PX;
	return { x, y };
}
