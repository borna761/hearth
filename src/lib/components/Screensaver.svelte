<script lang="ts">
	import { localMinutesInZone, localDateInZone } from '$lib/datetime';
	import { formatDayHeading, formatMinutes, formatHHMM, type TimeFormat } from '$lib/week/format';
	import { driftOffset } from '$lib/week/driftPosition';
	import type { Weather } from '$lib/server/weather';
	import type { GroceriesSnapshot } from '$lib/server/groceries';
	import WeatherIconGlyph from './WeatherIcon.svelte';

	type ScreensaverPhoto = { url: string; blurHash: string | null };
	type ScreensaverSlide =
		| { kind: 'single'; photo: ScreensaverPhoto }
		| { kind: 'pair'; photos: [ScreensaverPhoto, ScreensaverPhoto] };
	type MusicFolder = { id: number; displayName: string };
	type MusicSpeaker = { id: number; castName: string };

	let {
		timeZone,
		weather,
		slide,
		theme,
		timeFormat,
		groceries,
		musicFolders,
		musicSpeakers,
		panelOpen = false,
		onWake,
		onOpenGroceries,
		onOpenMusic
	}: {
		timeZone: string;
		weather: Weather | null;
		slide: ScreensaverSlide | null;
		theme: 'light' | 'dark';
		timeFormat: TimeFormat;
		groceries: GroceriesSnapshot | null;
		musicFolders: MusicFolder[] | null;
		musicSpeakers: MusicSpeaker[] | null;
		/** True while the grocery or music sidebar is open. Both floating buttons hide in
		 *  that case — the panel itself is translucent (not blurred, per DESIGN.md §2.4), so
		 *  a button left visible behind it shows through as a distinct, oddly "floating"
		 *  shape rather than the softened blob a blurred backdrop would have hidden. The
		 *  button's whole purpose is quick access from the resting screensaver anyway; once
		 *  a panel is open, it has nothing left to do. */
		panelOpen?: boolean;
		onWake: () => void;
		onOpenGroceries: () => void;
		onOpenMusic: () => void;
	} = $props();

	let now = $state(new Date());
	$effect(() => {
		const id = setInterval(() => (now = new Date()), 15_000);
		return () => clearInterval(id);
	});

	let clock = $derived(formatMinutes(localMinutesInZone(now, timeZone), timeFormat));
	let dateLine = $derived(formatDayHeading(localDateInZone(now, timeZone)));
	let offset = $derived(driftOffset(now.getTime()));

	// Music sits above groceries (Alex's ask) — the groceries button's vertical offset is
	// derived from whether music is actually showing, rather than a hardcoded assumption
	// that both buttons are always present together. The two {#if}s are independently
	// gated (groceries on AnyList being connected, music on both a library and a speaker
	// being configured), so without this a groceries-only household would see the
	// groceries button floating with a phantom gap above it where music would have been.
	let musicButtonVisible = $derived(
		!!musicFolders && musicFolders.length > 0 && !!musicSpeakers && musicSpeakers.length > 0
	);

	function slideUrls(s: ScreensaverSlide): string[] {
		return s.kind === 'single' ? [s.photo.url] : [s.photos[0].url, s.photos[1].url];
	}
	function slideKey(s: ScreensaverSlide | null): string {
		return s ? slideUrls(s).join('|') : '';
	}

	// Two-layer crossfade: preload every image the incoming slide needs (one for a
	// landscape, two for a portrait pair) off-screen, then swap which layer is on top only
	// once all of them are actually decoded — otherwise a slow network paints a half-blank
	// frame during the transition instead of the previous slide holding until ready.
	let layerA = $state<ScreensaverSlide | null>(null);
	let layerB = $state<ScreensaverSlide | null>(null);
	let showA = $state(true);
	// No photo to sit an overlay on top of (quiet hours' night clock, DESIGN.md §9.2) —
	// centered and considerably bigger than the small top-pinned clock that overlays a
	// photo the rest of the time, since here it's the entire screen's content. Also happens
	// to be exactly "is it quiet hours right now" — the server only ever sends `slide: null`
	// during that window (screensaverPublisher.ts) — which the dimming below relies on.
	let isNightClock = $derived(!layerA && !layerB);

	$effect(() => {
		if (!slide) {
			// Quiet hours: the server explicitly told us to stop showing a photo (DESIGN.md
			// §9.2) — clear both layers so the display actually goes to the plain night
			// clock instead of leaving whatever was up frozen behind it.
			layerA = null;
			layerB = null;
			return;
		}
		const key = slideKey(slide);
		if (key === slideKey(layerA) || key === slideKey(layerB)) return;

		let cancelled = false;
		Promise.all(
			slideUrls(slide).map(
				(url) =>
					new Promise<void>((resolve, reject) => {
						const img = new Image();
						img.onload = () => resolve();
						img.onerror = () => reject(new Error(`failed to load ${url}`));
						img.src = url;
					})
			)
		)
			.then(() => {
				if (cancelled) return;
				if (showA) {
					layerB = slide;
					showA = false;
				} else {
					layerA = slide;
					showA = true;
				}
			})
			.catch(() => {
				// A photo failed to load (a stale fallback-ring entry, a transient NAS hiccup) —
				// keep showing whatever's already up rather than getting stuck on a broken slide.
			});
		return () => {
			cancelled = true;
		};
	});
</script>

{#snippet slideLayer(s: ScreensaverSlide)}
	{#if s.kind === 'single'}
		<img src={s.photo.url} alt="" class="absolute inset-0 h-full w-full object-cover" />
	{:else}
		<div class="absolute inset-0 flex">
			{#each s.photos as photo (photo.url)}
				<div class="relative h-full w-1/2 overflow-hidden">
					<img src={photo.url} alt="" class="absolute inset-0 h-full w-full object-contain" />
				</div>
			{/each}
		</div>
	{/if}
{/snippet}

<div class="relative h-full w-full">
	<button
		type="button"
		onclick={onWake}
		aria-label="Wake display"
		class="relative flex h-full w-full items-center justify-center bg-black text-white"
	>
		{#if layerA}
			<div
				class="absolute inset-0 transition-opacity duration-[2000ms]"
				style="opacity: {showA ? 1 : 0}"
			>
				{@render slideLayer(layerA)}
			</div>
		{/if}
		{#if layerB}
			<div
				class="absolute inset-0 transition-opacity duration-[2000ms]"
				style="opacity: {showA ? 0 : 1}"
			>
				{@render slideLayer(layerB)}
			</div>
		{/if}
		{#if layerA || layerB}
			<!-- Flat tint, not blur (DESIGN.md §2.4 rules out backdrop-filter/blur on this
		     hardware) — keeps the overlay text legible over a bright photo. -->
			<div class="absolute inset-0 bg-black/20"></div>
			<!-- DESIGN.md §5.3: "after sunset the screensaver dims photos to roughly 80%
		     brightness" — a second flat black tint, not a CSS `filter`, for the same §2.4
		     hardware reason as above: opacity is pure compositor work, filter forces its own
		     composited layer and isn't verified cheap on this GPU. Stacked on the legibility
		     tint above, 20% here brings a dark-mode photo to ~64% of its original brightness
		     (0.8 × 0.8) — same combined effect a brightness(0.8) filter would have produced,
		     with none of the filter risk. Crossfades with everything else theme-driven, same
		     ~2s. -->
			<div
				class="absolute inset-0 bg-black transition-opacity duration-[2000ms]"
				style="opacity: {theme === 'dark' ? 0.2 : 0}"
			></div>
		{/if}

		<!-- Clock and guest badge drift together, DESIGN.md §7.1's "overlay drifts slowly
	     around the screen" — both are small enough, with enough margin from the true
	     screen edge, that a few px of wobble never exposes anything behind them. -->
		<div class="absolute inset-0" style="transform: translate({offset.x}px, {offset.y}px)">
			<!-- Dims the night clock itself, not an overlay on top of it — the background here is
		     already pure black (bg-black on the root button), so there's nothing else to tint;
		     the clock's own white text is the only thing on screen worth dimming. No scheduled
		     screen-off/wake is configured on the tablet (§9.2, deploy/README.md §11), so this
		     is the substitute for "the display isn't glaring in a dark kitchen at 2am" —
		     opacity, not a CSS filter, for the same §2.4
		     hardware reason the photo dimming below uses opacity too. 40%, well below the 80%
		     DESIGN.md §5.3 dims photos to after sunset — a solid block of white digits on pure
		     black is a much more extreme "one bright thing on black" case than a photo, which
		     already has its own local contrast and gets stacked tints on top. -->
			<div
				class="flex h-full flex-col items-center gap-2 transition-opacity duration-[2000ms] {isNightClock
					? 'justify-center opacity-40'
					: 'justify-start pt-[10vh]'}"
			>
				<p
					class="leading-none font-light tabular-nums {isNightClock ? 'text-[13rem]' : 'text-8xl'}"
				>
					{clock}
				</p>
				<p class="text-slate-300 {isNightClock ? 'text-3xl' : 'text-2xl'}">{dateLine}</p>
				{#if weather}
					<p class="flex items-center gap-2 text-xl text-slate-300">
						<WeatherIconGlyph icon={weather.icon} class="h-6 w-6" />
						{weather.temperatureC}° {weather.condition}
					</p>
					{#if weather.sunrise && weather.sunset}
						<p class="flex items-center gap-4 text-lg text-slate-300">
							<span class="flex items-center gap-1.5">
								<WeatherIconGlyph icon="sunrise" class="h-5 w-5" />
								{formatHHMM(weather.sunrise, timeFormat)}
							</span>
							<span class="flex items-center gap-1.5">
								<WeatherIconGlyph icon="sunset" class="h-5 w-5" />
								{formatHHMM(weather.sunset, timeFormat)}
							</span>
						</p>
					{/if}
				{/if}
			</div>
		</div>

		{#if weather && weather.hourly.length > 0}
			<!-- §7.1's overlay carries "the current temperature and condition" — this extends
		     that into a short forecast strip, the way most weather apps show what's coming
		     rather than only right now.

		     No backdrop at all, in either theme — a solid bg-black panel (tried first for
		     dark theme only, after an earlier gradient version read as a smudge) turned out
		     to read as a harsh cutoff across the bottom of the picture regardless of theme,
		     not just by day. The row sits directly on the photo; legibility comes from the
		     existing full-screen tint above (20% always, another 20% stacked at night) —
		     the same thing the clock/weather overlay up top already relies on with no
		     backdrop of its own. -->
			<div class="absolute inset-x-0 bottom-0 flex items-end justify-center px-10 pt-16 pb-8">
				<div class="flex gap-10" style="transform: translate({offset.x}px, {offset.y}px)">
					{#each weather.hourly as hour (hour.time)}
						<div class="flex flex-col items-center gap-1 text-slate-200">
							<p class="text-sm text-slate-400">{formatHHMM(hour.time, timeFormat)}</p>
							<WeatherIconGlyph icon={hour.icon} class="h-7 w-7" />
							<p class="text-lg font-medium tabular-nums">{hour.temperatureC}°</p>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</button>

	{#if musicButtonVisible && !panelOpen}
		<!-- docs/phase-7-music-plan.md: same PIN-free-from-the-screensaver treatment as
		     groceries, positioned above it (Alex's ask). Gated on both lists being
		     non-empty (unlike groceries' "show even when empty") — an empty library or no
		     configured speakers means there's genuinely nothing to do here yet, not a
		     normal empty state worth surfacing. -->
		<button
			type="button"
			onclick={onOpenMusic}
			aria-label="Music"
			class="absolute top-6 right-6 flex h-14 w-14 items-center justify-center rounded-full border border-white/40 bg-white/25 text-slate-800 shadow-[0_2px_10px_rgba(0,0,0,0.35)] active:bg-white/40"
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="h-7 w-7"
			>
				<path d="M9.5 17.5V5.5l9-2v12" />
				<circle cx="6.8" cy="17.5" r="2.7" fill="currentColor" stroke="none" />
				<circle cx="15.8" cy="15.5" r="2.7" fill="currentColor" stroke="none" />
			</svg>
		</button>
	{/if}

	{#if groceries && !panelOpen}
		<!-- DESIGN.md §5.1: PIN-free groceries, reachable straight from the resting screensaver.
	     Sibling of the wake button, not nested in it — a real <button> can't nest inside
	     another one — so it sits fixed in the corner rather than drifting with the clock
	     overlay above (DESIGN.md §7.1's burn-in drift lives inside that button's own
	     subtree); a small icon tapped occasionally is a much smaller burn-in risk than the
	     always-on clock that drift exists for. Offset depends on whether the music button
	     is showing above it — the two {#if}s gate independently (this on AnyList being
	     connected, music on a library + speaker being configured), so a fixed offset would
	     leave a phantom gap whenever only one of the two is present. -->
		<button
			type="button"
			onclick={onOpenGroceries}
			aria-label="Groceries"
			class="absolute {musicButtonVisible
				? 'top-24'
				: 'top-6'} right-6 flex h-14 w-14 items-center justify-center rounded-full border border-white/40 bg-white/25 text-slate-800 shadow-[0_2px_10px_rgba(0,0,0,0.35)] active:bg-white/40"
		>
			<!-- A hand-drawn glyph, not the 🛒 emoji — WeatherIconGlyph's own reasoning applies
			     here too: an emoji's rendering (and its color) depends on the platform's font,
			     which on some renders as a near-invisible thin outline. currentColor keeps this
			     one a guaranteed-contrast solid regardless of device. -->
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="h-7 w-7"
			>
				<path d="M3 4h2.2l2.1 11.1a1.8 1.8 0 0 0 1.8 1.5h7.6a1.8 1.8 0 0 0 1.77-1.47L20 8H6.1" />
				<circle cx="9.5" cy="20" r="1.3" fill="currentColor" stroke="none" />
				<circle cx="17" cy="20" r="1.3" fill="currentColor" stroke="none" />
			</svg>
		</button>
	{/if}
</div>
