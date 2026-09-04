// Starts the in-process sync loop. Kept separate from scheduler.ts so the cycle logic
// stays free of timers and environment lookups, and therefore testable.

import { db } from '../db';
import { getHouseholdTimeZone, getMusicHours, getQuietHours, isMusicAllowed } from '../settings';
import { getGoogleOAuthConfig } from '../google/config';
import { getValidAccessTokenForConnection, type StoredGoogleSecrets } from '../google/tokens';
import type { ConnectionRecord } from '../connections';
import { publishState } from '../state/publisher';
import { publishScreensaverState } from '../state/screensaverPublisher';
import { stopIfOutsideMusicHours } from '../googleCast/playbackSession';
import { refreshWeather, getCachedWeather, hydrateWeatherCache } from '../weather';
import { localMinutesInZone } from '$lib/datetime';
import { runSyncCycle, createSingleFlight } from './scheduler';
import {
	initGroceriesRuntime,
	runGroceriesCycleNow,
	onGroceriesListsUpdate,
	recentlyCycled,
	groceriesSourceId
} from '../groceriesRuntime';
import { initTasksRuntime, runTasksCycleNow } from '../tasksRuntime';

/** DESIGN.md §3.1: Google Calendar deltas every five minutes. */
const DEFAULT_INTERVAL_MINUTES = 5;
/** Long enough for the network to be up on a cold boot, short enough to feel immediate. */
const STARTUP_DELAY_MS = 10_000;
/** Catches the midnight date rollover without waiting for a sync. */
const STATE_TICK_MS = 60_000;
/** DESIGN.md §3.1: Open-Meteo, 15 min. */
const WEATHER_INTERVAL_MS = 15 * 60_000;
/** DESIGN.md §7.1: the screensaver cross-fades to a new slide every 30s. */
const SCREENSAVER_TICK_MS = 30_000;
/** docs/phase-5-plan.md §2.1: the actual freshness guarantee for groceries, independent
 *  of whether AnyList's push channel is still alive. */
const GROCERIES_POLL_INTERVAL_MS = 15 * 60_000;
/** docs/phase-5-plan.md §2.2: collapses a burst of rapid edits (someone adding several
 *  items in a row) into one reconcile instead of one per item. */
const GROCERIES_PUSH_DEBOUNCE_MS = 2_000;
/**
 * A push landing this soon after a cycle already completed is treated as AnyList echoing
 * back a write this same process just made, not independent news — added during code
 * review: an API route already triggers a full reconcile+drain right after enqueueing,
 * and without this, that write's own AnyList confirmation coming back as a push would
 * trigger a second full cycle (walking every item in the list, not just the one that
 * changed) a couple of seconds later for nothing new. Generous relative to the 2s debounce
 * above to comfortably cover AnyList's own round-trip latency on top of it.
 */
const GROCERIES_ECHO_SUPPRESS_MS = 6_000;
/** docs/phase-6-todoist-plan.md §7: matches groceries' own freshness guarantee. No push
 *  channel to debounce against here — Todoist's REST API has nothing comparable to
 *  AnyList's websocket, so polling is the only freshness signal there is at all, not one
 *  of two. */
const TASKS_POLL_INTERVAL_MS = 15 * 60_000;

let started = false;
let groceriesStarted = false;
let tasksStarted = false;

/** Module-level, not a closure inside startSyncScheduler — publishState needs nothing else
 *  from that scope, and startGroceries (below) has to reach it too from outside the timer
 *  setup, once the settings screen (M6) can trigger a connect after the process has
 *  already been running for a while. */
async function pushState(): Promise<void> {
	try {
		await publishState();
	} catch (err) {
		console.warn('[state] publish failed:', err instanceof Error ? err.message : err);
	}
}

/**
 * Same as pushState, plus the screensaver bus — for groceries specifically, since its
 * PIN-free screensaver button (DESIGN.md §5.1) reads from screensaverPublisher, not the
 * session-gated stream pushState alone reaches. Without this, an AnyList-side edit (this
 * file's own poll/push-debounce handlers, not the /api/groceries routes, which call
 * publishAll directly) would sit invisible on that display for up to tickScreensaver's own
 * SCREENSAVER_TICK_MS.
 *
 * `{ advanceSlide: false }` — same reasoning as publishAll (state/publisher.ts): an
 * AnyList-side grocery edit has nothing to do with the photo rotation, and a plain
 * publishScreensaverState call would otherwise advance the background photo on every one
 * of these, not just on the periodic tick that's actually supposed to.
 */
async function pushGroceriesState(): Promise<void> {
	await pushState();
	try {
		await publishScreensaverState(db, new Date(), Math.random, { advanceSlide: false });
	} catch (err) {
		console.warn('[screensaver] publish failed:', err instanceof Error ? err.message : err);
	}
}

/**
 * Connects and wires up the poll + push handlers — docs/phase-5-plan.md M2/M3. The
 * connection itself (and the single-flight-guarded trigger both this and /api/groceries
 * routes call) lives in groceriesRuntime.ts, not here, so a route enqueueing a write can
 * reach the same guarded cycle this file's timers use rather than waiting on the next
 * scheduled poll. Does nothing further if initialisation fails — no AnyList connection
 * configured yet, a bad login, the account missing the expected list — all normal states
 * this app can be in, not crashes.
 *
 * Exported and idempotent (guarded on `groceriesStarted` — checking `groceriesSourceId()`
 * instead would still return true after a second, redundant `initGroceriesRuntime()` call,
 * which opens a second real AnyList login/websocket without tearing down the first) so the
 * settings screen's connect form (M6) can call this directly right after saving a new
 * connection, rather than requiring a full process restart before groceries appears —
 * DESIGN.md §1: "Web app, so updates never require touching the tablet." The scheduler's
 * own boot-time call below is what covers the normal case (already connected at startup).
 */
export async function startGroceries(): Promise<boolean> {
	if (groceriesStarted) return groceriesSourceId() !== null;

	const connected = await initGroceriesRuntime();
	if (!connected) return false;
	groceriesStarted = true;

	const pollGroceries = async () => {
		// null means a debounced push (or an API route's own trigger) landed on the exact
		// same tick — the next poll is 15 minutes away, which costs nothing to wait for.
		const result = await runGroceriesCycleNow(true);
		if (result?.error) console.warn('[groceries] poll failed:', result.error);
		await pushGroceriesState();
	};

	let pushDebounce: ReturnType<typeof setTimeout> | undefined;
	onGroceriesListsUpdate(() => {
		// Trailing debounce: a burst of rapid edits collapses into one reconcile.
		clearTimeout(pushDebounce);
		pushDebounce = setTimeout(() => {
			void (async () => {
				// Skip if a cycle just ran — almost certainly this push is AnyList echoing
				// back the write that cycle already made, not independent news.
				if (recentlyCycled(GROCERIES_ECHO_SUPPRESS_MS)) return;
				const result = await runGroceriesCycleNow(false);
				if (result?.error) console.warn('[groceries] push reconcile failed:', result.error);
				await pushGroceriesState();
			})();
		}, GROCERIES_PUSH_DEBOUNCE_MS);
	});

	// Populate list_items right away rather than leaving the count blank for up to 15
	// minutes after a restart.
	await pollGroceries();
	setInterval(pollGroceries, GROCERIES_POLL_INTERVAL_MS);
	return true;
}

/**
 * Same exported-and-idempotent shape as startGroceries, for the same reason: the settings
 * screen's Todoist connect form needs to bring tasks live without a process restart. No
 * push handler to register — poll only, every TASKS_POLL_INTERVAL_MS.
 */
export async function startTasks(): Promise<boolean> {
	if (tasksStarted) return true;

	const connected = await initTasksRuntime();
	if (!connected) return false;
	tasksStarted = true;

	const pollTasks = async () => {
		const result = await runTasksCycleNow();
		if (result?.error) console.warn('[tasks] poll failed:', result.error);
		await pushState();
	};

	await pollTasks();
	setInterval(pollTasks, TASKS_POLL_INTERVAL_MS);
	return true;
}

function intervalMs(): number {
	const configured = Number(process.env.HEARTH_SYNC_INTERVAL_MINUTES ?? DEFAULT_INTERVAL_MINUTES);
	return Number.isFinite(configured) && configured > 0
		? configured * 60_000
		: DEFAULT_INTERVAL_MINUTES * 60_000;
}

export function startSyncScheduler(): void {
	// Module state rather than a caller-side guard: in dev, HMR can re-evaluate this
	// module, and a second interval would mean two cycles racing the same sync tokens.
	if (started) return;
	if (process.env.HEARTH_SYNC_ENABLED === 'false') {
		console.log('[sync] disabled by HEARTH_SYNC_ENABLED=false');
		return;
	}
	started = true;

	// Fire-and-forget: seeds the in-memory cache from the last persisted reading before
	// anything asks for it, so a restart doesn't show a blank strip for the ~10s until the
	// first real fetch (STARTUP_DELAY_MS below) — hydrateWeatherCache already swallows its
	// own errors, so there's nothing to catch here.
	void hydrateWeatherCache(db);

	const runCycle = createSingleFlight(async () => {
		const timeZone = await getHouseholdTimeZone(db);
		return runSyncCycle(db, {
			now: new Date(),
			timeZone,
			getAccessToken: (connection) =>
				getValidAccessTokenForConnection(
					db,
					connection as unknown as ConnectionRecord<StoredGoogleSecrets>,
					getGoogleOAuthConfig()
				)
		});
	});

	const tick = async () => {
		try {
			const result = await runCycle();
			// null means a previous cycle was still running; the next tick is five minutes
			// away, so dropping this one costs nothing.
			if (!result) return;
			if (result.calendars > 0 || result.failures.length > 0) {
				console.log(
					`[sync] ${result.mode}: ${result.calendars} calendars, ` +
						`+${result.upserted} ~${result.deleted} -${result.pruned}` +
						(result.failures.length ? `, ${result.failures.length} failed` : '')
				);
			}
			for (const failure of result.failures) {
				console.warn(`[sync] ${failure.calendar}: ${failure.error}`);
			}
		} catch (err) {
			// Never let a cycle's failure kill the interval — no Google connection yet, a
			// missing OAuth config, or the NAS/network being down at boot are all normal.
			console.warn('[sync] cycle failed:', err instanceof Error ? err.message : err);
		}

		// Push after every cycle, successful or not: a partial sync still changed the week,
		// and publishState dedupes anyway, so a no-op cycle costs one comparison.
		await pushState();
	};

	// Its own cadence, independent of the calendar sync interval — refreshWeather has its
	// own 15-minute cache internally too, so calling this more often than that costs
	// nothing (it just returns the cached reading without another fetch).
	const tickWeather = async () => {
		const before = JSON.stringify(getCachedWeather());
		await refreshWeather();
		const after = JSON.stringify(getCachedWeather());
		if (before !== after) await pushState();
	};

	const tickScreensaver = async () => {
		try {
			await publishScreensaverState(db);
		} catch (err) {
			console.warn('[screensaver] publish failed:', err instanceof Error ? err.message : err);
		}
	};

	// Same cadence as tickScreensaver — the music button hiding (screensaverPublisher.ts's
	// own musicHours gate) is cosmetic, but actually cutting the Cast device's audio at the
	// window's end needs its own active step, not just the UI going quiet around it. Checks
	// quiet hours too (via isMusicAllowed), not just music hours — the two settings are
	// independent, so an overlapping music-hours window must not leave audio playing once
	// quiet hours begin.
	const tickMusicHours = async () => {
		try {
			const timeZone = await getHouseholdTimeZone(db);
			const musicHours = await getMusicHours(db);
			const quietHours = await getQuietHours(db);
			const minutes = localMinutesInZone(new Date(), timeZone);
			await stopIfOutsideMusicHours(isMusicAllowed(minutes, musicHours, quietHours));
		} catch (err) {
			console.warn('[music] hours check failed:', err instanceof Error ? err.message : err);
		}
	};

	setTimeout(tick, STARTUP_DELAY_MS);
	setTimeout(tickWeather, STARTUP_DELAY_MS);
	setTimeout(tickScreensaver, STARTUP_DELAY_MS);
	setTimeout(tickMusicHours, STARTUP_DELAY_MS);
	setTimeout(startGroceries, STARTUP_DELAY_MS);
	setTimeout(startTasks, STARTUP_DELAY_MS);
	setInterval(tick, intervalMs());
	setInterval(pushState, STATE_TICK_MS);
	setInterval(tickWeather, WEATHER_INTERVAL_MS);
	setInterval(tickScreensaver, SCREENSAVER_TICK_MS);
	setInterval(tickMusicHours, SCREENSAVER_TICK_MS);
	console.log(`[sync] scheduler started, every ${intervalMs() / 60_000} min`);
}
