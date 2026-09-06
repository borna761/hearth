<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { PublicUser } from '$lib/server/users';

	let { adminUsers }: { adminUsers: PublicUser[] } = $props();

	let selectedUserId = $state<number | null>(null);
	let pin = $state('');
	let loginError = $state<string | null>(null);
	let loggingIn = $state(false);

	async function login(event: SubmitEvent) {
		event.preventDefault();
		if (selectedUserId === null || pin.length === 0) return;
		loggingIn = true;
		loginError = null;
		try {
			const res = await fetch('/api/settings/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ userId: selectedUserId, pin })
			});
			const body = await res.json();
			if (!res.ok) {
				pin = '';
				loginError =
					body.reason === 'locked' ? 'Too many wrong PINs — try again in a minute.' : 'Wrong PIN.';
				return;
			}
			await invalidateAll();
		} finally {
			loggingIn = false;
		}
	}
</script>

<form onsubmit={login} class="flex max-w-sm flex-col gap-4">
	<div>
		<span class="mb-1 block text-sm font-medium text-slate-600">Who are you?</span>
		<div class="flex gap-2">
			{#each adminUsers as user (user.id)}
				<button
					type="button"
					onclick={() => (selectedUserId = user.id)}
					class="rounded-full px-4 py-2 text-sm font-medium text-white {selectedUserId === user.id
						? 'ring-2 ring-offset-2'
						: ''}"
					style="background-color: {user.color}"
				>
					{user.name}
				</button>
			{/each}
		</div>
	</div>

	<label class="flex flex-col gap-1">
		<span class="text-sm font-medium text-slate-600">PIN</span>
		<input
			type="password"
			inputmode="numeric"
			autocomplete="off"
			bind:value={pin}
			disabled={selectedUserId === null || loggingIn}
			class="rounded border border-slate-300 px-3 py-2"
		/>
	</label>

	{#if loginError}
		<p class="text-sm text-red-600">{loginError}</p>
	{/if}

	<button
		type="submit"
		disabled={selectedUserId === null || pin.length === 0 || loggingIn}
		class="rounded bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-40"
	>
		Log in
	</button>
</form>
