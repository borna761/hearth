// Event normalisation — DESIGN.md §4.1.
//
// The whole point of this module is the all-day/timed split. The account's calendars
// disagree about timezones (Family is UTC, Dana's is America/New_York, Visitors is
// Asia/Jerusalem, the Culture calendar is America/Los_Angeles), and the classic failure is to treat an
// all-day event as midnight-UTC — which in America/Toronto is 20:00 the previous day, so
// every all-day event renders one day early.
//
// The fix is structural rather than careful: an all-day event never becomes an epoch at
// any point. It carries a 'YYYY-MM-DD' string from Google straight through to the
// database, and all arithmetic on it is done on the string via UTC-based math that has no
// concept of a timezone to get wrong. That arithmetic lives in $lib/datetime.ts, not here
// — it is needed client-side too (the week view's "next up" strip), and SvelteKit refuses
// to bundle anything under src/lib/server/ into client code.

import { addDaysToLocalDate } from '$lib/datetime';

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface GoogleEventTime {
	date?: string;
	dateTime?: string;
	timeZone?: string;
}

export interface GoogleEvent {
	id: string;
	status?: string;
	summary?: string;
	location?: string;
	start?: GoogleEventTime;
	end?: GoogleEventTime;
	updated?: string;
}

export interface NormalizedEvent {
	id: string;
	title: string;
	startsAt: Date | null;
	endsAt: Date | null;
	localDate: string | null;
	/** Inclusive — the last day the event covers. See the note in normalizeEvent. */
	localEndDate: string | null;
	allDay: boolean;
	location: string | null;
	status: string | null;
	updatedAt: Date;
}

export type NormalizeResult =
	| { kind: 'event'; event: NormalizedEvent }
	| { kind: 'cancelled'; id: string }
	| { kind: 'skipped'; id: string; reason: string };

function parseUpdated(updated: string | undefined): Date {
	const parsed = updated ? new Date(updated) : null;
	// A row with an invalid updated_at would poison change detection, so fall back to
	// "seen now" rather than storing NaN.
	return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
}

export function normalizeEvent(raw: GoogleEvent): NormalizeResult {
	// Must come first: a cancellation tombstone from an incremental sync often carries
	// nothing but an id and this status — no summary, no start — and title is NOT NULL.
	if (raw.status === 'cancelled') {
		return { kind: 'cancelled', id: raw.id };
	}

	const title = raw.summary?.trim() || '(no title)';
	const updatedAt = parseUpdated(raw.updated);
	const common = {
		id: raw.id,
		title,
		location: raw.location ?? null,
		status: raw.status ?? null,
		updatedAt
	};

	if (raw.start?.date) {
		const localDate = raw.start.date;
		if (!LOCAL_DATE_PATTERN.test(localDate)) {
			return { kind: 'skipped', id: raw.id, reason: `unparseable start date ${localDate}` };
		}

		// Google's all-day end.date is EXCLUSIVE — a single-day event on the 21st reports
		// end.date 2026-08-22. Stored verbatim, every all-day event would render a day
		// longer than it is, so it is converted to an inclusive last-day here. Downstream
		// code should never have to remember this again.
		let localEndDate = localDate;
		if (raw.end?.date && LOCAL_DATE_PATTERN.test(raw.end.date)) {
			try {
				const inclusive = addDaysToLocalDate(raw.end.date, -1);
				// A zero-length or inverted range would put the end before the start; clamp
				// rather than store something a range query can never match.
				localEndDate = inclusive < localDate ? localDate : inclusive;
			} catch {
				localEndDate = localDate;
			}
		}

		return {
			kind: 'event',
			event: {
				...common,
				allDay: true,
				startsAt: null,
				endsAt: null,
				localDate,
				localEndDate
			}
		};
	}

	if (raw.start?.dateTime) {
		// RFC3339 with an offset, so this resolves to the right instant regardless of the
		// server's own timezone. The calendar's `timeZone` field is not needed for that.
		const startsAt = new Date(raw.start.dateTime);
		if (Number.isNaN(startsAt.getTime())) {
			return { kind: 'skipped', id: raw.id, reason: `unparseable start ${raw.start.dateTime}` };
		}

		const endCandidate = raw.end?.dateTime ? new Date(raw.end.dateTime) : null;
		const endsAt = endCandidate && !Number.isNaN(endCandidate.getTime()) ? endCandidate : null;

		return {
			kind: 'event',
			event: {
				...common,
				allDay: false,
				startsAt,
				endsAt,
				localDate: null,
				localEndDate: null
			}
		};
	}

	return { kind: 'skipped', id: raw.id, reason: 'event has neither date nor dateTime' };
}
