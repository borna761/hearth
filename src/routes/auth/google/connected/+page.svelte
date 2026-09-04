<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Google connected — Hearth</title></svelte:head>

<main class="mx-auto max-w-md p-8">
	{#if data.account}
		<h1 class="text-2xl font-semibold">Google connected</h1>
		<p class="mt-2 text-slate-600">
			Authorized as <strong>{data.account}</strong>.
		</p>
	{:else}
		<h1 class="text-2xl font-semibold">Not connected</h1>
		<p class="mt-2 text-slate-600">
			No Google connection is stored.
			<a class="underline" href={resolve('/auth/google/start')}>Start again</a>.
		</p>
	{/if}
</main>
