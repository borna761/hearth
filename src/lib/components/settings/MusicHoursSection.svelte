<script lang="ts">
	import { untrack } from 'svelte';

	let {
		musicHoursValue,
		showToast
	}: { musicHoursValue: string; showToast: (message: string) => void } = $props();

	// Same split-fields shape as quiet hours, plus a checkbox — unlike quiet hours, an unset
	// window is a real, common state (music always available), not just a startup gap.
	let musicHoursEnabled = $state(false);
	let musicHoursStart = $state('09:00');
	let musicHoursEnd = $state('21:00');
	$effect(() => {
		const [start, end] = musicHoursValue ? musicHoursValue.split('-') : [null, null];
		untrack(() => {
			musicHoursEnabled = !!musicHoursValue;
			if (start) musicHoursStart = start;
			if (end) musicHoursEnd = end;
		});
	});
	let musicHoursError = $state<string | null>(null);
	let savingMusicHours = $state(false);

	async function saveMusicHours(event: SubmitEvent) {
		event.preventDefault();
		musicHoursError = null;
		// Same time twice parses fine server-side but leaves music permanently unavailable
		// with no other way to notice — catch it here instead of round-tripping to find out.
		if (musicHoursEnabled && musicHoursStart === musicHoursEnd) {
			musicHoursError = 'Start and end can’t be the same time.';
			return;
		}
		savingMusicHours = true;
		try {
			const res = await fetch('/api/settings/music-hours', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					value: musicHoursEnabled ? `${musicHoursStart}-${musicHoursEnd}` : ''
				})
			});
			if (!res.ok) {
				musicHoursError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingMusicHours = false;
		}
	}
</script>

<section class="mt-10">
	<h2 class="mb-3 text-lg font-medium">Music hours</h2>
	<p class="mb-3 text-sm text-slate-500">
		The window the music button is available in. Outside it, the button hides and any playback
		already going stops automatically. Leave off to allow music at any time.
	</p>
	<form onsubmit={saveMusicHours} class="flex max-w-md flex-col gap-3">
		<label class="flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				bind:checked={musicHoursEnabled}
				disabled={savingMusicHours}
				class="h-4 w-4 rounded border-slate-300"
			/>
			Only allow music within these hours
		</label>
		<div class="flex items-end gap-3">
			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium text-slate-500">Starts</span>
				<input
					type="time"
					bind:value={musicHoursStart}
					step="900"
					required
					disabled={savingMusicHours || !musicHoursEnabled}
					class="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
				/>
			</label>
			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium text-slate-500">Ends</span>
				<input
					type="time"
					bind:value={musicHoursEnd}
					step="900"
					required
					disabled={savingMusicHours || !musicHoursEnabled}
					class="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
				/>
			</label>
			<button
				type="submit"
				disabled={savingMusicHours}
				class="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
			>
				Save
			</button>
		</div>
	</form>
	{#if musicHoursError}
		<p class="mt-2 text-sm text-red-600">{musicHoursError}</p>
	{/if}
</section>
