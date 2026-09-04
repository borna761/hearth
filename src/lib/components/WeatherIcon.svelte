<script lang="ts">
	import type { WeatherIcon } from '$lib/server/weather';

	// Flat, single-stroke icons — DESIGN.md §2.4 rules out backdrop-filter/blur/heavy
	// shadows on this hardware, and these are cheap enough that a whole forecast row of
	// them costs nothing. currentColor so the parent controls tint (dimmed after sunset,
	// per §5.3's post-sunset screensaver dimming).
	let {
		icon,
		class: className = ''
	}: { icon: WeatherIcon | 'sunrise' | 'sunset'; class?: string } = $props();
</script>

{#if icon === 'sun'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class={className}>
		<circle cx="12" cy="12" r="4.5" />
		<path
			stroke-linecap="round"
			d="M12 2v2.5M12 19.5V22M22 12h-2.5M4.5 12H2M19.07 4.93l-1.77 1.77M6.7 17.3l-1.77 1.77M19.07 19.07l-1.77-1.77M6.7 6.7 4.93 4.93"
		/>
	</svg>
{:else if icon === 'partly-cloudy'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class={className}>
		<circle cx="9" cy="8" r="3.5" />
		<path
			stroke-linecap="round"
			d="M9 1.5v1.8M9 12.7v1.3M15.5 8h-1.5M4 8H2.5M13.6 3.4l-1 1M5.4 11.6l-1 1"
		/>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M9.5 20.5h8a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.6 13.1a3.5 3.5 0 0 0 .9 7.4Z"
		/>
	</svg>
{:else if icon === 'fog'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class={className}>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M6.5 15.5h11a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.6 8.1a3.5 3.5 0 0 0-2.1 7.4Z"
		/>
		<path stroke-linecap="round" d="M4 19h16M6 22h12" />
	</svg>
{:else if icon === 'drizzle'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class={className}>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M6.5 13.5h11a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.6 6.1a3.5 3.5 0 0 0-2.1 7.4Z"
		/>
		<path stroke-linecap="round" d="M8 18v2M12 18v2M16 18v2" />
	</svg>
{:else if icon === 'rain'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class={className}>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M6.5 13h11a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.6 5.6a3.5 3.5 0 0 0-2.1 7.4Z"
		/>
		<path stroke-linecap="round" d="M7.5 17.5 6 21M12.5 17.5 11 21M17.5 17.5 16 21" />
	</svg>
{:else if icon === 'snow'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class={className}>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M6.5 13h11a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.6 5.6a3.5 3.5 0 0 0-2.1 7.4Z"
		/>
		<path
			stroke-linecap="round"
			d="M8 17.5v4M6 18.7l4 1.6M12 18v4M10 18.7l4 1.6M16 17.5v4M14 18.7l4 1.6"
		/>
	</svg>
{:else if icon === 'storm'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class={className}>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M6.5 12h11a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.6 4.6a3.5 3.5 0 0 0-2.1 7.4Z"
		/>
		<path stroke-linecap="round" stroke-linejoin="round" d="m13 15-3 4.5h3L11 23" />
	</svg>
{:else if icon === 'sunrise'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class={className}>
		<path
			stroke-linecap="round"
			d="M12 7.7V4.3M15 8.7 17 5.9M17 11.2 20.2 10M9 8.7 7 5.9M7 11.2 3.8 10"
		/>
		<path stroke-linecap="round" d="M1 13h22M4 16h16M6.5 19h11" />
		<path stroke-linecap="round" stroke-linejoin="round" d="M7.5 13a4.5 4.5 0 0 1 9 0" />
	</svg>
{:else if icon === 'sunset'}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class={className}>
		<path
			stroke-linecap="round"
			d="M12 7.7V4.3M15 8.7 17 5.9M17 11.2 20.2 10M9 8.7 7 5.9M7 11.2 3.8 10"
		/>
		<path stroke-linecap="round" d="M1 13h22M4 16h16M6.5 19h11" />
		<path stroke-linecap="round" d="M7.5 13a4.5 4.5 0 0 1 9 0z" fill="currentColor" />
	</svg>
{:else}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class={className}>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M6.5 16.5h11a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.6 9.1a3.5 3.5 0 0 0-2.1 7.4Z"
		/>
	</svg>
{/if}
