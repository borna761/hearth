import { describe, it, expect } from 'vitest';
import { normalizeEvent } from './events';

describe('normalizeEvent — timed events', () => {
	it('stores a UTC epoch and no local date', () => {
		const result = normalizeEvent({
			id: 'timed-1',
			status: 'confirmed',
			summary: 'Dentist',
			start: { dateTime: '2026-08-21T14:00:00-04:00', timeZone: 'America/Toronto' },
			end: { dateTime: '2026-08-21T14:30:00-04:00', timeZone: 'America/Toronto' },
			updated: '2026-08-20T10:00:00.000Z'
		});

		expect(result.kind).toBe('event');
		if (result.kind !== 'event') return;
		expect(result.event.allDay).toBe(false);
		expect(result.event.startsAt).toEqual(new Date('2026-08-21T18:00:00Z'));
		expect(result.event.endsAt).toEqual(new Date('2026-08-21T18:30:00Z'));
		expect(result.event.localDate).toBeNull();
		expect(result.event.localEndDate).toBeNull();
	});

	it('resolves the instant correctly whatever offset the source calendar uses', () => {
		// The Visitors calendar is Asia/Jerusalem. The offset in the string is what fixes
		// the instant; the calendar's own timeZone field is not needed for that.
		const result = normalizeEvent({
			id: 'timed-2',
			status: 'confirmed',
			summary: 'Call',
			start: { dateTime: '2026-08-21T14:00:00+03:00', timeZone: 'Asia/Jerusalem' },
			end: { dateTime: '2026-08-21T15:00:00+03:00', timeZone: 'Asia/Jerusalem' },
			updated: '2026-08-20T10:00:00.000Z'
		});

		if (result.kind !== 'event') throw new Error('expected event');
		expect(result.event.startsAt).toEqual(new Date('2026-08-21T11:00:00Z'));
	});

	it('carries location, status and updated timestamp', () => {
		const result = normalizeEvent({
			id: 'timed-3',
			status: 'tentative',
			summary: 'Lunch',
			location: 'Café Olimpico',
			start: { dateTime: '2026-08-21T12:00:00-04:00' },
			end: { dateTime: '2026-08-21T13:00:00-04:00' },
			updated: '2026-08-20T10:00:00.000Z'
		});

		if (result.kind !== 'event') throw new Error('expected event');
		expect(result.event.location).toBe('Café Olimpico');
		expect(result.event.status).toBe('tentative');
		expect(result.event.updatedAt).toEqual(new Date('2026-08-20T10:00:00.000Z'));
	});
});

describe('normalizeEvent — all-day events', () => {
	it('stores a date string and never an epoch', () => {
		// The core of §4.1. new Date('2026-08-21') is midnight UTC, which is 20:00 on the
		// 20th in Toronto — so an all-day event must never become an epoch at all.
		const result = normalizeEvent({
			id: 'allday-1',
			status: 'confirmed',
			summary: "Bahá'í Feast",
			start: { date: '2026-08-21' },
			end: { date: '2026-08-22' },
			updated: '2026-08-20T10:00:00.000Z'
		});

		if (result.kind !== 'event') throw new Error('expected event');
		expect(result.event.allDay).toBe(true);
		expect(result.event.localDate).toBe('2026-08-21');
		expect(result.event.startsAt).toBeNull();
		expect(result.event.endsAt).toBeNull();
	});

	it('converts Google’s exclusive end date into an inclusive one', () => {
		// Google says a single-day event on the 21st ends on the 22nd. Storing that
		// verbatim would render every all-day event a day longer than it is.
		const result = normalizeEvent({
			id: 'allday-2',
			status: 'confirmed',
			summary: 'Holiday',
			start: { date: '2026-08-21' },
			end: { date: '2026-08-22' },
			updated: '2026-08-20T10:00:00.000Z'
		});

		if (result.kind !== 'event') throw new Error('expected event');
		expect(result.event.localEndDate).toBe('2026-08-21');
	});

	it('keeps a multi-day span, rather than collapsing it to the first day', () => {
		const result = normalizeEvent({
			id: 'allday-3',
			status: 'confirmed',
			summary: 'Vacation',
			start: { date: '2026-08-21' },
			end: { date: '2026-08-26' },
			updated: '2026-08-20T10:00:00.000Z'
		});

		if (result.kind !== 'event') throw new Error('expected event');
		expect(result.event.localDate).toBe('2026-08-21');
		expect(result.event.localEndDate).toBe('2026-08-25');
	});

	it('handles a multi-day span across a DST transition', () => {
		const result = normalizeEvent({
			id: 'allday-4',
			status: 'confirmed',
			summary: 'March break',
			start: { date: '2026-03-07' },
			end: { date: '2026-03-10' },
			updated: '2026-03-01T10:00:00.000Z'
		});

		if (result.kind !== 'event') throw new Error('expected event');
		expect(result.event.localEndDate).toBe('2026-03-09');
	});

	it('handles a span across a year boundary', () => {
		const result = normalizeEvent({
			id: 'allday-5',
			status: 'confirmed',
			summary: 'Winter break',
			start: { date: '2026-12-28' },
			end: { date: '2027-01-05' },
			updated: '2026-12-01T10:00:00.000Z'
		});

		if (result.kind !== 'event') throw new Error('expected event');
		expect(result.event.localEndDate).toBe('2027-01-04');
	});

	it('falls back to the start date when the end is missing or malformed', () => {
		const result = normalizeEvent({
			id: 'allday-6',
			status: 'confirmed',
			summary: 'Odd one',
			start: { date: '2026-08-21' },
			updated: '2026-08-20T10:00:00.000Z'
		});

		if (result.kind !== 'event') throw new Error('expected event');
		expect(result.event.localEndDate).toBe('2026-08-21');
	});
});

describe('normalizeEvent — cancellations and malformed input', () => {
	it('reports a cancelled event for deletion, even when it carries nothing else', () => {
		// Incremental syncs return tombstones with no summary and no start. Trying to
		// upsert one would violate the NOT NULL on title.
		const result = normalizeEvent({ id: 'gone-1', status: 'cancelled' });
		expect(result).toEqual({ kind: 'cancelled', id: 'gone-1' });
	});

	it('substitutes a placeholder title rather than failing on an untitled event', () => {
		// Google allows events with no summary; the column is NOT NULL.
		const result = normalizeEvent({
			id: 'untitled-1',
			status: 'confirmed',
			start: { dateTime: '2026-08-21T14:00:00-04:00' },
			end: { dateTime: '2026-08-21T15:00:00-04:00' },
			updated: '2026-08-20T10:00:00.000Z'
		});

		if (result.kind !== 'event') throw new Error('expected event');
		expect(result.event.title).toBe('(no title)');
	});

	it('treats an event with neither date nor dateTime as unusable', () => {
		const result = normalizeEvent({
			id: 'broken-1',
			status: 'confirmed',
			summary: 'Nonsense',
			updated: '2026-08-20T10:00:00.000Z'
		});
		expect(result.kind).toBe('skipped');
	});

	it('defaults updatedAt rather than storing an invalid date', () => {
		const result = normalizeEvent({
			id: 'no-updated',
			status: 'confirmed',
			summary: 'Thing',
			start: { date: '2026-08-21' },
			end: { date: '2026-08-22' },
			updated: 'not-a-timestamp'
		});

		if (result.kind !== 'event') throw new Error('expected event');
		expect(Number.isNaN(result.event.updatedAt.getTime())).toBe(false);
	});
});
