<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	// docs/phase-5-plan.md M6. No pre-fill from an existing connection — secrets never
	// travel back down to the client (connections.ts's listConnections deliberately omits
	// them), so this is always a blank "enter credentials" form, functioning as both
	// first-time connect and password rotation the same way scripts/connect-anylist.mjs's
	// "re-running this rotates the password" already does.
	let anylistEmail = $state('');
	let anylistPassword = $state('');
	let savingAnyList = $state(false);
	let anylistError = $state<string | null>(null);
	let anylistResult = $state<'connected' | 'saved-only' | null>(null);

	async function connectAnyList(event: SubmitEvent) {
		event.preventDefault();
		if (!anylistEmail.trim() || !anylistPassword) return;
		savingAnyList = true;
		anylistError = null;
		anylistResult = null;
		try {
			const res = await fetch('/api/settings/anylist', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email: anylistEmail.trim(), password: anylistPassword })
			});
			if (!res.ok) {
				anylistError = 'Something went wrong. Try again.';
				return;
			}
			const body = await res.json();
			anylistResult = body.connected ? 'connected' : 'saved-only';
			anylistPassword = '';
			await invalidateAll();
		} finally {
			savingAnyList = false;
		}
	}
</script>

<section class="mt-10">
	<h2 class="mb-3 text-lg font-medium">Groceries (AnyList)</h2>
	<p class="mb-3 text-sm text-slate-500">
		Connects "My Grocery List" from an AnyList account. Re-entering credentials here rotates the
		stored password without disturbing the connection's status below.
	</p>
	<form onsubmit={connectAnyList} class="flex max-w-sm flex-col gap-3">
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium text-slate-500">Email</span>
			<input
				type="email"
				autocomplete="off"
				bind:value={anylistEmail}
				disabled={savingAnyList}
				class="rounded border border-slate-300 px-3 py-2 text-sm"
			/>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium text-slate-500">Password</span>
			<input
				type="password"
				autocomplete="off"
				bind:value={anylistPassword}
				disabled={savingAnyList}
				class="rounded border border-slate-300 px-3 py-2 text-sm"
			/>
		</label>
		<button
			type="submit"
			disabled={!anylistEmail.trim() || !anylistPassword || savingAnyList}
			class="self-start rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
		>
			Connect
		</button>
		{#if anylistError}
			<p class="text-sm text-red-600">{anylistError}</p>
		{:else if anylistResult === 'connected'}
			<p class="text-sm text-green-600">Connected.</p>
		{:else if anylistResult === 'saved-only'}
			<!-- initGroceriesRuntime already marked the connection's status/lastError,
			     which the Connections list right below renders — no separate error text
			     to keep in sync with that here. -->
			<p class="text-sm text-amber-600">Saved, but couldn't log in — check the status below.</p>
		{/if}
	</form>
</section>
