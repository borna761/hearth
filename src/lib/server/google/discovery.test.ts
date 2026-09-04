import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { connections, sources } from '../db/schema';
import { classifyCalendar, discoverCalendars } from './discovery';
import type { GoogleCalendarListEntry } from './api';

let sqlite: Database.Database;
let db: BetterSQLite3Database<typeof schema>;
const originalKey = process.env.SECRETS_KEY;

beforeEach(() => {
	process.env.SECRETS_KEY = randomBytes(32).toString('hex');
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
});

afterEach(() => {
	sqlite.close();
	process.env.SECRETS_KEY = originalKey;
});

describe('classifyCalendar', () => {
	it('excludes the Todoist calendar entirely — it duplicates the Todoist panel', () => {
		const result = classifyCalendar({ id: 'x', summary: 'Todoist', backgroundColor: '#ffffff' });
		expect(result.enabled).toBe(false);
	});

	it('excludes Weather for Springfield — redundant with Open-Meteo', () => {
		const result = classifyCalendar({
			id: 'x',
			summary: 'Weather for Springfield',
			backgroundColor: '#16a765'
		});
		expect(result.enabled).toBe(false);
	});

	it('groups the four football feeds under one label, but keeps each team’s own colour', () => {
		// Alex's call: he'd rather tell Arsenal from Barcelona at a glance than avoid the
		// real colour collisions below (§4) — grouping is for the settings/visibility matrix
		// (§7.5), which can toggle all four as one row, not for merging their identity.
		for (const [summary, backgroundColor] of [
			['Arsenal', '#ff7537'],
			['Barcelona', '#d06b64'],
			['Inter', '#000000'],
			['Inter Miami CF', '#b99aff']
		]) {
			const result = classifyCalendar({ id: 'x', summary, backgroundColor });
			expect(result.groupLabel).toBe('Football');
			expect(result.color).toBe(backgroundColor);
			expect(result.enabled).toBe(true);
		}
	});

	it('does not dodge the real colour collisions with Holidays in Canada or Visitors', () => {
		// DESIGN.md §4: Barcelona's #d06b64 also belongs to Holidays in Canada, and Inter
		// Miami's #b99aff also belongs to Visitors. Deliberate as of the latest decision —
		// distinct per-team colour matters more than avoiding this collision.
		const barcelona = classifyCalendar({
			id: 'x',
			summary: 'Barcelona',
			backgroundColor: '#d06b64'
		});
		expect(barcelona.color).toBe('#d06b64');
	});

	it('passes ordinary calendars through with their own Google colour, ungrouped', () => {
		const result = classifyCalendar({ id: 'x', summary: 'Family', backgroundColor: '#fbe983' });
		expect(result).toEqual({ enabled: true, color: '#fbe983', groupLabel: null });
	});

	it('is not fooled by a calendar that merely contains a football club’s name', () => {
		// Exact-name matching on purpose: "Arsenal Book Club" is a plausible real calendar
		// and must not be swept into the football group by a substring match.
		const result = classifyCalendar({ id: 'x', summary: 'Arsenal Book Club' });
		expect(result.groupLabel).toBeNull();
	});
});

describe('discoverCalendars', () => {
	async function seedConnection() {
		const [row] = await db
			.insert(connections)
			.values({ provider: 'google', label: 'alex@example.com', secrets: Buffer.from('x') })
			.returning();
		return row.id;
	}

	const CALENDARS: GoogleCalendarListEntry[] = [
		{ id: 'family@group.calendar.google.com', summary: 'Family', backgroundColor: '#fbe983' },
		{ id: 'todoist@group.calendar.google.com', summary: 'Todoist', backgroundColor: '#ffffff' },
		{ id: 'arsenal@import.calendar.google.com', summary: 'Arsenal', backgroundColor: '#ff7537' },
		{ id: 'barca@import.calendar.google.com', summary: 'Barcelona', backgroundColor: '#d06b64' }
	];

	it('writes one source row per discovered calendar', async () => {
		const connectionId = await seedConnection();
		await discoverCalendars(db, connectionId, async () => CALENDARS);

		const rows = await db.select().from(sources).where(eq(sources.connectionId, connectionId));
		expect(rows).toHaveLength(4);
		expect(rows.map((r) => r.externalId).sort()).toEqual(CALENDARS.map((c) => c.id).sort());
	});

	it('applies exclusion and football-grouping rules on first discovery', async () => {
		const connectionId = await seedConnection();
		await discoverCalendars(db, connectionId, async () => CALENDARS);

		const rows = await db.select().from(sources).where(eq(sources.connectionId, connectionId));
		const todoist = rows.find((r) => r.displayName === 'Todoist')!;
		const barcelona = rows.find((r) => r.displayName === 'Barcelona')!;
		const family = rows.find((r) => r.displayName === 'Family')!;

		expect(todoist.enabled).toBe(false);
		expect(barcelona.groupLabel).toBe('Football');
		expect(barcelona.color).toBe('#d06b64'); // its own colour, not overridden
		expect(family.enabled).toBe(true);
		expect(family.groupLabel).toBeNull();
	});

	it('is idempotent — running twice does not duplicate rows', async () => {
		const connectionId = await seedConnection();
		await discoverCalendars(db, connectionId, async () => CALENDARS);
		await discoverCalendars(db, connectionId, async () => CALENDARS);

		const rows = await db.select().from(sources).where(eq(sources.connectionId, connectionId));
		expect(rows).toHaveLength(4);
	});

	it('updates display_name and colour when they change on Google’s side', async () => {
		const connectionId = await seedConnection();
		await discoverCalendars(db, connectionId, async () => CALENDARS);

		const renamed = CALENDARS.map((c) =>
			c.id === 'family@group.calendar.google.com'
				? { ...c, summary: 'The Family Calendar', backgroundColor: '#123456' }
				: c
		);
		await discoverCalendars(db, connectionId, async () => renamed);

		const rows = await db.select().from(sources).where(eq(sources.connectionId, connectionId));
		const family = rows.find((r) => r.externalId === 'family@group.calendar.google.com')!;
		expect(family.displayName).toBe('The Family Calendar');
		expect(family.color).toBe('#123456');
	});

	it('does not resurrect a source a user has manually disabled in settings', async () => {
		// sources.enabled is a manual kill-switch (DESIGN.md §7.5). Re-discovery must not
		// silently re-enable something Alex turned off, or the settings screen becomes
		// untrustworthy — except for the two calendars that are excluded by policy, which
		// is covered by the next test.
		const connectionId = await seedConnection();
		await discoverCalendars(db, connectionId, async () => CALENDARS);

		await db
			.update(sources)
			.set({ enabled: false })
			.where(eq(sources.externalId, 'family@group.calendar.google.com'));

		await discoverCalendars(db, connectionId, async () => CALENDARS);

		const rows = await db.select().from(sources).where(eq(sources.connectionId, connectionId));
		const family = rows.find((r) => r.externalId === 'family@group.calendar.google.com')!;
		expect(family.enabled).toBe(false);
	});

	it('keeps a policy-excluded calendar disabled even if it was manually re-enabled', async () => {
		const connectionId = await seedConnection();
		await discoverCalendars(db, connectionId, async () => CALENDARS);

		await db
			.update(sources)
			.set({ enabled: true })
			.where(eq(sources.externalId, 'todoist@group.calendar.google.com'));

		await discoverCalendars(db, connectionId, async () => CALENDARS);

		const rows = await db.select().from(sources).where(eq(sources.connectionId, connectionId));
		const todoist = rows.find((r) => r.externalId === 'todoist@group.calendar.google.com')!;
		expect(todoist.enabled).toBe(false);
	});

	it('disables a calendar that no longer appears in a fresh listing, instead of leaving it to error forever', async () => {
		const connectionId = await seedConnection();
		await discoverCalendars(db, connectionId, async () => CALENDARS);

		const withoutFamily = CALENDARS.filter((c) => c.id !== 'family@group.calendar.google.com');
		await discoverCalendars(db, connectionId, async () => withoutFamily);

		const rows = await db.select().from(sources).where(eq(sources.connectionId, connectionId));
		expect(rows).toHaveLength(4); // row kept, not deleted — its events aren't cascaded away
		const family = rows.find((r) => r.externalId === 'family@group.calendar.google.com')!;
		expect(family.enabled).toBe(false);
	});

	it('does not auto re-enable a calendar that reappears after having gone missing', async () => {
		const connectionId = await seedConnection();
		const withoutFamily = CALENDARS.filter((c) => c.id !== 'family@group.calendar.google.com');
		await discoverCalendars(db, connectionId, async () => CALENDARS);
		await discoverCalendars(db, connectionId, async () => withoutFamily);
		await discoverCalendars(db, connectionId, async () => CALENDARS); // it's back

		const rows = await db.select().from(sources).where(eq(sources.connectionId, connectionId));
		const family = rows.find((r) => r.externalId === 'family@group.calendar.google.com')!;
		expect(family.enabled).toBe(false);
	});

	it('leaves other connections’ sources alone when reconciling a missing calendar', async () => {
		const connectionId = await seedConnection();
		const [otherConnection] = await db
			.insert(connections)
			.values({ provider: 'todoist', label: 'personal token', secrets: Buffer.from('x') })
			.returning();
		await db.insert(sources).values({
			connectionId: otherConnection.id,
			kind: 'tasks',
			externalId: 'todoist-tasks',
			displayName: 'Todoist tasks',
			enabled: true
		});

		await discoverCalendars(db, connectionId, async () => []); // every calendar "gone"

		const [otherSource] = await db
			.select()
			.from(sources)
			.where(eq(sources.connectionId, otherConnection.id));
		expect(otherSource.enabled).toBe(true);
	});
});
