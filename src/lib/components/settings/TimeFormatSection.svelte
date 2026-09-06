<script lang="ts">
	import { untrack } from 'svelte';
	import type { TimeFormat } from '$lib/week/format';

	let {
		timeFormat: initialTimeFormat,
		showToast
	}: { timeFormat: TimeFormat; showToast: (message: string) => void } = $props();

	// Re-seeded the same way theme mode is.
	let timeFormat = $state<TimeFormat>('24h');
	$effect(() => {
		untrack(() => {
			timeFormat = initialTimeFormat;
		});
	});
	let savingTimeFormat = $state(false);
	let timeFormatError = $state<string | null>(null);

	async function saveTimeFormat(format: TimeFormat) {
		const previous = timeFormat;
		timeFormat = format;
		savingTimeFormat = true;
		timeFormatError = null;
		try {
			const res = await fetch('/api/settings/time-format', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value: format })
			});
			if (!res.ok) {
				timeFormat = previous;
				timeFormatError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingTimeFormat = false;
		}
	}
</script>

<section class="mt-10">
	<h2 class="mb-3 text-lg font-medium">Time format</h2>
	<div class="flex max-w-sm gap-2">
		{#each [{ value: '12h', label: '12-hour' }, { value: '24h', label: '24-hour' }] as option (option.value)}
			<button
				type="button"
				disabled={savingTimeFormat}
				onclick={() => saveTimeFormat(option.value as TimeFormat)}
				class="flex-1 rounded border px-3 py-2 text-sm font-medium disabled:opacity-40 {timeFormat ===
				option.value
					? 'border-blue-600 bg-blue-600 text-white'
					: 'border-slate-300 text-slate-700'}"
			>
				{option.label}
			</button>
		{/each}
	</div>
	{#if timeFormatError}
		<p class="mt-2 text-sm text-red-600">{timeFormatError}</p>
	{/if}
</section>
