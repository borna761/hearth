// Timezone-safe date/time helpers — DESIGN.md §4.1.
//
// Deliberately outside src/lib/server/: the week view's "next up" strip needs to keep
// advancing through the day client-side, using the SAME zone-conversion logic the server
// uses to build the snapshot in the first place (localMinutesInZone). SvelteKit refuses to
// bundle anything under src/lib/server/ into client code, so these have to live somewhere
// both sides can import — which also means there is exactly one implementation of "what
// time is it in the household zone", not a client copy that could drift from the server's.
//
// The account's calendars disagree about timezones (Family is UTC, Dana's is
// America/New_York, Visitors is Asia/Jerusalem, the Culture calendar is America/Los_Angeles), and the
// classic failure is to treat an all-day event as midnight-UTC — which in
// America/Toronto is 20:00 the previous day, so every all-day event renders one day
// early. The fix is structural: an all-day event never becomes an epoch at any point. It
// carries a 'YYYY-MM-DD' string straight through, and all arithmetic on it goes through
// Date.UTC/getUTC*, which has no concept of a timezone to get wrong.

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function formatUtcDate(date: Date): string {
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * Shifts a 'YYYY-MM-DD' string by whole days.
 *
 * Deliberately built on Date.UTC/getUTC*: UTC has no daylight saving, so adding 86400000ms
 * is always exactly one calendar day. The same arithmetic in local time breaks twice a
 * year — across Toronto's spring-forward, midnight minus a day is 23:00 of the day before
 * the one you wanted.
 */
export function addDaysToLocalDate(date: string, days: number): string {
	if (!LOCAL_DATE_PATTERN.test(date)) {
		throw new Error(`Not a YYYY-MM-DD local date: ${date}`);
	}
	const [year, month, day] = date.split('-').map(Number);
	const base = new Date(Date.UTC(year, month - 1, day));

	// Rejects well-formed impossibilities like 2026-02-30, which Date.UTC would silently
	// roll forward into March rather than refusing.
	if (formatUtcDate(base) !== date) {
		throw new Error(`Not a real calendar date: ${date}`);
	}

	return formatUtcDate(new Date(base.getTime() + days * 86_400_000));
}

/**
 * The calendar date an instant falls on *in a given zone*. Intl carries the zone's DST
 * rules, so this stays correct across transitions without a timezone library.
 */
export function localDateInZone(instant: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(instant);

	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Hour of day (0–23) an instant falls on in a given zone. */
export function localHourInZone(instant: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(instant);
	return Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
}

/**
 * Minutes since local midnight (0–1439). A timezone-safe, sortable value for ranking
 * events within a day — used server-side to build the snapshot, and client-side to find
 * "the next event" against the tablet's own wall clock without either side ever handling
 * an epoch or a zone conversion directly.
 */
export function localMinutesInZone(instant: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(instant);
	const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
	const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
	return hour * 60 + minute;
}

/**
 * "Mon"/"Tue"/... for a 'YYYY-MM-DD' string. UTC-anchored like addDaysToLocalDate — the
 * date is already the correct calendar day, so naming its weekday is pure calendar
 * arithmetic and must not risk a real timezone conversion shifting it.
 */
export function weekdayAbbrev(date: string): string {
	const [year, month, day] = date.split('-').map(Number);
	const anchor = new Date(Date.UTC(year, month - 1, day, 12));
	return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(anchor);
}
