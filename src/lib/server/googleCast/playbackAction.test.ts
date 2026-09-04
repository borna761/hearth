import { describe, it, expect } from 'vitest';
import { nextToggleAction } from './playbackAction';

describe('nextToggleAction', () => {
	it('pauses when currently playing', () => {
		expect(nextToggleAction('PLAYING')).toBe('pause');
	});

	it('plays when currently paused', () => {
		expect(nextToggleAction('PAUSED')).toBe('play');
	});

	it('plays when idle, buffering, or unknown — anything not actively playing', () => {
		expect(nextToggleAction('IDLE')).toBe('play');
		expect(nextToggleAction('BUFFERING')).toBe('play');
		expect(nextToggleAction(undefined)).toBe('play');
	});
});
