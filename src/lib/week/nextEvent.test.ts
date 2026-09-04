import { describe, it, expect } from 'vitest';
import { findNextEvent } from './nextEvent';
import type { WeekSnapshot, SnapshotEvent } from '$lib/server/state/snapshot';

function event(over: Partial<SnapshotEvent> = {}): SnapshotEvent {
	return {
		id: 'e1',
		title: 'Event',
		time: null,
		startMinutes: null,
		endMinutes: null,
		allDay: false,
		color: null,
		calendar: 'Test',
		...over
	};
}

function snapshot(
	today: string,
	days: Array<{ date: string; events: SnapshotEvent[] }>
): WeekSnapshot {
	return {
		timeZone: 'America/Toronto',
		today,
		displayHours: { start: 7, end: 22 },
		days: days.map((d) => ({
			date: d.date,
			weekday: 'Mon',
			isToday: d.date === today,
			events: d.events
		}))
	};
}

describe('findNextEvent', () => {
	it('finds the next timed event later today', () => {
		const s = snapshot('2026-08-19', [
			{
				date: '2026-08-19',
				events: [
					event({ id: 'past', startMinutes: 8 * 60 }),
					event({ id: 'next', startMinutes: 15 * 60 })
				]
			}
		]);
		// It's 10:00 — the 8am event has passed, the 3pm one is next.
		const result = findNextEvent(s, 10 * 60);
		expect(result?.event.id).toBe('next');
	});

	it('is not confused by an event that starts exactly now — treats it as still upcoming', () => {
		const s = snapshot('2026-08-19', [
			{ date: '2026-08-19', events: [event({ id: 'now', startMinutes: 600 })] }
		]);
		expect(findNextEvent(s, 600)?.event.id).toBe('now');
	});

	it('excludes an event that has already started', () => {
		const s = snapshot('2026-08-19', [
			{ date: '2026-08-19', events: [event({ id: 'started', startMinutes: 599 })] }
		]);
		expect(findNextEvent(s, 600)).toBeNull();
	});

	it('falls through to tomorrow when today has nothing left', () => {
		const s = snapshot('2026-08-19', [
			{ date: '2026-08-19', events: [event({ id: 'today', startMinutes: 8 * 60 })] },
			{ date: '2026-08-20', events: [event({ id: 'tomorrow', startMinutes: 9 * 60 })] }
		]);
		expect(findNextEvent(s, 20 * 60)?.event.id).toBe('tomorrow');
	});

	it('skips all-day events — they have no "next up" time and already show in the grid', () => {
		const s = snapshot('2026-08-19', [
			{
				date: '2026-08-19',
				events: [
					event({ id: 'allday', allDay: true, startMinutes: null }),
					event({ id: 'timed', startMinutes: 15 * 60 })
				]
			}
		]);
		expect(findNextEvent(s, 0)?.event.id).toBe('timed');
	});

	it('returns null when nothing is left in the week', () => {
		const s = snapshot('2026-08-19', [
			{ date: '2026-08-19', events: [event({ startMinutes: 8 * 60 })] }
		]);
		expect(findNextEvent(s, 23 * 60)).toBeNull();
	});

	it('ignores days before today, even if they have events with high startMinutes', () => {
		// Regression guard: a naive filter on startMinutes alone, without checking the
		// date, could resurrect yesterday's late event.
		const s = snapshot('2026-08-19', [
			{ date: '2026-08-18', events: [event({ id: 'yesterday', startMinutes: 23 * 60 })] },
			{ date: '2026-08-19', events: [event({ id: 'today', startMinutes: 60 })] }
		]);
		expect(findNextEvent(s, 0)?.event.id).toBe('today');
	});

	it('returns the day alongside the event', () => {
		const s = snapshot('2026-08-19', [
			{ date: '2026-08-19', events: [event({ id: 'e', startMinutes: 60 })] }
		]);
		expect(findNextEvent(s, 0)?.day.date).toBe('2026-08-19');
	});
});
