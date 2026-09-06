<script lang="ts">
	import type { PublicUser } from '$lib/server/users';
	import type { VisibilityMatrixRow } from '$lib/server/visibility';

	let {
		rows,
		users,
		checked,
		showToast
	}: {
		rows: VisibilityMatrixRow[];
		users: PublicUser[];
		/** { [rowKey]: { [userId]: checked } } — mutated in place, not reassigned, so this
		 *  must be the actual reactive object the route's `load()` returned (passed straight
		 *  through by +page.svelte), not a copy or a `$derived` view of it — SvelteKit's own
		 *  reactive props proxy is what makes mutating a nested field here repaint the
		 *  checkbox, the same way saveTaskAccess's optimistic `user.taskAccess` mutation
		 *  relies on `users` being the live array. */
		checked: Record<string, Record<number, boolean>>;
		showToast: (message: string) => void;
	} = $props();

	// Auto-saves on every toggle rather than requiring a separate save flow (DESIGN.md
	// doesn't specify one either way) — each toggle is already a single well-defined write.
	async function toggle(rowKey: string, sourceIds: number[], userId: number, next: boolean) {
		checked[rowKey][userId] = next; // optimistic
		const res = await fetch('/api/settings/visibility', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ userId, sourceIds, visible: next })
		});
		if (!res.ok) {
			checked[rowKey][userId] = !next; // revert on failure
		} else {
			showToast('Saved');
		}
	}
</script>

<section>
	<h2 class="mb-3 text-lg font-medium">Calendar visibility</h2>
	<p class="mb-4 text-sm text-slate-500">
		Which calendars each person sees on the tablet. Football's four feeds are grouped into one row.
	</p>

	{#if rows.length === 0}
		<p class="text-slate-400">No calendars discovered yet.</p>
	{:else}
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-left text-sm">
				<thead>
					<tr>
						<th class="border-b border-slate-200 py-2 pr-4">Calendar</th>
						{#each users as user (user.id)}
							<th class="border-b border-slate-200 px-3 py-2 text-center">{user.name}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.key)}
						<tr>
							<td class="border-b border-slate-100 py-2 pr-4">{row.label}</td>
							{#each users as user (user.id)}
								<td class="border-b border-slate-100 px-3 py-2 text-center">
									<input
										type="checkbox"
										checked={checked[row.key][user.id]}
										onchange={(e) =>
											toggle(row.key, row.sourceIds, user.id, e.currentTarget.checked)}
										class="h-5 w-5"
									/>
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>
