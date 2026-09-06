<script lang="ts">
	import { untrack } from 'svelte';

	let {
		timeZone: initialTimeZone,
		timeZoneOptions,
		showToast
	}: {
		timeZone: string;
		timeZoneOptions: string[];
		showToast: (message: string) => void;
	} = $props();

	// Re-seeded the same way quiet hours/theme mode are above.
	let timeZone = $state('America/Toronto');
	$effect(() => {
		untrack(() => {
			timeZone = initialTimeZone;
		});
	});
	let timeZoneError = $state<string | null>(null);
	let savingTimeZone = $state(false);

	async function saveTimeZone(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		const previous = timeZone;
		timeZone = value;
		savingTimeZone = true;
		timeZoneError = null;
		try {
			const res = await fetch('/api/settings/timezone', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value })
			});
			if (!res.ok) {
				timeZone = previous;
				timeZoneError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingTimeZone = false;
		}
	}
</script>

<section class="mt-10">
	<h2 class="mb-3 text-lg font-medium">Time zone</h2>
	<p class="mb-3 text-sm text-slate-500">
		The zone every timed event, quiet hours, and clock renders in.
	</p>
	<select
		value={timeZone}
		onchange={saveTimeZone}
		disabled={savingTimeZone}
		class="w-full max-w-sm rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
	>
		{#each timeZoneOptions as tz (tz)}
			<option value={tz}>{tz}</option>
		{/each}
	</select>
	{#if timeZoneError}
		<p class="mt-2 text-sm text-red-600">{timeZoneError}</p>
	{/if}
</section>
