<script lang="ts">
	import { computeElapsedSeconds } from '$lib/musicProgress';
	import { shouldAutoOpenPlayingFolder, isPlayingSelectedFolder } from '$lib/musicPanelLogic';
	import { panelSizes } from '$lib/panelSizes';
	import SidebarPanel from './SidebarPanel.svelte';
	import PanelCloseButton from './PanelCloseButton.svelte';
	import TrackCover from './TrackCover.svelte';
	import MusicNowPlayingFooter from './MusicNowPlayingFooter.svelte';

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
			? { ...panelSizes(true), backBtn: 'h-12 w-12 text-2xl', cover: 'h-12 w-12' }
			: { ...panelSizes(false), backBtn: 'h-10 w-10 text-xl', cover: 'h-10 w-10' }
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
	// state. Also polled periodically while playback is active (see the STATUS_POLL_MS
	// effect below) — the device auto-advancing to the next queued track, or a pause/skip
	// made from outside Hearth (e.g. the Google Home app directly), are both changes this
	// panel didn't cause itself, so it can't just refresh after "every action this panel
	// takes"; without the poll, the footer kept showing the track that was playing when the
	// panel was opened until someone closed and reopened it.
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

	// Separate from the 250ms ticker above (which only interpolates the progress bar
	// between real syncs) — this actually re-fetches from the server, at a coarser
	// interval, since /api/music/status is a plain in-memory read (no network round-trip
	// to the speaker itself) and doesn't need sub-second freshness.
	const STATUS_POLL_MS = 5000;
	$effect(() => {
		if (!playbackActive) return;
		const interval = setInterval(refreshStatus, STATUS_POLL_MS);
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

<SidebarPanel {onClose} closeLabel="Close music" width={sizes.width}>
	<!-- Not PanelHeader (unlike GroceryPanel/TasksPanel) — this header needs a conditional
	     back button and a title that changes with `view`, neither of which PanelHeader
	     supports, and it has no subtitle/stale badge to show. Only the close button itself
	     (PanelCloseButton) is shared with PanelHeader's version. -->
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
		<PanelCloseButton {onClose} sizeClass={sizes.closeBtn} />
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
								<TrackCover trackId={song.id} class={sizes.cover} />
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
		<MusicNowPlayingFooter
			trackId={playingTrackId}
			{trackTitle}
			folderName={playingFolderName}
			{playerState}
			{elapsedSeconds}
			{duration}
			{volume}
			{controlBusy}
			coverSize={sizes.cover}
			{progressPercent}
			{toggle}
			{next}
			{previous}
			{stop}
			{onVolumeInput}
		/>
	{/if}
</SidebarPanel>
