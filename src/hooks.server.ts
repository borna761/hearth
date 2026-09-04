import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { startSyncScheduler } from '$lib/server/sync/runtime';
import { registerShutdownHandler } from '$lib/server/shutdown';
import { db } from '$lib/server/db';
import { loadSession, SESSION_COOKIE, GUEST_COOKIE } from '$lib/server/auth/session';

// Module scope runs once when the server boots, which is where the sync loop belongs —
// DESIGN.md §10 keeps calendar sync in-process rather than in its own unit. Skipped
// during `building`, when SvelteKit imports modules to analyse routes and there is no
// server to schedule anything on.
if (!building) {
	startSyncScheduler();
	// Without this, the sync scheduler's own setIntervals keep the process alive forever
	// after adapter-node's graceful HTTP shutdown finishes — see shutdown.ts.
	registerShutdownHandler();
}

// Populates locals only — no redirects/route-gating here yet. That lands once the
// lock/screensaver UI exists to redirect *to* (Phase 3, milestone 2); until then every
// route still behaves exactly as it did before this hook existed.
export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	event.locals.session = token ? await loadSession(db, token) : null;
	event.locals.guestMode = event.cookies.get(GUEST_COOKIE) === '1';
	return resolve(event);
};
