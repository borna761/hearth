<script lang="ts">
	import PinPad from './PinPad.svelte';
	import type { PublicUser } from '$lib/server/users';
	import type { Weather } from '$lib/server/weather';
	import { localMinutesInZone } from '$lib/datetime';
	import { formatMinutes, type TimeFormat } from '$lib/week/format';

	type LoginResponse =
		| { ok: true }
		| { ok: false; reason: 'invalid' }
		| { ok: false; reason: 'wrong'; attemptsRemaining: number }
		| { ok: false; reason: 'locked'; lockedUntil: string };

	let {
		users,
		timeZone,
		weather,
		timeFormat,
		onLogin,
		onGuest,
		onCancel
	}: {
		users: PublicUser[];
		timeZone: string;
		weather: Weather | null;
		timeFormat: TimeFormat;
		onLogin: (userId: number, pin: string) => Promise<LoginResponse>;
		onGuest: () => void;
		onCancel: () => void;
	} = $props();

	// §7.2: "the same clock and weather" as the screensaver. Computed client-side exactly
	// like Screensaver.svelte's own clock — no SSE needed for a clock, and Lock is only
	// ever on screen for a few seconds, so a plain interval is plenty.
	let now = $state(new Date());
	$effect(() => {
		const id = setInterval(() => (now = new Date()), 15_000);
		return () => clearInterval(id);
	});
	let clock = $derived(formatMinutes(localMinutesInZone(now, timeZone), timeFormat));

	// Fixed length (DESIGN.md §13: "four-digit PINs") is what makes auto-submit
	// unambiguous — there's never a "did they mean to stop early?" case to guess at.
	const PIN_LENGTH = 4;

	let selectedUser = $state<PublicUser | null>(null);
	let pin = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let lockedUntil = $state<Date | null>(null);
	let lockSecondsLeft = $state(0);

	$effect(() => {
		if (!lockedUntil) return;
		const tick = () => {
			const remaining = Math.max(0, Math.ceil((lockedUntil!.getTime() - Date.now()) / 1000));
			lockSecondsLeft = remaining;
			if (remaining === 0) lockedUntil = null;
		};
		tick();
		const id = setInterval(tick, 1000);
		return () => clearInterval(id);
	});

	$effect(() => {
		if (pin.length === PIN_LENGTH) submit();
	});

	function selectUser(user: PublicUser) {
		selectedUser = user;
		pin = '';
		error = null;
	}

	function backToAvatars() {
		selectedUser = null;
		pin = '';
		error = null;
		lockedUntil = null;
	}

	async function submit() {
		if (!selectedUser || pin.length !== PIN_LENGTH || submitting || lockedUntil) return;
		submitting = true;
		error = null;
		try {
			const result = await onLogin(selectedUser.id, pin);
			if (!result.ok) {
				pin = '';
				if (result.reason === 'locked') {
					lockedUntil = new Date(result.lockedUntil);
				} else if (result.reason === 'wrong') {
					error = `Wrong PIN — ${result.attemptsRemaining} attempt${result.attemptsRemaining === 1 ? '' : 's'} left`;
				} else {
					error = 'Something went wrong. Try again.';
				}
			}
			// On success, the parent (+page.svelte) transitions away from this component
			// entirely — nothing left to do here.
		} finally {
			submitting = false;
		}
	}
</script>

<!-- Full-screen backdrop; tapping outside the card returns to the screensaver rather than
     leaving someone stuck on this screen with no specified way back (DESIGN.md §5 doesn't
     describe an explicit lock-screen timeout, but trapping the user here is worse). -->
<div class="flex h-full w-full items-center justify-center bg-slate-950/90">
	<button
		type="button"
		class="absolute inset-0 h-full w-full cursor-default"
		aria-label="Back to screensaver"
		onclick={onCancel}
	></button>

	<!-- Clock/weather and the card are one flex column so the card growing taller (avatar
	     picker -> name + PIN pad) re-centers the whole group instead of the two colliding —
	     a fixed top offset for the clock clipped against the card in the PIN-entry state. -->
	<div class="relative flex flex-col items-center gap-4">
		<!-- §7.2: "the same clock and weather" as the screensaver — no event names, no
		     counts, nothing that leaks, just the same ambient reading everyone sees resting. -->
		<div class="flex flex-col items-center gap-1 text-white">
			<p class="text-3xl leading-none font-light tabular-nums">{clock}</p>
			{#if weather}
				<p class="text-sm text-slate-300">{weather.temperatureC}° {weather.condition}</p>
			{/if}
		</div>

		<div
			class="flex flex-col items-center gap-4 rounded-2xl bg-white p-6 shadow-xl dark:bg-slate-800"
		>
			{#if !selectedUser}
				<div class="flex gap-5">
					{#each users as user (user.id)}
						<button
							type="button"
							onclick={() => selectUser(user)}
							class="flex h-20 w-20 flex-col items-center justify-center rounded-full text-base font-semibold text-white active:opacity-80"
							style="background-color: {user.color}"
						>
							{user.name}
						</button>
					{/each}
					<button
						type="button"
						onclick={onGuest}
						class="flex h-20 w-20 flex-col items-center justify-center rounded-full border-2 border-dashed border-slate-300 text-sm font-medium text-slate-500 active:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:active:bg-slate-700"
					>
						Guest
					</button>
				</div>
			{:else}
				<div class="flex items-center gap-3">
					<span
						class="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-white"
						style="background-color: {selectedUser.color}"
					>
						{selectedUser.name[0]}
					</span>
					<p class="text-base font-medium text-slate-800 dark:text-slate-100">
						{selectedUser.name}
					</p>
					<button
						type="button"
						onclick={backToAvatars}
						class="ml-2 text-sm text-slate-400 underline dark:text-slate-500"
					>
						not you?
					</button>
				</div>

				{#if lockedUntil}
					<p class="text-amber-600">Too many wrong PINs — try again in {lockSecondsLeft}s</p>
				{:else}
					{#if error}
						<p class="text-sm text-red-600">{error}</p>
					{/if}
					<PinPad
						value={pin}
						disabled={submitting}
						onDigit={(d) => {
							if (pin.length < PIN_LENGTH) pin += d;
						}}
						onBackspace={() => (pin = pin.slice(0, -1))}
					/>
				{/if}
			{/if}
		</div>
	</div>
</div>
