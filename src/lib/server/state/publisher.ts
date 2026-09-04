// Ties the snapshot builder to the broadcaster, and owns the one process-wide bus.

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { db as defaultDb } from '../db';
import type * as schema from '../db/schema';
import {
	getHouseholdTimeZone,
	getHouseholdLocation,
	getQuietHours,
	getThemeMode,
	getTimeFormat,
	isWithinQuietHours
} from '../settings';
import { loadSession } from '../auth/session';
import { getVisibleSourceIds } from '../visibility';
import { localMinutesInZone } from '$lib/datetime';
import { createBroadcaster } from './broadcaster';
import { publishScreensaverState } from './screensaverPublisher';
import { buildWeekSnapshot } from './snapshot';
import { getCachedWeather } from '../weather';
import { computeTheme } from '$lib/theme';
import { buildGroceriesSnapshot } from '../groceries';
import { buildTasksSnapshot } from '../tasks';

type Db = BetterSQLite3Database<typeof schema>;

export const stateBus = createBroadcaster();

export type PublishOutcome = 'published' | 'unchanged' | 'quiet-hours';

/**
 * Which session, if any, the one physical tablet is currently showing (DESIGN.md §5).
 * Set by the login/logout endpoints. publishState resolves this fresh — via loadSession,
 * not a cached boolean — on every call, so an idle-expired session is caught the next
 * time anything publishes (at most 60s later, via the state tick in sync/runtime.ts) even
 * if the client never calls /logout itself.
 */
let activeSessionToken: string | null = null;

export function setActiveSessionToken(token: string | null): void {
	activeSessionToken = token;
}

/**
 * Builds the current week and hands it to the bus, or — with no valid active session —
 * publishes a `{type:'locked'}` envelope instead, so an open stream snaps back to the
 * lock screen independent of the client's own idle timer.
 *
 * Returns 'unchanged' rather than pushing when the payload matches what displays already
 * have — the five-minute sync usually finds nothing, and the week only really changes
 * when someone edits a calendar or the date rolls over.
 */
export async function publishState(
	now: Date = new Date(),
	db: Db = defaultDb
): Promise<PublishOutcome> {
	const timeZone = await getHouseholdTimeZone(db);
	const quietHours = await getQuietHours(db);

	// §7.2/§7.3: the lock screen and the top strip both carry "the same clock and weather",
	// so it rides in every envelope this publishes, not just the week one. Theme and time
	// format ride alongside for the same reason — they apply to an active session at night
	// (or after a settings change) too, not just the resting screensaver.
	const weather = getCachedWeather();
	const theme = computeTheme(now, await getThemeMode(db), await getHouseholdLocation(db));
	const timeFormat = await getTimeFormat(db);

	const session = activeSessionToken ? await loadSession(db, activeSessionToken, now) : null;
	if (!session) {
		activeSessionToken = null;
		// §9.2: the screen is assumed dark between 22:00 and 07:00 with nobody logged in, so
		// there's no point refreshing the lock screen's clock/weather for it. This must only
		// gate the *locked* branch, not the function as a whole — a real, PIN-verified session
		// means someone is deliberately looking at the screen right now regardless of what
		// quiet_hours assumes about the backlight (the kiosk app has no scheduled screen-off
		// configured, so that assumption is wrong outright even setting aside that logging in
		// at night to check tomorrow's schedule is a normal thing to do anyway). Previously
		// this suppressed the week snapshot too, which meant logging in during quiet hours got
		// stuck on "Loading…" forever — the server never sent it anything.
		if (isWithinQuietHours(localMinutesInZone(now, timeZone), quietHours)) {
			return 'quiet-hours';
		}
		return stateBus.publish(JSON.stringify({ type: 'locked', weather, theme, timeFormat }))
			? 'published'
			: 'unchanged';
	}

	// DESIGN.md §4/§7.5: each session shows only that person's configured calendars.
	const visibleSourceIds = await getVisibleSourceIds(db, session.userId);
	const snapshot = await buildWeekSnapshot(db, {
		now,
		timeZone,
		quietHours,
		timeFormat,
		visibleSourceIds
	});
	// DESIGN.md §5.1: groceries stay behind the PIN like everything else in a session —
	// unlike weather/theme above, this has no business riding in the 'locked' envelope.
	const groceries = await buildGroceriesSnapshot(db);
	// Per-user task access (users.taskAccess) — buildTasksSnapshot resolves it from the
	// user id itself, not from session.viewMode.
	const tasks = await buildTasksSnapshot(db, session.userId, now);
	return stateBus.publish(
		JSON.stringify({ type: 'week', snapshot, weather, theme, timeFormat, groceries, tasks })
	)
		? 'published'
		: 'unchanged';
}

/**
 * publishState alone only reaches the session-gated week stream — a locked envelope
 * carries no groceries/music/weather-for-the-screensaver at all (DESIGN.md §5.1). The
 * screensaver's own PIN-free groceries button and music panel read from
 * screensaverPublisher's separate bus, which — without this — only ever refreshed on
 * sync/runtime.ts's own periodic tick (up to SCREENSAVER_TICK_MS behind an edit). Callers
 * that just changed something a screensaver-mode display might be showing (groceries,
 * primarily) should call this instead of publishState alone, so the edit shows up
 * immediately regardless of which button — logged-in or PIN-free — made it.
 *
 * `{ advanceSlide: false }` on the screensaver publish: this fires on a grocery edit,
 * unrelated to the photo rotation, and composeNextSlide (photos.ts) has no "peek" — a
 * plain publishScreensaverState call here would advance the background photo on every
 * grocery tap, not just on the periodic screensaver tick that's actually supposed to.
 */
export async function publishAll(now: Date = new Date(), db: Db = defaultDb): Promise<void> {
	await publishState(now, db);
	await publishScreensaverState(db, now, Math.random, { advanceSlide: false });
}
