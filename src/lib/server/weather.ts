// Open-Meteo polling — DESIGN.md §3.1 (15 min, no key) and §7.3's top-strip weather.
//
// No connections-table row: Open-Meteo needs no key, unlike every other provider in that
// table (DESIGN.md §10's stack table calls this out explicitly), so there is nothing to
// store or encrypt — just a URL.

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { db as defaultDb } from './db';
import type * as schema from './db/schema';
import {
	getSetting,
	setSetting,
	getHouseholdLocation,
	getHouseholdTimeZone,
	DEFAULT_HOUSEHOLD_TIMEZONE,
	SETTING_KEYS
} from './settings';
import { DEFAULT_HOUSEHOLD_LOCATION, type HouseholdLocation } from '$lib/location';

type Db = BetterSQLite3Database<typeof schema>;

const CACHE_TTL_MS = 15 * 60_000;

export type WeatherIcon =
	'sun' | 'partly-cloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';

export interface HourlyForecastEntry {
	/** 'HH:MM', already in the household's zone (the request pins `timezone`). */
	time: string;
	temperatureC: number;
	icon: WeatherIcon;
	precipitationMm: number;
}

export interface DailyForecastEntry {
	/** 'YYYY-MM-DD', already in the household's zone. Index 0 is today. */
	date: string;
	highC: number;
	lowC: number;
	icon: WeatherIcon;
}

export interface Weather {
	temperatureC: number;
	condition: string;
	icon: WeatherIcon;
	/** Null if Open-Meteo's response omitted it — same optional-chained fallback as
	 * sunrise/sunset below, for the full-screen weather report (not shown on the
	 * screensaver's small overlay, which stays just temperature + condition). */
	feelsLikeC: number | null;
	humidityPercent: number | null;
	precipitationMm: number | null;
	windSpeedKmh: number | null;
	windDirectionDeg: number | null;
	/** Today's peak, not the current instantaneous value — Open-Meteo only offers UV index
	 * on the daily block, not current, and "how high does it get today" is the more useful
	 * number for planning around anyway. */
	uvIndex: number | null;
	/** US AQI (0-500+, EPA scale) from a second, separate Open-Meteo request — best-effort:
	 * a failure there falls back to null rather than failing the whole weather fetch, since
	 * it's one metric among many, not the reason this function exists. */
	airQualityIndex: number | null;
	/** Roughly the next 11 hours, for the screensaver's forecast strip (DESIGN.md §7.1). */
	hourly: HourlyForecastEntry[];
	/** Today plus the next several days, for the full-screen weather report. Empty if
	 * Open-Meteo's response omitted the daily block. */
	daily: DailyForecastEntry[];
	/** 'HH:MM', already in the household's zone. Null if Open-Meteo's response omitted it. */
	sunrise: string | null;
	sunset: string | null;
}

// WMO weather interpretation codes, from Open-Meteo's own docs (open-meteo.com/en/docs).
// Collapsed to the short words DESIGN.md's §7.3 mockup uses ("22° Sunny").
const CONDITION_BY_CODE: Record<number, string> = {
	0: 'Clear',
	1: 'Mostly clear',
	2: 'Partly cloudy',
	3: 'Overcast',
	45: 'Fog',
	48: 'Fog',
	51: 'Light drizzle',
	53: 'Drizzle',
	55: 'Heavy drizzle',
	56: 'Freezing drizzle',
	57: 'Freezing drizzle',
	61: 'Light rain',
	63: 'Rain',
	65: 'Heavy rain',
	66: 'Freezing rain',
	67: 'Freezing rain',
	71: 'Light snow',
	73: 'Snow',
	75: 'Heavy snow',
	77: 'Snow grains',
	80: 'Light showers',
	81: 'Showers',
	82: 'Heavy showers',
	85: 'Snow showers',
	86: 'Snow showers',
	95: 'Thunderstorm',
	96: 'Thunderstorm',
	99: 'Thunderstorm'
};

export function weatherConditionFromCode(code: number): string {
	return CONDITION_BY_CODE[code] ?? 'Unknown';
}

// A small icon set the client can render with no WMO knowledge of its own — the server
// decides, the same "client stays dumb" split DESIGN.md §5.3 already uses for theme.
const ICON_BY_CODE: Record<number, WeatherIcon> = {
	0: 'sun',
	1: 'sun',
	2: 'partly-cloudy',
	3: 'cloudy',
	45: 'fog',
	48: 'fog',
	51: 'drizzle',
	53: 'drizzle',
	55: 'drizzle',
	56: 'drizzle',
	57: 'drizzle',
	61: 'rain',
	63: 'rain',
	65: 'rain',
	66: 'rain',
	67: 'rain',
	71: 'snow',
	73: 'snow',
	75: 'snow',
	77: 'snow',
	80: 'rain',
	81: 'rain',
	82: 'rain',
	85: 'snow',
	86: 'snow',
	95: 'storm',
	96: 'storm',
	99: 'storm'
};

export function weatherIconFromCode(code: number): WeatherIcon {
	return ICON_BY_CODE[code] ?? 'cloudy';
}

// Presentational label helpers for AQI/UV/wind direction live in $lib/weatherLabels.ts,
// not here — that file is importable from client code (WeatherPanel.svelte), which
// SvelteKit refuses to let anything under $lib/server/* be, even a plain pure function.

interface OpenMeteoResponse {
	current: {
		temperature_2m: number;
		weather_code: number;
		apparent_temperature?: number;
		relative_humidity_2m?: number;
		precipitation?: number;
		wind_speed_10m?: number;
		wind_direction_10m?: number;
	};
	hourly: {
		time: string[];
		temperature_2m: number[];
		weather_code: number[];
		precipitation?: number[];
	};
	daily?: {
		time?: string[];
		sunrise: string[];
		sunset: string[];
		weather_code?: number[];
		temperature_2m_max?: number[];
		temperature_2m_min?: number[];
		uv_index_max?: number[];
	};
}

interface AirQualityResponse {
	current?: { us_aqi?: number };
}

/** DESIGN.md §3.1's "no key" applies here too — same host family as the main forecast,
 * just a separate API (Open-Meteo doesn't fold air quality into /v1/forecast). Wrapped in
 * its own try/catch by the caller: this is one metric among several on the full-screen
 * weather report, not worth failing the whole fetch over. */
async function fetchAirQualityIndex(
	fetchImpl: typeof fetch,
	location: HouseholdLocation,
	timeZone: string
): Promise<number | null> {
	const params = new URLSearchParams({
		latitude: String(location.latitude),
		longitude: String(location.longitude),
		current: 'us_aqi',
		timezone: timeZone
	});
	try {
		const res = await fetchImpl(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`);
		if (!res.ok) return null;
		const body = (await res.json()) as AirQualityResponse;
		return body.current?.us_aqi ?? null;
	} catch {
		return null;
	}
}

export async function fetchWeather(
	fetchImpl: typeof fetch = fetch,
	location: HouseholdLocation = DEFAULT_HOUSEHOLD_LOCATION,
	timeZone: string = DEFAULT_HOUSEHOLD_TIMEZONE
): Promise<Weather> {
	const params = new URLSearchParams({
		latitude: String(location.latitude),
		longitude: String(location.longitude),
		current:
			'temperature_2m,weather_code,apparent_temperature,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m',
		hourly: 'temperature_2m,weather_code,precipitation',
		daily: 'weather_code,temperature_2m_max,temperature_2m_min,uv_index_max,sunrise,sunset',
		forecast_hours: '12',
		// Today plus 8 more — enough for the full-screen weather report's multi-day strip
		// (WeatherPanel.svelte skips today there, already covered by the "current conditions"
		// block above it, so this is 8 future days shown) to read as a proper outlook without
		// needing to scroll (Alex's call: the 16-day max Open-Meteo offers was "too much").
		// The hourly/screensaver-strip fields above are unaffected, they're capped
		// independently by forecast_hours.
		forecast_days: '9',
		// So `hourly.time` comes back already in household-local 'YYYY-MM-DDTHH:MM' strings,
		// rather than UTC — matching the household's own configured timezone setting.
		timezone: timeZone
	});
	// Run alongside the main request, not after it — fetchAirQualityIndex depends on
	// nothing the forecast response produces (same lat/lon/timeZone inputs) and already
	// isolates its own failure into a null return, so there's no error-handling reason to
	// serialize them; parallel halves the wall-clock cost of every refresh for free.
	const [res, airQualityIndex] = await Promise.all([
		fetchImpl(`https://api.open-meteo.com/v1/forecast?${params}`),
		fetchAirQualityIndex(fetchImpl, location, timeZone)
	]);
	if (!res.ok) {
		throw new Error(`Open-Meteo request failed: ${res.status}`);
	}
	const body = (await res.json()) as OpenMeteoResponse;
	const hourly: HourlyForecastEntry[] = body.hourly.time.map((isoLocal, i) => ({
		// 'YYYY-MM-DDTHH:MM' -> 'HH:MM'.
		time: isoLocal.slice(11, 16),
		temperatureC: Math.round(body.hourly.temperature_2m[i]),
		icon: weatherIconFromCode(body.hourly.weather_code[i]),
		precipitationMm: body.hourly.precipitation?.[i] ?? 0
	}));
	// flatMap + explicit undefined checks, not the hourly loop's straight assertions above —
	// unlike hourly (a single well-known request), a day entry missing one of these three
	// arrays (a partial/malformed response) skips just that day rather than surfacing as
	// "NaN°" or throwing, matching how sunrise/sunset/uvIndex already degrade per-field.
	const daily: DailyForecastEntry[] = (body.daily?.time ?? []).flatMap((isoDate, i) => {
		const highC = body.daily?.temperature_2m_max?.[i];
		const lowC = body.daily?.temperature_2m_min?.[i];
		const code = body.daily?.weather_code?.[i];
		if (highC === undefined || lowC === undefined || code === undefined) return [];
		return [
			{
				date: isoDate,
				highC: Math.round(highC),
				lowC: Math.round(lowC),
				icon: weatherIconFromCode(code)
			}
		];
	});
	return {
		temperatureC: Math.round(body.current.temperature_2m),
		condition: weatherConditionFromCode(body.current.weather_code),
		icon: weatherIconFromCode(body.current.weather_code),
		feelsLikeC:
			body.current.apparent_temperature !== undefined
				? Math.round(body.current.apparent_temperature)
				: null,
		humidityPercent: body.current.relative_humidity_2m ?? null,
		precipitationMm: body.current.precipitation ?? null,
		windSpeedKmh:
			body.current.wind_speed_10m !== undefined ? Math.round(body.current.wind_speed_10m) : null,
		windDirectionDeg: body.current.wind_direction_10m ?? null,
		uvIndex: body.daily?.uv_index_max?.[0] ?? null,
		airQualityIndex,
		hourly,
		daily,
		// Today's entry only — same 'YYYY-MM-DDTHH:MM' -> 'HH:MM' slice as hourly.time.
		// Optional-chained: older cached responses / test fixtures may not carry `daily`.
		sunrise: body.daily?.sunrise?.[0]?.slice(11, 16) ?? null,
		sunset: body.daily?.sunset?.[0]?.slice(11, 16) ?? null
	};
}

// In-process cache with a "last known good" fallback — a transient Open-Meteo outage
// should not blank the strip. Module-scope singleton state, same shape as
// activeSessionToken in state/publisher.ts (one process, one household's weather).
let cached: Weather | null = null;
let cachedAt = 0;

export function getCachedWeather(): Weather | null {
	return cached;
}

/** Test-only reset — mirrors setActiveSessionToken(null) in publisher.test.ts. */
export function resetWeatherCache(): void {
	cached = null;
	cachedAt = 0;
}

/**
 * Seeds the in-process cache from the last reading persisted to `settings`, so a restart
 * (deploy, crash, power cycle) doesn't blank the strip while waiting for the next
 * successful Open-Meteo fetch — the in-memory "last known-good" fallback in refreshWeather
 * only helps once something has actually been fetched in *this* process. Call once at
 * startup, before the first refreshWeather (see sync/runtime.ts).
 */
export async function hydrateWeatherCache(db: Db = defaultDb): Promise<void> {
	if (cached) return;
	try {
		const raw = await getSetting(db, SETTING_KEYS.lastWeather);
		if (!raw) return;
		const parsed = JSON.parse(raw) as { weather?: Weather; cachedAt?: number };
		if (!parsed.weather || typeof parsed.cachedAt !== 'number') return;
		// A reading persisted by a version of this code from before a field was added to
		// Weather (e.g. `daily`, added for the multi-day forecast) would otherwise hydrate
		// as a truthy-but-wrong-shaped object — WeatherPanel.svelte's `weather.daily.slice(1)`
		// has no guard of its own against that, so this is the one place that has to catch
		// it before it ever reaches a client.
		if (!Array.isArray(parsed.weather.daily)) return;
		cached = parsed.weather;
		cachedAt = parsed.cachedAt;
	} catch {
		// Missing row, corrupt JSON, or a shape from some future format — no worse off than
		// the blank-cache boot this is meant to improve on.
	}
}

export async function refreshWeather(
	now: Date = new Date(),
	fetchImpl: typeof fetch = fetch,
	db: Db = defaultDb
): Promise<Weather | null> {
	if (cached && now.getTime() - cachedAt < CACHE_TTL_MS) {
		return cached;
	}
	try {
		const [location, timeZone] = await Promise.all([
			getHouseholdLocation(db),
			getHouseholdTimeZone(db)
		]);
		cached = await fetchWeather(fetchImpl, location, timeZone);
		cachedAt = now.getTime();
		// Best-effort: persisting the reading is what lets the *next* process start with a
		// fallback instead of nothing, but a write failure shouldn't lose the fetch we just
		// made for this process.
		try {
			await setSetting(db, SETTING_KEYS.lastWeather, JSON.stringify({ weather: cached, cachedAt }));
		} catch {
			// Same reasoning as the outer catch below — a stale or missing persisted reading
			// just means the next restart falls back to nothing, same as today.
		}
	} catch {
		// Keep serving the last known-good reading. A boot with zero successful fetches yet
		// leaves cached === null, which the UI already renders as "no weather yet" — unless
		// hydrateWeatherCache already seeded it from a previous process's last reading.
	}
	return cached;
}
