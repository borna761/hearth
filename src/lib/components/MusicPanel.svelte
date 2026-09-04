<script lang="ts">
	import { computeElapsedSeconds, formatTrackTime } from '$lib/musicProgress';
	import { shouldAutoOpenPlayingFolder, isPlayingSelectedFolder } from '$lib/musicPanelLogic';

	type MusicFolder = { id: number; displayName: string };
	type MusicTrack = { id: number; title: string };
	type MusicSpeaker = { id: number; castName: string };

	let {
		musicFolders,
		musicSpeakers,
		onClose,
		large = false
	}: {
		musicFolders: MusicFolder[];
		musicSpeakers: MusicSpeaker[];
		onClose: () => void;
		/** Sam's simple view (DESIGN.md §5.2) runs everything else at ~1.6x the standard
		 *  view's type — same reasoning as GroceryPanel's own `large` prop. */
		large?: boolean;
	} = $props();

	let sizes = $derived(
		large
			? {
					width: 'w-[26rem]',
					headerHeight: 'h-20',
					title: 'text-2xl',
					closeBtn: 'h-12 w-12 text-2xl',
					backBtn: 'h-12 w-12 text-2xl',
					emptyState: 'text-lg',
					itemRow: 'min-h-16',
					itemTitle: 'text-xl',
					cover: 'h-12 w-12'
				}
			: {
					width: 'w-96',
					headerHeight: 'h-16',
					title: 'text-lg',
					closeBtn: 'h-10 w-10 text-xl',
					backBtn: 'h-10 w-10 text-xl',
					emptyState: 'text-base',
					itemRow: 'min-h-14',
					itemTitle: 'text-base',
					cover: 'h-10 w-10'
				}
	);

	// Three-step flow: pick a playlist/folder, then a song (or shuffle all), then a
	// speaker — extends the original two-step ask (docs/phase-7-music-plan.md) with a
	// song-picker step in between, so starting on a specific track is still just as easy
	// as shuffling the whole folder.
	let view = $state<'folders' | 'songs' | 'speakers'>('folders');
	let selectedFolder = $state<MusicFolder | null>(null);
	// null means "Shuffle All" was chosen rather than a specific track.
	let selectedTrack = $state<MusicTrack | null>(null);
	let songs = $state<MusicTrack[]>([]);
	let loadingSongs = $state(false);
	let starting = $state(false);
	let error = $state<string | null>(null);

	// Transport controls reflect the server's own in-memory session (§ playbackSession.ts)
	// rather than anything this panel remembers locally — that way reopening the panel
	// after closing it, or after someone else started playback, still shows the right
	// state. No periodic polling for now: fetched once on open and after every action this
	// panel itself takes; a pause/skip made from outside Hearth (e.g. the Google Home app
	// directly) won't be reflected until the panel is reopened.
	let playbackActive = $state(false);
	let playerState = $state<'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED'>('IDLE');
	let playingFolderId = $state<number | null>(null);
	let playingSpeakerId = $state<number | null>(null);
	let playingTrackId = $state<number | null>(null);
	let trackTitle = $state<string | null>(null);
	let controlBusy = $state(false);

	// The server only reports a snapshot of playback position (from the device's own
	// status), not a live tick — currentTime/syncedAtMs let the progress bar interpolate
	// smoothly between real syncs (on open, and after play/pause/next) via the ticking
	// `now` below, rather than polling the device just to keep a bar moving.
	let currentTime = $state<number | null>(null);
	let duration = $state<number | null>(null);
	let syncedAtMs = $state<number | null>(null);
	let now = $state(Date.now());

	// The receiver's own volume (0-1), not tied to any particular track — same as its
	// hardware controls or the Google Home app's slider.
	let volume = $state<number | null>(null);
	let volumeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	async function refreshStatus() {
		try {
			const res = await fetch('/api/music/status');
			const body = await res.json();
			playbackActive = body.active === true;
			playerState = body.playerState ?? 'IDLE';
			playingFolderId = body.folderId ?? null;
			playingSpeakerId = body.speakerId ?? null;
			playingTrackId = body.trackId ?? null;
			trackTitle = body.trackTitle ?? null;
			currentTime = body.currentTime ?? null;
			duration = body.duration ?? null;
			volume = body.volume ?? null;
			syncedAtMs = Date.now();
		} catch {
			// Leave whatever state was already showing — a failed status check shouldn't
			// blank out controls that might still be accurate.
		}
	}

	// Runs once, right after the panel's very first status check. Opening straight onto
	// the songs of whatever's already playing (rather than the folder list) saves a tap in
	// the common case of wanting to pick a different song from the same playlist. Guarded
	// on view still being 'folders' — if the very first refreshStatus() happens to resolve
	// after the user has already tapped into a folder themselves, their own navigation
	// wins rather than being yanked back.
	let didAutoOpenPlayingFolder = false;
	async function initialize() {
		await refreshStatus();
		if (didAutoOpenPlayingFolder) return;
		didAutoOpenPlayingFolder = true;
		if (!shouldAutoOpenPlayingFolder({ view, playingFolderId })) return;
		const folder = musicFolders.find((f) => f.id === playingFolderId);
		if (folder) await selectFolder(folder);
	}

	/** Shared by every transport action (toggle/next/previous/stop) — they all follow the
	 *  same shape: call the endpoint, ask the server for fresh truth on success, drop the
	 *  footer if the session turned out to already be gone, or surface whatever the server
	 *  said went wrong. */
	async function callAction(url: string) {
		if (controlBusy) return;
		controlBusy = true;
		error = null;
		try {
			const res = await fetch(url, { method: 'POST' });
			const body = await res.json();
			if (body.ok) {
				await refreshStatus();
			} else if (body.reason === 'inactive') {
				playbackActive = false;
			} else {
				error = body.error ?? 'Something went wrong.';
			}
		} catch {
			error = 'Something went wrong.';
		} finally {
			controlBusy = false;
		}
	}

	$effect(() => {
		initialize();
	});

	$effect(() => {
		if (!playbackActive) return;
		const interval = setInterval(() => {
			now = Date.now();
		}, 250);
		return () => clearInterval(interval);
	});

	let elapsedSeconds = $derived(
		computeElapsedSeconds({ currentTime, syncedAtMs, nowMs: now, playerState, duration })
	);
	let progressPercent = $derived(
		duration && duration > 0 ? Math.min(100, (elapsedSeconds / duration) * 100) : 0
	);

	async function selectFolder(folder: MusicFolder) {
		selectedFolder = folder;
		view = 'songs';
		error = null;
		songs = [];
		loadingSongs = true;
		try {
			const res = await fetch(`/api/music/folders/${folder.id}/tracks`);
			const body = await res.json();
			songs = body.ok ? body.tracks : [];
		} catch {
			songs = [];
		} finally {
			loadingSongs = false;
		}
	}

	// True while browsing the songs of the folder that's already playing — in that case
	// there's no need to ask which speaker, since we already know: it's the one it's
	// already coming out of.
	let isPlayingCurrentFolder = $derived(
		isPlayingSelectedFolder({
			selectedFolderId: selectedFolder?.id ?? null,
			playingFolderId,
			playingSpeakerId
		})
	);
	let playingSpeakerName = $derived(
		musicSpeakers.find((s) => s.id === playingSpeakerId)?.castName ?? null
	);

	/** Shared by both the speaker-picker's taps and the already-playing-folder fast path —
	 *  same request, just a different source for which speaker. */
	async function startPlayback(
		speakerId: number,
		speakerName: string | null,
		trackId: number | null
	) {
		if (!selectedFolder || starting) return;
		starting = true;
		error = null;
		try {
			const res = await fetch('/api/music/play', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ speakerId, folderId: selectedFolder.id, trackId })
			});
			const body = await res.json();
			if (body.ok) {
				// Lands back on the song list of the folder just started, not the top-level
				// folder list — selectedFolder/songs are already loaded from getting here,
				// and this is exactly the view that lets picking another song from the same
				// playlist skip the speaker step next time (isPlayingCurrentFolder).
				view = 'songs';
				selectedTrack = null;
				// The play request itself already waits for the device to report the
				// first track's title before responding, so this reflects it immediately.
				await refreshStatus();
			} else {
				error = body.error ?? `Couldn't play music${speakerName ? ` on ${speakerName}` : ''}.`;
			}
		} catch {
			error = `Couldn't play music${speakerName ? ` on ${speakerName}` : ''}.`;
		} finally {
			starting = false;
		}
	}

	/** Shared by "Shuffle All" (song: null) and picking a specific song — same dispatch
	 *  either way: play directly if we already know the speaker (isPlayingCurrentFolder),
	 *  otherwise ask which one. */
	async function pickSong(song: MusicTrack | null) {
		selectedTrack = song;
		error = null;
		if (isPlayingCurrentFolder) {
			await startPlayback(playingSpeakerId!, playingSpeakerName, song?.id ?? null);
		} else {
			view = 'speakers';
		}
	}

	function back() {
		if (view === 'speakers') {
			view = 'songs';
			selectedTrack = null;
		} else if (view === 'songs') {
			view = 'folders';
			selectedFolder = null;
			songs = [];
		}
		error = null;
	}

	async function playOn(speaker: MusicSpeaker) {
		await startPlayback(speaker.id, speaker.castName, selectedTrack?.id ?? null);
	}

	// Each request itself already refreshes the session's status before responding
	// (toggle picks up the exact pause/resume position, next/previous wait for the new
	// track's title) — callAction's refreshStatus() call picks all of that up in one read
	// rather than each function needing its own bespoke follow-up.
	const toggle = () => callAction('/api/music/toggle');
	const next = () => callAction('/api/music/next');
	const previous = () => callAction('/api/music/previous');
	const stop = () => callAction('/api/music/stop');

	function onVolumeInput(event: Event) {
		const percent = Number((event.currentTarget as HTMLInputElement).value);
		volume = percent / 100;
		if (volumeDebounceTimer) clearTimeout(volumeDebounceTimer);
		// Debounced rather than sent on every drag tick — a slider drag can fire dozens of
		// input events in under a second, and the device only needs to hear the settled
		// value, not every intermediate one.
		volumeDebounceTimer = setTimeout(() => {
			fetch('/api/music/volume', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ level: percent / 100 })
			}).catch(() => {
				// The slider already shows the attempted value; if it didn't actually take,
				// the next status refresh corrects it.
			});
		}, 150);
	}

	let playingFolderName = $derived(
		musicFolders.find((f) => f.id === playingFolderId)?.displayName ?? null
	);
</script>

<!-- Shared by the song list rows and the now-playing footer — a placeholder note icon
     always sits underneath, and the real cover (if any) covers it once loaded; a failed
     or missing cover just leaves the placeholder showing, no separate empty state needed.
     trackId null (nothing resolved yet) skips the <img> entirely rather than pointing it
     at a nonsensical URL. -->
{#snippet trackCover(trackId: number | null, sizeClass: string)}
	<span
		class="relative {sizeClass} shrink-0 overflow-hidden rounded bg-slate-200 dark:bg-slate-700"
	>
		<svg
			viewBox="0 0 24 24"
			class="absolute inset-0 h-full w-full p-2.5 text-slate-400 dark:text-slate-500"
		>
			<path
				d="M9 18V5l11-2v13"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
			<circle cx="6" cy="18" r="3" fill="currentColor" />
			<circle cx="17" cy="16" r="3" fill="currentColor" />
		</svg>
		{#if trackId !== null}
			<img
				src="/api/music/tracks/{trackId}/cover"
				alt=""
				loading="lazy"
				class="absolute inset-0 h-full w-full object-cover"
				onerror={(e) => {
					(e.currentTarget as HTMLImageElement).style.display = 'none';
				}}
			/>
		{/if}
	</span>
{/snippet}

<!-- Same invisible tap-to-close scrim + right-edge sidebar chrome as GroceryPanel. -->
<button type="button" onclick={onClose} aria-label="Close music" class="absolute inset-0 z-10"
></button>

<!-- Translucent (bg-white/70), not blurred — DESIGN.md §2.4 rules out backdrop-filter/blur
     on this hardware, same reasoning Screensaver.svelte's own overlay already follows. -->
<div
	class="absolute inset-y-0 right-0 z-20 flex {sizes.width} flex-col border-l border-slate-200 bg-white/70 shadow-xl dark:border-slate-700 dark:bg-slate-900/70"
>
	<header
		class="flex {sizes.headerHeight} shrink-0 items-center gap-2 border-b border-slate-200 px-4 dark:border-slate-700"
	>
		{#if view !== 'folders'}
			<button
				type="button"
				onclick={back}
				aria-label="Back"
				class="flex {sizes.backBtn} items-center justify-center rounded-full text-slate-500 active:bg-slate-100 dark:text-slate-400 dark:active:bg-slate-800"
			>
				‹
			</button>
		{/if}
		<h1 class="{sizes.title} flex-1 truncate font-semibold text-slate-900 dark:text-slate-100">
			{#if view === 'folders'}
				Music
			{:else if view === 'songs'}
				“{selectedFolder?.displayName}”
			{:else}
				Play {selectedTrack
					? `“${selectedTrack.title}”`
					: `“${selectedFolder?.displayName}” shuffled`}
				on…
			{/if}
		</h1>
		<button
			type="button"
			onclick={onClose}
			aria-label="Done"
			class="flex {sizes.closeBtn} items-center justify-center rounded-full text-slate-500 active:bg-slate-100 dark:text-slate-400 dark:active:bg-slate-800"
		>
			✕
		</button>
	</header>

	{#if error}
		<p class="px-4 pt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
	{/if}

	<div class="flex-1 overflow-y-auto px-3 py-2">
		{#if view === 'folders'}
			{#if musicFolders.length === 0}
				<p class="{sizes.emptyState} py-8 text-center text-slate-400 dark:text-slate-500">
					No playlists yet — add folders on the NAS.
				</p>
			{:else}
				<ul>
					{#each musicFolders as folder (folder.id)}
						<li>
							<button
								type="button"
								onclick={() => selectFolder(folder)}
								class="flex {sizes.itemRow} w-full items-center gap-3 border-b border-slate-100 text-left dark:border-slate-800"
							>
								<span class="flex-1 truncate {sizes.itemTitle} text-slate-900 dark:text-slate-100">
									{folder.displayName}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		{:else if view === 'songs'}
			<ul>
				<li>
					<button
						type="button"
						onclick={() => pickSong(null)}
						disabled={starting}
						class="flex {sizes.itemRow} w-full items-center gap-3 border-b border-slate-100 text-left disabled:opacity-50 dark:border-slate-800"
					>
						<span
							class="flex-1 truncate {sizes.itemTitle} font-medium text-slate-900 dark:text-slate-100"
						>
							Shuffle All
						</span>
					</button>
				</li>
				{#if loadingSongs}
					<li class="{sizes.emptyState} py-8 text-center text-slate-400 dark:text-slate-500">
						Loading songs…
					</li>
				{:else if songs.length === 0}
					<li class="{sizes.emptyState} py-8 text-center text-slate-400 dark:text-slate-500">
						No songs found in this playlist.
					</li>
				{:else}
					{#each songs as song (song.id)}
						<li>
							<button
								type="button"
								onclick={() => pickSong(song)}
								disabled={starting}
								class="flex {sizes.itemRow} w-full items-center gap-3 border-b border-slate-100 text-left disabled:opacity-50 dark:border-slate-800"
							>
								{@render trackCover(song.id, sizes.cover)}
								<span class="flex-1 truncate {sizes.itemTitle} text-slate-900 dark:text-slate-100">
									{song.title}
								</span>
							</button>
						</li>
					{/each}
				{/if}
			</ul>
		{:else if musicSpeakers.length === 0}
			<p class="{sizes.emptyState} py-8 text-center text-slate-400 dark:text-slate-500">
				No speakers configured yet — add some in Settings.
			</p>
		{:else}
			<ul>
				{#each musicSpeakers as speaker (speaker.id)}
					<li>
						<button
							type="button"
							onclick={() => playOn(speaker)}
							disabled={starting}
							class="flex {sizes.itemRow} w-full items-center gap-3 border-b border-slate-100 text-left disabled:opacity-50 dark:border-slate-800"
						>
							<span class="flex-1 truncate {sizes.itemTitle} text-slate-900 dark:text-slate-100">
								{speaker.castName}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	{#if playbackActive}
		<footer
			class="flex shrink-0 flex-col items-center gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-700"
		>
			<div class="flex w-full items-center gap-3">
				{@render trackCover(playingTrackId, sizes.cover)}
				<div class="min-w-0 flex-1 text-left">
					<p class="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
						{trackTitle ?? playingFolderName ?? 'Playing'}
					</p>
					{#if trackTitle && playingFolderName}
						<p class="truncate text-xs text-slate-500 dark:text-slate-400">
							{playingFolderName}
						</p>
					{/if}
				</div>
			</div>

			{#if duration}
				<div class="flex w-full items-center gap-2">
					<span
						class="w-9 shrink-0 text-right text-[11px] text-slate-500 tabular-nums dark:text-slate-400"
					>
						{formatTrackTime(elapsedSeconds)}
					</span>
					<div class="h-1 flex-1 overflow-hidden rounded-full bg-slate-300 dark:bg-slate-700">
						<div
							class="h-full rounded-full bg-slate-900 dark:bg-slate-100"
							style="width: {progressPercent}%"
						></div>
					</div>
					<span class="w-9 shrink-0 text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
						{formatTrackTime(duration)}
					</span>
				</div>
			{/if}
			<!-- Same hand-drawn-icon reasoning as Screensaver.svelte's buttons: the emoji
			     equivalents (⏸/▶/⏭) render inconsistently across platforms — some render as
			     plain glyphs, some (⏭ especially, on macOS) as full-color emoji with their own
			     background chip, which is what made these look mismatched in the first place.
			     Solid-fill currentColor shapes guarantee both buttons render identically. -->
			<div class="flex items-center justify-center gap-3">
				<button
					type="button"
					onclick={previous}
					disabled={controlBusy}
					aria-label="Previous"
					class="flex h-11 w-11 items-center justify-center rounded-full bg-slate-200 text-slate-700 active:bg-slate-300 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:active:bg-slate-700"
				>
					<svg viewBox="0 0 24 24" class="h-5 w-5">
						<rect x="4.7" y="5" width="2.3" height="14" rx="1" fill="currentColor" />
						<path
							d="M18.5 5.6v12.8a1 1 0 0 1-1.5.87l-9.5-6.4a1 1 0 0 1 0-1.74l9.5-6.4a1 1 0 0 1 1.5.87z"
							fill="currentColor"
						/>
					</svg>
				</button>
				<button
					type="button"
					onclick={toggle}
					disabled={controlBusy}
					aria-label={playerState === 'PLAYING' ? 'Pause' : 'Play'}
					class="flex h-14 w-14 items-center justify-center rounded-full bg-slate-900 text-white active:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:active:bg-slate-300"
				>
					{#if playerState === 'PLAYING'}
						<svg viewBox="0 0 24 24" class="h-6 w-6">
							<rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" />
							<rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" />
						</svg>
					{:else}
						<svg viewBox="0 0 24 24" class="h-6 w-6">
							<path
								d="M7.5 5.2v13.6a1 1 0 0 0 1.53.85l10.9-6.8a1 1 0 0 0 0-1.7L9.03 4.35A1 1 0 0 0 7.5 5.2z"
								fill="currentColor"
							/>
						</svg>
					{/if}
				</button>
				<button
					type="button"
					onclick={next}
					disabled={controlBusy}
					aria-label="Next"
					class="flex h-11 w-11 items-center justify-center rounded-full bg-slate-200 text-slate-700 active:bg-slate-300 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:active:bg-slate-700"
				>
					<svg viewBox="0 0 24 24" class="h-5 w-5">
						<path
							d="M5.5 5.6v12.8a1 1 0 0 0 1.5.87l9.5-6.4a1 1 0 0 0 0-1.74l-9.5-6.4a1 1 0 0 0-1.5.87z"
							fill="currentColor"
						/>
						<rect x="17" y="5" width="2.3" height="14" rx="1" fill="currentColor" />
					</svg>
				</button>
				<button
					type="button"
					onclick={stop}
					disabled={controlBusy}
					aria-label="Stop"
					class="flex h-11 w-11 items-center justify-center rounded-full bg-slate-200 text-slate-700 active:bg-slate-300 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:active:bg-slate-700"
				>
					<svg viewBox="0 0 24 24" class="h-5 w-5">
						<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
					</svg>
				</button>
			</div>

			{#if volume !== null}
				<div class="flex w-full items-center gap-2 px-1">
					<svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400">
						<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
						<path
							d="M16.5 8.5a5 5 0 0 1 0 7"
							stroke="currentColor"
							stroke-width="1.8"
							stroke-linecap="round"
							fill="none"
						/>
					</svg>
					<input
						type="range"
						min="0"
						max="100"
						value={Math.round(volume * 100)}
						oninput={onVolumeInput}
						aria-label="Volume"
						class="h-1.5 flex-1 accent-slate-900 dark:accent-slate-100"
					/>
				</div>
			{/if}
		</footer>
	{/if}
</div>
