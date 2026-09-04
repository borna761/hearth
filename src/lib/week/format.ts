// Pure display formatting for the week view. Runs client-side but stays timezone-free —
// `today`/`date` strings arriving over SSE are already the correct household-local
// calendar date (DESIGN.md §4.1), so nothing here may re-derive a day through a real
// timezone conversion. That is exactly the class of bug (§4.1's "classic off-by-one-day")
// this whole project goes out of its way to avoid; re-introducing it in a display
// formatter would be silly after all the trouble sync.ts and snapshot.ts go to.

/**
 * Anchored at UTC noon — the same UTC-anchoring $lib/datetime.ts uses throughout — so
 * every formatter built on this is pure calendar-date arithmetic with no real timezone
 * conversion involved, and therefore no dependency on the browser's own zone.
 */
function anchorLocalDate(date: string): Date {
	const [year, month, day] = date.split('-').map(Number);
	return new Date(Date.UTC(year, month - 1, day, 12));
}

/** "Wednesday, August 19" from a 'YYYY-MM-DD' string. */
export function formatDayHeading(date: string): string {
	return new Intl.DateTimeFormat('en-US', {
		timeZone: 'UTC',
		weekday: 'long',
		month: 'long',
		day: 'numeric'
	}).format(anchorLocalDate(date));
}

/** "Wednesday" alone — Sam's simple view (DESIGN.md §5.2) sets this large, separately
 * from the date beneath it, rather than the combined "Wednesday, August 19" heading. */
export function formatWeekday(date: string): string {
	return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(
		anchorLocalDate(date)
	);
}

/** "August 19" alone — the smaller line beneath formatWeekday in Sam's simple view. */
export function formatMonthDay(date: string): string {
	return new Intl.DateTimeFormat('en-US', {
		timeZone: 'UTC',
		month: 'long',
		day: 'numeric'
	}).format(anchorLocalDate(date));
}

/** The household's clock preference — settings' time_format, default 24h. */
export type TimeFormat = '12h' | '24h';

/** "07:00", or "7:00 AM" when `format` is '12h', from minutes-since-midnight. */
export function formatMinutes(minutes: number, format: TimeFormat = '24h'): string {
	const totalHours = Math.floor(minutes / 60);
	const m = String(minutes % 60).padStart(2, '0');
	if (format === '12h') {
		const period = totalHours < 12 ? 'AM' : 'PM';
		const h12 = totalHours % 12 === 0 ? 12 : totalHours % 12;
		return `${h12}:${m} ${period}`;
	}
	const h = String(totalHours).padStart(2, '0');
	return `${h}:${m}`;
}

/**
 * "18:30–19:30" (or "6:30 PM–7:30 PM" in 12h) from minutes-since-midnight, for the hour
 * grid's event blocks — pure arithmetic on an already-correct local value, no timezone
 * conversion involved. Each side carries its own AM/PM rather than collapsing a shared one
 * off the first side — unambiguous beats three saved characters.
 */
export function formatMinutesRange(
	startMinutes: number,
	endMinutes: number,
	format: TimeFormat = '24h'
): string {
	if (endMinutes <= startMinutes) return formatMinutes(startMinutes, format);
	return `${formatMinutes(startMinutes, format)}–${formatMinutes(endMinutes, format)}`;
}

/**
 * Reformats an already-produced 'HH:MM' (24h) string for display — weather.ts's cached
 * hourly/sunrise/sunset strings are always stored in this canonical 24h form regardless of
 * the household's format preference, so a later preference change doesn't require
 * re-fetching or reprocessing weather that's already cached.
 */
export function formatHHMM(hhmm: string, format: TimeFormat = '24h'): string {
	const [h, m] = hhmm.split(':').map(Number);
	return formatMinutes(h * 60 + m, format);
}
