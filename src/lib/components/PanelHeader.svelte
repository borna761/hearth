<script lang="ts">
	import PanelCloseButton from './PanelCloseButton.svelte';

	let {
		title,
		subtitle,
		staleMessage = null,
		onClose,
		sizes
	}: {
		title: string;
		subtitle: string;
		/** DESIGN.md §2.5: "an outage degrades one card to a stale badge, never the page" —
		 *  null hides the badge entirely. */
		staleMessage?: string | null;
		onClose: () => void;
		sizes: {
			headerHeight: string;
			title: string;
			subtitle: string;
			stale: string;
			closeBtn: string;
		};
	} = $props();
</script>

<!-- Shared by GroceryPanel and TasksPanel — same title/subtitle/stale-badge/close-button
     shape, differing only in the text each passes in. -->
<header
	class="flex {sizes.headerHeight} shrink-0 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-700"
>
	<div class="flex items-baseline gap-2.5">
		<h1 class="{sizes.title} font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
		<p class="{sizes.subtitle} text-slate-500 dark:text-slate-400">{subtitle}</p>
		{#if staleMessage}
			<span
				class="rounded bg-amber-100 {sizes.stale} font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
			>
				{staleMessage}
			</span>
		{/if}
	</div>
	<PanelCloseButton {onClose} sizeClass={sizes.closeBtn} />
</header>
