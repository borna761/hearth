<script lang="ts">
	let { class: className }: { class: string } = $props();
</script>

<!-- §6.1 point 3: a small pending mark on unsynced items; nothing is ever lost, only
     delayed, and this is the visible reminder of that. Shared by GroceryPanel and
     TasksPanel, which both show it on an item's row for the same reason. -->
<span class="{className} shrink-0 rounded-full bg-amber-400" aria-label="Not yet synced"></span>
