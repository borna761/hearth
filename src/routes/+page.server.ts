import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { listPublicUsers } from '$lib/server/users';
import { toPageSession } from '$lib/server/auth/session';
import {
	getHouseholdTimeZone,
	getHouseholdLocation,
	getThemeMode,
	getTimeFormat,
	getQuietHours,
	isWithinQuietHours
} from '$lib/server/settings';
import { getCachedWeather } from '$lib/server/weather';
import { computeTheme } from '$lib/theme';
import { localMinutesInZone } from '$lib/datetime';

export const load: PageServerLoad = async ({ locals }) => {
	const timeZone = await getHouseholdTimeZone(db);
	// Mirrors publishScreensaverState's own quiet-hours check (DESIGN.md §9.2) so the
	// server-rendered first paint already agrees with what the screensaver stream's first
	// message will say — otherwise the real weather flashes on screen for a frame before
	// the SSE connection overwrites it with null.
	const inQuietHours = isWithinQuietHours(
		localMinutesInZone(new Date(), timeZone),
		await getQuietHours(db)
	);
	const location = await getHouseholdLocation(db);

	return {
		session: toPageSession(locals.session),
		guestMode: locals.guestMode,
		users: await listPublicUsers(db),
		// Needed by the screensaver to show a correct clock before any session/snapshot
		// exists — the same household zone the week view already trusts over the tablet's
		// own configured timezone (§5.3: "the client stays dumb").
		timeZone,
		// Weather is explicitly not "household data" (DESIGN.md §5's access diagram), so
		// it's safe on the pre-session load too — this is a page-load snapshot for the lock
		// screen; it only live-updates once a session's /api/stream is open. Lock only stays
		// on screen for a few seconds in practice, so that staleness is fine until the
		// public screensaver stream (phase 4 milestone 3) gives it a live source too.
		weather: inQuietHours ? null : getCachedWeather(),
		// Same reasoning as weather: the theme decision isn't household data either, and
		// seeding it here avoids a flash of the wrong theme before the first SSE message.
		theme: computeTheme(new Date(), await getThemeMode(db), location),
		// Same one-shot-seed-then-SSE pattern as weather/theme above.
		timeFormat: await getTimeFormat(db)
	};
};
