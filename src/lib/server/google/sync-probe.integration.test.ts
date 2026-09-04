/**
 * Opt-in probe against the real Google account. Skipped unless HEARTH_PROBE=1:
 *
 *   HEARTH_PROBE=1 npx vitest run src/lib/server/google/sync-probe.integration.test.ts
 *
 * This exists to answer questions the documentation does not settle, so the sync design
 * rests on observed behaviour rather than inference. It reads the local dev database for
 * a token, makes real API calls, and prints a report. It asserts only things that must be
 * true for the design to hold — a failure here is a genuine finding, not a flaky test.
 *
 * The open question (2026-08-22): the docs say timeMin/timeMax cannot accompany a
 * syncToken, but say nothing about whether singleEvents=true can produce a syncToken at
 * all. If it can, Google does recurrence expansion for us — EXDATE, RECURRENCE-ID
 * overrides, DST-correct instance times — which is the single largest correctness win
 * available in this phase.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and } from 'drizzle-orm';
import * as schema from '../db/schema';
import { sources, events } from '../db/schema';
import { getValidAccessToken } from './tokens';
import { googleApiRequest, GoogleApiError, listGoogleCalendars } from './api';
import { discoverCalendars } from './discovery';
import { buildSyncWindow, syncCalendar } from './sync';
import { getConnection } from '../connections';
import type { GoogleOAuthConfig } from './oauth';

const RUN = process.env.HEARTH_PROBE === '1';

function openDb() {
	const path = process.env.DATABASE_URL ?? 'local.db';
	return drizzle(new Database(path), { schema });
}

function config(): GoogleOAuthConfig {
	return {
		clientId: process.env.GOOGLE_CLIENT_ID!,
		clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
		redirectUri: process.env.GOOGLE_REDIRECT_URI!
	};
}

interface EventsPage {
	items?: { id: string; summary?: string; recurringEventId?: string }[];
	nextPageToken?: string;
	nextSyncToken?: string;
}

const WINDOW = {
	timeMin: new Date(Date.now() - 30 * 864e5).toISOString(),
	timeMax: new Date(Date.now() + 365 * 864e5).toISOString()
};

describe.skipIf(!RUN)('google sync semantics (live)', () => {
	it('lists the account’s calendars with colours', async () => {
		const token = await getValidAccessToken(openDb(), config());
		const list = await googleApiRequest<{
			items: {
				id: string;
				summary: string;
				backgroundColor?: string;
				primary?: boolean;
				timeZone?: string;
			}[];
		}>('/users/me/calendarList', token);

		console.log(`\n=== ${list.items.length} calendars ===`);
		for (const cal of list.items) {
			console.log(
				`  ${(cal.backgroundColor ?? '-------').padEnd(8)} ${(cal.timeZone ?? '?').padEnd(20)} ${cal.summary}`
			);
		}
		// DESIGN.md §4 expects fifteen; if this drifts the visibility matrix needs revisiting.
		expect(list.items.length).toBeGreaterThan(0);
	});

	it('discovers calendars into `sources` for real, applying exclusions and grouping', async () => {
		const db = openDb();
		const token = await getValidAccessToken(db, config());
		const connection = await getConnection(db, 'google');
		if (!connection) throw new Error('no google connection in local.db');

		await discoverCalendars(db, connection.id, () => listGoogleCalendars(token));

		const rows = await db.select().from(sources).where(eq(sources.connectionId, connection.id));
		console.log(`\n=== discovered ${rows.length} sources ===`);
		for (const row of rows) {
			const flags = [row.enabled ? 'enabled ' : 'DISABLED', row.groupLabel ?? ''].join(' ');
			console.log(`  ${(row.color ?? '-------').padEnd(8)} ${flags.padEnd(18)} ${row.displayName}`);
		}

		const todoist = rows.find((r) => r.displayName === 'Todoist');
		const weather = rows.find((r) => r.displayName === 'Weather for Springfield');
		const football = rows.filter((r) => r.groupLabel === 'Football');

		expect(todoist?.enabled).toBe(false);
		expect(weather?.enabled).toBe(false);
		expect(football.length).toBe(4);
		// Grouped for visibility purposes only — each team keeps its own Google colour now,
		// including the two that collide with Holidays in Canada and Visitors.
		expect(new Set(football.map((r) => r.color)).size).toBeGreaterThan(1);
	});

	it('syncs every enabled calendar and lands all-day events on the right dates', async () => {
		const db = openDb();
		const token = await getValidAccessToken(db, config());
		const connection = await getConnection(db, 'google');
		if (!connection) throw new Error('no google connection in local.db');

		await discoverCalendars(db, connection.id, () => listGoogleCalendars(token));
		const window = buildSyncWindow(new Date(), 'America/Toronto');
		console.log(`\n=== window ${window.localMin} .. ${window.localMax} ===`);

		// Force the full-sync path on every run, so this exercises reconciliation rather
		// than short-circuiting into a no-op incremental once tokens are stored. On a
		// re-run the database already matches Google, so a correct reconciliation must
		// prune nothing — that is the assertion that would catch over-deletion.
		await db.update(sources).set({ syncToken: null });

		const enabled = await db
			.select()
			.from(sources)
			.where(and(eq(sources.connectionId, connection.id), eq(sources.enabled, true)));

		const rowsBefore = (await db.select().from(events)).length;

		let total = 0;
		let totalPruned = 0;
		for (const source of enabled) {
			const result = await syncCalendar(db, source, token, { window });
			total += result.upserted;
			totalPruned += result.pruned;
			console.log(
				`  ${String(result.upserted).padStart(4)} events  ${result.fullSync ? 'full' : 'incr'}  ` +
					`${result.pruned ? `pruned ${result.pruned} ` : ''}` +
					`${result.skipped ? `(${result.skipped} skipped) ` : ''}${source.displayName}`
			);
		}
		console.log(`  total pruned: ${totalPruned} (rows before: ${rowsBefore})`);

		// The real check: all-day events must sit on the date a human would name, with no
		// epoch anywhere. Canada Day and Christmas are the unambiguous fixtures — if the
		// midnight-UTC bug were present these would read as 06-30 and 12-24.
		const allDay = await db.select().from(events).where(eq(events.allDay, true));
		console.log(`\n=== ${allDay.length} all-day events; known fixtures ===`);
		for (const name of ['Canada Day', 'Christmas Day', "New Year's Day"]) {
			const match = allDay.find((e) => e.title.includes(name));
			if (match) {
				console.log(
					`  ${match.localDate} .. ${match.localEndDate}  ${match.title}  (epoch: ${match.startsAt ?? 'null'})`
				);
			}
		}

		const multiDay = allDay.filter((e) => e.localEndDate && e.localEndDate !== e.localDate);
		console.log(`\n=== ${multiDay.length} multi-day all-day events ===`);
		for (const e of multiDay.slice(0, 8)) {
			console.log(`  ${e.localDate} .. ${e.localEndDate}  ${e.title}`);
		}

		expect(total).toBeGreaterThan(0);
		// Reconciliation must be a no-op when the database already agrees with Google. A
		// non-zero count here on a repeat run would mean the full sync is deleting live
		// events and re-inserting them, which would churn the SD card nightly (§3.4).
		if (rowsBefore > 0) expect(totalPruned).toBe(0);
		// No all-day event may carry an epoch — that is the §4.1 bug, structurally excluded.
		expect(allDay.every((e) => e.startsAt === null)).toBe(true);
		expect(allDay.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.localDate ?? ''))).toBe(true);

		const canadaDay = allDay.find((e) => e.title.includes('Canada Day'));
		if (canadaDay) expect(canadaDay.localDate?.slice(5)).toBe('07-01');
		const christmas = allDay.find((e) => e.title === 'Christmas Day');
		if (christmas) expect(christmas.localDate?.slice(5)).toBe('12-25');
	}, 60_000);

	it('a second sync of the same calendar goes incremental and is a no-op', async () => {
		const db = openDb();
		const token = await getValidAccessToken(db, config());
		const connection = await getConnection(db, 'google');
		if (!connection) throw new Error('no google connection in local.db');

		const window = buildSyncWindow(new Date(), 'America/Toronto');
		const [source] = await db
			.select()
			.from(sources)
			.where(and(eq(sources.connectionId, connection.id), eq(sources.displayName, 'Alex')));
		if (!source) throw new Error('no Alex calendar');

		const before = await db.select().from(events).where(eq(events.sourceId, source.id));
		const result = await syncCalendar(db, source, token, { window });
		const after = await db.select().from(events).where(eq(events.sourceId, source.id));

		console.log(`\n=== re-sync of "${source.displayName}" ===`);
		console.log(`  mode: ${result.fullSync ? 'full' : 'incremental'}`);
		console.log(`  upserted ${result.upserted}, deleted ${result.deleted}`);
		console.log(`  rows before ${before.length}, after ${after.length}`);

		// Nothing changed on Google's side between the two runs, so an incremental sync
		// should return no work at all — that is what makes the 5-minute cadence cheap.
		expect(result.fullSync).toBe(false);
		expect(after.length).toBe(before.length);
	});

	it('THE QUESTION: does singleEvents=true still yield a nextSyncToken?', async () => {
		const token = await getValidAccessToken(openDb(), config());

		let pageToken: string | undefined;
		let pages = 0;
		let events = 0;
		let syncToken: string | undefined;

		// nextSyncToken only appears on the LAST page — the most likely explanation for
		// reports that singleEvents=true "returns no sync token" is not paginating to the end.
		do {
			const page: EventsPage = await googleApiRequest<EventsPage>(
				'/calendars/primary/events',
				token,
				{
					searchParams: {
						singleEvents: 'true',
						maxResults: '2500',
						showDeleted: 'true',
						timeMin: pageToken ? undefined : WINDOW.timeMin,
						timeMax: pageToken ? undefined : WINDOW.timeMax,
						pageToken
					}
				}
			);
			pages += 1;
			events += page.items?.length ?? 0;
			pageToken = page.nextPageToken;
			syncToken = page.nextSyncToken;
		} while (pageToken);

		console.log(`\n=== initial windowed sync (singleEvents=true) ===`);
		console.log(`  pages: ${pages}, events: ${events}`);
		console.log(`  nextSyncToken: ${syncToken ? 'YES — ' + syncToken.slice(0, 24) + '…' : 'NO'}`);

		expect(events).toBeGreaterThanOrEqual(0);
		if (!syncToken) {
			console.log('  >>> FALLBACK REQUIRED: full windowed poll with local diffing.');
		}
	});

	it('follow-up: an incremental call with that syncToken succeeds', async () => {
		const token = await getValidAccessToken(openDb(), config());

		let pageToken: string | undefined;
		let syncToken: string | undefined;
		do {
			const page: EventsPage = await googleApiRequest<EventsPage>(
				'/calendars/primary/events',
				token,
				{
					searchParams: {
						singleEvents: 'true',
						maxResults: '2500',
						showDeleted: 'true',
						timeMin: pageToken ? undefined : WINDOW.timeMin,
						timeMax: pageToken ? undefined : WINDOW.timeMax,
						pageToken
					}
				}
			);
			pageToken = page.nextPageToken;
			syncToken = page.nextSyncToken;
		} while (pageToken);

		if (!syncToken) {
			console.log('\n=== incremental: skipped, no sync token to test with ===');
			expect(syncToken).toBeUndefined();
			return;
		}

		const incremental = await googleApiRequest<EventsPage>('/calendars/primary/events', token, {
			searchParams: { singleEvents: 'true', showDeleted: 'true', syncToken }
		});

		console.log(`\n=== incremental sync with syncToken ===`);
		console.log(`  changed events since initial sync: ${incremental.items?.length ?? 0}`);
		console.log(`  fresh nextSyncToken: ${incremental.nextSyncToken ? 'YES' : 'NO'}`);
		expect(incremental.items).toBeDefined();
	});

	it('confirms timeMin alongside syncToken is rejected', async () => {
		// Validates the constraint the whole design rests on, rather than trusting the docs.
		const token = await getValidAccessToken(openDb(), config());

		let pageToken: string | undefined;
		let syncToken: string | undefined;
		do {
			const page: EventsPage = await googleApiRequest<EventsPage>(
				'/calendars/primary/events',
				token,
				{
					searchParams: {
						singleEvents: 'true',
						maxResults: '2500',
						showDeleted: 'true',
						timeMin: pageToken ? undefined : WINDOW.timeMin,
						timeMax: pageToken ? undefined : WINDOW.timeMax,
						pageToken
					}
				}
			);
			pageToken = page.nextPageToken;
			syncToken = page.nextSyncToken;
		} while (pageToken);

		if (!syncToken) {
			expect(syncToken).toBeUndefined();
			return;
		}

		let caught: GoogleApiError | undefined;
		try {
			await googleApiRequest('/calendars/primary/events', token, {
				searchParams: { singleEvents: 'true', syncToken, timeMin: WINDOW.timeMin }
			});
		} catch (e) {
			caught = e as GoogleApiError;
		}

		console.log(`\n=== syncToken + timeMin ===`);
		console.log(`  status: ${caught?.status ?? 'accepted (!)'} — ${caught?.message ?? ''}`);
		expect(caught?.status).toBe(400);
	});
});
