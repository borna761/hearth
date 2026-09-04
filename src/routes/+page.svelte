<script lang="ts">
	import { untrack } from 'svelte';
	import type { PageData } from './$types';
	import TopStrip from '$lib/components/TopStrip.svelte';
	import WeekGrid from '$lib/components/WeekGrid.svelte';
	import HourGrid from '$lib/components/HourGrid.svelte';
	import Screensaver from '$lib/components/Screensaver.svelte';
	import Lock from '$lib/components/Lock.svelte';
	import SimpleView from '$lib/components/SimpleView.svelte';
	import GroceryPanel from '$lib/components/GroceryPanel.svelte';
	import TasksPanel from '$lib/components/TasksPanel.svelte';
	import MusicPanel from '$lib/components/MusicPanel.svelte';
	import { findNextEvent } from '$lib/week/nextEvent';
	import { applyWeekViewChange, resolveWeekViewOnLogin, type ViewMode } from '$lib/week/viewMode';
	import type { TimeFormat } from '$lib/week/format';
	import { localMinutesInZone } from '$lib/datetime';
	import type { WeekSnapshot } from '$lib/server/state/snapshot';
	import type { Weather } from '$lib/server/weather';
	import type { GroceriesSnapshot } from '$lib/server/groceries';
	import type { TasksSnapshot } from '$lib/server/tasks';
	import { saveSessionCache, loadSessionCache, clearSessionCache } from '$lib/sessionCache';
	import {
		anyPanelOpen,
		panelIdleTimeoutMs,
		closePanels,
		PANEL_IDLE_TIMEOUT_MS
	} from '$lib/panelIdle';

	let { data }: { data: PageData } = $props();

	type Stage = 'screensaver' | 'lock' | 'session';
	type Theme = 'light' | 'dark';
	type StreamEnvelope =
		| {
				type: 'week';
				snapshot: WeekSnapshot;
				weather: Weather | null;
				theme: Theme;
				timeFormat: TimeFormat;
				groceries: GroceriesSnapshot | null;
				tasks: TasksSnapshot | null;
		  }
		| { type: 'locked'; weather: Weather | null; theme: Theme; timeFormat: TimeFormat };
	type ScreensaverPhoto = { url: string; blurHash: string | null };
	type ScreensaverSlide =
		| { kind: 'single'; photo: ScreensaverPhoto }
		| { kind: 'pair'; photos: [ScreensaverPhoto, ScreensaverPhoto] };
	type MusicFolder = { id: number; displayName: string };
	type MusicSpeaker = { id: number; castName: string };
	type ScreensaverEnvelope = {
		weather: Weather | null;
		theme: Theme;
		timeFormat: TimeFormat;
		slide: ScreensaverSlide | null;
		// DESIGN.md §5.1, docs/phase-7-music-plan.md: the deliberate exceptions to this
		// stream carrying no household data — null in guest mode/quiet hours
		// (screensaverPublisher.ts).
		groceries: GroceriesSnapshot | null;
		musicFolders: MusicFolder[] | null;
		musicSpeakers: MusicSpeaker[] | null;
	};

	// Seeded from the initial page load's session, so a mid-session page reload (or the
	// nightly one, DESIGN.md §9.1) resumes straight into the calendar rather than forcing
	// a re-login every time. Deliberately not reactive to `data` after that — `stage` is
	// independently driven from here on by user actions and SSE pushes, not by re-running
	// the load function (untrack makes that one-shot read explicit rather than a lint warning).
	let stage = $state<Stage>(untrack(() => (data.session ? 'session' : 'screensaver')));
	// Tracks whoever's actually logged in right now, kept current across logout/login —
	// toggleViewMode needs this to know which data.users row to patch (see below), since
	// data.session itself is only ever the initial-load snapshot.
	let currentUserId = $state<number | null>(untrack(() => data.session?.userId ?? null));
	// data.session already carries viewMode for the initial-load case. A fresh client-side
	// login only gets back {ok:true} though, so that path looks it up in data.users
	// (loaded once, PIN-free) by id instead of widening the login endpoint's response for it.
	let sessionViewMode = $state<'standard' | 'simple'>(
		untrack(() => data.session?.viewMode ?? 'standard')
	);

	// Seeded from sessionCache.ts's last-known snapshot for this same user, not always
	// null — a reload (the nightly one, or any other) otherwise shows a blank "Loading…"
	// until the SSE stream reconnects and pushes a fresh message, which is exactly the
	// window a slow-to-restart Pi (the ~90s service-stop quirk, or a genuine outage) makes
	// most visible. Purely a rendering fallback: the moment a real message arrives below,
	// it overwrites this unconditionally, cache or not.
	const cachedSession = untrack(() =>
		data.session ? loadSessionCache(data.session.userId) : null
	);
	let snapshot = $state<WeekSnapshot | null>(cachedSession?.snapshot ?? null);
	// null until the first 'week' envelope arrives (cache aside) — before then there's no
	// way to tell "AnyList isn't connected yet" apart from "haven't heard from the stream
	// at all", and TopStrip already treats null as "don't show the badge" either way.
	let groceries = $state<GroceriesSnapshot | null>(cachedSession?.groceries ?? null);
	// Same null-until-first-message reasoning as groceries above.
	let tasks = $state<TasksSnapshot | null>(cachedSession?.tasks ?? null);
	// Seeded from the page load's snapshot (see +page.server.ts), then kept live by the
	// session's own SSE stream once one is open — the same one-shot-then-live pattern as
	// `stage` above.
	let weather = $state<Weather | null>(untrack(() => data.weather));
	let theme = $state<Theme>(untrack(() => data.theme));
	let timeFormat = $state<TimeFormat>(untrack(() => data.timeFormat));
	let slide = $state<ScreensaverSlide | null>(null);
	let musicFolders = $state<MusicFolder[] | null>(null);
	let musicSpeakers = $state<MusicSpeaker[] | null>(null);
	let connected = $state(false);
	let nowMinutes = $state(0);
	// Same one-shot-then-live-updated-elsewhere seeding as sessionViewMode above — this one
	// is kept current by toggleViewMode's own write instead of a stream, since it only ever
	// changes from this same session's own action.
	let viewMode = $state<ViewMode>(untrack(() => data.session?.weekView ?? 'agenda'));
	// docs/phase-5-plan.md M4: a layer inside the session, not a stage and not a route — a
	// real /groceries route would remount the page, tear down and reopen the EventSource,
	// and re-run the load function, a visible stall on a Zero 2 W for something that should
	// feel instant.
	let groceryPanelOpen = $state(false);
	// Same reasoning, same layer — docs/phase-6-todoist-plan.md §6.
	let taskPanelOpen = $state(false);
	// Same reasoning, same layer — docs/phase-7-music-plan.md.
	let musicPanelOpen = $state(false);

	async function toggleViewMode() {
		const next = viewMode === 'agenda' ? 'grid' : 'agenda';
		viewMode = next; // optimistic
		const res = await fetch('/api/week-view', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ weekView: next })
		}).catch(() => null);
		if (!res?.ok) {
			viewMode = next === 'agenda' ? 'grid' : 'agenda'; // revert on failure
			return;
		}
		if (currentUserId !== null) applyWeekViewChange(data.users, currentUserId, next);
	}

	$effect(() => {
		if (!snapshot) return;
		const zone = snapshot.timeZone;
		const update = () => (nowMinutes = localMinutesInZone(new Date(), zone));
		update();
		const id = setInterval(update, 30_000);
		return () => clearInterval(id);
	});

	// Only open once authenticated — /api/stream 401s otherwise (DESIGN.md §5: "no
	// unauthenticated path to any data at all"), and there is nothing useful to stream
	// before a session exists anyway.
	$effect(() => {
		if (stage !== 'session') return;

		const source = new EventSource('/api/stream');
		source.onopen = () => (connected = true);
		source.onerror = () => (connected = false);
		source.onmessage = (event) => {
			const envelope = JSON.parse(event.data) as StreamEnvelope;
			weather = envelope.weather;
			theme = envelope.theme;
			timeFormat = envelope.timeFormat;
			if (envelope.type === 'locked') {
				// The server independently decided this session is gone (idle-expired and
				// caught by the next state-tick, most likely) — snap back even though the
				// client's own idle timer never fired.
				snapshot = null;
				groceries = null;
				tasks = null;
				stage = 'screensaver';
				clearSessionCache();
			} else {
				snapshot = envelope.snapshot;
				groceries = envelope.groceries;
				tasks = envelope.tasks;
				if (currentUserId !== null) {
					saveSessionCache({
						userId: currentUserId,
						snapshot: envelope.snapshot,
						groceries: envelope.groceries,
						tasks: envelope.tasks
					});
				}
			}
		};
		return () => source.close();
	});

	// The screensaver/lock stream — public (DESIGN.md §5: "no household data", groceries
	// excepted per §5.1), open whenever there's no session to show instead. Only one of this
	// and the stream above is ever open at once, since the two guards are complementary on
	// `stage`.
	$effect(() => {
		if (stage === 'session') return;

		const source = new EventSource('/api/screensaver-stream');
		source.onmessage = (event) => {
			const envelope = JSON.parse(event.data) as ScreensaverEnvelope;
			weather = envelope.weather;
			theme = envelope.theme;
			timeFormat = envelope.timeFormat;
			slide = envelope.slide;
			groceries = envelope.groceries;
			musicFolders = envelope.musicFolders;
			musicSpeakers = envelope.musicSpeakers;
		};
		return () => source.close();
	});

	let nextEvent = $derived(snapshot ? findNextEvent(snapshot, nowMinutes) : null);

	// --- idle timeout + heartbeat (DESIGN.md §5: "Idle for two minutes ends the session") ---
	//
	// This timer is UX, not the security boundary — it's what makes the lock feel
	// immediate rather than waiting on a round trip. The actual boundary is server-side:
	// loadSession computes idle-expiry live from lastSeenAt on every request, so even a
	// client that never fires this (a JS error, a backgrounded tab) stops being served
	// data once the server notices, via the 'locked' envelope above.
	// docs/phase-5-plan.md M4: standing at the counter reading the list while putting
	// shopping away touches nothing, and that's the single most likely real use of the
	// grocery panel — this is that timeout while it's open. Applies to the tasks and music
	// panels too (docs/phase-6-todoist-plan.md §6) — reading an overdue list or a track
	// list is the same "standing there, not tapping" case. panelIdleTimeoutMs/anyPanelOpen
	// come from $lib/panelIdle so this logic is testable (src/lib/panelIdle.test.ts) — it
	// was missing musicPanelOpen entirely until that panel stopped auto-closing.
	const HEARTBEAT_MIN_INTERVAL_MS = 15_000;

	async function endSessionAndLock() {
		stage = 'screensaver';
		snapshot = null;
		groceries = null;
		tasks = null;
		groceryPanelOpen = false;
		taskPanelOpen = false;
		musicPanelOpen = false;
		clearSessionCache();
		await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
	}

	$effect(() => {
		if (stage !== 'session') return;

		let idleTimer: ReturnType<typeof setTimeout>;
		let lastHeartbeat = 0;

		const resetIdle = () => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(
				endSessionAndLock,
				panelIdleTimeoutMs({ groceryPanelOpen, taskPanelOpen, musicPanelOpen })
			);

			const now = Date.now();
			if (now - lastHeartbeat > HEARTBEAT_MIN_INTERVAL_MS) {
				lastHeartbeat = now;
				fetch('/api/auth/heartbeat', { method: 'POST' })
					.then((res) => res.json())
					.then((body: { expired?: boolean }) => {
						if (body.expired) endSessionAndLock();
					})
					.catch(() => {});
			}
		};

		resetIdle();
		const activityEvents = ['touchstart', 'click', 'keydown'] as const;
		for (const eventName of activityEvents) window.addEventListener(eventName, resetIdle);

		return () => {
			clearTimeout(idleTimer);
			for (const eventName of activityEvents) window.removeEventListener(eventName, resetIdle);
		};
	});

	// The heartbeat above only fires on real activity (touchstart/click/keydown), so it
	// never runs at all while someone just reads a panel's contents with nothing to tap —
	// the exact case PANEL_IDLE_TIMEOUT_MS above is meant to cover. session.ts's own idle
	// cutoff is a fixed 2 minutes, server-side, and has no idea this client-side extension
	// exists — without an active ping here, the server would expire the session out from
	// under someone mid-task regardless of what the local timer says. Well under that
	// 2-minute cutoff for margin.
	const PANEL_HEARTBEAT_INTERVAL_MS = 60_000;

	$effect(() => {
		if (stage !== 'session' || !anyPanelOpen({ groceryPanelOpen, taskPanelOpen, musicPanelOpen }))
			return;

		const ping = () => {
			fetch('/api/auth/heartbeat', { method: 'POST' })
				.then((res) => res.json())
				.then((body: { expired?: boolean }) => {
					if (body.expired) endSessionAndLock();
				})
				.catch(() => {});
		};

		const id = setInterval(ping, PANEL_HEARTBEAT_INTERVAL_MS);
		return () => clearInterval(id);
	});

	// Guest mode opens grocery/music panels straight from the screensaver (no session to
	// expire), so the two effects above never run for them at all — left with no timeout
	// whatsoever, a panel opened there stayed open indefinitely until someone tapped
	// through to the lock screen. Same panel-length allowance, just closing the panels
	// instead of ending a session that doesn't exist in this stage.
	$effect(() => {
		if (
			stage !== 'screensaver' ||
			!anyPanelOpen({ groceryPanelOpen, taskPanelOpen, musicPanelOpen })
		)
			return;

		let idleTimer: ReturnType<typeof setTimeout>;
		const resetIdle = () => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				({ groceryPanelOpen, taskPanelOpen, musicPanelOpen } = closePanels());
			}, PANEL_IDLE_TIMEOUT_MS);
		};

		resetIdle();
		const activityEvents = ['touchstart', 'click', 'keydown'] as const;
		for (const eventName of activityEvents) window.addEventListener(eventName, resetIdle);

		return () => {
			clearTimeout(idleTimer);
			for (const eventName of activityEvents) window.removeEventListener(eventName, resetIdle);
		};
	});

	// --- screensaver <-> lock <-> session transitions ---

	function wake() {
		if (stage === 'screensaver') stage = 'lock';
		// Tapping through to the lock screen while a panel is open (rather than closing it
		// first) shouldn't leave it stranded open over the PIN pad.
		groceryPanelOpen = false;
		musicPanelOpen = false;
	}

	async function login(userId: number, pin: string) {
		const res = await fetch('/api/auth/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ userId, pin })
		});
		const body = await res.json();
		if (res.ok) {
			const user = data.users.find((u) => u.id === userId);
			sessionViewMode = user?.viewMode ?? 'standard';
			viewMode = resolveWeekViewOnLogin(data.users, userId);
			currentUserId = userId;
			stage = 'session';
		}
		return body;
	}

	async function enterGuest() {
		await fetch('/api/auth/guest', { method: 'POST' }).catch(() => {});
		stage = 'screensaver';
	}

	function cancelLock() {
		stage = 'screensaver';
	}
</script>

<svelte:head><title>Hearth</title></svelte:head>

<main
	class="relative h-screen w-screen overflow-hidden bg-white dark:bg-slate-900"
	class:dark={theme === 'dark'}
>
	{#if stage === 'screensaver'}
		<Screensaver
			timeZone={data.timeZone}
			{weather}
			{slide}
			{theme}
			{timeFormat}
			{groceries}
			{musicFolders}
			{musicSpeakers}
			panelOpen={groceryPanelOpen || musicPanelOpen}
			onWake={wake}
			onOpenGroceries={() => (groceryPanelOpen = true)}
			onOpenMusic={() => (musicPanelOpen = true)}
		/>
	{:else if stage === 'lock'}
		<Lock
			users={data.users}
			timeZone={data.timeZone}
			{weather}
			{timeFormat}
			onLogin={login}
			onGuest={enterGuest}
			onCancel={cancelLock}
		/>
	{:else if snapshot && sessionViewMode === 'simple'}
		<SimpleView
			{snapshot}
			{nowMinutes}
			{timeFormat}
			{tasks}
			onLock={endSessionAndLock}
			onOpenTasks={() => (taskPanelOpen = true)}
		/>
	{:else if snapshot}
		<div class="flex h-full w-full flex-col">
			<TopStrip
				today={snapshot.today}
				{nextEvent}
				{viewMode}
				{tasks}
				onToggleView={toggleViewMode}
				onOpenTasks={() => (taskPanelOpen = true)}
				onLock={endSessionAndLock}
			/>
			{#if viewMode === 'grid'}
				<HourGrid
					days={snapshot.days}
					{nowMinutes}
					displayHours={snapshot.displayHours}
					{timeFormat}
				/>
			{:else}
				<WeekGrid days={snapshot.days} />
			{/if}
		</div>
	{:else}
		<div class="flex h-full items-center justify-center text-slate-400">
			<p class="text-2xl">Loading…</p>
		</div>
	{/if}

	<!-- Shared by both views (§5.2 item 5: Sam opens the same panel, not a variant of
	     it) rather than duplicated per-branch above. -->
	{#if groceryPanelOpen && groceries}
		<GroceryPanel
			{groceries}
			large={sessionViewMode === 'simple'}
			onClose={() => (groceryPanelOpen = false)}
		/>
	{/if}
	{#if taskPanelOpen && tasks}
		<TasksPanel
			{tasks}
			large={sessionViewMode === 'simple'}
			onClose={() => (taskPanelOpen = false)}
		/>
	{/if}
	{#if musicPanelOpen && musicFolders && musicSpeakers}
		<MusicPanel
			{musicFolders}
			{musicSpeakers}
			large={sessionViewMode === 'simple'}
			onClose={() => (musicPanelOpen = false)}
		/>
	{/if}

	{#if stage === 'session' && !connected}
		<div
			class="absolute right-3 bottom-3 rounded bg-amber-100 px-3 py-1 text-sm text-amber-800 shadow"
		>
			Reconnecting…
		</div>
	{/if}
</main>
