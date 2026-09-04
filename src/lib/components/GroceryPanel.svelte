<script lang="ts">
	import type { GroceriesSnapshot, GroceriesItemSnapshot } from '$lib/server/groceries';

	let {
		groceries,
		onClose,
		large = false
	}: {
		groceries: GroceriesSnapshot;
		onClose: () => void;
		/** Sam's simple view (DESIGN.md §5.2) runs everything else at ~1.6x the standard
		 *  view's type — this panel is shared between both views (see +page.svelte), so it
		 *  needs its own scaled variant rather than always rendering at the standard view's
		 *  (denser, more items-on-screen) sizing regardless of which view opened it. */
		large?: boolean;
	} = $props();

	let sizes = $derived(
		large
			? {
					width: 'w-[26rem]',
					headerHeight: 'h-20',
					title: 'text-2xl',
					subtitle: 'text-sm',
					stale: 'px-2.5 py-1 text-sm',
					closeBtn: 'h-12 w-12 text-2xl',
					formPad: 'p-4',
					input: 'h-14 px-4 text-lg',
					addBtn: 'h-14 px-6 text-lg',
					suggestionRow: 'h-14 text-lg',
					suggestionTag: 'text-sm',
					emptyState: 'text-lg',
					categoryLabel: 'text-sm',
					categoryIcon: 'text-base',
					checkbox: 'h-8 w-8',
					pendingDot: 'h-2.5 w-2.5',
					itemRow: 'min-h-16',
					itemTitle: 'text-xl',
					quantity: 'text-base'
				}
			: {
					width: 'w-96',
					headerHeight: 'h-16',
					title: 'text-lg',
					subtitle: 'text-xs',
					stale: 'px-2 py-0.5 text-xs',
					closeBtn: 'h-10 w-10 text-xl',
					formPad: 'p-3',
					input: 'h-11 px-3 text-base',
					addBtn: 'h-11 px-5 text-base',
					suggestionRow: 'h-11 text-base',
					suggestionTag: 'text-xs',
					emptyState: 'text-base',
					categoryLabel: 'text-xs',
					categoryIcon: 'text-sm',
					checkbox: 'h-6 w-6',
					pendingDot: 'h-2 w-2',
					itemRow: 'min-h-14',
					itemTitle: 'text-base',
					quantity: 'text-sm'
				}
	);

	// AnyList exposes no icon assets over the API — categories only carry the display name
	// resolved in client.ts's `categoryNameFor` (see anylist-lib.d.ts) — so this maps that
	// fixed, verified-against-the-real-account set of names to an emoji by hand. A name this
	// doesn't recognise (an AnyList-side category added after this map was written) falls
	// back to the same 🛒 as "Other" rather than rendering nothing.
	const CATEGORY_ICONS: Record<string, string> = {
		Baby: '🍼',
		Bakery: '🥖',
		Beverages: '🥤',
		'Breakfast & Cereal': '🥣',
		'Condiments & Dressings': '🍯',
		'Cooking & Baking': '🧁',
		Dairy: '🧀',
		Deli: '🥪',
		'Frozen Foods': '🧊',
		'Grains, Pasta & Sides': '🍝',
		'Health & Personal Care': '💊',
		'Household & Cleaning': '🧽',
		Meat: '🥩',
		'Pet Supplies': '🐾',
		Produce: '🥬',
		Seafood: '🐟',
		Snacks: '🍪',
		'Soups & Canned Goods': '🥫',
		'Wine, Beer & Spirits': '🍷',
		Other: '🛒'
	};

	// DESIGN.md §7.2.1's spec is deliberately narrow: "the list, a text field, and a done
	// button." No remove/delete affordance here — tapping a row only checks/unchecks it,
	// matching AnyList's own tap-to-toggle behaviour. The write queue's `remove` action
	// exists server-side (M3) for later, not because this milestone's UI needs it.

	let newItemName = $state('');
	let adding = $state(false);
	let inputEl: HTMLInputElement | undefined;
	// Per-item in-flight guard so a double-tap on the same row (or a slow round trip)
	// can't fire two requests for one intent — there's no local optimistic state here to
	// dedupe against otherwise, since the server's own optimistic apply + SSE push is what
	// actually updates `groceries`, not this component.
	let busy = $state<Record<string, boolean>>({});

	let unchecked = $derived(groceries.items.filter((item) => !item.checked));

	// Grouped by AnyList's own category names so the sidebar reads like a shopping list
	// organized by aisle. Uncategorized items ("Other") sort last — everything else
	// alphabetically, matching how the categories themselves have no inherent order here.
	let grouped = $derived.by(() => {
		const groups: Record<string, GroceriesItemSnapshot[]> = {};
		for (const item of unchecked) {
			const key = item.category ?? 'Other';
			(groups[key] ??= []).push(item);
		}
		return Object.entries(groups).sort(([a], [b]) => {
			if (a === 'Other') return 1;
			if (b === 'Other') return -1;
			return a.localeCompare(b);
		});
	});

	// Sourced from `groceries.items` — already the full history for this list (checked and
	// unchecked alike; nothing is pruned until AnyList itself drops it), pushed to every
	// client over SSE regardless, so this needs no request of its own. (AnyList's own
	// "recent items" bank, a broader autocomplete source in principle, turned out to be
	// nearly 1:1 with what's already on this list when checked against the real
	// account — not worth the extra adapter plumbing for one item's difference.)
	// Priority for previously-checked names: an item that's been bought before is a
	// stronger signal of "this is what they meant" for ranking purposes, but capped at 20,
	// not 6 — with most of a long-running list checked at any given time, a tight cap plus
	// checked-first sorting meant a currently-needed (unchecked) item could get crowded out
	// of the dropdown entirely by checked matches for a common query.
	let suggestions = $derived.by(() => {
		const query = newItemName.trim().toLowerCase();
		if (!query) return [];
		const byName: Record<string, { title: string; everChecked: boolean; category: string | null }> =
			{};
		for (const item of groceries.items) {
			const key = item.title.toLowerCase();
			const entry = byName[key];
			if (entry) {
				entry.everChecked ||= item.checked;
				entry.category ??= item.category;
			} else {
				byName[key] = { title: item.title, everChecked: item.checked, category: item.category };
			}
		}
		return Object.values(byName)
			.filter((entry) => entry.title.toLowerCase().includes(query))
			.sort((a, b) => {
				if (a.everChecked !== b.everChecked) return a.everChecked ? -1 : 1;
				const aStarts = a.title.toLowerCase().startsWith(query);
				const bStarts = b.title.toLowerCase().startsWith(query);
				if (aStarts !== bStarts) return aStarts ? -1 : 1;
				return a.title.localeCompare(b.title);
			})
			.slice(0, 20);
	});

	async function submitItem(name: string) {
		if (!name || adding) return;
		adding = true;
		try {
			const res = await fetch('/api/groceries', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (res.ok) newItemName = '';
		} finally {
			adding = false;
			inputEl?.focus();
		}
	}

	async function addItem(event: SubmitEvent) {
		event.preventDefault();
		await submitItem(newItemName.trim());
	}

	async function toggle(item: GroceriesItemSnapshot) {
		if (busy[item.id]) return;
		busy[item.id] = true;
		try {
			await fetch(`/api/groceries/${item.id}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: item.checked ? 'uncheck' : 'check' })
			});
		} finally {
			delete busy[item.id];
		}
	}
</script>

<!-- Invisible tap-to-close target for everything outside the sidebar. No dimming — the
     whole point of the sidebar over the old full-bleed layout was to keep the dashboard
     visible, and a scrim would fight that. Sits below the sidebar in stacking order so a
     tap on the sidebar itself never reaches it. -->
<button type="button" onclick={onClose} aria-label="Close groceries" class="absolute inset-0 z-10"
></button>

<!-- Sidebar over the right edge of the grid, not full-bleed — the rest of the dashboard
     (calendar, weather) stays visible and reachable while checking items off. Translucent
     (bg-white/70), not blurred — DESIGN.md §2.4 rules out backdrop-filter/blur on this
     hardware, same reasoning Screensaver.svelte's own overlay already follows. -->
<div
	class="absolute inset-y-0 right-0 z-20 flex {sizes.width} flex-col border-l border-slate-200 bg-white/70 shadow-xl dark:border-slate-700 dark:bg-slate-900/70"
>
	<header
		class="flex {sizes.headerHeight} shrink-0 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-700"
	>
		<div class="flex items-baseline gap-2.5">
			<h1 class="{sizes.title} font-semibold text-slate-900 dark:text-slate-100">Groceries</h1>
			<p class="{sizes.subtitle} text-slate-500 dark:text-slate-400">
				{unchecked.length} to get
			</p>
			{#if groceries.stale}
				<!-- DESIGN.md §2.5: "an outage degrades one card to a stale badge, never the
				     page" — this is that badge, scoped to the one card that's actually affected. -->
				<span
					class="rounded bg-amber-100 {sizes.stale} font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
				>
					Can't reach AnyList right now
				</span>
			{/if}
		</div>
		<button
			type="button"
			onclick={onClose}
			aria-label="Done"
			class="flex {sizes.closeBtn} items-center justify-center rounded-full text-slate-500 active:bg-slate-100 dark:text-slate-400 dark:active:bg-slate-800"
		>
			✕
		</button>
	</header>

	<!-- Pinned at the top, not the bottom: bottom placement lands exactly where the
	     on-screen keyboard appears, and whether it stays visible depends on whether the
	     kiosk app resizes the viewport or pans it. At the top it never moves. -->
	<form
		onsubmit={addItem}
		class="flex shrink-0 items-center gap-2 border-b border-slate-100 {sizes.formPad} dark:border-slate-800"
	>
		<div class="relative flex-1">
			<input
				bind:this={inputEl}
				bind:value={newItemName}
				type="text"
				placeholder="Add an item…"
				disabled={adding}
				autocomplete="off"
				class="{sizes.input} w-full rounded-lg border border-slate-300 bg-white text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500"
			/>
			{#if suggestions.length > 0}
				<!-- Shown whenever there's a matching query, not gated on input focus: a blur-
				     to-hide would race a touch tap on the suggestion itself (the blur fires
				     first), which is exactly the kind of "why didn't my tap register" bug this
				     sidesteps by not depending on focus state at all. -->
				<ul
					class="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800"
				>
					{#each suggestions as suggestion (suggestion.title)}
						<li>
							<button
								type="button"
								onclick={() => submitItem(suggestion.title)}
								disabled={adding}
								class="flex {sizes.suggestionRow} w-full items-center justify-between gap-2 px-3 text-left text-slate-900 active:bg-slate-100 disabled:opacity-50 dark:text-slate-100 dark:active:bg-slate-700"
							>
								<span class="truncate">{suggestion.title}</span>
								{#if suggestion.category}
									<span
										class="flex shrink-0 items-center gap-1 {sizes.suggestionTag} text-slate-400 dark:text-slate-500"
									>
										<span class="not-italic"
											>{CATEGORY_ICONS[suggestion.category] ?? CATEGORY_ICONS.Other}</span
										>
										{suggestion.category}
									</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
		<button
			type="submit"
			disabled={!newItemName.trim() || adding}
			class="{sizes.addBtn} rounded-lg bg-slate-900 font-medium text-white active:bg-slate-700 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900 dark:active:bg-slate-300"
		>
			Add
		</button>
	</form>

	<div class="flex-1 overflow-y-auto px-3 py-2">
		{#if unchecked.length === 0}
			<p class="{sizes.emptyState} py-8 text-center text-slate-400 dark:text-slate-500">
				{groceries.items.length === 0
					? 'No items yet — add one above.'
					: 'Nothing needed right now.'}
			</p>
		{:else}
			{#each grouped as [category, items] (category)}
				<p
					class="mt-3 flex items-center gap-1.5 px-1 pt-2 {sizes.categoryLabel} font-medium tracking-wide text-slate-400 uppercase first:mt-0 dark:text-slate-500"
				>
					<span class="{sizes.categoryIcon} not-italic"
						>{CATEGORY_ICONS[category] ?? CATEGORY_ICONS.Other}</span
					>
					{category}
				</p>
				<ul>
					{#each items as item (item.id)}
						<li>
							<button
								type="button"
								onclick={() => toggle(item)}
								disabled={busy[item.id]}
								class="flex {sizes.itemRow} w-full items-center gap-3 border-b border-slate-100 text-left disabled:opacity-50 dark:border-slate-800"
							>
								<span
									class="{sizes.checkbox} shrink-0 rounded-md border-2 border-slate-300 dark:border-slate-600"
								></span>
								{#if item.pending}
									<!-- §6.1 point 3: a small pending mark on unsynced items; nothing is
									     ever lost, only delayed, and this is the visible reminder of that.
									     Leading, right after the checkbox — not trailing past the title's
									     flex-1 spacer, where it would sit at the row's far edge and read as
									     belonging to whatever's in the adjacent column instead. -->
									<span
										class="{sizes.pendingDot} shrink-0 rounded-full bg-amber-400"
										aria-label="Not yet synced"
									></span>
								{/if}
								<span class="flex-1 truncate {sizes.itemTitle} text-slate-900 dark:text-slate-100">
									{item.title}
								</span>
								{#if item.quantity}
									<span class="shrink-0 {sizes.quantity} text-slate-500 dark:text-slate-400"
										>{item.quantity}</span
									>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/each}
		{/if}
	</div>
</div>
