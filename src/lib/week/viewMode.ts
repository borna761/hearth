// Which layout the week view renders in — agenda list or hour grid.
//
// Per-user (users.weekView), not client-side/localStorage: several people share the one
// tablet, and DESIGN.md's "the server owns decisions" (§5.3) applies here the same as
// everywhere else once it's tied to who's actually logged in, rather than which device
// happens to be asking.

export type ViewMode = 'agenda' | 'grid';

export interface WeekViewUser {
	id: number;
	weekView: ViewMode;
}

/** What the toggle should show right after logging in as `userId`. */
export function resolveWeekViewOnLogin(users: WeekViewUser[], userId: number): ViewMode {
	return users.find((u) => u.id === userId)?.weekView ?? 'agenda';
}

/**
 * Patches `userId`'s entry in `users` after a successful toggle save, in place.
 *
 * Without this, a later resolveWeekViewOnLogin call within the same page session (this
 * one stays open for hours — DESIGN.md §9.1's nightly reload is the only one) reads the
 * snapshot `users` held at initial page load, silently reverting whatever was just saved
 * the next time someone logs back in. `users` is treated as session-lifetime state here,
 * the same way the settings page's own visibility toggle already mutates its loaded data
 * in place rather than re-fetching.
 */
export function applyWeekViewChange(users: WeekViewUser[], userId: number, next: ViewMode): void {
	const user = users.find((u) => u.id === userId);
	if (user) user.weekView = next;
}
