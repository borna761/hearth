// Resolves "My Grocery List" to a `sources` row, once. Mirrors google/discovery.ts's
// shape for the same reason: which list the household means is app policy, not something
// the library has an opinion on, and DESIGN.md §2.5 is explicit that everything after this
// first resolution must match on the stored id, never the display name someone could
// rename from their phone.

import { eq, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../db/schema';
import { sources } from '../db/schema';
import type { AnyListClient } from './client';

type Db = BetterSQLite3Database<typeof schema>;

/** DESIGN.md §2.5: "The household list is 'My Grocery List'." */
export const GROCERY_LIST_NAME = 'My Grocery List';

/**
 * Idempotent: a `sources` row for this connection's groceries, once one exists, is never
 * re-resolved by name — this returns its id without calling AnyList at all. Only the very
 * first run (or a fresh connection after a reconnect) needs findListByName.
 */
export async function resolveGroceryList(
	db: Db,
	connectionId: number,
	client: Pick<AnyListClient, 'findListByName'>
): Promise<number> {
	const [existing] = await db
		.select({ id: sources.id })
		.from(sources)
		.where(and(eq(sources.connectionId, connectionId), eq(sources.kind, 'groceries')))
		.limit(1);
	if (existing) return existing.id;

	const list = client.findListByName(GROCERY_LIST_NAME);
	if (!list) {
		throw new Error(
			`AnyList: no list named "${GROCERY_LIST_NAME}" on this account — DESIGN.md §2.5 ` +
				'assumes this exact name.'
		);
	}

	const [row] = await db
		.insert(sources)
		.values({
			connectionId,
			kind: 'groceries',
			externalId: list.id,
			displayName: list.name
		})
		.returning({ id: sources.id });
	return row.id;
}
