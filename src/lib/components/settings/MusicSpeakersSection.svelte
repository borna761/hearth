<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { MusicSpeaker } from '$lib/server/musicLibrary';

	let { musicSpeakers }: { musicSpeakers: MusicSpeaker[] } = $props();

	// docs/phase-7-music-plan.md — "Scan for speakers" lists every discoverable Cast
	// friendly name (individual speakers and groups alike) so the household picks from
	// what's actually on the network rather than typing a name blind.
	let scanningForSpeakers = $state(false);
	let discoveredSpeakerNames = $state<string[] | null>(null);
	let scanError = $state<string | null>(null);
	let addingSpeakerName = $state<string | null>(null);

	async function scanForSpeakers() {
		scanningForSpeakers = true;
		scanError = null;
		discoveredSpeakerNames = null;
		try {
			const res = await fetch('/api/settings/music-speakers/scan', { method: 'POST' });
			if (!res.ok) {
				scanError = 'Something went wrong. Try again.';
				return;
			}
			const body = await res.json();
			discoveredSpeakerNames = body.names;
		} finally {
			scanningForSpeakers = false;
		}
	}

	async function addDiscoveredSpeaker(castName: string) {
		addingSpeakerName = castName;
		try {
			const res = await fetch('/api/settings/music-speakers', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ castName })
			});
			if (res.ok) await invalidateAll();
		} finally {
			addingSpeakerName = null;
		}
	}

	async function removeSpeaker(id: number) {
		await fetch(`/api/settings/music-speakers/${id}`, { method: 'DELETE' }).catch(() => {});
		await invalidateAll();
	}
</script>

<section class="mt-10">
	<h2 class="mb-3 text-lg font-medium">Music</h2>
	<p class="mb-3 text-sm text-slate-500">
		Playlists come from folders on the NAS (one folder per playlist) — nothing to configure here for
		those. Speakers/groups are found by scanning the network for Cast devices, the same ones visible
		in the Google Home app.
	</p>

	<button
		type="button"
		onclick={scanForSpeakers}
		disabled={scanningForSpeakers}
		class="mb-3 self-start rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
	>
		{scanningForSpeakers ? 'Scanning…' : 'Scan for speakers'}
	</button>
	{#if scanError}
		<p class="mb-3 text-sm text-red-600">{scanError}</p>
	{:else if discoveredSpeakerNames}
		{#if discoveredSpeakerNames.length === 0}
			<p class="mb-3 text-sm text-slate-400">No Cast devices found on the network.</p>
		{:else}
			<ul class="mb-3 flex flex-col gap-2">
				{#each discoveredSpeakerNames as name (name)}
					<li class="flex items-center gap-3 rounded border border-slate-200 px-3 py-2 text-sm">
						<span>{name}</span>
						<button
							type="button"
							onclick={() => addDiscoveredSpeaker(name)}
							disabled={addingSpeakerName === name ||
								musicSpeakers.some((s) => s.castName === name)}
							class="ml-auto text-blue-600 disabled:text-slate-300"
						>
							{musicSpeakers.some((s) => s.castName === name) ? 'Added' : 'Add'}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}

	<h3 class="mt-4 mb-2 text-sm font-medium text-slate-700">Configured speakers</h3>
	<ul class="flex flex-col gap-2">
		{#each musicSpeakers as speaker (speaker.id)}
			<li class="flex items-center gap-3 rounded border border-slate-200 px-3 py-2 text-sm">
				<span>{speaker.castName}</span>
				<button
					type="button"
					onclick={() => removeSpeaker(speaker.id)}
					class="ml-auto text-slate-400 hover:text-red-600"
				>
					Remove
				</button>
			</li>
		{:else}
			<li class="text-slate-400">No speakers configured yet.</li>
		{/each}
	</ul>
</section>
