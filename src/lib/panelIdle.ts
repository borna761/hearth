// Pure decision logic pulled out of +page.svelte's idle-timeout effects so it's testable
// without a component-testing setup — same reasoning musicPanelLogic.ts already follows.
//
// The music panel was missing from every one of these checks (only grocery/tasks were
// wired in when it was added in phase 7), which is why it never got the panel-length idle
// allowance, never kept its session alive with a heartbeat, and never closed itself when a
// session did end. A 4th panel (weather) repeated that exact shape a second time before
// this collapsed to a single `openPanel` value — at most one panel is ever open at once in
// practice (they're all full-bleed or edge-pinned overlays that don't compose), so one
// `PanelKind | null` says that directly instead of four independently-settable booleans
// that happened to always move in lockstep.

export type PanelKind = 'grocery' | 'task' | 'music' | 'weather';

export const IDLE_TIMEOUT_MS = 2 * 60_000;
export const PANEL_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Shorter than PANEL_IDLE_TIMEOUT_MS on purpose: music is usually actively browsed or
 * controlled rather than passively read like a grocery/task list, and weather is normally
 * just a quick glance — a stray open panel with nobody touching it should give up sooner
 * than the grocery/task allowance does. */
export const SHORT_PANEL_IDLE_TIMEOUT_MS = 60_000;

const PANEL_TIMEOUT_MS: Record<PanelKind, number> = {
	grocery: PANEL_IDLE_TIMEOUT_MS,
	task: PANEL_IDLE_TIMEOUT_MS,
	weather: SHORT_PANEL_IDLE_TIMEOUT_MS,
	music: SHORT_PANEL_IDLE_TIMEOUT_MS
};

/** docs/phase-5-plan.md M4: standing at the counter reading a panel's contents touches
 *  nothing, and that shouldn't end the session as fast as genuine inactivity would. A new
 *  panel kind gets the right timeout automatically the moment it's added to
 *  PANEL_TIMEOUT_MS above — no separate if-chain to remember to extend. */
export function panelIdleTimeoutMs(openPanel: PanelKind | null): number {
	return openPanel ? PANEL_TIMEOUT_MS[openPanel] : IDLE_TIMEOUT_MS;
}
