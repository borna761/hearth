// The screensaver's own SSE bus — deliberately separate from publisher.ts's session-gated
// one. DESIGN.md §5's access diagram labels the screensaver "no household data," visible
// before any PIN. Groceries and music are the deliberate exceptions (DESIGN.md §5.1,
// docs/phase-7-music-plan.md): shared household data, not per-person, so they ride this
// public bus too — but only in 'family' mode. Guest mode still sees nothing, same as
// everything else here.

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';
import {
	getHouseholdTimeZone,
	getHouseholdLocation,
	getQuietHours,
	getMusicHours,
	getThemeMode,
	getTimeFormat,
	isWithinQuietHours,
	isWithinMusicHours,
	getSetting,
	setSetting,
	SETTING_KEYS
} from '../settings';
import { getCachedWeather } from '../weather';
import { nextGuestPhotoUrl } from '../guestPhotos';
import { composeNextSlide, type PhotoRow, type ScreensaverPhotoSlide } from '../photos';
import { buildGroceriesSnapshot } from '../groceries';
import { listMusicFolders, listMusicSpeakers } from '../musicLibrary';
import { localMinutesInZone } from '$lib/datetime';
import { createBroadcaster } from './broadcaster';
import { computeTheme } from '$lib/theme';

type Db = BetterSQLite3Database<typeof schema>;

export const screensaverBus = createBroadcaster();

export type ScreensaverPublishOutcome = 'published' | 'unchanged' | 'quiet-hours';

interface PublishedPhoto {
	url: string;
	blurHash: string | null;
}

type PublishedSlide =
	| { kind: 'single'; photo: PublishedPhoto }
	| { kind: 'pair'; photos: [PublishedPhoto, PublishedPhoto] };

/**
 * Which screensaver variant the one physical tablet is currently showing (DESIGN.md §5).
 * Settings-table-backed, unlike activeSessionToken (state/publisher.ts) — deliberately
 * durable across a restart. A live session ending mid-idle-timeout and needing a fresh
 * PIN afterward is correct/safe default behavior; a guest's photos and PIN-free access
 * silently reverting to the family screensaver because a deploy happened to restart the
 * process overnight is not — DESIGN.md §5 already calls guest mode "sticky... until
 * someone enters a PIN," and that has to survive more than just the current process.
 * Set by the login/logout/guest endpoints; defaults to 'family' (the resting state) when
 * nothing has ever been set, since DESIGN.md §5's diagram returns from a session to the
 * family screensaver, not back to guest.
 */
export async function getActiveScreensaverMode(db: Db): Promise<'family' | 'guest'> {
	return (await getSetting(db, SETTING_KEYS.screensaverMode)) === 'guest' ? 'guest' : 'family';
}

export async function setActiveScreensaverMode(db: Db, mode: 'family' | 'guest'): Promise<void> {
	await setSetting(db, SETTING_KEYS.screensaverMode, mode);
}

function toPublishedPhoto(photo: PhotoRow): PublishedPhoto {
	return {
		// ?v= busts the browser's own cache once a reprocessed photo overwrites the same
		// cachedPath in place — see the route's own comment for why.
		url: `/api/photos/${photo.id}?v=${photo.mtime.getTime()}`,
		blurHash: photo.blurHash
	};
}

// The last slide this process actually composed — module-scope, same "one physical
// tablet" reasoning as screensaverBus itself. composeNextSlide (photos.ts) has no
// "peek" — every call dequeues the next photo and marks it shown, which is exactly what
// the periodic 30s tick (DESIGN.md §7.1) is supposed to do, but wrong for an eager
// republish triggered by something unrelated (a grocery edit, DESIGN.md §5.1) that just
// needs the rest of the envelope refreshed *now* without also skipping ahead in the
// photo rotation. Reusing the cached slide is what keeps those two concerns separate.
let lastSlide: PublishedSlide | null = null;

/** Test-only reset — mirrors resetWeatherCache/resetPhotoRotation elsewhere. */
export function resetScreensaverSlideCache(): void {
	lastSlide = null;
}

async function composeSlide(
	db: Db,
	timeZone: string,
	randomSource: () => number,
	mode: 'family' | 'guest',
	advance: boolean
): Promise<PublishedSlide> {
	if (!advance && lastSlide) return lastSlide;

	// Both modes try their own NAS-hosted kind first (HEARTH_PHOTOS_DIR/HEARTH_GUEST_PHOTOS_DIR,
	// scripts/resize-photos.mjs) and fall back to Picsum only when that kind's library is
	// empty — the nightly scan hasn't run yet, or (guest) nothing's been curated at all.
	// Picsum needs no NAS and is always available, so it's the safety net, not the source.
	const photoSlide: ScreensaverPhotoSlide | null = await composeNextSlide(
		db,
		timeZone,
		randomSource,
		undefined,
		mode
	);
	const slide: PublishedSlide = photoSlide
		? photoSlide.kind === 'single'
			? { kind: 'single', photo: toPublishedPhoto(photoSlide.photo) }
			: {
					kind: 'pair',
					photos: [toPublishedPhoto(photoSlide.photos[0]), toPublishedPhoto(photoSlide.photos[1])]
				}
		: { kind: 'single', photo: { url: nextGuestPhotoUrl(randomSource), blurHash: null } };

	lastSlide = slide;
	return slide;
}

/**
 * Composes the next slide and publishes {weather, theme, slide}. Photo rotation is
 * suppressed during quiet hours, same as publishState — DESIGN.md §9.2: "the app can
 * pause photo rotation and stop pushing SSE updates to a dark screen." It still publishes
 * once on entering quiet hours, though: the backlight stays on around the clock (no
 * device-side screen-off schedule exists at all, §9.1/§9.2), so this app-level {slide:
 * null} "night clock" state (weather and photos both stripped, dimmed to 40% opacity in
 * Screensaver.svelte) is what actually makes the tablet look dark, not a fallback for a
 * device schedule that might already be handling it. The broadcaster's dedupe means every
 * tick after the first no-op's straight through — same cost as before.
 *
 * `advanceSlide` (default true) governs the photo rotation specifically — leave it true
 * for the periodic screensaver tick this was originally built for; pass false from an
 * eager, unrelated-to-photos republish (e.g. a grocery write, DESIGN.md §5.1) so it
 * refreshes everything else without also cycling the background photo.
 */
export async function publishScreensaverState(
	db: Db,
	now: Date = new Date(),
	randomSource: () => number = Math.random,
	options: { advanceSlide?: boolean } = {}
): Promise<ScreensaverPublishOutcome> {
	const advanceSlide = options.advanceSlide ?? true;
	const timeZone = await getHouseholdTimeZone(db);
	const quietHours = await getQuietHours(db);
	const theme = computeTheme(now, await getThemeMode(db), await getHouseholdLocation(db));
	const timeFormat = await getTimeFormat(db);

	if (isWithinQuietHours(localMinutesInZone(now, timeZone), quietHours)) {
		// timeFormat still rides along even though weather/slide are stripped — the night
		// clock itself needs it. Groceries and music go dark too: quiet hours means
		// minimizing the screen's draw, not just its brightness.
		const published = screensaverBus.publish(
			JSON.stringify({
				weather: null,
				theme,
				timeFormat,
				slide: null,
				groceries: null,
				musicFolders: null,
				musicSpeakers: null
			})
		);
		return published ? 'quiet-hours' : 'unchanged';
	}

	const mode = await getActiveScreensaverMode(db);
	const weather = getCachedWeather();
	const slide = await composeSlide(db, timeZone, randomSource, mode, advanceSlide);
	// Guest mode keeps these null, same as every other household field on this bus.
	const groceries = mode === 'family' ? await buildGroceriesSnapshot(db) : null;
	// Unlike groceries, music is intentionally available in guest mode too (Alex's
	// call — full control, not just visibility) — the household's shared music, not
	// household data a visitor shouldn't see. Still hides outside its own configured
	// hours regardless of mode (Alex's ask).
	const musicHours = await getMusicHours(db);
	const musicAvailable = isWithinMusicHours(localMinutesInZone(now, timeZone), musicHours);
	const musicFolders = musicAvailable ? await listMusicFolders(db) : null;
	const musicSpeakers = musicAvailable ? await listMusicSpeakers(db) : null;
	return screensaverBus.publish(
		JSON.stringify({ weather, theme, timeFormat, slide, groceries, musicFolders, musicSpeakers })
	)
		? 'published'
		: 'unchanged';
}
