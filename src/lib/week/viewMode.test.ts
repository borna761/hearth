import { describe, it, expect } from 'vitest';
import { applyWeekViewChange, resolveWeekViewOnLogin, type WeekViewUser } from './viewMode';

describe('resolveWeekViewOnLogin', () => {
	it("returns the user's stored week view", () => {
		const users: WeekViewUser[] = [
			{ id: 1, weekView: 'grid' },
			{ id: 2, weekView: 'agenda' }
		];
		expect(resolveWeekViewOnLogin(users, 1)).toBe('grid');
		expect(resolveWeekViewOnLogin(users, 2)).toBe('agenda');
	});

	it('defaults to agenda for a user id not in the list', () => {
		expect(resolveWeekViewOnLogin([], 1)).toBe('agenda');
	});
});

describe('applyWeekViewChange', () => {
	it("patches the matching user's entry in place", () => {
		const users: WeekViewUser[] = [{ id: 1, weekView: 'agenda' }];
		applyWeekViewChange(users, 1, 'grid');
		expect(users[0].weekView).toBe('grid');
	});

	it('only touches the targeted user', () => {
		const users: WeekViewUser[] = [
			{ id: 1, weekView: 'agenda' },
			{ id: 2, weekView: 'agenda' }
		];
		applyWeekViewChange(users, 1, 'grid');
		expect(users[1].weekView).toBe('agenda');
	});

	it('is a no-op for a user id not in the list', () => {
		const users: WeekViewUser[] = [{ id: 1, weekView: 'agenda' }];
		expect(() => applyWeekViewChange(users, 999, 'grid')).not.toThrow();
		expect(users[0].weekView).toBe('agenda');
	});

	it(
		'a toggle followed by a later login resolves to the new value, not the stale one — ' +
			'the exact bug this pair of functions replaced (a live session logging out and back ' +
			'in read a snapshot of users taken once at initial page load, silently reverting ' +
			"whatever the previous login session had just toggled, since that snapshot's only " +
			'other writer was a full page reload)',
		() => {
			const users: WeekViewUser[] = [{ id: 1, weekView: 'agenda' }];

			applyWeekViewChange(users, 1, 'grid');

			expect(resolveWeekViewOnLogin(users, 1)).toBe('grid');
		}
	);
});
