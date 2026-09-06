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
	feelsLikeC?: number;
	humidityPercent?: number;
	precipitationMm?: number;
	windSpeedKmh?: number;
	windDirectionDeg?: number;
	hourlyTimes?: string[];
	hourlyTemps?: number[];
	hourlyCodes?: number[];
	hourlyPrecip?: number[];
	sunrise?: string[];
	sunset?: string[];
	dailyTimes?: string[];
	dailyCodes?: number[];
	dailyHighs?: number[];
	dailyLows?: number[];
	uvIndexMax?: number[];
}) {
	const hasDaily =
		overrides.sunrise ||
		overrides.sunset ||
		overrides.dailyTimes ||
		overrides.dailyCodes ||
		overrides.dailyHighs ||
		overrides.dailyLows ||
		overrides.uvIndexMax;
	return {
		current: {
			temperature_2m: overrides.currentTemp ?? 18,
			weather_code: overrides.currentCode ?? 3,
			...(overrides.feelsLikeC !== undefined ? { apparent_temperature: overrides.feelsLikeC } : {}),
			...(overrides.humidityPercent !== undefined
				? { relative_humidity_2m: overrides.humidityPercent }
				: {}),
			...(overrides.precipitationMm !== undefined
				? { precipitation: overrides.precipitationMm }
				: {}),
			...(overrides.windSpeedKmh !== undefined ? { wind_speed_10m: overrides.windSpeedKmh } : {}),
			...(overrides.windDirectionDeg !== undefined
				? { wind_direction_10m: overrides.windDirectionDeg }
				: {})
		},
		hourly: {
			time: overrides.hourlyTimes ?? ['2026-08-23T14:00', '2026-08-23T15:00'],
			temperature_2m: overrides.hourlyTemps ?? [18, 19],
			weather_code: overrides.hourlyCodes ?? [3, 1],
			precipitation: overrides.hourlyPrecip ?? [0, 0]
		},
		...(hasDaily
			? {
					daily: {
						time: overrides.dailyTimes ?? ['2026-08-23', '2026-08-24'],
						sunrise: overrides.sunrise ?? ['2026-08-23T06:12'],
						sunset: overrides.sunset ?? ['2026-08-23T20:03'],
						weather_code: overrides.dailyCodes ?? [3, 1],
						temperature_2m_max: overrides.dailyHighs ?? [22, 24],
						temperature_2m_min: overrides.dailyLows ?? [14, 15],
						uv_index_max: overrides.uvIndexMax ?? [5, 6]
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

	it('parses the hourly forecast into time/temperature/icon/precipitation entries', async () => {
		const fetchImpl = fakeFetch(
			openMeteoBody({
				hourlyTimes: ['2026-08-23T14:00', '2026-08-23T15:00', '2026-08-23T16:00'],
				hourlyTemps: [18.4, 19.6, 20.1],
				hourlyCodes: [3, 1, 61],
				hourlyPrecip: [0, 0.2, 1.8]
			})
		);
		const weather = await fetchWeather(fetchImpl);
		expect(weather.hourly).toEqual([
			{ time: '14:00', temperatureC: 18, icon: 'cloudy', precipitationMm: 0 },
			{ time: '15:00', temperatureC: 20, icon: 'sun', precipitationMm: 0.2 },
			{ time: '16:00', temperatureC: 20, icon: 'rain', precipitationMm: 1.8 }
		]);
	});

	it('falls back to 0 hourly precipitation when the response omits it', async () => {
		const fetchImpl = fakeFetch(
			openMeteoBody({ hourlyTimes: ['2026-08-23T14:00'], hourlyTemps: [18], hourlyCodes: [3] })
		);
		const body = await fetchImpl('irrelevant');
		const raw = (await body.json()) as { hourly: { precipitation?: number[] } };
		delete raw.hourly.precipitation;
		const fetchImplWithoutPrecip = (async () => ({
			ok: true,
			status: 200,
			json: async () => raw
		})) as unknown as typeof fetch;
		const weather = await fetchWeather(fetchImplWithoutPrecip);
		expect(weather.hourly[0].precipitationMm).toBe(0);
	});

	it('requests the pinned Springfield coordinates by default, an hourly forecast, and no key', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({}));
		await fetchWeather(fetchImpl);
		const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
		expect(url).toContain('latitude=45.5');
		expect(url).toContain('longitude=-75.5');
		expect(url).toContain('timezone=America%2FToronto');
		expect(url).toContain('hourly=temperature_2m%2Cweather_code%2Cprecipitation');
		expect(url).toContain('relative_humidity_2m');
		expect(url).toContain('apparent_temperature');
		expect(url).toContain('wind_speed_10m');
		expect(url).toContain('wind_direction_10m');
		expect(url).toContain('uv_index_max');
		expect(url).toContain('sunrise');
		expect(url).toContain('sunset');
		expect(url).not.toContain('key');
		expect(url).not.toContain('appid');
	});

	it('also requests air quality, from Open-Meteo’s separate host, with no key', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({}));
		await fetchWeather(fetchImpl);
		const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as [string][];
		const airQualityUrl = calls.map((c) => c[0]).find((u) => u.includes('air-quality'));
		expect(airQualityUrl).toContain('https://air-quality-api.open-meteo.com/v1/air-quality');
		expect(airQualityUrl).toContain('latitude=45.5');
		expect(airQualityUrl).toContain('us_aqi');
		expect(airQualityUrl).not.toContain('key');
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

	it('parses feels-like, humidity, precipitation, and wind from the current block', async () => {
		const fetchImpl = fakeFetch(
			openMeteoBody({
				feelsLikeC: 24.6,
				humidityPercent: 62,
				precipitationMm: 0.4,
				windSpeedKmh: 13.7,
				windDirectionDeg: 270
			})
		);
		const weather = await fetchWeather(fetchImpl);
		expect(weather.feelsLikeC).toBe(25);
		expect(weather.humidityPercent).toBe(62);
		expect(weather.precipitationMm).toBe(0.4);
		expect(weather.windSpeedKmh).toBe(14);
		expect(weather.windDirectionDeg).toBe(270);
	});

	it('falls back to null current metrics the response omits', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({}));
		const weather = await fetchWeather(fetchImpl);
		expect(weather.feelsLikeC).toBeNull();
		expect(weather.humidityPercent).toBeNull();
		expect(weather.precipitationMm).toBeNull();
		expect(weather.windSpeedKmh).toBeNull();
		expect(weather.windDirectionDeg).toBeNull();
	});

	it('parses today’s peak UV index from the daily block', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({ uvIndexMax: [7.8, 6] }));
		const weather = await fetchWeather(fetchImpl);
		expect(weather.uvIndex).toBe(7.8);
	});

	it('falls back to null UV index when the response omits the daily block', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({}));
		const weather = await fetchWeather(fetchImpl);
		expect(weather.uvIndex).toBeNull();
	});

	it('parses the multi-day forecast into date/high/low/icon entries', async () => {
		const fetchImpl = fakeFetch(
			openMeteoBody({
				dailyTimes: ['2026-08-23', '2026-08-24', '2026-08-25'],
				dailyCodes: [3, 1, 61],
				dailyHighs: [22.4, 24.6, 19.1],
				dailyLows: [14.2, 15.8, 13.4]
			})
		);
		const weather = await fetchWeather(fetchImpl);
		expect(weather.daily).toEqual([
			{ date: '2026-08-23', highC: 22, lowC: 14, icon: 'cloudy' },
			{ date: '2026-08-24', highC: 25, lowC: 16, icon: 'sun' },
			{ date: '2026-08-25', highC: 19, lowC: 13, icon: 'rain' }
		]);
	});

	it('falls back to an empty daily forecast when the response omits the daily block', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({}));
		const weather = await fetchWeather(fetchImpl);
		expect(weather.daily).toEqual([]);
	});

	it('skips a daily entry missing a required field rather than throwing', async () => {
		// A malformed/partial upstream response: `time` has 3 entries but the other daily
		// arrays only cover the first 2 — same "API omitted a field" case sunrise/sunset/
		// uvIndex already tolerate, just at the per-entry level instead of block level.
		const fetchImpl = fakeFetch({
			...openMeteoBody({}),
			daily: {
				time: ['2026-08-23', '2026-08-24', '2026-08-25'],
				sunrise: ['2026-08-23T06:12'],
				sunset: ['2026-08-23T20:03'],
				weather_code: [3, 1],
				temperature_2m_max: [22, 24],
				temperature_2m_min: [14, 15],
				uv_index_max: [5, 6]
			}
		});
		const weather = await fetchWeather(fetchImpl);
		expect(weather.daily).toEqual([
			{ date: '2026-08-23', highC: 22, lowC: 14, icon: 'cloudy' },
			{ date: '2026-08-24', highC: 24, lowC: 15, icon: 'sun' }
		]);
	});

	it('parses the US AQI from the air-quality response', async () => {
		const fetchImpl = vi.fn().mockImplementation((url: string) => {
			const body = url.includes('air-quality') ? { current: { us_aqi: 42 } } : openMeteoBody({});
			return Promise.resolve({ ok: true, status: 200, json: async () => body });
		}) as unknown as typeof fetch;
		const weather = await fetchWeather(fetchImpl);
		expect(weather.airQualityIndex).toBe(42);
	});

	it('falls back to a null air-quality index rather than failing the whole fetch when that request errors', async () => {
		const fetchImpl = vi.fn().mockImplementation((url: string) => {
			if (url.includes('air-quality')) return Promise.reject(new Error('network error'));
			return Promise.resolve({ ok: true, status: 200, json: async () => openMeteoBody({}) });
		}) as unknown as typeof fetch;
		const weather = await fetchWeather(fetchImpl);
		expect(weather.airQualityIndex).toBeNull();
		// The main forecast itself must still succeed — a broken secondary metric shouldn't
		// take down the whole weather fetch.
		expect(weather.temperatureC).toBe(18);
	});

	it('falls back to a null air-quality index when that request responds non-OK', async () => {
		const fetchImpl = vi.fn().mockImplementation((url: string) => {
			if (url.includes('air-quality')) {
				return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
			}
			return Promise.resolve({ ok: true, status: 200, json: async () => openMeteoBody({}) });
		}) as unknown as typeof fetch;
		const weather = await fetchWeather(fetchImpl);
		expect(weather.airQualityIndex).toBeNull();
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
		// 2, not 1: fetchWeather makes two requests per call now — the main forecast and
		// the separate air-quality one.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('re-fetches once the TTL has elapsed', async () => {
		const fetchImpl = fakeFetch(openMeteoBody({}));
		const now = new Date('2026-08-23T18:00:00Z');
		await refreshWeather(now, fetchImpl, db);

		const later = new Date(now.getTime() + 16 * 60_000);
		await refreshWeather(later, fetchImpl, db);
		expect(fetchImpl).toHaveBeenCalledTimes(4);
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

	it('refuses to hydrate a reading persisted by an older version missing newer required fields', async () => {
		// `daily` didn't exist on Weather before this file added the multi-day forecast —
		// a reading from before that deploy has no `daily` key at all. Hydrating it as-is
		// would crash WeatherPanel.svelte's `weather.daily.slice(1)` the moment someone
		// opens the report, since there's no shape check between here and that component.
		await setSetting(
			db,
			SETTING_KEYS.lastWeather,
			JSON.stringify({
				weather: {
					temperatureC: 18,
					condition: 'Overcast',
					icon: 'cloudy',
					hourly: [],
					sunrise: null,
					sunset: null
				},
				cachedAt: Date.now()
			})
		);
		await hydrateWeatherCache(db);
		expect(getCachedWeather()).toBeNull();
	});
});
