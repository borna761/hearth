// Calendar discovery — DESIGN.md §4. Writes the account's calendars into `sources`,
// applying the two exclusions and the football grouping.
//
// This is app policy specific to Alex's account, not something derivable from Google's
// API — there is no generic signal for "this is a Todoist-sync calendar" or "this is a
// football fixtures feed". §4 treats the matrix as "a seed, not a fixture" precisely
// because it is hardcoded here rather than discovered.

import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';
import { sources } from '../db/schema';
import type { GoogleCalendarListEntry } from './api';

type Db = BetterSQLite3Database<typeof schema>;

const EXCLUDED_CALENDAR_NAMES = new Set(['Todoist', 'Weather for Springfield']);
const FOOTBALL_CALENDAR_NAMES = new Set(['Arsenal', 'Barcelona', 'Inter', 'Inter Miami CF']);

export interface CalendarClassification {
	enabled: boolean;
	color: string | null;
	groupLabel: string | null;
}

export function classifyCalendar(calendar: GoogleCalendarListEntry): CalendarClassification {
	if (EXCLUDED_CALENDAR_NAMES.has(calendar.summary)) {
		return { enabled: false, color: calendar.backgroundColor ?? null, groupLabel: null };
	}
	if (FOOTBALL_CALENDAR_NAMES.has(calendar.summary)) {
		// Grouped for the settings/visibility matrix (§7.5) — toggling "Football" there
		// should flip all four calendars as one row — but each keeps its own Google colour.
		// Two of the four do collide for real (Barcelona's #d06b64 also belongs to Holidays
		// in Canada; Inter Miami's #b99aff also belongs to Visitors), and Alex's call is
		// that telling the teams apart at a glance matters more than dodging that.
		return { enabled: true, color: calendar.backgroundColor ?? null, groupLabel: 'Football' };
	}
	return { enabled: true, color: calendar.backgroundColor ?? null, groupLabel: null };
}

type ListCalendars = () => Promise<GoogleCalendarListEntry[]>;

export async function discoverCalendars(
	db: Db,
	connectionId: number,
	listCalendars: ListCalendars
): Promise<void> {
	const calendars = await listCalendars();

	for (const calendar of calendars) {
		const classification = classifyCalendar(calendar);

		const [existing] = await db
			.select({ id: sources.id, enabled: sources.enabled })
			.from(sources)
			.where(and(eq(sources.connectionId, connectionId), eq(sources.externalId, calendar.id)))
			.limit(1);

		// A policy exclusion (Todoist, the weather import) is re-asserted on every run —
		// it is not a user preference to respect. Everything else keeps whatever `enabled`
		// is already stored, since that is the manual kill-switch DESIGN.md §7.5 gives
		// Alex in settings, and Google has no opinion on it at all.
		const enabled = classification.enabled === false ? false : (existing?.enabled ?? true);

		if (existing) {
			await db
				.update(sources)
				.set({
					displayName: calendar.summary,
					color: classification.color,
					groupLabel: classification.groupLabel,
					enabled
				})
				.where(eq(sources.id, existing.id));
		} else {
			await db.insert(sources).values({
				connectionId,
				kind: 'calendar',
				externalId: calendar.id,
				displayName: calendar.summary,
				color: classification.color,
				groupLabel: classification.groupLabel,
				enabled
			});
		}
	}

	// A calendar Google no longer reports (deleted from the account, or access revoked)
	// stays in `sources` rather than being deleted outright — deleting the row would
	// cascade-delete its events (onDelete: 'cascade') and throw away the household's
	// history for nothing. Disabled instead, via the same `enabled` flag the sync loop
	// (runSyncCycle) and the visibility matrix already respect, so it just stops being
	// synced/shown instead of erroring on every single cycle forever (previously: a
	// deleted calendar's every-5-minutes 404 permanently overwrote the whole connection's
	// `last_error`, with no way for it to ever clear on its own).
	//
	// Deliberately one-directional: a calendar reappearing later does not auto re-enable
	// here. There's currently no way to tell "disabled because it vanished" apart from a
	// deliberate manual disable (no UI toggle exists for that yet, but this shouldn't
	// assume one never will) — auto re-enabling would risk silently overriding an
	// intentional choice once one does.
	const currentExternalIds = new Set(calendars.map((c) => c.id));
	const knownCalendarSources = await db
		.select({ id: sources.id, externalId: sources.externalId })
		.from(sources)
		.where(and(eq(sources.connectionId, connectionId), eq(sources.kind, 'calendar')));

	for (const source of knownCalendarSources) {
		if (!currentExternalIds.has(source.externalId)) {
			await db.update(sources).set({ enabled: false }).where(eq(sources.id, source.id));
		}
	}
}
