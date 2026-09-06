<script lang="ts">
	import { untrack } from 'svelte';
	import type { ThemeMode } from '$lib/theme';

	let {
		themeMode: initialThemeMode,
		showToast
	}: { themeMode: ThemeMode; showToast: (message: string) => void } = $props();

	// Re-seeded the same way quiet hours is — see QuietHoursSection's own comment for why
	// this component needs an effect rather than a mount-time-only seed.
	let themeMode = $state<ThemeMode>('auto');
	$effect(() => {
		untrack(() => {
			themeMode = initialThemeMode;
		});
	});
	let savingThemeMode = $state(false);
	let themeModeError = $state<string | null>(null);

	async function saveThemeMode(mode: ThemeMode) {
		const previous = themeMode;
		themeMode = mode;
		savingThemeMode = true;
		themeModeError = null;
		try {
			const res = await fetch('/api/settings/theme-mode', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value: mode })
			});
			if (!res.ok) {
				themeMode = previous;
				themeModeError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingThemeMode = false;
		}
	}
</script>

<section class="mt-10">
	<h2 class="mb-3 text-lg font-medium">Theme</h2>
	<p class="mb-3 text-sm text-slate-500">
		Auto follows the sun at the household's location; light and dark override it.
	</p>
	<div class="flex max-w-sm gap-2">
		{#each [{ value: 'auto', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] as option (option.value)}
			<button
				type="button"
				disabled={savingThemeMode}
				onclick={() => saveThemeMode(option.value as ThemeMode)}
				class="flex-1 rounded border px-3 py-2 text-sm font-medium disabled:opacity-40 {themeMode ===
				option.value
					? 'border-blue-600 bg-blue-600 text-white'
					: 'border-slate-300 text-slate-700'}"
			>
				{option.label}
			</button>
		{/each}
	</div>
	{#if themeModeError}
		<p class="mt-2 text-sm text-red-600">{themeModeError}</p>
	{/if}
</section>
