import { describe, it, expect } from 'vitest';
import {
	addDaysToLocalDate,
	localDateInZone,
	localHourInZone,
	localMinutesInZone,
	weekdayAbbrev
} from './datetime';

describe('addDaysToLocalDate', () => {
	it('adds and subtracts days', () => {
		expect(addDaysToLocalDate('2026-08-21', 1)).toBe('2026-08-22');
		expect(addDaysToLocalDate('2026-08-21', -1)).toBe('2026-08-20');
		expect(addDaysToLocalDate('2026-08-21', 0)).toBe('2026-08-21');
	});

	it('crosses month and year boundaries', () => {
		expect(addDaysToLocalDate('2026-08-31', 1)).toBe('2026-09-01');
		expect(addDaysToLocalDate('2026-09-01', -1)).toBe('2026-08-31');
		expect(addDaysToLocalDate('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDaysToLocalDate('2027-01-01', -1)).toBe('2026-12-31');
	});

	it('handles leap days', () => {
		expect(addDaysToLocalDate('2028-02-28', 1)).toBe('2028-02-29');
		expect(addDaysToLocalDate('2028-03-01', -1)).toBe('2028-02-29');
		expect(addDaysToLocalDate('2026-02-28', 1)).toBe('2026-03-01');
	});

	it('is unaffected by daylight-saving transitions', () => {
		// The whole reason this does UTC-based arithmetic rather than local-time Date math:
		// Toronto springs forward on 2026-03-08 and falls back on 2026-11-01. Local-time
		// arithmetic across those boundaries lands on 23:00 or 01:00 of the wrong day.
		expect(addDaysToLocalDate('2026-03-07', 1)).toBe('2026-03-08');
		expect(addDaysToLocalDate('2026-03-08', 1)).toBe('2026-03-09');
		expect(addDaysToLocalDate('2026-03-09', -1)).toBe('2026-03-08');
		expect(addDaysToLocalDate('2026-11-01', 1)).toBe('2026-11-02');
		expect(addDaysToLocalDate('2026-11-02', -1)).toBe('2026-11-01');
	});

	it('rejects a malformed date rather than producing a plausible wrong one', () => {
		expect(() => addDaysToLocalDate('21-08-2026', 1)).toThrow();
		expect(() => addDaysToLocalDate('not-a-date', 1)).toThrow();
		expect(() => addDaysToLocalDate('2026-08', 1)).toThrow();
	});
});

describe('localDateInZone', () => {
	it('returns the calendar date as seen in the given zone, not UTC', () => {
		// 02:00 UTC is still the previous evening in Toronto. Getting this wrong is the
		// off-by-one-day bug DESIGN.md §4.1 is about.
		expect(localDateInZone(new Date('2026-08-21T02:00:00Z'), 'America/Toronto')).toBe('2026-08-20');
		expect(localDateInZone(new Date('2026-08-21T16:00:00Z'), 'America/Toronto')).toBe('2026-08-21');
	});

	it('accounts for the zone’s current DST offset', () => {
		// Toronto is UTC-4 in August but UTC-5 in January, so the cutover instant differs.
		expect(localDateInZone(new Date('2026-01-15T02:00:00Z'), 'America/Toronto')).toBe('2026-01-14');
		expect(localDateInZone(new Date('2026-01-15T05:00:00Z'), 'America/Toronto')).toBe('2026-01-15');
	});

	it('works for the other zones this account’s calendars use', () => {
		// §4.1: the account's calendars disagree — Asia/Jerusalem is well ahead of UTC.
		const instant = new Date('2026-08-21T22:00:00Z');
		expect(localDateInZone(instant, 'Asia/Jerusalem')).toBe('2026-08-22');
		expect(localDateInZone(instant, 'America/Toronto')).toBe('2026-08-21');
		expect(localDateInZone(instant, 'America/Los_Angeles')).toBe('2026-08-21');
	});

	it('zero-pads month and day', () => {
		expect(localDateInZone(new Date('2026-01-05T17:00:00Z'), 'America/Toronto')).toBe('2026-01-05');
	});
});

describe('localHourInZone', () => {
	it('returns the hour as seen in the given zone', () => {
		expect(localHourInZone(new Date('2026-08-21T18:30:00Z'), 'America/Toronto')).toBe(14);
	});

	it('accounts for the zone’s current DST offset', () => {
		expect(localHourInZone(new Date('2026-01-21T18:30:00Z'), 'America/Toronto')).toBe(13);
	});
});

describe('localMinutesInZone', () => {
	it('returns minutes since local midnight', () => {
		// 18:30 UTC is 14:30 in Toronto (UTC-4 in August) — 14*60+30 = 870.
		expect(localMinutesInZone(new Date('2026-08-21T18:30:00Z'), 'America/Toronto')).toBe(870);
	});

	it('is zero at local midnight', () => {
		expect(localMinutesInZone(new Date('2026-08-21T04:00:00Z'), 'America/Toronto')).toBe(0);
	});

	it('accounts for the zone’s current DST offset', () => {
		// Toronto is UTC-5 in January; 18:30 UTC is 13:30 local, not 14:30.
		expect(localMinutesInZone(new Date('2026-01-21T18:30:00Z'), 'America/Toronto')).toBe(810);
	});

	it('works for a zone ahead of UTC', () => {
		expect(localMinutesInZone(new Date('2026-08-21T10:15:00Z'), 'Asia/Jerusalem')).toBe(
			13 * 60 + 15
		);
	});
});

describe('weekdayAbbrev', () => {
	it('names each day of the week', () => {
		expect(weekdayAbbrev('2026-08-17')).toBe('Mon');
		expect(weekdayAbbrev('2026-08-18')).toBe('Tue');
		expect(weekdayAbbrev('2026-08-19')).toBe('Wed');
		expect(weekdayAbbrev('2026-08-20')).toBe('Thu');
		expect(weekdayAbbrev('2026-08-21')).toBe('Fri');
		expect(weekdayAbbrev('2026-08-22')).toBe('Sat');
		expect(weekdayAbbrev('2026-08-23')).toBe('Sun');
	});

	it('does not depend on the browser or server’s local timezone', () => {
		// Same UTC-anchoring as addDaysToLocalDate — the date string is already the correct
		// calendar day, so naming its weekday must not risk a real timezone conversion.
		expect(weekdayAbbrev('2026-12-31')).toBe('Thu');
	});
});
