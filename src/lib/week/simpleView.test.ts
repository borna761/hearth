import { describe, it, expect } from 'vitest';
import { buildSimpleViewModel } from './simpleView';
import type { WeekSnapshot, SnapshotDay, SnapshotEvent } from '$lib/server/state/snapshot';

function timed(
	id: string,
	startMinutes: number,
	endMinutes: number,
	title = id,
	color: string | null = '#3b82f6'
): SnapshotEvent {
	return {
		id,
		title,
		time: null,
		startMinutes,
		endMinutes,
		allDay: false,
		color,
		calendar: 'Test'
	};
}

function allDay(id: string, title = id): SnapshotEvent {
	return {
		id,
		title,
		time: null,
		startMinutes: null,
		endMinutes: null,
		allDay: true,
		color: null,
		calendar: 'Test'
	};
}

function day(date: string, events: SnapshotEvent[], isToday = false): SnapshotDay {
	return { date, weekday: 'Wed', isToday, events };
}

function snapshot(today: string, days: SnapshotDay[]): WeekSnapshot {
	return { timeZone: 'America/Toronto', today, displayHours: { start: 7, end: 22 }, days };
}

const TODAY = '2026-08-19';
const TOMORROW = '2026-08-20';

describe('buildSimpleViewModel', () => {
	it('splits the date heading into weekday and month/day separately', () => {
		const model = buildSimpleViewModel(snapshot(TODAY, [day(TODAY, [], true)]), 8 * 60);
		expect(model.weekday).toBe('Wednesday');
		expect(model.monthDay).toBe('August 19');
	});

	it('picks the next upcoming event today as "next up", phrased as "at HH:MM" when far off', () => {
		const snap = snapshot(TODAY, [day(TODAY, [timed('a', 16 * 60, 17 * 60, 'Piano')], true)]);
		const model = buildSimpleViewModel(snap, 9 * 60); // 09:00, event at 16:00 — 7h away
		expect(model.nextUp).toMatchObject({ title: 'Piano', time: '16:00', relative: 'at 16:00' });
	});

	it('phrases an event starting soon in minutes', () => {
		const snap = snapshot(TODAY, [day(TODAY, [timed('a', 9 * 60 + 45, 10 * 60, 'Bus')], true)]);
		const model = buildSimpleViewModel(snap, 9 * 60 + 30); // 15 min away
		expect(model.nextUp?.relative).toBe('in 15 minutes');
	});

	it('phrases exactly one minute away in the singular', () => {
		const snap = snapshot(TODAY, [day(TODAY, [timed('a', 9 * 60 + 31, 10 * 60, 'Bus')], true)]);
		const model = buildSimpleViewModel(snap, 9 * 60 + 30);
		expect(model.nextUp?.relative).toBe('in 1 minute');
	});

	it('phrases an event a couple hours away in rounded hours', () => {
		const snap = snapshot(TODAY, [day(TODAY, [timed('a', 11 * 60, 12 * 60, 'Lunch')], true)]);
		const model = buildSimpleViewModel(snap, 9 * 60); // 2h away
		expect(model.nextUp?.relative).toBe('in 2 hours');
	});

	it('phrases a currently-ongoing event as "now"', () => {
		const snap = snapshot(TODAY, [day(TODAY, [timed('a', 9 * 60, 10 * 60, 'Class')], true)]);
		const model = buildSimpleViewModel(snap, 9 * 60 + 30); // inside the event
		expect(model.nextUp?.relative).toBe('now');
	});

	it('carries the owning calendar’s color for the color bar', () => {
		const snap = snapshot(TODAY, [
			day(TODAY, [timed('a', 10 * 60, 11 * 60, 'Piano', '#f59e0b')], true)
		]);
		const model = buildSimpleViewModel(snap, 9 * 60);
		expect(model.nextUp?.color).toBe('#f59e0b');
	});

	it('ignores all-day events for "next up" — they are context, not a moment to point at', () => {
		const snap = snapshot(TODAY, [day(TODAY, [allDay('holiday', 'Holiday')], true)]);
		const model = buildSimpleViewModel(snap, 9 * 60);
		expect(model.nextUp).toBeNull();
	});

	it('is null with nothing scheduled today, so the component can show the empty state', () => {
		const model = buildSimpleViewModel(snapshot(TODAY, [day(TODAY, [], true)]), 9 * 60);
		expect(model.nextUp).toBeNull();
		expect(model.restOfToday).toEqual([]);
	});

	it('lists up to four more events after next-up as "rest of today"', () => {
		const events = [
			timed('a', 9 * 60, 9 * 60 + 30, 'One'),
			timed('b', 10 * 60, 10 * 60 + 30, 'Two'),
			timed('c', 11 * 60, 11 * 60 + 30, 'Three'),
			timed('d', 12 * 60, 12 * 60 + 30, 'Four'),
			timed('e', 13 * 60, 13 * 60 + 30, 'Five'),
			timed('f', 14 * 60, 14 * 60 + 30, 'Six')
		];
		const model = buildSimpleViewModel(snapshot(TODAY, [day(TODAY, events, true)]), 8 * 60);
		expect(model.nextUp?.title).toBe('One');
		expect(model.restOfToday.map((r) => r.title)).toEqual(['Two', 'Three', 'Four', 'Five']);
	});

	it('does not resurrect an event that has already ended', () => {
		const events = [
			timed('past', 8 * 60, 8 * 60 + 30, 'Past'),
			timed('now', 9 * 60, 9 * 60 + 30, 'Now')
		];
		const model = buildSimpleViewModel(snapshot(TODAY, [day(TODAY, events, true)]), 9 * 60);
		expect(model.nextUp?.title).toBe('Now');
	});

	it('summarizes tomorrow’s timed events on one compressed line', () => {
		const snap = snapshot(TODAY, [
			day(TODAY, [], true),
			day(TOMORROW, [
				timed('a', 17 * 60, 18 * 60, 'Swimming'),
				timed('b', 18 * 60 + 30, 19 * 60 + 30, 'Piano')
			])
		]);
		const model = buildSimpleViewModel(snap, 9 * 60);
		expect(model.tomorrowLine).toBe('Tomorrow · Swimming 17:00 · Piano 18:30');
	});

	it('omits all-day events from the tomorrow line', () => {
		const snap = snapshot(TODAY, [
			day(TODAY, [], true),
			day(TOMORROW, [allDay('holiday', 'Holiday'), timed('a', 17 * 60, 18 * 60, 'Swimming')])
		]);
		const model = buildSimpleViewModel(snap, 9 * 60);
		expect(model.tomorrowLine).toBe('Tomorrow · Swimming 17:00');
	});

	it('is null when tomorrow has nothing timed scheduled', () => {
		const snap = snapshot(TODAY, [day(TODAY, [], true), day(TOMORROW, [])]);
		const model = buildSimpleViewModel(snap, 9 * 60);
		expect(model.tomorrowLine).toBeNull();
	});

	it('caps the tomorrow line at three events — a real day can have far more than the two in DESIGN.md’s example, which would defeat "compressed"', () => {
		const snap = snapshot(TODAY, [
			day(TODAY, [], true),
			day(TOMORROW, [
				timed('a', 7 * 60 + 30, 8 * 60, 'Work'),
				timed('b', 9 * 60 + 15, 9 * 60 + 45, 'Florence'),
				timed('c', 13 * 60 + 30, 14 * 60, 'Adrianne'),
				timed('d', 17 * 60 + 30, 18 * 60, 'Zoom Juliet'),
				timed('e', 18 * 60 + 30, 19 * 60, 'Dinner')
			])
		]);
		const model = buildSimpleViewModel(snap, 9 * 60);
		expect(model.tomorrowLine).toBe('Tomorrow · Work 07:30 · Florence 09:15 · Adrianne 13:30');
	});

	it('points at the next event later in the week when today and tomorrow are both empty', () => {
		const laterDay = '2026-08-21'; // Friday
		const snap = snapshot(TODAY, [
			day(TODAY, [], true),
			day(TOMORROW, []),
			day(laterDay, [timed('a', 17 * 60, 18 * 60, 'Piano')])
		]);
		const model = buildSimpleViewModel(snap, 9 * 60);
		expect(model.nextLine).toBe('Next: Friday · Piano 17:00');
	});

	it('is null for the next-event fallback when tomorrow already has something', () => {
		const laterDay = '2026-08-21'; // Friday
		const snap = snapshot(TODAY, [
			day(TODAY, [], true),
			day(TOMORROW, [timed('a', 17 * 60, 18 * 60, 'Swimming')]),
			day(laterDay, [timed('b', 17 * 60, 18 * 60, 'Piano')])
		]);
		const model = buildSimpleViewModel(snap, 9 * 60);
		expect(model.nextLine).toBeNull();
	});

	it('is null for the next-event fallback when today still has something upcoming', () => {
		const laterDay = '2026-08-21'; // Friday
		const snap = snapshot(TODAY, [
			day(TODAY, [timed('a', 16 * 60, 17 * 60, 'Class')], true),
			day(TOMORROW, []),
			day(laterDay, [timed('b', 17 * 60, 18 * 60, 'Piano')])
		]);
		const model = buildSimpleViewModel(snap, 9 * 60);
		expect(model.nextLine).toBeNull();
	});

	it('skips all-day events when looking for the next-event fallback', () => {
		const laterDay = '2026-08-21'; // Friday
		const snap = snapshot(TODAY, [
			day(TODAY, [], true),
			day(TOMORROW, [allDay('holiday', 'Holiday')]),
			day(laterDay, [timed('a', 17 * 60, 18 * 60, 'Piano')])
		]);
		const model = buildSimpleViewModel(snap, 9 * 60);
		expect(model.nextLine).toBe('Next: Friday · Piano 17:00');
	});

	it('is null for the next-event fallback when nothing timed remains in the snapshot', () => {
		const snap = snapshot(TODAY, [day(TODAY, [], true), day(TOMORROW, [])]);
		const model = buildSimpleViewModel(snap, 9 * 60);
		expect(model.nextLine).toBeNull();
	});

	describe('timeFormat', () => {
		it('defaults to 24h everywhere a time is rendered', () => {
			const snap = snapshot(TODAY, [
				day(TODAY, [timed('a', 16 * 60, 17 * 60, 'Piano')], true),
				day(TOMORROW, [timed('b', 18 * 60 + 30, 19 * 60, 'Swimming')])
			]);
			const model = buildSimpleViewModel(snap, 9 * 60);
			expect(model.nextUp?.relative).toBe('at 16:00');
			expect(model.tomorrowLine).toBe('Tomorrow · Swimming 18:30');
		});

		it('carries a 12h format into next-up, rest-of-today, the tomorrow line, and the next-event fallback', () => {
			const laterDay = '2026-08-21'; // Friday
			const snap = snapshot(TODAY, [
				day(
					TODAY,
					[timed('a', 16 * 60, 17 * 60, 'Piano'), timed('b', 20 * 60, 21 * 60, 'Late')],
					true
				),
				day(TOMORROW, [timed('c', 18 * 60 + 30, 19 * 60, 'Swimming')])
			]);
			const model = buildSimpleViewModel(snap, 9 * 60, '12h');
			expect(model.nextUp).toMatchObject({ time: '4:00 PM', relative: 'at 4:00 PM' });
			expect(model.restOfToday).toMatchObject([{ time: '8:00 PM' }]);
			expect(model.tomorrowLine).toBe('Tomorrow · Swimming 6:30 PM');

			const nothingScheduled = snapshot(TODAY, [
				day(TODAY, [], true),
				day(TOMORROW, []),
				day(laterDay, [timed('d', 17 * 60, 18 * 60, 'Piano')])
			]);
			const fallbackModel = buildSimpleViewModel(nothingScheduled, 9 * 60, '12h');
			expect(fallbackModel.nextLine).toBe('Next: Friday · Piano 5:00 PM');
		});
	});
});
