<script lang="ts">
	import { formatTrackTime } from '$lib/musicProgress';
	import TrackCover from './TrackCover.svelte';

	let {
		trackId,
		trackTitle,
		folderName,
		playerState,
		elapsedSeconds,
		duration,
		volume,
		controlBusy,
		coverSize,
		progressPercent,
		toggle,
		next,
		previous,
		stop,
		onVolumeInput
	}: {
		trackId: number | null;
		trackTitle: string | null;
		folderName: string | null;
		playerState: 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED';
		elapsedSeconds: number;
		duration: number | null;
		volume: number | null;
		controlBusy: boolean;
		coverSize: string;
		progressPercent: number;
		toggle: () => void;
		next: () => void;
		previous: () => void;
		stop: () => void;
		onVolumeInput: (event: Event) => void;
	} = $props();
</script>

<!-- Transport controls reflect the server's own in-memory playback session, not anything
     MusicPanel remembers locally (see MusicPanel.svelte's own comment on why) — this
     component just renders whatever it's handed. -->
<footer
	class="flex shrink-0 flex-col items-center gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-700"
>
	<div class="flex w-full items-center gap-3">
		<TrackCover {trackId} class={coverSize} />
		<div class="min-w-0 flex-1 text-left">
			<p class="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
				{trackTitle ?? folderName ?? 'Playing'}
			</p>
			{#if trackTitle && folderName}
				<p class="truncate text-xs text-slate-500 dark:text-slate-400">
					{folderName}
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
