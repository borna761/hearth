<script lang="ts">
	import { untrack } from 'svelte';

	let {
		locationValue,
		showToast
	}: { locationValue: string; showToast: (message: string) => void } = $props();

	// Split into two plain-number fields for the same reason quiet hours splits into two
	// time fields — a bad value should come from a real network failure, not a typo in the
	// punctuation of a combined 'lat,lng' string. Re-seeded the same way quiet hours is.
	let latitude = $state('45.5');
	let longitude = $state('-75.5');
	$effect(() => {
		const [lat, lng] = locationValue.split(',');
		untrack(() => {
			latitude = lat;
			longitude = lng;
		});
	});
	let locationError = $state<string | null>(null);
	let savingLocation = $state(false);

	async function saveLocation(event: SubmitEvent) {
		event.preventDefault();
		savingLocation = true;
		locationError = null;
		try {
			const res = await fetch('/api/settings/location', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value: `${latitude},${longitude}` })
			});
			if (!res.ok) {
				locationError = 'Something went wrong. Check both values are valid coordinates.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingLocation = false;
		}
	}
</script>

<section class="mt-10">
	<h2 class="mb-3 text-lg font-medium">Location</h2>
	<p class="mb-3 text-sm text-slate-500">
		Used for weather and for sunrise/sunset — including the theme's auto light/dark switch.
	</p>
	<form onsubmit={saveLocation} class="flex max-w-sm items-end gap-3">
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium text-slate-500">Latitude</span>
			<input
				type="number"
				step="any"
				min="-90"
				max="90"
				bind:value={latitude}
				required
				disabled={savingLocation}
				class="w-32 rounded border border-slate-300 px-3 py-2 text-sm"
			/>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium text-slate-500">Longitude</span>
			<input
				type="number"
				step="any"
				min="-180"
				max="180"
				bind:value={longitude}
				required
				disabled={savingLocation}
				class="w-32 rounded border border-slate-300 px-3 py-2 text-sm"
			/>
		</label>
		<button
			type="submit"
			disabled={savingLocation}
			class="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
		>
			Save
		</button>
	</form>
	{#if locationError}
		<p class="mt-2 text-sm text-red-600">{locationError}</p>
	{/if}
</section>
