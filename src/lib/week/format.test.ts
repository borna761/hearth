import { describe, it, expect } from 'vitest';
import {
	formatDayHeading,
	formatWeekday,
	formatMonthDay,
	formatMinutes,
	formatMinutesRange,
	formatHHMM
} from './format';

describe('formatDayHeading', () => {
	it('formats a full weekday and month', () => {
		expect(formatDayHeading('2026-08-19')).toBe('Wednesday, August 19');
	});

	it('is correct at year boundaries', () => {
		expect(formatDayHeading('2027-01-01')).toBe('Friday, January 1');
	});

	it('does not depend on the browser’s local timezone', () => {
		// The date string is already the correct household-local calendar date (§4.1); this
		// must render it as given, not re-derive a day from it via any real timezone
		// conversion, which is exactly the class of bug that would shift it by one.
		expect(formatDayHeading('2026-12-31')).toBe('Thursday, December 31');
	});
});

describe('formatWeekday', () => {
	it('formats just the weekday name, for Sam’s simple view (DESIGN.md §5.2)', () => {
		expect(formatWeekday('2026-08-19')).toBe('Wednesday');
	});

	it('does not depend on the browser’s local timezone', () => {
		expect(formatWeekday('2026-12-31')).toBe('Thursday');
	});
});

describe('formatMonthDay', () => {
	it('formats just the month and day, for Sam’s simple view (DESIGN.md §5.2)', () => {
		expect(formatMonthDay('2026-08-19')).toBe('August 19');
	});

	it('is correct at year boundaries', () => {
		expect(formatMonthDay('2027-01-01')).toBe('January 1');
	});
});

describe('formatMinutes', () => {
	it('zero-pads hours and minutes below 10', () => {
		expect(formatMinutes(7 * 60)).toBe('07:00');
		expect(formatMinutes(9 * 60 + 5)).toBe('09:05');
	});

	it('formats double-digit hours', () => {
		expect(formatMinutes(22 * 60)).toBe('22:00');
	});

	it('is zero at midnight', () => {
		expect(formatMinutes(0)).toBe('00:00');
	});

	it('defaults to 24h when no format is given', () => {
		expect(formatMinutes(13 * 60 + 5)).toBe('13:05');
	});

	it('formats 12h with AM/PM, unpadded hour', () => {
		expect(formatMinutes(9 * 60 + 5, '12h')).toBe('9:05 AM');
		expect(formatMinutes(13 * 60 + 5, '12h')).toBe('1:05 PM');
	});

	it('renders midnight as 12:00 AM and noon as 12:00 PM in 12h', () => {
		expect(formatMinutes(0, '12h')).toBe('12:00 AM');
		expect(formatMinutes(12 * 60, '12h')).toBe('12:00 PM');
	});

	it('renders the last minute of the day correctly in 12h', () => {
		expect(formatMinutes(23 * 60 + 59, '12h')).toBe('11:59 PM');
	});
});

describe('formatMinutesRange', () => {
	it('formats a start–end range in 24-hour time', () => {
		expect(formatMinutesRange(18 * 60 + 30, 19 * 60 + 30)).toBe('18:30–19:30');
	});

	it('zero-pads single-digit hours and minutes', () => {
		expect(formatMinutesRange(9 * 60 + 5, 9 * 60 + 45)).toBe('09:05–09:45');
	});

	it('shows only the start time when the event has no real duration', () => {
		// A zero-length event showing "14:00–14:00" reads as a typo, not useful information.
		expect(formatMinutesRange(14 * 60, 14 * 60)).toBe('14:00');
	});

	it('shows only the start time when end is before start', () => {
		// Defensive: should not happen given how endMinutes is derived server-side, but a
		// range display must never read as if it goes backward.
		expect(formatMinutesRange(14 * 60, 13 * 60)).toBe('14:00');
	});

	it('handles midnight and the end of a clamped day', () => {
		expect(formatMinutesRange(0, 30)).toBe('00:00–00:30');
		expect(formatMinutesRange(23 * 60, 23 * 60 + 59)).toBe('23:00–23:59');
	});

	it('carries the format into both sides of a 12h range, independently', () => {
		// Each side gets its own AM/PM rather than a shared one collapsed off the first —
		// unambiguous beats three saved characters, even across the noon boundary.
		expect(formatMinutesRange(11 * 60 + 30, 12 * 60 + 30, '12h')).toBe('11:30 AM–12:30 PM');
	});
});

describe('formatHHMM', () => {
	it('passes an already-24h "HH:MM" string through unchanged by default', () => {
		expect(formatHHMM('14:05')).toBe('14:05');
	});

	it('reformats a 24h "HH:MM" string to 12h', () => {
		expect(formatHHMM('14:05', '12h')).toBe('2:05 PM');
		expect(formatHHMM('00:00', '12h')).toBe('12:00 AM');
		expect(formatHHMM('12:00', '12h')).toBe('12:00 PM');
	});

	it('round-trips weather.ts’s own sunrise/sunset shape', () => {
		// weather.ts always caches these as canonical 24h strings regardless of the
		// household's preference — this is the reformat step applied at display time.
		expect(formatHHMM('06:07', '12h')).toBe('6:07 AM');
		expect(formatHHMM('19:45', '12h')).toBe('7:45 PM');
	});
});
