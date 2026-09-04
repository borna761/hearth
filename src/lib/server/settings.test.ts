import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './db/schema';
import {
	getSetting,
	setSetting,
	getHouseholdTimeZone,
	getQuietHours,
	isWithinQuietHours,
	parseQuietHours,
	formatQuietHours,
	getMusicHours,
	isWithinMusicHours,
	isMusicAllowed,
	parseMusicHours,
	formatMusicHours,
	getThemeMode,
	getTimeFormat,
	parseHouseholdLocation,
	formatHouseholdLocation,
	getHouseholdLocation,
	SETTING_KEYS
} from './settings';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;

beforeEach(() => {
	sqlite = new Database(':memory:');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
});

afterEach(() => sqlite.close());

describe('settings', () => {
	it('returns null for an unset key', async () => {
		expect(await getSetting(db, 'nope')).toBeNull();
	});

	it('round-trips a value', async () => {
		await setSetting(db, 'k', 'v');
		expect(await getSetting(db, 'k')).toBe('v');
	});

	it('overwrites rather than duplicating', async () => {
		await setSetting(db, 'k', 'v1');
		await setSetting(db, 'k', 'v2');
		expect(await getSetting(db, 'k')).toBe('v2');
		expect(sqlite.prepare('SELECT * FROM settings').all()).toHaveLength(1);
	});

	it('defaults the household timezone to Springfield’s zone', async () => {
		// DESIGN.md §4.1 — the zone every timed event renders in.
		expect(await getHouseholdTimeZone(db)).toBe('America/Toronto');
	});

	it('honours an overridden household timezone', async () => {
		await setSetting(db, 'household_timezone', 'Europe/Lisbon');
		expect(await getHouseholdTimeZone(db)).toBe('Europe/Lisbon');
	});
});

describe('getQuietHours', () => {
	it('defaults to the 22:00–07:00 window the tablet is dark for', async () => {
		// DESIGN.md §9.2. The kiosk app owns the backlight, which stays on around the
		// clock; this copy exists so the app can stop pushing to a screen nobody can see.
		expect(await getQuietHours(db)).toEqual({ startMinutes: 22 * 60, endMinutes: 7 * 60 });
	});

	it('parses an overridden window', async () => {
		await setSetting(db, 'quiet_hours', '23:00-06:00');
		expect(await getQuietHours(db)).toEqual({ startMinutes: 23 * 60, endMinutes: 6 * 60 });
	});

	it('honours the stored minutes, not just the hour', async () => {
		// Households set this to the actual minute, not just the hour (§9.2) — rounding
		// it would silently disagree with whatever they actually intended.
		await setSetting(db, 'quiet_hours', '22:30-07:15');
		expect(await getQuietHours(db)).toEqual({
			startMinutes: 22 * 60 + 30,
			endMinutes: 7 * 60 + 15
		});
	});

	it('falls back to the default when the stored value is malformed', async () => {
		// A bad hand-edit must not take the display down; §9.2 keeps these two fields in
		// sync by hand, so a typo is realistic.
		await setSetting(db, 'quiet_hours', 'nonsense');
		expect(await getQuietHours(db)).toEqual({ startMinutes: 22 * 60, endMinutes: 7 * 60 });
	});

	it('falls back to the default when the minutes are out of range', async () => {
		await setSetting(db, 'quiet_hours', '22:99-07:00');
		expect(await getQuietHours(db)).toEqual({ startMinutes: 22 * 60, endMinutes: 7 * 60 });
	});
});

describe('parseQuietHours', () => {
	// The settings screen (§7.5) needs to tell a genuinely malformed submission apart from
	// a legitimate value, which getQuietHours' silent-fallback-to-default can't do — this
	// is the same parsing logic, exposed so both call sites share it.
	it('parses a valid window', () => {
		expect(parseQuietHours('22:30-07:15')).toEqual({
			startMinutes: 22 * 60 + 30,
			endMinutes: 7 * 60 + 15
		});
	});

	it('returns null, not a default, for malformed input', () => {
		expect(parseQuietHours('nonsense')).toBeNull();
	});

	it('returns null for out-of-range hours or minutes', () => {
		expect(parseQuietHours('24:00-07:00')).toBeNull();
		expect(parseQuietHours('22:60-07:00')).toBeNull();
	});
});

describe('formatQuietHours', () => {
	it('is the exact inverse of parseQuietHours, for pre-filling the settings edit form', () => {
		const value = '22:30-07:15';
		expect(formatQuietHours(parseQuietHours(value)!)).toBe(value);
	});

	it('zero-pads single-digit hours and minutes', () => {
		expect(formatQuietHours({ startMinutes: 9 * 60 + 5, endMinutes: 60 })).toBe('09:05-01:00');
	});
});

describe('isWithinQuietHours', () => {
	const window = { startMinutes: 22 * 60, endMinutes: 7 * 60 };

	it('covers the hours across midnight', () => {
		expect(isWithinQuietHours(22 * 60, window)).toBe(true);
		expect(isWithinQuietHours(23 * 60, window)).toBe(true);
		expect(isWithinQuietHours(0, window)).toBe(true);
		expect(isWithinQuietHours(3 * 60, window)).toBe(true);
		expect(isWithinQuietHours(6 * 60, window)).toBe(true);
	});

	it('is over at the end minute, when the screen comes back on', () => {
		expect(isWithinQuietHours(7 * 60, window)).toBe(false);
		expect(isWithinQuietHours(12 * 60, window)).toBe(false);
		expect(isWithinQuietHours(21 * 60, window)).toBe(false);
	});

	it('handles a window that does not cross midnight', () => {
		const daytime = { startMinutes: 1 * 60, endMinutes: 5 * 60 };
		expect(isWithinQuietHours(0, daytime)).toBe(false);
		expect(isWithinQuietHours(1 * 60, daytime)).toBe(true);
		expect(isWithinQuietHours(4 * 60, daytime)).toBe(true);
		expect(isWithinQuietHours(5 * 60, daytime)).toBe(false);
	});

	it('treats an empty window as never quiet', () => {
		expect(isWithinQuietHours(3 * 60, { startMinutes: 7 * 60, endMinutes: 7 * 60 })).toBe(false);
	});

	it('respects a non-zero-minute boundary', () => {
		// The bug this guards: quiet_hours "22:30-07:15" must go dark at 22:30, not 22:00.
		const window = { startMinutes: 22 * 60 + 30, endMinutes: 7 * 60 + 15 };
		expect(isWithinQuietHours(22 * 60 + 15, window)).toBe(false);
		expect(isWithinQuietHours(22 * 60 + 30, window)).toBe(true);
		expect(isWithinQuietHours(7 * 60 + 14, window)).toBe(true);
		expect(isWithinQuietHours(7 * 60 + 15, window)).toBe(false);
	});
});

describe('getMusicHours', () => {
	it('returns null when nothing has ever been configured — music is unrestricted by default', async () => {
		expect(await getMusicHours(db)).toBeNull();
	});

	it('parses a configured window', async () => {
		await setSetting(db, 'music_hours', '09:00-21:30');
		expect(await getMusicHours(db)).toEqual({ startMinutes: 9 * 60, endMinutes: 21 * 60 + 30 });
	});

	it('falls back to unrestricted (null) for a malformed stored value', async () => {
		await setSetting(db, 'music_hours', 'nonsense');
		expect(await getMusicHours(db)).toBeNull();
	});

	it('treats an explicitly cleared (empty) value the same as never configured', async () => {
		await setSetting(db, 'music_hours', '');
		expect(await getMusicHours(db)).toBeNull();
	});

	it('treats a zero-width window (equal start/end) as unrestricted rather than permanently unavailable', async () => {
		// Unlike quiet hours, where an equal window is a legitimate way to say "never
		// quiet", a music-hours field defaulting both times to the same value is far more
		// likely to be an unnoticed mistake than a deliberate "never available" — and
		// isWithinMusicHours has no other way to express "unrestricted" once a window is
		// stored, so a bad value here should fail open like a malformed string does.
		await setSetting(db, 'music_hours', '09:00-09:00');
		expect(await getMusicHours(db)).toBeNull();
	});
});

describe('parseMusicHours / formatMusicHours', () => {
	it('share the same HH:MM-HH:MM parsing as quiet hours', () => {
		expect(parseMusicHours('09:00-21:30')).toEqual({
			startMinutes: 9 * 60,
			endMinutes: 21 * 60 + 30
		});
	});

	it('round-trips through format', () => {
		const value = '09:00-21:30';
		expect(formatMusicHours(parseMusicHours(value)!)).toBe(value);
	});
});

describe('isWithinMusicHours', () => {
	it('is always available when no window is configured', () => {
		expect(isWithinMusicHours(0, null)).toBe(true);
		expect(isWithinMusicHours(12 * 60, null)).toBe(true);
	});

	it('honours a configured window', () => {
		const window = { startMinutes: 9 * 60, endMinutes: 21 * 60 + 30 };
		expect(isWithinMusicHours(8 * 60 + 59, window)).toBe(false);
		expect(isWithinMusicHours(9 * 60, window)).toBe(true);
		expect(isWithinMusicHours(21 * 60 + 29, window)).toBe(true);
		expect(isWithinMusicHours(21 * 60 + 30, window)).toBe(false);
	});
});

describe('isMusicAllowed', () => {
	// The bug this guards: music hours and quiet hours are independent settings, and an
	// overlapping music-hours window (e.g. 20:00-23:00) must not let Cast playback keep
	// going once quiet hours (default 22:00-07:00) begin — quiet hours means minimizing
	// the screen's draw, not just its brightness, and that has to win.
	it('is blocked by quiet hours even while still inside the music-hours window', () => {
		const musicHours = { startMinutes: 20 * 60, endMinutes: 23 * 60 };
		const quietHours = { startMinutes: 22 * 60, endMinutes: 7 * 60 };
		expect(isMusicAllowed(22 * 60 + 30, musicHours, quietHours)).toBe(false);
	});

	it('is allowed inside music hours when quiet hours have not started yet', () => {
		const musicHours = { startMinutes: 20 * 60, endMinutes: 23 * 60 };
		const quietHours = { startMinutes: 22 * 60, endMinutes: 7 * 60 };
		expect(isMusicAllowed(21 * 60, musicHours, quietHours)).toBe(true);
	});

	it('is blocked outside music hours even when quiet hours are not active', () => {
		const musicHours = { startMinutes: 9 * 60, endMinutes: 17 * 60 };
		const quietHours = { startMinutes: 22 * 60, endMinutes: 7 * 60 };
		expect(isMusicAllowed(18 * 60, musicHours, quietHours)).toBe(false);
	});

	it('respects an unrestricted (null) music-hours window, still gated by quiet hours', () => {
		const quietHours = { startMinutes: 22 * 60, endMinutes: 7 * 60 };
		expect(isMusicAllowed(12 * 60, null, quietHours)).toBe(true);
		expect(isMusicAllowed(23 * 60, null, quietHours)).toBe(false);
	});
});

describe('getThemeMode', () => {
	it('defaults to auto — DESIGN.md §5.3: "theme_mode setting — auto | light | dark, default auto"', async () => {
		expect(await getThemeMode(db)).toBe('auto');
	});

	it('honours a stored override', async () => {
		await setSetting(db, SETTING_KEYS.themeMode, 'dark');
		expect(await getThemeMode(db)).toBe('dark');
	});

	it('falls back to auto for a garbage stored value, rather than passing it through', async () => {
		await setSetting(db, SETTING_KEYS.themeMode, 'nonsense');
		expect(await getThemeMode(db)).toBe('auto');
	});
});

describe('getTimeFormat', () => {
	it('defaults to 24h', async () => {
		expect(await getTimeFormat(db)).toBe('24h');
	});

	it('honours a stored override', async () => {
		await setSetting(db, SETTING_KEYS.timeFormat, '12h');
		expect(await getTimeFormat(db)).toBe('12h');
	});

	it('falls back to 24h for a garbage stored value', async () => {
		await setSetting(db, SETTING_KEYS.timeFormat, 'nonsense');
		expect(await getTimeFormat(db)).toBe('24h');
	});
});

describe('parseHouseholdLocation', () => {
	it('parses a valid "lat,lng" pair', () => {
		expect(parseHouseholdLocation('45.5,-75.5')).toEqual({
			latitude: 45.5,
			longitude: -75.5
		});
	});

	it('accepts whitespace after the comma', () => {
		expect(parseHouseholdLocation('45.5, -75.5')).toEqual({
			latitude: 45.5,
			longitude: -75.5
		});
	});

	it('accepts integer coordinates and 0,0', () => {
		expect(parseHouseholdLocation('0,0')).toEqual({ latitude: 0, longitude: 0 });
	});

	it('returns null, not a default, for malformed input', () => {
		expect(parseHouseholdLocation('nonsense')).toBeNull();
		expect(parseHouseholdLocation('45.0')).toBeNull();
		expect(parseHouseholdLocation('')).toBeNull();
	});

	it('returns null for out-of-range latitude or longitude', () => {
		expect(parseHouseholdLocation('91,0')).toBeNull();
		expect(parseHouseholdLocation('-91,0')).toBeNull();
		expect(parseHouseholdLocation('0,181')).toBeNull();
		expect(parseHouseholdLocation('0,-181')).toBeNull();
	});

	it('accepts the boundary values', () => {
		expect(parseHouseholdLocation('90,180')).toEqual({ latitude: 90, longitude: 180 });
		expect(parseHouseholdLocation('-90,-180')).toEqual({ latitude: -90, longitude: -180 });
	});
});

describe('formatHouseholdLocation', () => {
	it('is the exact inverse of parseHouseholdLocation, for pre-filling the settings form', () => {
		const value = '45.5,-75.5';
		expect(formatHouseholdLocation(parseHouseholdLocation(value)!)).toBe(value);
	});
});

describe('getHouseholdLocation', () => {
	it('defaults to Springfield’s coordinates', async () => {
		expect(await getHouseholdLocation(db)).toEqual({ latitude: 45.5, longitude: -75.5 });
	});

	it('honours a stored override', async () => {
		await setSetting(db, SETTING_KEYS.householdLocation, '51.5072,-0.1276');
		expect(await getHouseholdLocation(db)).toEqual({ latitude: 51.5072, longitude: -0.1276 });
	});

	it('falls back to the default for a malformed stored value', async () => {
		await setSetting(db, SETTING_KEYS.householdLocation, 'nonsense');
		expect(await getHouseholdLocation(db)).toEqual({ latitude: 45.5, longitude: -75.5 });
	});
});
