<script lang="ts">
	import { untrack } from 'svelte';

	let {
		quietHoursValue,
		showToast
	}: { quietHoursValue: string; showToast: (message: string) => void } = $props();

	// Split into two <input type="time"> fields rather than one HH:MM-HH:MM text field —
	// native time pickers can't produce a malformed value, so the only error path left is
	// a real network failure, not a typo in the punctuation.
	//
	// Re-seeded via an effect on quietHoursValue rather than once at mount: this component
	// only ever exists once already logged in, but it stays mounted for the rest of the
	// session — any other section's invalidateAll() (AnyList connect, a color change, adding
	// a speaker, ...) re-runs the route's load() and pushes a fresh quietHoursValue down as
	// a prop without unmounting this component. A mount-time-only seed would miss that and
	// leave these fields stuck on whatever they last showed. untrack on the write side keeps
	// typing from fighting this re-sync.
	let quietHoursStart = $state('22:00');
	let quietHoursEnd = $state('07:00');
	$effect(() => {
		const [start, end] = quietHoursValue.split('-');
		untrack(() => {
			quietHoursStart = start;
			quietHoursEnd = end;
		});
	});
	let quietHoursError = $state<string | null>(null);
	let savingQuietHours = $state(false);

	async function saveQuietHours(event: SubmitEvent) {
		event.preventDefault();
		savingQuietHours = true;
		quietHoursError = null;
		try {
			const res = await fetch('/api/settings/quiet-hours', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value: `${quietHoursStart}-${quietHoursEnd}` })
			});
			if (!res.ok) {
				quietHoursError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingQuietHours = false;
		}
	}
</script>

<section class="mt-10">
	<h2 class="mb-3 text-lg font-medium">Quiet hours</h2>
	<p class="mb-3 text-sm text-slate-500">
		The window the tablet shows a dimmed night clock instead of the normal display.
	</p>
	<form onsubmit={saveQuietHours} class="flex max-w-sm items-end gap-3">
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium text-slate-500">Starts</span>
			<input
				type="time"
				bind:value={quietHoursStart}
				step="900"
				required
				disabled={savingQuietHours}
				class="rounded border border-slate-300 px-3 py-2 text-sm"
			/>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium text-slate-500">Ends</span>
			<input
				type="time"
				bind:value={quietHoursEnd}
				step="900"
				required
				disabled={savingQuietHours}
				class="rounded border border-slate-300 px-3 py-2 text-sm"
			/>
		</label>
		<button
			type="submit"
			disabled={savingQuietHours}
			class="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
		>
			Save
		</button>
	</form>
	{#if quietHoursError}
		<p class="mt-2 text-sm text-red-600">{quietHoursError}</p>
	{/if}
</section>
