// Pure decision logic pulled out of +page.svelte's idle-timeout effects so it's testable
// without a component-testing setup — same reasoning musicPanelLogic.ts already follows.
//
// The music panel was missing from every one of these checks (only grocery/tasks were
// wired in when it was added in phase 7), which is why it never got the panel-length idle
// allowance, never kept its session alive with a heartbeat, and never closed itself when a
// session did end.

export const IDLE_TIMEOUT_MS = 2 * 60_000;
export const PANEL_IDLE_TIMEOUT_MS = 5 * 60_000;

export interface PanelOpenState {
	groceryPanelOpen: boolean;
	taskPanelOpen: boolean;
	musicPanelOpen: boolean;
}

export function anyPanelOpen(state: PanelOpenState): boolean {
	return state.groceryPanelOpen || state.taskPanelOpen || state.musicPanelOpen;
}

/** docs/phase-5-plan.md M4: standing at the counter reading a panel's contents touches
 *  nothing, and that shouldn't end the session as fast as genuine inactivity would. */
export function panelIdleTimeoutMs(state: PanelOpenState): number {
	return anyPanelOpen(state) ? PANEL_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
}

export function closePanels(): PanelOpenState {
	return { groceryPanelOpen: false, taskPanelOpen: false, musicPanelOpen: false };
}
