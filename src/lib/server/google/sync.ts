// Event sync — DESIGN.md §3.1's two cadences.
//
// Both cadences run through here. The difference is only whether a stored syncToken is
// used: with one, the request is a delta and carries no time bounds (Google rejects
// syncToken alongside timeMin/timeMax with a 400); without one, it is a full windowed
// fetch that re-anchors the rolling window and mints a fresh token.
//
// singleEvents=true means Google returns expanded instances, so recurrence rules,
// per-instance overrides and DST-correct instance times are its problem, not ours.

import { eq, and, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';
import { events, sources } from '../db/schema';
import { googleApiRequest, GoogleApiError } from './api';
import { normalizeEvent, type GoogleEvent, type NormalizedEvent } from './events';
import { localDateInZone } from '$lib/datetime';

type Db = BetterSQLite3Database<typeof schema>;

export interface SyncWindow {
	timeMin: string;
	timeMax: string;
	/** The same bounds as local calendar dates, for comparing against all-day events. */
	localMin: string;
	localMax: string;
}

export interface SyncResult {
	fullSync: boolean;
	upserted: number;
	deleted: number;
	/** Stale rows removed by reconciliation; only ever non-zero on a full sync. */
	pruned: number;
	skipped: number;
}

const MONTHS_BACK = 1;
const MONTHS_FORWARD = 12;

export function buildSyncWindow(now: Date, timeZone: string): SyncWindow {
	const min = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MONTHS_BACK, now.getUTCDate())
	);
	const max = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + MONTHS_FORWARD, now.getUTCDate())
	);

	return {
		timeMin: min.toISOString(),
		timeMax: max.toISOString(),
		localMin: localDateInZone(min, timeZone),
		localMax: localDateInZone(max, timeZone)
	};
}

type WindowCandidate = Pick<NormalizedEvent, 'allDay'> &
	Partial<Pick<NormalizedEvent, 'startsAt' | 'endsAt' | 'localDate' | 'localEndDate'>>;

/**
 * Overlap test, not containment: an event that begins before the window and runs into it
 * belongs on the display. All-day comparison is plain string comparison, which is correct
 * for ISO dates and keeps timezones out of it entirely.
 */
export function isEventInWindow(event: WindowCandidate, window: SyncWindow): boolean {
	if (event.allDay) {
		const start = event.localDate;
		if (!start) return false;
		const end = event.localEndDate ?? start;
		return start <= window.localMax && end >= window.localMin;
	}

	if (!event.startsAt) return false;
	const start = event.startsAt.getTime();
	const end = (event.endsAt ?? event.startsAt).getTime();
	return start <= Date.parse(window.timeMax) && end >= Date.parse(window.timeMin);
}

interface EventsPage {
	items?: GoogleEvent[];
	nextPageToken?: string;
	nextSyncToken?: string;
}

async function fetchAllPages(
	calendarId: string,
	accessToken: string,
	options: { window: SyncWindow; syncToken: string | null; fetchFn?: typeof fetch }
): Promise<{ items: GoogleEvent[]; syncToken: string | undefined }> {
	const items: GoogleEvent[] = [];
	let pageToken: string | undefined;
	let syncToken: string | undefined;

	do {
		const page = await googleApiRequest<EventsPage>(
			`/calendars/${encodeURIComponent(calendarId)}/events`,
			accessToken,
			{
				fetchFn: options.fetchFn,
				searchParams: {
					singleEvents: 'true',
					showDeleted: 'true',
					maxResults: '2500',
					pageToken,
					// Exactly one of these two modes, and syncToken only belongs on the first
					// page — a page-token continuation request already carries the cursor
					// Google needs, and repeating syncToken alongside pageToken is untested
					// territory this avoids rather than risks.
					syncToken: pageToken ? undefined : (options.syncToken ?? undefined),
					timeMin: options.syncToken || pageToken ? undefined : options.window.timeMin,
					timeMax: options.syncToken || pageToken ? undefined : options.window.timeMax
				}
			}
		);

		items.push(...(page.items ?? []));
		pageToken = page.nextPageToken;
		// Only the final page carries it; intermediate pages leave it undefined.
		syncToken = page.nextSyncToken ?? syncToken;
	} while (pageToken);

	return { items, syncToken };
}

export async function syncCalendar(
	db: Db,
	source: { id: number; externalId: string; syncToken: string | null },
	accessToken: string,
	options: { window: SyncWindow; fetchFn?: typeof fetch; forceFull?: boolean }
): Promise<SyncResult> {
	// forceFull is how the nightly re-anchor happens: the stored token is ignored rather
	// than deleted, so if the full sync fails the token is still there for the next
	// incremental poll to fall back on.
	let usingToken = options.forceFull ? null : source.syncToken;
	let page;

	try {
		page = await fetchAllPages(source.externalId, accessToken, {
			window: options.window,
			syncToken: usingToken,
			fetchFn: options.fetchFn
		});
	} catch (err) {
		if (!(err instanceof GoogleApiError && err.isSyncTokenExpired)) throw err;
		// The token aged out. Discard it and re-anchor with a full windowed sync.
		usingToken = null;
		page = await fetchAllPages(source.externalId, accessToken, {
			window: options.window,
			syncToken: null,
			fetchFn: options.fetchFn
		});
	}

	const toUpsert: NormalizedEvent[] = [];
	const toDelete: string[] = [];
	let skipped = 0;

	for (const raw of page.items) {
		const result = normalizeEvent(raw);
		if (result.kind === 'cancelled') {
			toDelete.push(result.id);
		} else if (result.kind === 'skipped') {
			skipped += 1;
		} else if (isEventInWindow(result.event, options.window)) {
			toUpsert.push(result.event);
		} else {
			// Outside the window — an incremental sync can return far-future instances of an
			// edited recurring event. Also delete any copy we already hold, in case an event
			// was moved out of the window rather than deleted.
			toDelete.push(result.event.id);
		}
	}

	// Reconciliation, and only on a full sync. A full response is authoritative for the
	// window, so anything we hold that it did not mention is gone — Google purges deleted
	// events from its tombstones eventually, so an event deleted during an outage may
	// never be reported as cancelled to us at all. It also sweeps up rows the window has
	// slid past, without which the table grows forever.
	//
	// This must never run on an incremental sync: that response mentions only what
	// changed, so absence means "unchanged", and pruning would empty the calendar on the
	// first quiet poll.
	const isFullSync = usingToken === null;
	const pruneIds: string[] = [];

	if (isFullSync) {
		const seen = new Set(page.items.map((item) => item.id));
		const existing = await db
			.select({
				id: events.id,
				allDay: events.allDay,
				startsAt: events.startsAt,
				endsAt: events.endsAt,
				localDate: events.localDate,
				localEndDate: events.localEndDate
			})
			.from(events)
			.where(eq(events.sourceId, source.id));

		for (const row of existing) {
			if (!seen.has(row.id) || !isEventInWindow(row, options.window)) {
				pruneIds.push(row.id);
			}
		}
	}

	// pruneIds and toDelete can legitimately overlap — an item just normalized as
	// out-of-window lands in both if it also fails reconciliation's stale check. One
	// deduped statement instead of two avoids deleting the same row twice.
	const deleteIds = Array.from(new Set([...pruneIds, ...toDelete]));

	// One transaction for the whole sync, per DESIGN.md §3.4 — never a write per event.
	db.transaction((tx) => {
		if (deleteIds.length > 0) {
			tx.delete(events)
				.where(and(eq(events.sourceId, source.id), inArray(events.id, deleteIds)))
				.run();
		}

		for (const event of toUpsert) {
			tx.insert(events)
				.values({
					id: event.id,
					sourceId: source.id,
					title: event.title,
					startsAt: event.startsAt,
					endsAt: event.endsAt,
					localDate: event.localDate,
					localEndDate: event.localEndDate,
					allDay: event.allDay,
					location: event.location,
					status: event.status,
					updatedAt: event.updatedAt
				})
				.onConflictDoUpdate({
					target: events.id,
					set: {
						sourceId: source.id,
						title: event.title,
						startsAt: event.startsAt,
						endsAt: event.endsAt,
						localDate: event.localDate,
						localEndDate: event.localEndDate,
						allDay: event.allDay,
						location: event.location,
						status: event.status,
						updatedAt: event.updatedAt
					}
				})
				.run();
		}

		if (page.syncToken && page.syncToken !== source.syncToken) {
			tx.update(sources).set({ syncToken: page.syncToken }).where(eq(sources.id, source.id)).run();
		}
	});

	return {
		fullSync: isFullSync,
		upserted: toUpsert.length,
		deleted: toDelete.length,
		pruned: pruneIds.length,
		skipped
	};
}
