<script lang="ts">
	let { onClose, sizeClass }: { onClose: () => void; sizeClass: string } = $props();
</script>

<!-- Shared by PanelHeader (Grocery/Tasks) and MusicPanel's own inline header — same "Done"
     button in all three sidebar panels, regardless of whether the rest of the header comes
     from PanelHeader or is hand-rolled. -->
<button
	type="button"
	onclick={onClose}
	aria-label="Done"
	class="flex {sizeClass} items-center justify-center rounded-full text-slate-500 active:bg-slate-100 dark:text-slate-400 dark:active:bg-slate-800"
>
	✕
</button>
