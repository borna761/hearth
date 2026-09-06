<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	// Same shape as the AnyList form, one token field instead of email+password.
	let todoistToken = $state('');
	let savingTodoist = $state(false);
	let todoistError = $state<string | null>(null);
	let todoistResult = $state<'connected' | 'saved-only' | null>(null);

	async function connectTodoist(event: SubmitEvent) {
		event.preventDefault();
		if (!todoistToken.trim()) return;
		savingTodoist = true;
		todoistError = null;
		todoistResult = null;
		try {
			const res = await fetch('/api/settings/todoist', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: todoistToken.trim() })
			});
			if (!res.ok) {
				todoistError = 'Something went wrong. Try again.';
				return;
			}
			const body = await res.json();
			todoistResult = body.connected ? 'connected' : 'saved-only';
			todoistToken = '';
			await invalidateAll();
		} finally {
			savingTodoist = false;
		}
	}
</script>

<section class="mt-10">
	<h2 class="mb-3 text-lg font-medium">Tasks (Todoist)</h2>
	<p class="mb-3 text-sm text-slate-500">
		Shows overdue and due-today tasks from a personal Todoist account. Re-entering the token here
		rotates it without disturbing the connection's status below.
	</p>
	<form onsubmit={connectTodoist} class="flex max-w-sm flex-col gap-3">
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium text-slate-500">Personal API token</span>
			<input
				type="password"
				autocomplete="off"
				bind:value={todoistToken}
				disabled={savingTodoist}
				class="rounded border border-slate-300 px-3 py-2 text-sm"
			/>
		</label>
		<button
			type="submit"
			disabled={!todoistToken.trim() || savingTodoist}
			class="self-start rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
		>
			Connect
		</button>
		{#if todoistError}
			<p class="text-sm text-red-600">{todoistError}</p>
		{:else if todoistResult === 'connected'}
			<p class="text-sm text-green-600">Connected.</p>
		{:else if todoistResult === 'saved-only'}
			<p class="text-sm text-amber-600">Saved, but couldn't connect — check the status below.</p>
		{/if}
	</form>
</section>
