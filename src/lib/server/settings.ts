// Key/value settings — DESIGN.md §8's `settings` table.

import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema';
import { settings } from './db/schema';
import type { ThemeMode } from '$lib/theme';
import type { TimeFormat } from '$lib/week/format';
import { DEFAULT_HOUSEHOLD_LOCATION, type HouseholdLocation } from '$lib/location';

type Db = BetterSQLite3Database<typeof schema>;

/** DESIGN.md §4.1: Springfield's zone, and the one every timed event renders in. */
export const DEFAULT_HOUSEHOLD_TIMEZONE = 'America/Toronto';

export const SETTING_KEYS = {
	householdTimeZone: 'household_timezone',
	/** 'lat,lng' — DESIGN.md §5.3/§7.1's pinned coordinates, shared by weather.ts and
	 * theme.ts's sun-based auto theme (see $lib/location.ts). */
	householdLocation: 'household_location',
	/** 'YYYY-MM-DD' of the last full calendar re-sync — see sync/scheduler.ts. */
	lastFullSyncDate: 'last_full_sync_date',
	/** 'HH:MM-HH:MM'; the window the tablet's screen is dark for. */
	quietHours: 'quiet_hours',
	/** 'HH:MM-HH:MM', or unset — the window the music button/panel is available in. Unlike
	 * quietHours, unset means unrestricted (see getMusicHours), not a fallback default. */
	musicHours: 'music_hours',
	/** 'auto' | 'light' | 'dark' — DESIGN.md §5.3. */
	themeMode: 'theme_mode',
	/** '12h' | '24h' — how every clock/time in the app renders. */
	timeFormat: 'time_format',
	/** JSON `{ weather, cachedAt }` — see weather.ts's hydrateWeatherCache. Survives a
	 * restart, unlike the in-process cache it seeds. */
	lastWeather: 'last_weather',
	/** Todoist's own project id — the single project users.taskAccess's 'only-one'/
	 * 'all-but-one' modes are relative to (tasks.ts's buildTasksSnapshot). Unset until
	 * chosen in Settings; unlike every other setting here, that's a legitimate steady
	 * state, not just a startup gap — see getRestrictedTaskProjectId. */
	restrictedTaskProjectId: 'restricted_task_project_id',
	/** 'family' | 'guest' — which screensaver variant the one physical tablet shows
	 * (DESIGN.md §5). Deliberately durable, unlike activeSessionToken (state/publisher.ts):
	 * a guest staying the week shouldn't need Guest mode re-selected after every deploy or
	 * crash restart — see screensaverPublisher.ts's getActiveScreensaverMode. */
	screensaverMode: 'screensaver_mode'
} as const;

const THEME_MODES: readonly ThemeMode[] = ['auto', 'light', 'dark'];

/** DESIGN.md §9.2: screen off 22:00, on 07:00. */
export const DEFAULT_QUIET_HOURS: QuietHours = { startMinutes: 22 * 60, endMinutes: 7 * 60 };

export interface QuietHours {
	/** Minutes since local midnight (0–1439) the dark window starts. */
	startMinutes: number;
	/** Minutes since local midnight (0–1439) the dark window ends. */
	endMinutes: number;
}

export async function getSetting(db: Db, key: string): Promise<string | null> {
	const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
	return rows.length > 0 ? rows[0].value : null;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
	await db
		.insert(settings)
		.values({ key, value })
		.onConflictDoUpdate({ target: settings.key, set: { value } });
}

export async function getHouseholdTimeZone(db: Db): Promise<string> {
	return (await getSetting(db, SETTING_KEYS.householdTimeZone)) ?? DEFAULT_HOUSEHOLD_TIMEZONE;
}

/** DESIGN.md §5.3: "theme_mode setting — auto | light | dark, default auto." Falls back to
 * 'auto' for anything unset or hand-edited into something invalid, same reasoning as
 * getQuietHours' fallback-to-default. */
export async function getThemeMode(db: Db): Promise<ThemeMode> {
	const raw = await getSetting(db, SETTING_KEYS.themeMode);
	return THEME_MODES.includes(raw as ThemeMode) ? (raw as ThemeMode) : 'auto';
}

const TIME_FORMATS: readonly TimeFormat[] = ['12h', '24h'];

/** Defaults to 24h, matching every clock/time formatter's own default. */
export async function getTimeFormat(db: Db): Promise<TimeFormat> {
	const raw = await getSetting(db, SETTING_KEYS.timeFormat);
	return TIME_FORMATS.includes(raw as TimeFormat) ? (raw as TimeFormat) : '24h';
}

/**
 * Parses a 'lat,lng' string, or returns null for anything malformed or out of range —
 * distinct from getHouseholdLocation's silent fallback-to-default, same reasoning as
 * parseQuietHours below.
 */
export function parseHouseholdLocation(raw: string): HouseholdLocation | null {
	const match = raw.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
	if (!match) return null;
	const latitude = Number(match[1]);
	const longitude = Number(match[2]);
	if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
	return { latitude, longitude };
}

/** Inverse of parseHouseholdLocation — pre-fills the settings screen's edit form. */
export function formatHouseholdLocation({ latitude, longitude }: HouseholdLocation): string {
	return `${latitude},${longitude}`;
}

export async function getHouseholdLocation(db: Db): Promise<HouseholdLocation> {
	const raw = await getSetting(db, SETTING_KEYS.householdLocation);
	if (!raw) return DEFAULT_HOUSEHOLD_LOCATION;
	return parseHouseholdLocation(raw) ?? DEFAULT_HOUSEHOLD_LOCATION;
}

/**
 * Parses a 'HH:MM-HH:MM' string, or returns null for anything malformed — distinct from
 * getQuietHours' silent fallback-to-default, since the settings screen (§7.5) needs to
 * tell a user "that's not valid" rather than quietly accepting garbage. Shared by quiet
 * hours and music hours — both use the exact same window format.
 */
function parseTimeWindow(raw: string): { startMinutes: number; endMinutes: number } | null {
	const match = raw.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
	if (!match) return null;

	const startHour = Number(match[1]);
	const startMinute = Number(match[2]);
	const endHour = Number(match[3]);
	const endMinute = Number(match[4]);
	if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
		return null;
	}
	return { startMinutes: startHour * 60 + startMinute, endMinutes: endHour * 60 + endMinute };
}

/** Inverse of parseTimeWindow — pre-fills a settings edit form with the current value. */
function formatTimeWindow({
	startMinutes,
	endMinutes
}: {
	startMinutes: number;
	endMinutes: number;
}): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const toClock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
	return `${toClock(startMinutes)}-${toClock(endMinutes)}`;
}

export const parseQuietHours = parseTimeWindow;
export const formatQuietHours = formatTimeWindow;

export async function getQuietHours(db: Db): Promise<QuietHours> {
	const raw = await getSetting(db, SETTING_KEYS.quietHours);
	// §9.2: this is the *only* schedule driving "dark at night" — there's no device-side
	// screen-off schedule to keep it in sync with, so a hand-entered typo here is a
	// realistic way to end up with a bad value. Falling back beats letting one decide when
	// the display stops updating.
	if (!raw) return DEFAULT_QUIET_HOURS;
	return parseQuietHours(raw) ?? DEFAULT_QUIET_HOURS;
}

/**
 * Whether a minute-of-day falls inside a window. Written for wraparound first: quiet
 * hours' real window is 22:00–07:00, which is two ranges on a 24-hour clock, not one.
 */
function isWithinTimeWindow(
	minutes: number,
	{ startMinutes, endMinutes }: { startMinutes: number; endMinutes: number }
): boolean {
	if (startMinutes === endMinutes) return false;
	if (startMinutes < endMinutes) return minutes >= startMinutes && minutes < endMinutes;
	return minutes >= startMinutes || minutes < endMinutes;
}

export const isWithinQuietHours = isWithinTimeWindow;

export interface MusicHours {
	/** Minutes since local midnight (0–1439) the music button/panel becomes available. */
	startMinutes: number;
	/** Minutes since local midnight (0–1439) it stops being available. */
	endMinutes: number;
}

export const parseMusicHours = parseTimeWindow;
export const formatMusicHours = formatTimeWindow;

/** No fallback-to-default, unlike getQuietHours — null means music is unrestricted, the
 * correct behavior for every household until someone deliberately configures a window. A
 * zero-width window (equal start/end) is treated the same way — unlike quiet hours, where
 * that's a legitimate way to say "never quiet", a music-hours field defaulting both times
 * to the same value is far more likely to be an unnoticed mistake than someone
 * deliberately asking for music to never be available, and there's no other way to store
 * "unrestricted" once a window exists at all. */
export async function getMusicHours(db: Db): Promise<MusicHours | null> {
	const raw = await getSetting(db, SETTING_KEYS.musicHours);
	if (!raw) return null;
	const parsed = parseMusicHours(raw);
	if (parsed && parsed.startMinutes === parsed.endMinutes) return null;
	return parsed;
}

/** Whether a minute-of-day falls inside the configured music window — always true when no
 * window is configured, unlike isWithinQuietHours which always has a real window (falling
 * back to DEFAULT_QUIET_HOURS) to test against. */
export function isWithinMusicHours(minutes: number, musicHours: MusicHours | null): boolean {
	if (!musicHours) return true;
	return isWithinTimeWindow(minutes, musicHours);
}

/** Whether music is allowed to keep playing right now — inside its own configured hours
 * (or unrestricted) AND not inside quiet hours. Quiet hours take priority even when a
 * music-hours window would otherwise allow it: quiet hours means minimizing the screen's
 * draw, not just its brightness (screensaverPublisher.ts), and the two settings are
 * independent, so an overlapping music-hours window (e.g. 20:00-23:00 against the default
 * 22:00-07:00 quiet hours) must not let Cast audio keep going once quiet hours begin. */
export function isMusicAllowed(
	minutes: number,
	musicHours: MusicHours | null,
	quietHours: QuietHours
): boolean {
	return isWithinMusicHours(minutes, musicHours) && !isWithinQuietHours(minutes, quietHours);
}

/** No fallback-to-default, unlike getQuietHours/getHouseholdLocation above — `null` here
 * means "not configured yet," a real state buildTasksSnapshot handles explicitly, not a
 * gap to paper over. */
export async function getRestrictedTaskProjectId(db: Db): Promise<string | null> {
	return getSetting(db, SETTING_KEYS.restrictedTaskProjectId);
}

export async function setRestrictedTaskProjectId(db: Db, projectId: string): Promise<void> {
	await setSetting(db, SETTING_KEYS.restrictedTaskProjectId, projectId);
}
