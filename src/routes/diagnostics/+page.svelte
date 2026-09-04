<script lang="ts">
	// Device diagnostics — DESIGN.md §2.4/§9 require the tablet's real CSS viewport to be
	// measured before layout work, because Android reports far fewer CSS pixels than the
	// panel's physical resolution and the figure decides whether the 1024–1340px fluid
	// range holds at all.
	//
	// Deliberately dependency-free and readable at arm's length on a wall-mounted 8" panel.

	interface Metrics {
		innerWidth: number;
		innerHeight: number;
		dpr: number;
		screenWidth: number;
		screenHeight: number;
		visualWidth: number | null;
		orientation: string;
		userAgent: string;
	}

	let metrics = $state<Metrics | null>(null);

	function read(): Metrics {
		return {
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			dpr: window.devicePixelRatio,
			screenWidth: window.screen.width,
			screenHeight: window.screen.height,
			visualWidth: window.visualViewport ? Math.round(window.visualViewport.width) : null,
			orientation: window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait',
			userAgent: navigator.userAgent
		};
	}

	$effect(() => {
		metrics = read();
		const update = () => (metrics = read());
		window.addEventListener('resize', update);
		window.addEventListener('orientationchange', update);
		return () => {
			window.removeEventListener('resize', update);
			window.removeEventListener('orientationchange', update);
		};
	});

	// §2.4 builds the layout fluid across this range; anything outside it changes the plan.
	const FLUID_MIN = 960;
	const FLUID_MAX = 1340;

	let inRange = $derived(
		metrics ? metrics.innerWidth >= FLUID_MIN && metrics.innerWidth <= FLUID_MAX : false
	);
</script>

<svelte:head><title>Device diagnostics — Hearth</title></svelte:head>

<main class="min-h-screen bg-slate-950 p-6 font-mono text-slate-100">
	{#if metrics}
		<p class="text-sm tracking-widest text-slate-400 uppercase">CSS viewport width</p>
		<p class="text-8xl leading-none font-bold tabular-nums">{metrics.innerWidth}</p>
		<p class="mt-1 text-2xl text-slate-400 tabular-nums">
			× {metrics.innerHeight} &nbsp;·&nbsp; DPR {metrics.dpr}
		</p>

		<p
			class="mt-5 inline-block rounded px-3 py-2 text-lg font-semibold {inRange
				? 'bg-emerald-900 text-emerald-100'
				: 'bg-amber-900 text-amber-100'}"
		>
			{inRange
				? `inside the ${FLUID_MIN}–${FLUID_MAX}px fluid range`
				: `OUTSIDE the ${FLUID_MIN}–${FLUID_MAX}px range — layout plan needs revisiting`}
		</p>

		<dl class="mt-7 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-lg">
			<dt class="text-slate-400">screen</dt>
			<dd class="tabular-nums">{metrics.screenWidth} × {metrics.screenHeight}</dd>
			<dt class="text-slate-400">visual vp</dt>
			<dd class="tabular-nums">{metrics.visualWidth ?? 'n/a'}</dd>
			<dt class="text-slate-400">physical</dt>
			<dd class="tabular-nums">
				{Math.round(metrics.innerWidth * metrics.dpr)} × {Math.round(
					metrics.innerHeight * metrics.dpr
				)}
			</dd>
			<dt class="text-slate-400">orientation</dt>
			<dd>{metrics.orientation}</dd>
		</dl>

		<p class="mt-6 text-xs leading-relaxed break-all text-slate-500">{metrics.userAgent}</p>
	{:else}
		<p class="text-2xl">Reading device metrics…</p>
	{/if}
</main>
