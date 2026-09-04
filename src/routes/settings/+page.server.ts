import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { listPublicUsers } from '$lib/server/users';
import { listConnections } from '$lib/server/connections';
import { getVisibilityRows, getVisibleSourceIds } from '$lib/server/visibility';
import { listTodoistProjectOptions } from '$lib/server/todoist/projects';
import { listMusicSpeakers } from '$lib/server/musicLibrary';
import {
	getQuietHours,
	formatQuietHours,
	getMusicHours,
	formatMusicHours,
	getThemeMode,
	getTimeFormat,
	getHouseholdLocation,
	formatHouseholdLocation,
	getHouseholdTimeZone,
	getRestrictedTaskProjectId
} from '$lib/server/settings';

export const load: PageServerLoad = async ({ locals }) => {
	// Distinguishes "never logged in" from "logged in, but this account isn't an admin" —
	// without this, a non-admin who enters a correct PIN would just see the exact same
	// login picker reappear, indistinguishable from their PIN having been rejected.
	if (locals.session && !locals.session.isAdmin) {
		return { authorized: false as const, reason: 'not-admin' as const };
	}

	if (!locals.session?.isAdmin) {
		const users = await listPublicUsers(db);
		return {
			authorized: false as const,
			reason: 'not-logged-in' as const,
			// Only admins can do anything here — showing a non-admin avatar just to have
			// them hit "not authorized" after a correct PIN would be a pointless dead end.
			adminUsers: users.filter((u) => u.isAdmin)
		};
	}

	const [
		users,
		rows,
		connections,
		quietHours,
		musicHours,
		themeMode,
		timeFormat,
		location,
		timeZone,
		taskProjects,
		restrictedTaskProjectId,
		musicSpeakers
	] = await Promise.all([
		listPublicUsers(db),
		getVisibilityRows(db),
		listConnections(db),
		getQuietHours(db),
		getMusicHours(db),
		getThemeMode(db),
		getTimeFormat(db),
		getHouseholdLocation(db),
		getHouseholdTimeZone(db),
		listTodoistProjectOptions(db),
		getRestrictedTaskProjectId(db),
		listMusicSpeakers(db)
	]);

	const visibleByUser = new Map<number, Set<number>>();
	for (const user of users) {
		visibleByUser.set(user.id, new Set(await getVisibleSourceIds(db, user.id)));
	}

	// { [rowKey]: { [userId]: checked } } — checked only if every source id in the row is
	// visible to that user, so a grouped row (the four football feeds) reads as one toggle.
	const checked: Record<string, Record<number, boolean>> = {};
	for (const row of rows) {
		checked[row.key] = {};
		for (const user of users) {
			const visible = visibleByUser.get(user.id)!;
			checked[row.key][user.id] = row.sourceIds.every((id) => visible.has(id));
		}
	}

	return {
		authorized: true as const,
		users,
		rows,
		checked,
		connections,
		quietHoursValue: formatQuietHours(quietHours),
		musicHoursValue: musicHours ? formatMusicHours(musicHours) : '',
		themeMode,
		timeFormat,
		locationValue: formatHouseholdLocation(location),
		timeZone,
		// Node's own ICU data — every IANA zone name it recognizes, for the settings
		// dropdown. Sync and cheap; no need to round-trip through the db for this.
		timeZoneOptions: Intl.supportedValuesOf('timeZone'),
		taskProjects,
		restrictedTaskProjectId,
		musicSpeakers
	};
};
