<script lang="ts">
	let { trackId, class: className }: { trackId: number | null; class: string } = $props();
</script>

<!-- Shared by MusicPanel's song rows and MusicNowPlayingFooter — a placeholder note icon
     always sits underneath, and the real cover (if any) covers it once loaded; a failed
     or missing cover just leaves the placeholder showing, no separate empty state needed.
     trackId null (nothing resolved yet) skips the <img> entirely rather than pointing it
     at a nonsensical URL. -->
<span class="relative {className} shrink-0 overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
	<svg
		viewBox="0 0 24 24"
		class="absolute inset-0 h-full w-full p-2.5 text-slate-400 dark:text-slate-500"
	>
		<path
			d="M9 18V5l11-2v13"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		<circle cx="6" cy="18" r="3" fill="currentColor" />
		<circle cx="17" cy="16" r="3" fill="currentColor" />
	</svg>
	{#if trackId !== null}
		<img
			src="/api/music/tracks/{trackId}/cover"
			alt=""
			loading="lazy"
			class="absolute inset-0 h-full w-full object-cover"
			onerror={(e) => {
				(e.currentTarget as HTMLImageElement).style.display = 'none';
			}}
		/>
	{/if}
</span>
