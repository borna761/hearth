// Per-user calendar visibility — DESIGN.md §4/§7.5's matrix. `sources.enabled` is the
// policy-level kill-switch (Todoist, weather); this is the per-person layer on top of it.

import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema';
import { sources, visibility } from './db/schema';

type Db = BetterSQLite3Database<typeof schema>;

/**
 * A source with no row in `visibility` for this user is visible — the column's own
 * `DEFAULT true`, and DESIGN.md §4 frames the seed matrix as "a seed, not a fixture" that
 * Alex curates later, not something every source needs an explicit row for up front.
 */
export async function getVisibleSourceIds(db: Db, userId: number): Promise<number[]> {
	const rows = await db
		.select({ id: sources.id, visible: visibility.visible })
		.from(sources)
		.leftJoin(visibility, and(eq(visibility.sourceId, sources.id), eq(visibility.userId, userId)))
		.where(eq(sources.enabled, true));

	return rows.filter((row) => row.visible !== false).map((row) => row.id);
}

export interface VisibilityMatrixRow {
	/** `source:<id>` or `group:<label>` — stable identity for one row in the matrix editor. */
	key: string;
	label: string;
	/** One id for an ungrouped source, or every source sharing a group label — DESIGN.md
	 * §4/§7.5's football feeds collapse to one togglable row, not four. */
	sourceIds: number[];
}

/**
 * The settings screen's visibility matrix rows (DESIGN.md §7.5) — one per enabled
 * calendar, grouped sources collapsed to a single row. Non-calendar sources (groceries,
 * tasks) aren't part of this matrix at all.
 */
export async function getVisibilityRows(db: Db): Promise<VisibilityMatrixRow[]> {
	const rows = await db
		.select({ id: sources.id, displayName: sources.displayName, groupLabel: sources.groupLabel })
		.from(sources)
		.where(and(eq(sources.enabled, true), eq(sources.kind, 'calendar')))
		.orderBy(sources.displayName);

	const groups = new Map<string, VisibilityMatrixRow>();
	const result: VisibilityMatrixRow[] = [];

	for (const row of rows) {
		if (row.groupLabel) {
			const existing = groups.get(row.groupLabel);
			if (existing) {
				existing.sourceIds.push(row.id);
			} else {
				const grouped: VisibilityMatrixRow = {
					key: `group:${row.groupLabel}`,
					label: row.groupLabel,
					sourceIds: [row.id]
				};
				groups.set(row.groupLabel, grouped);
				result.push(grouped);
			}
		} else {
			result.push({ key: `source:${row.id}`, label: row.displayName, sourceIds: [row.id] });
		}
	}

	return result;
}

/** Sets one matrix row's visibility for a user — every source id in the row together, so
 * a grouped row (e.g. the four football feeds) always toggles as one unit. */
export async function setVisibilityForRow(
	db: Db,
	userId: number,
	sourceIds: number[],
	visible: boolean
): Promise<void> {
	for (const sourceId of sourceIds) {
		await db
			.insert(visibility)
			.values({ userId, sourceId, visible })
			.onConflictDoUpdate({ target: [visibility.userId, visibility.sourceId], set: { visible } });
	}
}
