<script lang="ts">
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let selectedUserId = $state<number | null>(null);
	let pin = $state('');
	let loginError = $state<string | null>(null);
	let loggingIn = $state(false);

	// One shared toast for every form's save confirmation on this page, rather than each
	// section managing its own inline "Saved" state — a single fixed-position notice reads
	// more clearly than several scattered around a long settings page.
	let toastMessage = $state<string | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | null = null;
	function showToast(message: string) {
		toastMessage = message;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toastMessage = null), 2000);
	}

	// Split into two <input type="time"> fields rather than one HH:MM-HH:MM text field —
	// native time pickers can't produce a malformed value, so the only error path left is
	// a real network failure, not a typo in the punctuation.
	//
	// Re-seeded via an effect on data.quietHoursValue rather than once at mount: logging in
	// through this page's own inline form (as opposed to arriving already authenticated)
	// doesn't remount the component, only flips data.authorized via invalidateAll — a
	// mount-time-only seed would leave these fields stuck on the placeholder default forever
	// in that case. untrack on the write side keeps typing from fighting this re-sync.
	let quietHoursStart = $state('22:00');
	let quietHoursEnd = $state('07:00');
	$effect(() => {
		if (!data.authorized) return;
		const [start, end] = data.quietHoursValue.split('-');
		untrack(() => {
			quietHoursStart = start;
			quietHoursEnd = end;
		});
	});
	let quietHoursError = $state<string | null>(null);
	let savingQuietHours = $state(false);

	async function saveQuietHours(event: SubmitEvent) {
		event.preventDefault();
		savingQuietHours = true;
		quietHoursError = null;
		try {
			const res = await fetch('/api/settings/quiet-hours', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value: `${quietHoursStart}-${quietHoursEnd}` })
			});
			if (!res.ok) {
				quietHoursError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingQuietHours = false;
		}
	}

	// Same split-fields shape as quiet hours, plus a checkbox — unlike quiet hours, an unset
	// window is a real, common state (music always available), not just a startup gap.
	let musicHoursEnabled = $state(false);
	let musicHoursStart = $state('09:00');
	let musicHoursEnd = $state('21:00');
	$effect(() => {
		if (!data.authorized) return;
		const [start, end] = data.musicHoursValue ? data.musicHoursValue.split('-') : [null, null];
		untrack(() => {
			musicHoursEnabled = !!data.musicHoursValue;
			if (start) musicHoursStart = start;
			if (end) musicHoursEnd = end;
		});
	});
	let musicHoursError = $state<string | null>(null);
	let savingMusicHours = $state(false);

	async function saveMusicHours(event: SubmitEvent) {
		event.preventDefault();
		musicHoursError = null;
		// Same time twice parses fine server-side but leaves music permanently unavailable
		// with no other way to notice — catch it here instead of round-tripping to find out.
		if (musicHoursEnabled && musicHoursStart === musicHoursEnd) {
			musicHoursError = 'Start and end can’t be the same time.';
			return;
		}
		savingMusicHours = true;
		try {
			const res = await fetch('/api/settings/music-hours', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					value: musicHoursEnabled ? `${musicHoursStart}-${musicHoursEnd}` : ''
				})
			});
			if (!res.ok) {
				musicHoursError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingMusicHours = false;
		}
	}

	// Re-seeded the same way quiet hours is (see above) — this page's own inline login
	// doesn't remount the component.
	let themeMode = $state<'auto' | 'light' | 'dark'>('auto');
	$effect(() => {
		if (!data.authorized) return;
		untrack(() => {
			themeMode = data.themeMode;
		});
	});
	let savingThemeMode = $state(false);
	let themeModeError = $state<string | null>(null);

	async function saveThemeMode(mode: 'auto' | 'light' | 'dark') {
		const previous = themeMode;
		themeMode = mode;
		savingThemeMode = true;
		themeModeError = null;
		try {
			const res = await fetch('/api/settings/theme-mode', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value: mode })
			});
			if (!res.ok) {
				themeMode = previous;
				themeModeError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingThemeMode = false;
		}
	}

	// Re-seeded the same way theme mode is (see above).
	let timeFormat = $state<'12h' | '24h'>('24h');
	$effect(() => {
		if (!data.authorized) return;
		untrack(() => {
			timeFormat = data.timeFormat;
		});
	});
	let savingTimeFormat = $state(false);
	let timeFormatError = $state<string | null>(null);

	async function saveTimeFormat(format: '12h' | '24h') {
		const previous = timeFormat;
		timeFormat = format;
		savingTimeFormat = true;
		timeFormatError = null;
		try {
			const res = await fetch('/api/settings/time-format', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value: format })
			});
			if (!res.ok) {
				timeFormat = previous;
				timeFormatError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingTimeFormat = false;
		}
	}

	// Split into two plain-number fields for the same reason quiet hours splits into two
	// time fields — a bad value should come from a real network failure, not a typo in the
	// punctuation of a combined 'lat,lng' string. Re-seeded the same way quiet hours is.
	let latitude = $state('45.5');
	let longitude = $state('-75.5');
	$effect(() => {
		if (!data.authorized) return;
		const [lat, lng] = data.locationValue.split(',');
		untrack(() => {
			latitude = lat;
			longitude = lng;
		});
	});
	let locationError = $state<string | null>(null);
	let savingLocation = $state(false);

	async function saveLocation(event: SubmitEvent) {
		event.preventDefault();
		savingLocation = true;
		locationError = null;
		try {
			const res = await fetch('/api/settings/location', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value: `${latitude},${longitude}` })
			});
			if (!res.ok) {
				locationError = 'Something went wrong. Check both values are valid coordinates.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingLocation = false;
		}
	}

	// Re-seeded the same way quiet hours/theme mode are.
	let timeZone = $state('America/Toronto');
	$effect(() => {
		if (!data.authorized) return;
		untrack(() => {
			timeZone = data.timeZone;
		});
	});
	let timeZoneError = $state<string | null>(null);
	let savingTimeZone = $state(false);

	async function saveTimeZone(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		const previous = timeZone;
		timeZone = value;
		savingTimeZone = true;
		timeZoneError = null;
		try {
			const res = await fetch('/api/settings/timezone', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ value })
			});
			if (!res.ok) {
				timeZone = previous;
				timeZoneError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingTimeZone = false;
		}
	}

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

	// Same shape as the AnyList form above, one token field instead of email+password.
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

	// docs/phase-7-music-plan.md — "Scan for speakers" lists every discoverable Cast
	// friendly name (individual speakers and groups alike) so the household picks from
	// what's actually on the network rather than typing a name blind.
	let scanningForSpeakers = $state(false);
	let discoveredSpeakerNames = $state<string[] | null>(null);
	let scanError = $state<string | null>(null);
	let addingSpeakerName = $state<string | null>(null);

	async function scanForSpeakers() {
		scanningForSpeakers = true;
		scanError = null;
		discoveredSpeakerNames = null;
		try {
			const res = await fetch('/api/settings/music-speakers/scan', { method: 'POST' });
			if (!res.ok) {
				scanError = 'Something went wrong. Try again.';
				return;
			}
			const body = await res.json();
			discoveredSpeakerNames = body.names;
		} finally {
			scanningForSpeakers = false;
		}
	}

	async function addDiscoveredSpeaker(castName: string) {
		addingSpeakerName = castName;
		try {
			const res = await fetch('/api/settings/music-speakers', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ castName })
			});
			if (res.ok) await invalidateAll();
		} finally {
			addingSpeakerName = null;
		}
	}

	async function removeSpeaker(id: number) {
		await fetch(`/api/settings/music-speakers/${id}`, { method: 'DELETE' }).catch(() => {});
		await invalidateAll();
	}

	// Re-seeded the same way timeZone/quiet-hours/theme mode are above.
	let restrictedTaskProjectId = $state<string | null>(null);
	$effect(() => {
		if (!data.authorized) return;
		untrack(() => {
			restrictedTaskProjectId = data.restrictedTaskProjectId;
		});
	});
	let savingRestrictedProject = $state(false);
	let restrictedProjectError = $state<string | null>(null);

	async function saveRestrictedProject(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		const previous = restrictedTaskProjectId;
		restrictedTaskProjectId = value;
		savingRestrictedProject = true;
		restrictedProjectError = null;
		try {
			const res = await fetch('/api/settings/task-restricted-project', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ projectId: value })
			});
			if (!res.ok) {
				restrictedTaskProjectId = previous;
				restrictedProjectError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingRestrictedProject = false;
		}
	}

	// Auto-saves per user, same reasoning as the visibility matrix's toggle() above.
	let savingTaskAccessUserId = $state<number | null>(null);
	let taskAccessError = $state<string | null>(null);

	async function saveTaskAccess(userId: number, event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value as
			'all-but-one' | 'only-one' | 'none';
		const user = data.authorized ? data.users.find((u) => u.id === userId) : undefined;
		const previous = user?.taskAccess;
		if (user) user.taskAccess = value; // optimistic
		savingTaskAccessUserId = userId;
		taskAccessError = null;
		try {
			const res = await fetch('/api/settings/task-access', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ userId, taskAccess: value })
			});
			if (!res.ok) {
				if (user && previous) user.taskAccess = previous; // revert
				taskAccessError = 'Something went wrong. Try again.';
			} else {
				showToast('Saved');
			}
		} finally {
			savingTaskAccessUserId = null;
		}
	}

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

	// Auto-saves on every toggle rather than requiring a separate save flow (DESIGN.md
	// doesn't specify one either way) — each toggle is already a single well-defined write.
	async function toggle(rowKey: string, sourceIds: number[], userId: number, next: boolean) {
		if (data.authorized) data.checked[rowKey][userId] = next; // optimistic
		const res = await fetch('/api/settings/visibility', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ userId, sourceIds, visible: next })
		});
		if (!res.ok) {
			if (data.authorized) data.checked[rowKey][userId] = !next; // revert on failure
		} else {
			showToast('Saved');
		}
	}
</script>

<svelte:head><title>Settings — Hearth</title></svelte:head>

<main class="mx-auto max-w-3xl p-6 text-slate-900">
	<h1 class="mb-6 text-2xl font-semibold">Hearth settings</h1>

	{#if !data.authorized && data.reason === 'not-admin'}
		<p class="text-slate-600">This account can't access settings.</p>
	{:else if !data.authorized}
		<form onsubmit={login} class="flex max-w-sm flex-col gap-4">
			<div>
				<span class="mb-1 block text-sm font-medium text-slate-600">Who are you?</span>
				<div class="flex gap-2">
					{#each data.adminUsers as user (user.id)}
						<button
							type="button"
							onclick={() => (selectedUserId = user.id)}
							class="rounded-full px-4 py-2 text-sm font-medium text-white {selectedUserId ===
							user.id
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
	{:else}
		<section>
			<h2 class="mb-3 text-lg font-medium">Calendar visibility</h2>
			<p class="mb-4 text-sm text-slate-500">
				Which calendars each person sees on the tablet. Football's four feeds are grouped into one
				row.
			</p>

			{#if data.rows.length === 0}
				<p class="text-slate-400">No calendars discovered yet.</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full border-collapse text-left text-sm">
						<thead>
							<tr>
								<th class="border-b border-slate-200 py-2 pr-4">Calendar</th>
								{#each data.users as user (user.id)}
									<th class="border-b border-slate-200 px-3 py-2 text-center">{user.name}</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each data.rows as row (row.key)}
								<tr>
									<td class="border-b border-slate-100 py-2 pr-4">{row.label}</td>
									{#each data.users as user (user.id)}
										<td class="border-b border-slate-100 px-3 py-2 text-center">
											<input
												type="checkbox"
												checked={data.checked[row.key][user.id]}
												onchange={(e) =>
													toggle(row.key, row.sourceIds, user.id, e.currentTarget.checked)}
												class="h-5 w-5"
											/>
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<section class="mt-10">
			<h2 class="mb-3 text-lg font-medium">Quiet hours</h2>
			<p class="mb-3 text-sm text-slate-500">
				The window the tablet shows a dimmed night clock instead of the normal display.
			</p>
			<form onsubmit={saveQuietHours} class="flex max-w-sm items-end gap-3">
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium text-slate-500">Starts</span>
					<input
						type="time"
						bind:value={quietHoursStart}
						step="900"
						required
						disabled={savingQuietHours}
						class="rounded border border-slate-300 px-3 py-2 text-sm"
					/>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium text-slate-500">Ends</span>
					<input
						type="time"
						bind:value={quietHoursEnd}
						step="900"
						required
						disabled={savingQuietHours}
						class="rounded border border-slate-300 px-3 py-2 text-sm"
					/>
				</label>
				<button
					type="submit"
					disabled={savingQuietHours}
					class="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
				>
					Save
				</button>
			</form>
			{#if quietHoursError}
				<p class="mt-2 text-sm text-red-600">{quietHoursError}</p>
			{/if}
		</section>

		<section class="mt-10">
			<h2 class="mb-3 text-lg font-medium">Music hours</h2>
			<p class="mb-3 text-sm text-slate-500">
				The window the music button is available in. Outside it, the button hides and any playback
				already going stops automatically. Leave off to allow music at any time.
			</p>
			<form onsubmit={saveMusicHours} class="flex max-w-md flex-col gap-3">
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						bind:checked={musicHoursEnabled}
						disabled={savingMusicHours}
						class="h-4 w-4 rounded border-slate-300"
					/>
					Only allow music within these hours
				</label>
				<div class="flex items-end gap-3">
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-slate-500">Starts</span>
						<input
							type="time"
							bind:value={musicHoursStart}
							step="900"
							required
							disabled={savingMusicHours || !musicHoursEnabled}
							class="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
						/>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-slate-500">Ends</span>
						<input
							type="time"
							bind:value={musicHoursEnd}
							step="900"
							required
							disabled={savingMusicHours || !musicHoursEnabled}
							class="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
						/>
					</label>
					<button
						type="submit"
						disabled={savingMusicHours}
						class="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
					>
						Save
					</button>
				</div>
			</form>
			{#if musicHoursError}
				<p class="mt-2 text-sm text-red-600">{musicHoursError}</p>
			{/if}
		</section>

		<section class="mt-10">
			<h2 class="mb-3 text-lg font-medium">Theme</h2>
			<p class="mb-3 text-sm text-slate-500">
				Auto follows the sun at the household's location; light and dark override it.
			</p>
			<div class="flex max-w-sm gap-2">
				{#each [{ value: 'auto', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] as option (option.value)}
					<button
						type="button"
						disabled={savingThemeMode}
						onclick={() => saveThemeMode(option.value as 'auto' | 'light' | 'dark')}
						class="flex-1 rounded border px-3 py-2 text-sm font-medium disabled:opacity-40 {themeMode ===
						option.value
							? 'border-blue-600 bg-blue-600 text-white'
							: 'border-slate-300 text-slate-700'}"
					>
						{option.label}
					</button>
				{/each}
			</div>
			{#if themeModeError}
				<p class="mt-2 text-sm text-red-600">{themeModeError}</p>
			{/if}
		</section>

		<section class="mt-10">
			<h2 class="mb-3 text-lg font-medium">Time format</h2>
			<div class="flex max-w-sm gap-2">
				{#each [{ value: '12h', label: '12-hour' }, { value: '24h', label: '24-hour' }] as option (option.value)}
					<button
						type="button"
						disabled={savingTimeFormat}
						onclick={() => saveTimeFormat(option.value as '12h' | '24h')}
						class="flex-1 rounded border px-3 py-2 text-sm font-medium disabled:opacity-40 {timeFormat ===
						option.value
							? 'border-blue-600 bg-blue-600 text-white'
							: 'border-slate-300 text-slate-700'}"
					>
						{option.label}
					</button>
				{/each}
			</div>
			{#if timeFormatError}
				<p class="mt-2 text-sm text-red-600">{timeFormatError}</p>
			{/if}
		</section>

		<section class="mt-10">
			<h2 class="mb-3 text-lg font-medium">Location</h2>
			<p class="mb-3 text-sm text-slate-500">
				Used for weather and for sunrise/sunset — including the theme's auto light/dark switch.
			</p>
			<form onsubmit={saveLocation} class="flex max-w-sm items-end gap-3">
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium text-slate-500">Latitude</span>
					<input
						type="number"
						step="any"
						min="-90"
						max="90"
						bind:value={latitude}
						required
						disabled={savingLocation}
						class="w-32 rounded border border-slate-300 px-3 py-2 text-sm"
					/>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium text-slate-500">Longitude</span>
					<input
						type="number"
						step="any"
						min="-180"
						max="180"
						bind:value={longitude}
						required
						disabled={savingLocation}
						class="w-32 rounded border border-slate-300 px-3 py-2 text-sm"
					/>
				</label>
				<button
					type="submit"
					disabled={savingLocation}
					class="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
				>
					Save
				</button>
			</form>
			{#if locationError}
				<p class="mt-2 text-sm text-red-600">{locationError}</p>
			{/if}
		</section>

		<section class="mt-10">
			<h2 class="mb-3 text-lg font-medium">Time zone</h2>
			<p class="mb-3 text-sm text-slate-500">
				The zone every timed event, quiet hours, and clock renders in.
			</p>
			<select
				value={timeZone}
				onchange={saveTimeZone}
				disabled={savingTimeZone}
				class="w-full max-w-sm rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
			>
				{#each data.timeZoneOptions as tz (tz)}
					<option value={tz}>{tz}</option>
				{/each}
			</select>
			{#if timeZoneError}
				<p class="mt-2 text-sm text-red-600">{timeZoneError}</p>
			{/if}
		</section>

		<section class="mt-10">
			<h2 class="mb-3 text-lg font-medium">User settings</h2>
			<ul class="flex flex-col gap-2">
				{#each data.users as user (user.id)}
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

		<section class="mt-10">
			<h2 class="mb-3 text-lg font-medium">Tasks (Todoist)</h2>
			<p class="mb-3 text-sm text-slate-500">
				Shows overdue and due-today tasks from a personal Todoist account. Re-entering the token
				here rotates it without disturbing the connection's status below.
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
					<p class="text-sm text-amber-600">
						Saved, but couldn't connect — check the status below.
					</p>
				{/if}
			</form>
		</section>

		<section class="mt-10">
			<h2 class="mb-3 text-lg font-medium">Task access</h2>
			<p class="mb-4 text-sm text-slate-500">
				Which Todoist tasks each person sees, relative to one restricted project.
			</p>

			{#if data.taskProjects.length === 0}
				<p class="text-slate-400">No Todoist projects discovered yet.</p>
			{:else}
				<label class="mb-4 flex max-w-sm flex-col gap-1">
					<span class="text-xs font-medium text-slate-500">Restricted project</span>
					<select
						value={restrictedTaskProjectId ?? ''}
						onchange={saveRestrictedProject}
						disabled={savingRestrictedProject}
						class="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-40"
					>
						<option value="" disabled>Choose a project…</option>
						{#each data.taskProjects as project (project.projectId)}
							<option value={project.projectId}>{project.label}</option>
						{/each}
					</select>
					{#if restrictedProjectError}
						<p class="text-sm text-red-600">{restrictedProjectError}</p>
					{/if}
				</label>

				<ul class="flex flex-col gap-2">
					{#each data.users as user (user.id)}
						<li class="flex items-center gap-3 rounded border border-slate-200 px-3 py-2">
							<span
								class="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white"
								style="background-color: {user.color}"
							>
								{user.name[0]}
							</span>
							<span class="text-sm font-medium">{user.name}</span>
							<select
								value={user.taskAccess}
								onchange={(e) => saveTaskAccess(user.id, e)}
								disabled={savingTaskAccessUserId === user.id}
								class="ml-auto rounded border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-40"
							>
								<option value="all-but-one">All except the restricted project</option>
								<option value="only-one">Only the restricted project</option>
								<option value="none">No tasks</option>
							</select>
						</li>
					{/each}
				</ul>
				{#if taskAccessError}
					<p class="mt-2 text-sm text-red-600">{taskAccessError}</p>
				{/if}
			{/if}
		</section>

		<section class="mt-10">
			<h2 class="mb-3 text-lg font-medium">Music</h2>
			<p class="mb-3 text-sm text-slate-500">
				Playlists come from folders on the NAS (one folder per playlist) — nothing to configure here
				for those. Speakers/groups are found by scanning the network for Cast devices, the same ones
				visible in the Google Home app.
			</p>

			<button
				type="button"
				onclick={scanForSpeakers}
				disabled={scanningForSpeakers}
				class="mb-3 self-start rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
			>
				{scanningForSpeakers ? 'Scanning…' : 'Scan for speakers'}
			</button>
			{#if scanError}
				<p class="mb-3 text-sm text-red-600">{scanError}</p>
			{:else if discoveredSpeakerNames}
				{#if discoveredSpeakerNames.length === 0}
					<p class="mb-3 text-sm text-slate-400">No Cast devices found on the network.</p>
				{:else}
					<ul class="mb-3 flex flex-col gap-2">
						{#each discoveredSpeakerNames as name (name)}
							<li class="flex items-center gap-3 rounded border border-slate-200 px-3 py-2 text-sm">
								<span>{name}</span>
								<button
									type="button"
									onclick={() => addDiscoveredSpeaker(name)}
									disabled={addingSpeakerName === name ||
										data.musicSpeakers.some((s) => s.castName === name)}
									class="ml-auto text-blue-600 disabled:text-slate-300"
								>
									{data.musicSpeakers.some((s) => s.castName === name) ? 'Added' : 'Add'}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}

			<h3 class="mt-4 mb-2 text-sm font-medium text-slate-700">Configured speakers</h3>
			<ul class="flex flex-col gap-2">
				{#each data.musicSpeakers as speaker (speaker.id)}
					<li class="flex items-center gap-3 rounded border border-slate-200 px-3 py-2 text-sm">
						<span>{speaker.castName}</span>
						<button
							type="button"
							onclick={() => removeSpeaker(speaker.id)}
							class="ml-auto text-slate-400 hover:text-red-600"
						>
							Remove
						</button>
					</li>
				{:else}
					<li class="text-slate-400">No speakers configured yet.</li>
				{/each}
			</ul>
		</section>

		<section class="mt-10">
			<h2 class="mb-3 text-lg font-medium">Connections</h2>
			{#if data.connections.length === 0}
				<p class="text-slate-400">Nothing connected yet.</p>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each data.connections as connection (connection.id)}
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
	{/if}

	{#if toastMessage}
		<p
			class="fixed bottom-6 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-lg"
		>
			{toastMessage}
		</p>
	{/if}
</main>
