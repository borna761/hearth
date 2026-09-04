import { describe, it, expect } from 'vitest';
import {
	anyPanelOpen,
	panelIdleTimeoutMs,
	closePanels,
	IDLE_TIMEOUT_MS,
	PANEL_IDLE_TIMEOUT_MS
} from './panelIdle';

describe('anyPanelOpen', () => {
	it('is false when no panel is open', () => {
		expect(
			anyPanelOpen({ groceryPanelOpen: false, taskPanelOpen: false, musicPanelOpen: false })
		).toBe(false);
	});

	it('is true when only the music panel is open', () => {
		expect(
			anyPanelOpen({ groceryPanelOpen: false, taskPanelOpen: false, musicPanelOpen: true })
		).toBe(true);
	});

	it('is true when only the grocery panel is open', () => {
		expect(
			anyPanelOpen({ groceryPanelOpen: true, taskPanelOpen: false, musicPanelOpen: false })
		).toBe(true);
	});

	it('is true when only the task panel is open', () => {
		expect(
			anyPanelOpen({ groceryPanelOpen: false, taskPanelOpen: true, musicPanelOpen: false })
		).toBe(true);
	});
});

describe('panelIdleTimeoutMs', () => {
	it('uses the short session timeout when no panel is open', () => {
		expect(
			panelIdleTimeoutMs({ groceryPanelOpen: false, taskPanelOpen: false, musicPanelOpen: false })
		).toBe(IDLE_TIMEOUT_MS);
	});

	it('uses the longer panel timeout when the music panel is open', () => {
		expect(
			panelIdleTimeoutMs({ groceryPanelOpen: false, taskPanelOpen: false, musicPanelOpen: true })
		).toBe(PANEL_IDLE_TIMEOUT_MS);
	});
});

describe('closePanels', () => {
	it('closes all three panels', () => {
		expect(closePanels()).toEqual({
			groceryPanelOpen: false,
			taskPanelOpen: false,
			musicPanelOpen: false
		});
	});
});
