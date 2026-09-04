import { describe, it, expect } from 'vitest';
import { computeTheme } from './theme';

// DESIGN.md §5.3's own worked examples, verified against the real suncalc output at the
// pinned coordinates: 21 Jun sunrise ~05:13, sunset ~20:54 EDT (UTC-4); 21 Dec sunrise
// ~07:39, sunset ~16:21 EST (UTC-5).
const SUMMER_SUNRISE_EDT = '2026-06-21T09:13:00Z'; // 05:13 Springfield
const SUMMER_SUNSET_EDT = '2026-06-22T00:54:00Z'; // 20:54 Springfield (21 Jun local)
const WINTER_SUNRISE_EST = '2026-12-21T12:39:00Z'; // 07:39 Springfield
const WINTER_SUNSET_EST = '2026-12-21T21:21:18.161Z'; // 16:21 Springfield — exact suncalc output, for the boundary test

describe('computeTheme', () => {
	it('is dark before sunrise on the summer solstice', () => {
		const beforeSunrise = new Date(new Date(SUMMER_SUNRISE_EDT).getTime() - 10 * 60_000);
		expect(computeTheme(beforeSunrise, 'auto')).toBe('dark');
	});

	it('is light shortly after sunrise on the summer solstice', () => {
		const afterSunrise = new Date(new Date(SUMMER_SUNRISE_EDT).getTime() + 10 * 60_000);
		expect(computeTheme(afterSunrise, 'auto')).toBe('light');
	});

	it('is light shortly before sunset on the summer solstice', () => {
		const beforeSunset = new Date(new Date(SUMMER_SUNSET_EDT).getTime() - 10 * 60_000);
		expect(computeTheme(beforeSunset, 'auto')).toBe('light');
	});

	it('is dark shortly after sunset on the summer solstice', () => {
		const afterSunset = new Date(new Date(SUMMER_SUNSET_EDT).getTime() + 10 * 60_000);
		expect(computeTheme(afterSunset, 'auto')).toBe('dark');
	});

	it("is dark through dinner on the winter solstice — DESIGN.md §5.3's worked example", () => {
		// "On 21 December the sun sets at 16:21, so the display is dark-themed through the
		// whole of dinner and the evening."
		const dinnerTime = new Date('2026-12-21T23:30:00Z'); // 18:30 Springfield
		expect(computeTheme(dinnerTime, 'auto')).toBe('dark');
	});

	it('is light for most of the day on the winter solstice, despite the short day', () => {
		const midday = new Date('2026-12-21T17:00:00Z'); // 12:00 Springfield
		expect(computeTheme(midday, 'auto')).toBe('light');
	});

	it('is dark before sunrise and light after it on the winter solstice too', () => {
		const beforeSunrise = new Date(new Date(WINTER_SUNRISE_EST).getTime() - 10 * 60_000);
		const afterSunrise = new Date(new Date(WINTER_SUNRISE_EST).getTime() + 10 * 60_000);
		expect(computeTheme(beforeSunrise, 'auto')).toBe('dark');
		expect(computeTheme(afterSunrise, 'auto')).toBe('light');
	});

	it('is dark exactly at and after sunset, not still light at the boundary', () => {
		const atSunset = new Date(WINTER_SUNSET_EST);
		expect(computeTheme(atSunset, 'auto')).toBe('dark');
	});

	it('forces light regardless of the actual time when mode is light', () => {
		const middleOfTheNight = new Date('2026-12-21T06:00:00Z'); // 01:00 Springfield
		expect(computeTheme(middleOfTheNight, 'light')).toBe('light');
	});

	it('forces dark regardless of the actual time when mode is dark', () => {
		const middleOfTheDay = new Date('2026-06-21T16:00:00Z'); // noon Springfield
		expect(computeTheme(middleOfTheDay, 'dark')).toBe('dark');
	});

	it('honours a household-configured location instead of the Springfield default', () => {
		// 05:00 Springfield on the winter solstice — still dark, well before its ~07:39 sunrise
		// — but the same instant is mid-morning in Buenos Aires' southern-hemisphere summer,
		// unambiguously light. Confirms the location parameter actually reaches suncalc
		// rather than the default silently winning. (Verified against the real suncalc
		// output, not hand-computed — sun times don't follow clean UTC-offset arithmetic
		// once "today vs. yesterday" windowing is involved.)
		const now = new Date('2026-12-21T10:00:00Z');
		const buenosAires = { latitude: -34.6037, longitude: -58.3816 };
		expect(computeTheme(now, 'auto')).toBe('dark');
		expect(computeTheme(now, 'auto', buenosAires)).toBe('light');
	});
});
