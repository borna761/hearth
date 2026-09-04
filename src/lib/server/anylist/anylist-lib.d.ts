// Ambient types for the `anylist` npm package (0.8.6) — it ships no types of its own and
// none exist on DefinitelyTyped. Declares only the surface client.ts actually calls,
// checked against node_modules/anylist/lib/*.js directly, not the library's full API
// (recipes, meal-planning calendars, favourites — none of which this app uses).

declare module 'anylist' {
	import { EventEmitter } from 'node:events';

	interface AnyListItemInit {
		name?: string;
		identifier?: string;
		quantity?: string;
	}

	class AnyListItem {
		readonly identifier: string;
		name: string;
		quantity: string | undefined;
		checked: boolean;
		/** An opaque id into the account's category list — resolved to a display name via
		 *  AnyList#_userData below, not directly on the item itself. */
		readonly categoryMatchId: string | undefined;
		save(isFavorite?: boolean): Promise<void>;
	}

	class AnyListList {
		readonly identifier: string;
		readonly name: string;
		readonly items: AnyListItem[];
		addItem(item: AnyListItem, isFavorite?: boolean): Promise<AnyListItem>;
		removeItem(item: AnyListItem, isFavorite?: boolean): Promise<void>;
		getItemById(identifier: string): AnyListItem | undefined;
		getItemByName(name: string): AnyListItem | undefined;
	}

	interface AnyListOptions {
		email: string;
		password: string;
		/** Passing `null` disables the library's own on-disk credential persistence
		 *  entirely — see docs/phase-5-plan.md §2.3 for why this app never does that. */
		credentialsFile?: string | null;
	}

	class AnyList extends EventEmitter {
		constructor(options: AnyListOptions);
		login(connectWebSocket?: boolean): Promise<void>;
		getLists(refreshCache?: boolean): Promise<AnyListList[]>;
		getListById(identifier: string): AnyListList | undefined;
		getListByName(name: string): AnyListList | undefined;
		createItem(item: AnyListItemInit): AnyListItem;
		teardown(): void;
		on(event: 'lists-update', listener: (lists: AnyListList[]) => void): this;

		/**
		 * UNDOCUMENTED, PRIVATE (leading-underscore) internal state — not part of the
		 * library's public API, declared here anyway because it's the only place category
		 * names actually live. Every `getLists()` call decodes a `PBUserDataResponse` that
		 * already includes `userCategoriesResponse.categories` (id -> name, e.g. "Produce"),
		 * per AnyList's own protobuf schema (checked directly against the bundled
		 * definitions.json for 0.8.6) — the public `Item` class just never surfaces it.
		 * client.ts reads this defensively (optional chaining, empty-array fallback) so a
		 * future `anylist` version restructuring this silently degrades to "no category
		 * names" instead of throwing. Re-verify this shape against definitions.json's
		 * `PBUserDataResponse`/`PBUserCategoryData`/`PBUserCategory` messages before trusting
		 * it again after any `anylist` version bump.
		 */
		_userData?: {
			userCategoriesResponse?: {
				// `identifier` is a random per-account id for the category row itself —
				// `categoryMatchId` (e.g. "dairy") is the stable slug an `AnyListItem`'s own
				// `categoryMatchId` actually matches against. Confirmed against a real
				// account's response, not just the protobuf schema: don't match on
				// `identifier`, it will never equal an item's `categoryMatchId`.
				categories?: { identifier: string; categoryMatchId: string; name: string }[];
			};
		};
	}

	export = AnyList;
}
