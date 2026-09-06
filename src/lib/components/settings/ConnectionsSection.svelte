<script lang="ts">
	import type { ConnectionSummary } from '$lib/server/connections';

	let { connections }: { connections: ConnectionSummary[] } = $props();
</script>

<section class="mt-10">
	<h2 class="mb-3 text-lg font-medium">Connections</h2>
	{#if connections.length === 0}
		<p class="text-slate-400">Nothing connected yet.</p>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each connections as connection (connection.id)}
				<li class="flex items-center gap-3 rounded border border-slate-200 px-3 py-2 text-sm">
					<span
						class="h-2.5 w-2.5 shrink-0 rounded-full {connection.status === 'ok'
							? 'bg-green-500'
							: 'bg-red-500'}"
					></span>
					<span class="font-medium capitalize">{connection.provider}</span>
					<span class="text-slate-500">{connection.label}</span>
					{#if connection.status === 'ok' && connection.lastSuccess}
						<span class="ml-auto text-slate-400">
							last synced {new Date(connection.lastSuccess).toLocaleString()}
						</span>
					{:else if connection.lastError}
						<span class="ml-auto text-red-600">{connection.lastError}</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
