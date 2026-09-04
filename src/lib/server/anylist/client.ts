// The entire `anylist` npm library surface lives behind this file — DESIGN.md §2.5's
// "strict adapter boundary". Nothing outside src/lib/server/anylist imports `anylist`
// directly, and no `AnyListItem`/`AnyListList` instance from the library escapes this
// module; every exported method here takes and returns this file's own domain types.
//
// docs/phase-5-plan.md §2.1: AnyList's push channel (`lists-update`) is not durable — the
// library's websocket gives up after two failed reconnects with no revival path, so a
// single connectivity blip can silently end push for the rest of the process's life.
// `onListsUpdate` below is therefore an optimisation the caller (M2) layers a
// reconcile-poll on top of, never the sole source of truth.
//
// A note on `npm audit`: installing this package flags protobufjs (a transitive
// dependency, pinned to the ancient 5.0.3 legacy Builder API) as a critical CVE
// (GHSA-xq3m-2v4x-88gg, and several related advisories). Read past the severity label —
// every one of them requires the *schema itself* to be attacker-controlled ("applications
// that only decode messages using trusted, application-defined schemas are not directly
// affected", per the advisory). `anylist` loads its protobuf schema from a static
// `definitions.json` bundled in the npm package, never from AnyList's server or from any
// input this app controls, so there is no reachable path for a server response to hit the
// vulnerable schema-loading code. Re-check this reasoning if `anylist` is ever upgraded to
// a version using a newer protobufjs, since the modern reflection API's behaviour differs
// from 5.x's.

import AnyListLib from 'anylist';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';

export interface AnyListCredentials {
	email: string;
	password: string;
}

export interface AnyListItem {
	/** AnyList's own item identifier. See generateItemId below for why callers can (and
	 *  for new items, should) supply this rather than let AnyList assign one. */
	id: string;
	name: string;
	quantity: string | null;
	checked: boolean;
	/** e.g. "Produce", "Dairy" — resolved from the account's own category list via an
	 *  undocumented internal on the library (see anylist-lib.d.ts's `_userData` comment for
	 *  the full reasoning). `null` when the item has no category assigned, or — more
	 *  defensively — whenever that internal shape doesn't match what's expected. */
	category: string | null;
}

export interface AnyListGroceryList {
	/** AnyList's own list identifier — stored as sources.external_id and matched on
	 *  thereafter, never the display name (DESIGN.md §2.5: someone could rename it from
	 *  their phone). */
	id: string;
	name: string;
	items: AnyListItem[];
}

export interface AnyListClientError extends Error {
	name: 'AnyListClientError';
}

function clientError(message: string): AnyListClientError {
	const err = new Error(message) as AnyListClientError;
	err.name = 'AnyListClientError';
	return err;
}

/**
 * The library's own item-identifier format (lib/uuid.js: `uuidv4().replace(/-/g, '')`,
 * i.e. 32 lowercase hex characters, no dashes). Matching it exactly lets a caller generate
 * an id at enqueue time and hand it to AnyList, rather than adding a row with a temporary
 * id and rewriting it once a write lands — see docs/phase-5-plan.md §3.
 */
export function generateItemId(): string {
	return randomUUID().replace(/-/g, '');
}

const DEFAULT_CREDENTIALS_FILE = '/var/lib/hearth/anylist-credentials';

/**
 * docs/phase-5-plan.md §2.3: the library's own default (`~/.anylist_credentials`) is wrong
 * under systemd running as the `hearth` user, and fails at *write* time — after a
 * successful login — which looks like an auth problem rather than a filesystem one.
 * Deliberately never `null`: that disables the library's on-disk persistence entirely and
 * forces a full email+password round trip on every process start, which invites
 * rate-limiting or an account lock on a Pi that restarts on every deploy.
 */
function credentialsFile(): string {
	return env.HEARTH_ANYLIST_CREDENTIALS_FILE || DEFAULT_CREDENTIALS_FILE;
}

const KNOWN_LIBRARY_LOG_PREFIXES = [
	'Connected to websocket',
	'Refreshing shopping lists',
	'No saved tokens found',
	'No saved clientId found',
	'Credentials file does not exist',
	'Failed to refresh access token',
	'Disconnected from websocket'
];

let logsSilenced = false;

/**
 * docs/phase-5-plan.md §6: the library logs straight to console.info/console.error,
 * including "Refreshing shopping lists" on every push event — real journald volume on a
 * display that runs for weeks. Filters only the library's own known messages by exact
 * prefix; every other call — this app's own logging, any other module's — passes through
 * untouched. A temporary monkeypatch-and-restore around one call couldn't guarantee that,
 * since other async work can log concurrently while this module awaits a network call.
 */
function silenceKnownLibraryLogs(): void {
	if (logsSilenced) return;
	logsSilenced = true;

	for (const method of ['info', 'error'] as const) {
		const original = console[method].bind(console);
		console[method] = (...args: unknown[]) => {
			const [first] = args;
			if (
				typeof first === 'string' &&
				KNOWN_LIBRARY_LOG_PREFIXES.some((prefix) => first.startsWith(prefix))
			) {
				return;
			}
			original(...args);
		};
	}
}

export interface AnyListClient {
	/**
	 * Resolves a list by its display name. Only ever meant to be called once, when no
	 * `sources` row exists yet to resolve by id instead — see resolve.ts. Returns `null`
	 * rather than throwing when no such list exists, since "the account has no list with
	 * this name" is a configuration problem for the caller to report, not a client error.
	 */
	findListByName(name: string): AnyListGroceryList | null;
	/** Everywhere after the first resolution, callers fetch by the id stored in
	 *  `sources.external_id` — never by name again. Throws if the id is no longer valid
	 *  (the list was deleted, or the account's lists haven't loaded yet). Reads from
	 *  whatever this client already has in memory — it does not itself touch the network.
	 *  A push event refreshes that automatically; a poll must call `refresh()` first. */
	fetchItems(listId: string): AnyListGroceryList;
	/**
	 * Forces a real network fetch of every list, updating what `fetchItems` and
	 * `findListByName` read from afterwards. docs/phase-5-plan.md §2.1: this is what a
	 * 15-minute reconcile poll calls before `fetchItems` — the actual freshness guarantee,
	 * independent of whether AnyList's push channel is still alive. A push handler should
	 * *not* call this too: the library has already refreshed its own cache by the time
	 * `onListsUpdate`'s callback fires, and refreshing again would be a redundant network
	 * round trip on every single item someone adds.
	 */
	refresh(): Promise<void>;
	/**
	 * docs/phase-5-plan.md §2.4: AnyList keeps checked-off items on the list, and its own
	 * README says the official clients reuse one rather than adding a duplicate. This
	 * looks up an existing item by name first; if found, it un-checks and updates that
	 * item instead of creating a new one. The returned item's `id` is therefore not
	 * guaranteed to equal `item.id` — a caller that generated an id up front (§3) must use
	 * the id on the returned item from here on, not the one it requested.
	 */
	addItem(
		listId: string,
		item: { id: string; name: string; quantity?: string | null }
	): Promise<AnyListItem>;
	/** A no-op, not an error, if the item is already gone — matching removeItem's own
	 *  contract below, and for the same reason. Originally threw here; corrected during
	 *  code review of docs/phase-5-plan.md M3 (2026-08-25) after a real failure mode
	 *  surfaced: a pending check/uncheck for an item someone deleted from their phone
	 *  before the drain ran would fail every cycle forever, and the caller (drainPendingWrites)
	 *  has no way to distinguish "AnyList is unreachable" from "there's nothing to check" —
	 *  both looked like a connection failure and flapped the whole account's status to
	 *  'error' for a one-item conflict that isn't actually an outage. */
	setChecked(listId: string, itemId: string, checked: boolean): Promise<void>;
	/** A no-op, not an error, if the item is already gone — removing something already
	 *  removed is the outcome the caller wanted either way. */
	removeItem(listId: string, itemId: string): Promise<void>;
	/** Fires with the caller's own domain type on every `lists-update` push. Per §2.1,
	 *  treat this as best-effort — it can go silent for the rest of the process's life
	 *  after a connectivity blip, which is why a reconcile poll exists alongside it. */
	onListsUpdate(callback: (lists: AnyListGroceryList[]) => void): void;
	teardown(): void;
}

/** The real library's constructor type, exported so tests can type a fake against it
 *  without reaching for an awkward inline extraction from ConnectAnyListOptions. */
export type AnyListConstructor = typeof AnyListLib;

export interface ConnectAnyListOptions {
	/**
	 * Injected in tests: a fake matching the surface this file actually calls, so
	 * addItem's reuse-existing-item behaviour and the rest of this adapter are verifiable
	 * without a network call — the same seam google/discovery.ts uses for `listCalendars`.
	 * Defaults to the real library.
	 */
	AnyListCtor?: AnyListConstructor;
}

function toDomainItem(
	item: {
		identifier: string;
		name: string;
		quantity: string | undefined;
		checked: boolean;
		categoryMatchId: string | undefined;
	},
	categoryNameFor: (categoryMatchId: string | undefined) => string | null
): AnyListItem {
	return {
		id: item.identifier,
		name: item.name,
		// `||`, not `??`: a cleared quantity (addItem's reuse path sets '' rather than
		// undefined, see there for why) means "none" exactly the same as never having
		// had one — nothing downstream should ever see the difference.
		quantity: item.quantity || null,
		checked: item.checked === true,
		category: categoryNameFor(item.categoryMatchId)
	};
}

function toDomainList(
	list: {
		identifier: string;
		name: string;
		items: Parameters<typeof toDomainItem>[0][];
	},
	categoryNameFor: (categoryMatchId: string | undefined) => string | null
): AnyListGroceryList {
	return {
		id: list.identifier,
		name: list.name,
		items: list.items.map((item) => toDomainItem(item, categoryNameFor))
	};
}

/** Logs in, loads the account's lists, and returns the adapter. Callers own the
 *  lifetime — call `teardown()` when done with it (a script exiting, or never, for the
 *  long-lived connection M2 wires into the sync loop). */
export async function connectAnyList(
	credentials: AnyListCredentials,
	options: ConnectAnyListOptions = {}
): Promise<AnyListClient> {
	silenceKnownLibraryLogs();
	const AnyListCtor = options.AnyListCtor ?? AnyListLib;

	const client = new AnyListCtor({
		email: credentials.email,
		password: credentials.password,
		credentialsFile: credentialsFile()
	});

	await client.login();
	await client.getLists();

	function requireList(listId: string) {
		const list = client.getListById(listId);
		if (!list) throw clientError(`AnyList: no list with id "${listId}" on this account`);
		return list;
	}

	// See anylist-lib.d.ts's `_userData` comment: reads AnyList's category list fresh on
	// every call (not cached at connect time), since a refresh() or a push can update it.
	// Deliberately linear-scan, not a Map — a household's own category list is small
	// (tens of entries at most), and rebuilding a Map on every item would cost more than
	// this saves at that scale.
	function categoryNameFor(categoryMatchId: string | undefined): string | null {
		if (!categoryMatchId) return null;
		const categories = client._userData?.userCategoriesResponse?.categories ?? [];
		// Match on the category's own `categoryMatchId` (a stable slug like "dairy"), not
		// its `identifier` — `identifier` is a random per-account id for the category row
		// itself, while `categoryMatchId` is the shared key both sides (item and category)
		// actually use to reference "this kind of category". Confirmed against a real
		// account's response: every item's `categoryMatchId` matches a category's own
		// `categoryMatchId` field, never its `identifier`.
		return (
			categories.find((category) => category.categoryMatchId === categoryMatchId)?.name ?? null
		);
	}

	return {
		findListByName(name) {
			const list = client.getListByName(name);
			return list ? toDomainList(list, categoryNameFor) : null;
		},

		fetchItems(listId) {
			return toDomainList(requireList(listId), categoryNameFor);
		},

		async refresh() {
			await client.getLists();
		},

		async addItem(listId, item) {
			const list = requireList(listId);

			const existing = list.getItemByName(item.name);
			if (existing) {
				let changed = false;
				if (existing.checked) {
					existing.checked = false;
					changed = true;
				}
				// A fresh add reflects only what was actually asked for this time —
				// reusing a previously-checked item (§2.4) must not also resurrect its
				// old quantity from whenever it was last bought. That's exactly what
				// surfaced this: re-adding "ice cream" via the autocomplete suggestion
				// brought back "4" from weeks earlier, with nothing about the add
				// implying a quantity at all. `''`, not `undefined`, is what clears it —
				// the anylist library's own Item#save() calls `.toString()`
				// unconditionally on every changed field's value (item.js), so assigning
				// `undefined` crashes the *next* save on this item too, since the library
				// never clears its pending-fields list between saves.
				const nextQuantity = item.quantity ?? '';
				if (existing.quantity !== nextQuantity) {
					existing.quantity = nextQuantity;
					changed = true;
				}
				if (changed) await existing.save();
				return toDomainItem(existing, categoryNameFor);
			}

			const created = client.createItem({
				identifier: item.id,
				name: item.name,
				quantity: item.quantity ?? undefined
			});
			const saved = await list.addItem(created);
			return toDomainItem(saved, categoryNameFor);
		},

		async setChecked(listId, itemId, checked) {
			const list = requireList(listId);
			const item = list.getItemById(itemId);
			if (!item) return;
			item.checked = checked;
			await item.save();
		},

		async removeItem(listId, itemId) {
			const list = requireList(listId);
			const item = list.getItemById(itemId);
			if (!item) return;
			await list.removeItem(item);
		},

		onListsUpdate(callback) {
			client.on('lists-update', (lists) =>
				callback(lists.map((list) => toDomainList(list, categoryNameFor)))
			);
		},

		teardown() {
			client.teardown();
		}
	};
}
