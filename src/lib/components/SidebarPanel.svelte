<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		onClose,
		closeLabel,
		width,
		children
	}: {
		onClose: () => void;
		closeLabel: string;
		width: string;
		children: Snippet;
	} = $props();
</script>

<!-- Invisible tap-to-close target for everything outside the sidebar. No dimming — the
     whole point of the sidebar over the old full-bleed layout was to keep the dashboard
     visible, and a scrim would fight that. Sits below the sidebar in stacking order so a
     tap on the sidebar itself never reaches it. Shared by GroceryPanel/TasksPanel/
     MusicPanel — same shell, only the width and what's inside differ. -->
<button type="button" onclick={onClose} aria-label={closeLabel} class="absolute inset-0 z-10"
></button>

<!-- Sidebar over the right edge of the grid, not full-bleed — the rest of the dashboard
     (calendar, weather) stays visible and reachable while a panel is open. Translucent
     (bg-white/90), not blurred — DESIGN.md §2.4 rules out backdrop-filter/blur on this
     hardware, same reasoning Screensaver.svelte's own overlay already follows. /90 rather
     than /70: over a busy calendar the lower opacity let background text bleed through
     list rows enough to hurt readability. -->
<div
	class="absolute inset-y-0 right-0 z-20 flex {width} flex-col border-l border-slate-200 bg-white/90 shadow-xl dark:border-slate-700 dark:bg-slate-900/90"
>
	{@render children()}
</div>
