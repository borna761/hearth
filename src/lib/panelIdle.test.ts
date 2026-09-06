import { describe, it, expect } from 'vitest';
import {
	panelIdleTimeoutMs,
	IDLE_TIMEOUT_MS,
	PANEL_IDLE_TIMEOUT_MS,
	SHORT_PANEL_IDLE_TIMEOUT_MS
} from './panelIdle';

describe('panelIdleTimeoutMs', () => {
	it('uses the short session timeout when no panel is open', () => {
		expect(panelIdleTimeoutMs(null)).toBe(IDLE_TIMEOUT_MS);
	});

	it('uses the longer panel timeout when the grocery panel is open', () => {
		expect(panelIdleTimeoutMs('grocery')).toBe(PANEL_IDLE_TIMEOUT_MS);
	});

	it('uses the longer panel timeout when the task panel is open', () => {
		expect(panelIdleTimeoutMs('task')).toBe(PANEL_IDLE_TIMEOUT_MS);
	});

	// Music is usually actively browsed/controlled rather than passively read like a
	// grocery/task list, and weather is normally just a quick glance — both should give up
	// the session/screensaver sooner than the grocery/task allowance does.
	it('uses the shorter timeout when the music panel is open', () => {
		expect(panelIdleTimeoutMs('music')).toBe(SHORT_PANEL_IDLE_TIMEOUT_MS);
	});

	it('uses the shorter timeout when the weather panel is open', () => {
		expect(panelIdleTimeoutMs('weather')).toBe(SHORT_PANEL_IDLE_TIMEOUT_MS);
	});
});
