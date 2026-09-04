import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './db/schema';
import { getSetting, setSetting, SETTING_KEYS } from './settings';
import {
	weatherConditionFromCode,
	weatherIconFromCode,
	fetchWeather,
	getCachedWeather,
	refreshWeather,
	resetWeatherCache,
	hydrateWeatherCache
} from './weather';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;

beforeEach(() => {
	resetWeatherCache();
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
});
afterEach(() => {
	resetWeatherCache();
	sqlite.close();
});

function fakeFetch(body: unknown, ok = true) {
	return vi.fn().mockResolvedValue({
		ok,
		status: ok ? 200 : 500,
		json: async () => body
	}) as unknown as typeof fetch;
}

/** Minimal Open-Meteo response shape with `current`, `hourly`, and (optionally) `daily` blocks. */
function openMeteoBody(overrides: {
	currentTemp?: number;
	currentCode?: number;
	hourlyTimes?: string[];
	hourlyTemps?: number[];
	hourlyCodes?: number[];
	sunrise?: string[];
	sunset?: string[];
}) {
	return {
		current: {
			temperature_2m: overrides.currentTemp ?? 18,
			weather_code: overrides.currentCode ?? 3
		},
		hourly: {
			time: overrides.hourlyTimes ?? ['2026-08-23T14:00', '2026-08-23T15:00'],
			temperature_2m: overrides.hourlyTemps ?? [18, 19],
			weather_code: overrides.hourlyCodes ?? [3, 1]
		},
		...(overrides.sunrise || overrides.sunset
			? {
					daily: {
						sunrise: overrides.sunrise ?? ['2026-08-23T06:12'],
						sunset: overrides.sunset ?? ['2026-08-23T20:03']
					}
				}
			: {})
	};
}

describe('weatherConditionFromCode', () => {
	it('maps known WMO codes to a short condition word', () => {
		expect(weatherConditionFromCode(0)).toBe('Clear');
		expect(weatherConditionFromCode(3)).toBe('Overcast');
		expect(weatherConditionFromCode(61)).toBe('Light rain');
		expect(weatherConditionFromCode(95)).toBe('Thunderstorm');
	});

	it('falls back rather than throwing on an unrecognised code', () => {
		expect(weatherConditionFromCode(9999)).toBe('Unknown');
	});
});

describe('weatherIconFromCode', () => {
	it('groups codes into a small icon set the client can render without WMO knowledge', () => {
		expect(weatherIconFromCode(0)).toBe('sun');
		expect(weatherIconFromCode(1)).toBe('sun');
		expect(weatherIconFromCode(2)).toBe('partly-cloudy');
		expect(weatherIconFromCode(3)).toBe('cloudy');
		expect(weatherIconFromCode(45)).toBe('fog');
		expect(weatherIconFromCode(51)).toBe('drizzle');
		expect(weatherIconFromCode(63)).toBe('rain');
		expect(weatherIconFromCode(81)).toBe('rain');
		expect(weatherIconFromCode(73)).toBe('snow');
		expect(weatherIconFromCode(86)).toBe('snow');
		expect(weatherIconFromCode(95)).toBe('storm');
	});

	it('falls back to cloudy rather than throwing on an unrecognised code', () => {
		expect(weatherIconFromCode(9999)).toBe('cloudy');
	});
});

describe('fetchWeather', () => {
	it('parses Open-Meteo’s current-weather response', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({ currentTemp: 21.6, currentCode: 1 }));
		const weather = await fetchWeather(fetchImpl);
		expect(weather.temperatureC).toBe(22);
		expect(weather.condition).toBe('Mostly clear');
		expect(weather.icon).toBe('sun');
	});

	it('parses the hourly forecast into time/temperature/icon entries', async () => {
		const fetchImpl = fakeFetch(
			openMeteoBody({
				hourlyTimes: ['2026-08-23T14:00', '2026-08-23T15:00', '2026-08-23T16:00'],
				hourlyTemps: [18.4, 19.6, 20.1],
				hourlyCodes: [3, 1, 61]
			})
		);
		const weather = await fetchWeather(fetchImpl);
		expect(weather.hourly).toEqual([
			{ time: '14:00', temperatureC: 18, icon: 'cloudy' },
			{ time: '15:00', temperatureC: 20, icon: 'sun' },
			{ time: '16:00', temperatureC: 20, icon: 'rain' }
		]);
	});

	it('requests the pinned Springfield coordinates by default, an hourly forecast, and no key', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({}));
		await fetchWeather(fetchImpl);
		const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
		expect(url).toContain('latitude=45.5');
		expect(url).toContain('longitude=-75.5');
		expect(url).toContain('timezone=America%2FToronto');
		expect(url).toContain('hourly=temperature_2m%2Cweather_code');
		expect(url).toContain('daily=sunrise%2Csunset');
		expect(url).not.toContain('key');
		expect(url).not.toContain('appid');
	});

	it('requests a household-configured location and timezone when given one', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({}));
		await fetchWeather(fetchImpl, { latitude: 51.5072, longitude: -0.1276 }, 'Europe/London');
		const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
		expect(url).toContain('latitude=51.5072');
		expect(url).toContain('longitude=-0.1276');
		expect(url).toContain('timezone=Europe%2FLondon');
	});

	it('throws on a non-OK response rather than returning garbage', async () => {
		const fetchImpl = fakeFetch({}, false);
		await expect(fetchWeather(fetchImpl)).rejects.toThrow();
	});

	it('parses sunrise/sunset into HH:MM', async () => {
		const fetchImpl = fakeFetch(
			openMeteoBody({ sunrise: ['2026-08-23T06:12'], sunset: ['2026-08-23T20:03'] })
		);
		const weather = await fetchWeather(fetchImpl);
		expect(weather.sunrise).toBe('06:12');
		expect(weather.sunset).toBe('20:03');
	});

	it('falls back to null sunrise/sunset when the response omits the daily block', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({}));
		const weather = await fetchWeather(fetchImpl);
		expect(weather.sunrise).toBeNull();
		expect(weather.sunset).toBeNull();
	});
});

describe('refreshWeather / getCachedWeather', () => {
	it('has no cached weather before the first refresh', () => {
		expect(getCachedWeather()).toBeNull();
	});

	it('caches a successful fetch', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({ currentTemp: 18, currentCode: 3 }));
		const now = new Date('2026-08-23T18:00:00Z');
		await refreshWeather(now, fetchImpl, db);
		expect(getCachedWeather()?.temperatureC).toBe(18);
		expect(getCachedWeather()?.condition).toBe('Overcast');
	});

	it('requests the household-configured location/timezone from settings, not the default', async () => {
		await setSetting(db, SETTING_KEYS.householdLocation, '51.5072,-0.1276');
		await setSetting(db, SETTING_KEYS.householdTimeZone, 'Europe/London');
		const fetchImpl = fakeFetch(openMeteoBody({}));
		await refreshWeather(new Date('2026-08-23T18:00:00Z'), fetchImpl, db);
		const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
		expect(url).toContain('latitude=51.5072');
		expect(url).toContain('longitude=-0.1276');
		expect(url).toContain('timezone=Europe%2FLondon');
	});

	it('serves the cache rather than re-fetching within the 15-minute TTL', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({}));
		const now = new Date('2026-08-23T18:00:00Z');
		await refreshWeather(now, fetchImpl, db);

		const stillFresh = new Date(now.getTime() + 5 * 60_000);
		await refreshWeather(stillFresh, fetchImpl, db);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('re-fetches once the TTL has elapsed', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({}));
		const now = new Date('2026-08-23T18:00:00Z');
		await refreshWeather(now, fetchImpl, db);

		const later = new Date(now.getTime() + 16 * 60_000);
		await refreshWeather(later, fetchImpl, db);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('keeps serving the last known-good reading when a refresh fails', async () => {
		const goodFetch = fakeFetch(openMeteoBody({ currentTemp: 18, currentCode: 3 }));
		const now = new Date('2026-08-23T18:00:00Z');
		await refreshWeather(now, goodFetch, db);

		const badFetch = vi
			.fn()
			.mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
		const later = new Date(now.getTime() + 16 * 60_000);
		const result = await refreshWeather(later, badFetch, db);

		expect(result?.temperatureC).toBe(18);
		expect(getCachedWeather()?.temperatureC).toBe(18);
	});

	it('returns null when the very first fetch fails', async () => {
		const badFetch = vi
			.fn()
			.mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
		const result = await refreshWeather(new Date(), badFetch, db);
		expect(result).toBeNull();
	});

	it('persists a successful fetch to settings, for the next process to hydrate from', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({ currentTemp: 18, currentCode: 3 }));
		const now = new Date('2026-08-23T18:00:00Z');
		await refreshWeather(now, fetchImpl, db);

		const raw = await getSetting(db, SETTING_KEYS.lastWeather);
		expect(raw).not.toBeNull();
		const parsed = JSON.parse(raw!) as { weather: { temperatureC: number }; cachedAt: number };
		expect(parsed.weather.temperatureC).toBe(18);
		expect(parsed.cachedAt).toBe(now.getTime());
	});
});

describe('hydrateWeatherCache', () => {
	it('seeds the cache from a previously persisted reading', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({ currentTemp: 12, currentCode: 61 }));
		await refreshWeather(new Date('2026-08-23T18:00:00Z'), fetchImpl, db);
		resetWeatherCache(); // simulates a process restart: memory is gone, settings isn't

		expect(getCachedWeather()).toBeNull();
		await hydrateWeatherCache(db);
		expect(getCachedWeather()?.temperatureC).toBe(12);
		expect(getCachedWeather()?.condition).toBe('Light rain');
	});

	it('leaves the cache empty when nothing has ever been persisted', async () => {
		await hydrateWeatherCache(db);
		expect(getCachedWeather()).toBeNull();
	});

	it('does not clobber an already-populated cache', async () => {
		await setSetting(
			db,
			SETTING_KEYS.lastWeather,
			JSON.stringify({ weather: { temperatureC: 99 }, cachedAt: 0 })
		);
		const fetchImpl = fakeFetch(openMeteoBody({ currentTemp: 18, currentCode: 3 }));
		await refreshWeather(new Date('2026-08-23T18:00:00Z'), fetchImpl, db);

		await hydrateWeatherCache(db);
		expect(getCachedWeather()?.temperatureC).toBe(18);
	});

	it('ignores a malformed persisted value rather than throwing', async () => {
		await setSetting(db, SETTING_KEYS.lastWeather, 'not json');
		await expect(hydrateWeatherCache(db)).resolves.toBeUndefined();
		expect(getCachedWeather()).toBeNull();
	});
});
