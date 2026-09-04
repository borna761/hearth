import { describe, it, expect } from 'vitest';
import { computeElapsedSeconds, formatTrackTime } from './musicProgress';

describe('computeElapsedSeconds', () => {
	it('advances with wall-clock time while playing', () => {
		const elapsed = computeElapsedSeconds({
			currentTime: 10,
			syncedAtMs: 1_000,
			nowMs: 4_000,
			playerState: 'PLAYING',
			duration: 120
		});
		expect(elapsed).toBe(13);
	});

	it('stays frozen at the last known value while paused, ignoring wall-clock time', () => {
		const elapsed = computeElapsedSeconds({
			currentTime: 10,
			syncedAtMs: 1_000,
			nowMs: 9_000,
			playerState: 'PAUSED',
			duration: 120
		});
		expect(elapsed).toBe(10);
	});

	it('never reports past the track duration, even if interpolation would overshoot', () => {
		const elapsed = computeElapsedSeconds({
			currentTime: 118,
			syncedAtMs: 1_000,
			nowMs: 20_000,
			playerState: 'PLAYING',
			duration: 120
		});
		expect(elapsed).toBe(120);
	});

	it('returns 0 when nothing is known yet', () => {
		const elapsed = computeElapsedSeconds({
			currentTime: null,
			syncedAtMs: null,
			nowMs: 5_000,
			playerState: 'PLAYING',
			duration: 120
		});
		expect(elapsed).toBe(0);
	});
});

describe('formatTrackTime', () => {
	it('formats sub-minute durations as 0:ss', () => {
		expect(formatTrackTime(7)).toBe('0:07');
	});

	it('formats minutes and seconds as m:ss', () => {
		expect(formatTrackTime(83)).toBe('1:23');
	});

	it('formats an hour-plus duration as h:mm:ss', () => {
		expect(formatTrackTime(3725)).toBe('1:02:05');
	});

	it('treats null/negative as 0:00', () => {
		expect(formatTrackTime(null)).toBe('0:00');
		expect(formatTrackTime(-5)).toBe('0:00');
	});
});
