import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { connectAnyList, generateItemId, type AnyListConstructor } from './client';

// A minimal stand-in for the `anylist` library — implements only what client.ts actually
// calls, so addItem's reuse-existing-item behaviour (docs/phase-5-plan.md §2.4) and the
// rest of this adapter are verifiable without a network call. Same seam
// google/discovery.test.ts uses for `listCalendars`.

class FakeItem {
	identifier: string;
	name: string;
	quantity: string | undefined;
	checked: boolean;
	categoryMatchId: string | undefined;
	save = vi.fn(async () => {});

	constructor(init: {
		identifier: string;
		name: string;
		quantity?: string;
		checked?: boolean;
		categoryMatchId?: string;
	}) {
		this.identifier = init.identifier;
		this.name = init.name;
		this.quantity = init.quantity;
		this.checked = init.checked ?? false;
		this.categoryMatchId = init.categoryMatchId;
	}
}

class FakeList {
	identifier: string;
	name: string;
	items: FakeItem[];

	constructor(identifier: string, name: string, items: FakeItem[] = []) {
		this.identifier = identifier;
		this.name = name;
		this.items = items;
	}

	addItem = vi.fn(async (item: FakeItem) => {
		this.items.push(item);
		return item;
	});

	removeItem = vi.fn(async (item: FakeItem) => {
		this.items = this.items.filter((i) => i.identifier !== item.identifier);
	});

	getItemById(identifier: string) {
		return this.items.find((i) => i.identifier === identifier);
	}

	getItemByName(name: string) {
		return this.items.find((i) => i.name === name);
	}
}

class FakeAnyList extends EventEmitter {
	lists: FakeList[];
	loggedIn = false;
	_userData?: {
		userCategoriesResponse?: {
			categories?: { identifier: string; categoryMatchId: string; name: string }[];
		};
	};

	constructor(
		public options: { email: string; password: string; credentialsFile?: string | null },
		lists: FakeList[] = [],
		categories: { identifier: string; categoryMatchId: string; name: string }[] = []
	) {
		super();
		this.lists = lists;
		this._userData = { userCategoriesResponse: { categories } };
	}

	async login() {
		this.loggedIn = true;
	}

	getLists = vi.fn(async () => this.lists);

	getListById(identifier: string) {
		return this.lists.find((l) => l.identifier === identifier);
	}

	getListByName(name: string) {
		return this.lists.find((l) => l.name === name);
	}

	createItem(init: { identifier?: string; name?: string; quantity?: string }) {
		return new FakeItem({
			identifier: init.identifier ?? 'generated',
			name: init.name ?? '',
			quantity: init.quantity
		});
	}

	teardown = vi.fn();
}

/**
 * Returns a fake constructor plus a handle to the instance it produces, so a test can
 * both drive `connectAnyList` through the normal AnyListCtor seam and reach back into the
 * instance afterwards (e.g. to `.emit('lists-update', ...)` or assert `.teardown` was
 * called) — the same shape `instance` would have if this were the real library.
 */
function fakeCtor(
	lists: FakeList[],
	categories: { identifier: string; categoryMatchId: string; name: string }[] = []
): { Ctor: AnyListConstructor; instance: () => FakeAnyList } {
	let captured: FakeAnyList | undefined;
	// A function call, not `const x = this`, so this doesn't trip @typescript-eslint's
	// no-this-alias — the rule targets accidental aliasing, not a constructor deliberately
	// handing itself off to its factory.
	const capture = (self: FakeAnyList) => {
		captured = self;
	};
	const Ctor = class extends FakeAnyList {
		constructor(options: { email: string; password: string; credentialsFile?: string | null }) {
			super(options, lists, categories);
			capture(this);
		}
	};
	return {
		Ctor: Ctor as unknown as AnyListConstructor,
		instance: () => {
			if (!captured) throw new Error('AnyListCtor was never constructed');
			return captured;
		}
	};
}

describe('generateItemId', () => {
	it("matches the library's own format — 32 lowercase hex characters, no dashes", () => {
		const id = generateItemId();
		expect(id).toMatch(/^[0-9a-f]{32}$/);
	});

	it('is different on every call', () => {
		expect(generateItemId()).not.toBe(generateItemId());
	});
});

describe('connectAnyList', () => {
	it('logs in and loads lists before returning', async () => {
		const list = new FakeList('list-1', 'My Grocery List');
		const client = await connectAnyList(
			{ email: 'a@b.com', password: 'pw' },
			{ AnyListCtor: fakeCtor([list]).Ctor }
		);
		expect(client.findListByName('My Grocery List')).toEqual({
			id: 'list-1',
			name: 'My Grocery List',
			items: []
		});
	});

	it('findListByName returns null for an unknown list rather than throwing', async () => {
		const client = await connectAnyList(
			{ email: 'a@b.com', password: 'pw' },
			{ AnyListCtor: fakeCtor([]).Ctor }
		);
		expect(client.findListByName('Nope')).toBeNull();
	});

	it('fetchItems maps every item field, including a null quantity', async () => {
		const list = new FakeList('list-1', 'Groceries', [
			new FakeItem({ identifier: 'i1', name: 'Milk', quantity: '2', checked: false }),
			new FakeItem({ identifier: 'i2', name: 'Bread', checked: true })
		]);
		const client = await connectAnyList(
			{ email: 'a@b.com', password: 'pw' },
			{ AnyListCtor: fakeCtor([list]).Ctor }
		);
		expect(client.fetchItems('list-1').items).toEqual([
			{ id: 'i1', name: 'Milk', quantity: '2', checked: false, category: null },
			{ id: 'i2', name: 'Bread', quantity: null, checked: true, category: null }
		]);
	});

	describe('category resolution', () => {
		// A category row's own `identifier` is a random per-account id for that row, never
		// what an item's `categoryMatchId` points at — confirmed against a real account's
		// response, where every fixture below deliberately gives the two different values
		// so a resolver that (wrongly) matched on `identifier` instead of `categoryMatchId`
		// would fail these.
		it("resolves an item's categoryMatchId to the account's category name", async () => {
			const list = new FakeList('list-1', 'Groceries', [
				new FakeItem({ identifier: 'i1', name: 'Milk', categoryMatchId: 'dairy' })
			]);
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{
					AnyListCtor: fakeCtor(
						[list],
						[{ identifier: 'row-xyz', categoryMatchId: 'dairy', name: 'Dairy' }]
					).Ctor
				}
			);

			expect(client.fetchItems('list-1').items[0].category).toBe('Dairy');
		});

		it('is null when the item has no categoryMatchId', async () => {
			const list = new FakeList('list-1', 'Groceries', [
				new FakeItem({ identifier: 'i1', name: 'Milk' })
			]);
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{
					AnyListCtor: fakeCtor(
						[list],
						[{ identifier: 'row-xyz', categoryMatchId: 'dairy', name: 'Dairy' }]
					).Ctor
				}
			);

			expect(client.fetchItems('list-1').items[0].category).toBeNull();
		});

		it('is null when categoryMatchId has no matching category on the account', async () => {
			const list = new FakeList('list-1', 'Groceries', [
				new FakeItem({ identifier: 'i1', name: 'Milk', categoryMatchId: 'unknown-cat' })
			]);
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{
					AnyListCtor: fakeCtor(
						[list],
						[{ identifier: 'row-xyz', categoryMatchId: 'dairy', name: 'Dairy' }]
					).Ctor
				}
			);

			expect(client.fetchItems('list-1').items[0].category).toBeNull();
		});

		it('degrades to null rather than throwing when _userData is missing or malformed', async () => {
			const list = new FakeList('list-1', 'Groceries', [
				new FakeItem({ identifier: 'i1', name: 'Milk', categoryMatchId: 'dairy' })
			]);
			const { Ctor, instance } = fakeCtor(
				[list],
				[{ identifier: 'row-xyz', categoryMatchId: 'dairy', name: 'Dairy' }]
			);
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{ AnyListCtor: Ctor }
			);

			// Simulate a future `anylist` version restructuring this undocumented internal.
			instance()._userData = undefined;

			expect(() => client.fetchItems('list-1')).not.toThrow();
			expect(client.fetchItems('list-1').items[0].category).toBeNull();
		});
	});

	it('fetchItems throws for an id not on the account', async () => {
		const client = await connectAnyList(
			{ email: 'a@b.com', password: 'pw' },
			{ AnyListCtor: fakeCtor([]).Ctor }
		);
		expect(() => client.fetchItems('missing')).toThrow(/no list with id/);
	});

	describe('refresh', () => {
		it("forces a fresh network fetch rather than reading the client's existing cache", async () => {
			const list = new FakeList('list-1', 'Groceries');
			const { Ctor, instance } = fakeCtor([list]);
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{ AnyListCtor: Ctor }
			);

			// getLists is called once already, by connectAnyList itself on login.
			expect(instance().getLists).toHaveBeenCalledTimes(1);

			await client.refresh();

			expect(instance().getLists).toHaveBeenCalledTimes(2);
		});
	});

	describe('addItem', () => {
		it('creates a new item when no item with that name exists', async () => {
			const list = new FakeList('list-1', 'Groceries');
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{ AnyListCtor: fakeCtor([list]).Ctor }
			);

			const result = await client.addItem('list-1', { id: 'new-id', name: 'Eggs', quantity: '12' });

			expect(result).toEqual({
				id: 'new-id',
				name: 'Eggs',
				quantity: '12',
				checked: false,
				category: null
			});
			expect(list.items).toHaveLength(1);
			expect(list.addItem).toHaveBeenCalledTimes(1);
		});

		it('reuses a checked-off item with the same name instead of adding a duplicate — §2.4', async () => {
			const existing = new FakeItem({ identifier: 'old-id', name: 'Milk', checked: true });
			const list = new FakeList('list-1', 'Groceries', [existing]);
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{ AnyListCtor: fakeCtor([list]).Ctor }
			);

			const result = await client.addItem('list-1', { id: 'fresh-id', name: 'Milk' });

			// The reused item keeps AnyList's original identifier, not the caller's — the
			// caller must use the returned id from here on (see client.ts's AddItem doc).
			expect(result.id).toBe('old-id');
			expect(result.checked).toBe(false);
			expect(list.items).toHaveLength(1);
			expect(list.addItem).not.toHaveBeenCalled();
			expect(existing.save).toHaveBeenCalledTimes(1);
		});

		it('does not re-save an already-unchecked item with a matching quantity', async () => {
			const existing = new FakeItem({
				identifier: 'old-id',
				name: 'Milk',
				quantity: '1',
				checked: false
			});
			const list = new FakeList('list-1', 'Groceries', [existing]);
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{ AnyListCtor: fakeCtor([list]).Ctor }
			);

			await client.addItem('list-1', { id: 'fresh-id', name: 'Milk', quantity: '1' });

			expect(existing.save).not.toHaveBeenCalled();
		});

		it("clears a reused item's stale quantity when the add gives an explicit null, without crashing", async () => {
			// groceriesQueue.ts's drain always passes quantity: null (never omits the
			// field) when the original add had none — PendingWritePayload.quantity is
			// `string | null`, never optional. A fresh add with no quantity must not
			// resurrect whatever quantity the item happened to have from being bought
			// last time — re-adding "ice cream" via the autocomplete suggestion brought
			// back a stale "4" from weeks earlier before this was fixed. Cleared to `''`,
			// not `undefined`: the real anylist library's Item#save() calls .toString()
			// unconditionally on every pending field, so undefined crashes the *next*
			// save on this item too, since the library never clears its pending-fields
			// list between saves.
			const existing = new FakeItem({
				identifier: 'old-id',
				name: 'Milk',
				quantity: '4',
				checked: true
			});
			const list = new FakeList('list-1', 'Groceries', [existing]);
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{ AnyListCtor: fakeCtor([list]).Ctor }
			);

			const result = await client.addItem('list-1', {
				id: 'fresh-id',
				name: 'Milk',
				quantity: null
			});

			expect(existing.quantity).toBe('');
			expect(result.quantity).toBeNull();
			expect(existing.save).toHaveBeenCalledTimes(1);
		});

		it('updates quantity on a reused item when it differs', async () => {
			const existing = new FakeItem({
				identifier: 'old-id',
				name: 'Milk',
				quantity: '1',
				checked: true
			});
			const list = new FakeList('list-1', 'Groceries', [existing]);
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{ AnyListCtor: fakeCtor([list]).Ctor }
			);

			const result = await client.addItem('list-1', {
				id: 'fresh-id',
				name: 'Milk',
				quantity: '2'
			});

			expect(result.quantity).toBe('2');
			expect(existing.save).toHaveBeenCalledTimes(1);
		});
	});

	describe('setChecked', () => {
		it('checks and unchecks an existing item', async () => {
			const item = new FakeItem({ identifier: 'i1', name: 'Milk' });
			const list = new FakeList('list-1', 'Groceries', [item]);
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{ AnyListCtor: fakeCtor([list]).Ctor }
			);

			await client.setChecked('list-1', 'i1', true);

			expect(item.checked).toBe(true);
			expect(item.save).toHaveBeenCalledTimes(1);
		});

		it('is a no-op for an item id that no longer exists, matching removeItem — a deleted item conflict must not look like a connection failure to the caller', async () => {
			const list = new FakeList('list-1', 'Groceries');
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{ AnyListCtor: fakeCtor([list]).Ctor }
			);

			await expect(client.setChecked('list-1', 'gone', true)).resolves.toBeUndefined();
		});
	});

	describe('removeItem', () => {
		it('removes an existing item', async () => {
			const item = new FakeItem({ identifier: 'i1', name: 'Milk' });
			const list = new FakeList('list-1', 'Groceries', [item]);
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{ AnyListCtor: fakeCtor([list]).Ctor }
			);

			await client.removeItem('list-1', 'i1');

			expect(list.items).toHaveLength(0);
		});

		it('is a no-op for an item id that is already gone', async () => {
			const list = new FakeList('list-1', 'Groceries');
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{ AnyListCtor: fakeCtor([list]).Ctor }
			);

			await expect(client.removeItem('list-1', 'gone')).resolves.toBeUndefined();
		});
	});

	describe('onListsUpdate', () => {
		it('maps pushed lists to domain types', async () => {
			const list = new FakeList('list-1', 'Groceries', [
				new FakeItem({ identifier: 'i1', name: 'Milk' })
			]);
			const { Ctor, instance } = fakeCtor([list]);
			const client = await connectAnyList(
				{ email: 'a@b.com', password: 'pw' },
				{ AnyListCtor: Ctor }
			);

			const received: unknown[] = [];
			client.onListsUpdate((lists) => received.push(lists));

			instance().emit('lists-update', [list]);

			expect(received).toEqual([
				[
					{
						id: 'list-1',
						name: 'Groceries',
						items: [{ id: 'i1', name: 'Milk', quantity: null, checked: false, category: null }]
					}
				]
			]);
		});
	});

	it('teardown delegates to the underlying client', async () => {
		const list = new FakeList('list-1', 'Groceries');
		const { Ctor, instance } = fakeCtor([list]);
		const client = await connectAnyList(
			{ email: 'a@b.com', password: 'pw' },
			{ AnyListCtor: Ctor }
		);

		client.teardown();

		expect(instance().teardown).toHaveBeenCalledTimes(1);
	});
});
