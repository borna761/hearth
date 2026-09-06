<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { PublicUser } from '$lib/server/users';

	let { users }: { users: PublicUser[] } = $props();

	let resetUserId = $state<number | null>(null);
	let newPin = $state('');
	let confirmPin = $state('');
	let pinError = $state<string | null>(null);
	let savingPin = $state(false);
	let pinSuccessUserId = $state<number | null>(null);

	function startPinReset(userId: number) {
		resetUserId = userId;
		newPin = '';
		confirmPin = '';
		pinError = null;
		pinSuccessUserId = null;
	}

	async function savePin(event: SubmitEvent) {
		event.preventDefault();
		if (resetUserId === null) return;
		if (!/^\d{4}$/.test(newPin)) {
			pinError = 'PIN must be exactly 4 digits.';
			return;
		}
		if (newPin !== confirmPin) {
			pinError = "Those didn't match.";
			return;
		}
		savingPin = true;
		pinError = null;
		try {
			const res = await fetch('/api/settings/pin', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ userId: resetUserId, pin: newPin })
			});
			if (!res.ok) {
				pinError = 'Something went wrong. Try again.';
				return;
			}
			pinSuccessUserId = resetUserId;
			resetUserId = null;
		} finally {
			savingPin = false;
		}
	}

	let colorEditUserId = $state<number | null>(null);
	let colorValue = $state('#000000');
	let colorError = $state<string | null>(null);
	let savingColor = $state(false);

	function startColorEdit(userId: number, currentColor: string) {
		colorEditUserId = userId;
		colorValue = currentColor;
		colorError = null;
	}

	async function saveColor(event: SubmitEvent) {
		event.preventDefault();
		if (colorEditUserId === null) return;
		savingColor = true;
		colorError = null;
		try {
			const res = await fetch('/api/settings/user-color', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ userId: colorEditUserId, color: colorValue })
			});
			if (!res.ok) {
				colorError = 'Something went wrong. Try again.';
				return;
			}
			colorEditUserId = null;
			await invalidateAll();
		} finally {
			savingColor = false;
		}
	}
</script>

<section class="mt-10">
	<h2 class="mb-3 text-lg font-medium">User settings</h2>
	<ul class="flex flex-col gap-2">
		{#each users as user (user.id)}
			<li class="rounded border border-slate-200 px-3 py-2">
				<div class="flex items-center gap-3">
					<span
						class="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white"
						style="background-color: {user.color}"
					>
						{user.name[0]}
					</span>
					<span class="text-sm font-medium">{user.name}</span>
					<div class="ml-auto flex items-center gap-4">
						{#if pinSuccessUserId === user.id}
							<span class="text-sm text-green-600">PIN updated</span>
						{:else if resetUserId !== user.id}
							<button
								type="button"
								onclick={() => startPinReset(user.id)}
								class="text-sm text-blue-600 underline"
							>
								Change PIN
							</button>
						{/if}
						{#if colorEditUserId !== user.id}
							<button
								type="button"
								onclick={() => startColorEdit(user.id, user.color)}
								class="text-sm text-blue-600 underline"
							>
								Change color
							</button>
						{/if}
					</div>
				</div>

				{#if resetUserId === user.id}
					<form onsubmit={savePin} class="mt-3 flex flex-wrap items-center gap-2">
						<input
							type="password"
							inputmode="numeric"
							autocomplete="off"
							placeholder="New PIN"
							bind:value={newPin}
							disabled={savingPin}
							class="w-28 rounded border border-slate-300 px-3 py-2 text-sm"
						/>
						<input
							type="password"
							inputmode="numeric"
							autocomplete="off"
							placeholder="Confirm"
							bind:value={confirmPin}
							disabled={savingPin}
							class="w-28 rounded border border-slate-300 px-3 py-2 text-sm"
						/>
						<button
							type="submit"
							disabled={savingPin}
							class="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
						>
							Save
						</button>
						<button
							type="button"
							onclick={() => (resetUserId = null)}
							class="text-sm text-slate-500"
						>
							Cancel
						</button>
						{#if pinError}
							<p class="w-full text-sm text-red-600">{pinError}</p>
						{/if}
					</form>
				{/if}

				{#if colorEditUserId === user.id}
					<form onsubmit={saveColor} class="mt-3 flex flex-wrap items-center gap-2">
						<input
							type="color"
							bind:value={colorValue}
							disabled={savingColor}
							class="h-9 w-14 cursor-pointer rounded border border-slate-300 p-0.5"
						/>
						<button
							type="submit"
							disabled={savingColor}
							class="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
						>
							Save
						</button>
						<button
							type="button"
							onclick={() => (colorEditUserId = null)}
							class="text-sm text-slate-500"
						>
							Cancel
						</button>
						{#if colorError}
							<p class="w-full text-sm text-red-600">{colorError}</p>
						{/if}
					</form>
				{/if}
			</li>
		{/each}
	</ul>
</section>
