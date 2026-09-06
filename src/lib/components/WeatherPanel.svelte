<script lang="ts">
	import type { Weather } from '$lib/server/weather';
	import { aqiCategory, uvCategory, windDirectionLabel } from '$lib/weatherLabels';
	import { weekdayAbbrev, dayNumber } from '$lib/datetime';
	import WeatherIconGlyph, { type GlyphIcon } from './WeatherIcon.svelte';

	let { weather, onClose }: { weather: Weather; onClose: () => void } = $props();

	// One row, sized to however many of these actually have data (each is independently
	// nullable) — built as a list rather than N near-identical {#if} blocks so the grid
	// below can size its columns to the real count and never leave a gap where a metric
	// happened to be missing.
	let metrics = $derived.by(() => {
		const items: { icon: GlyphIcon; value: string; label: string }[] = [];
		if (weather.precipitationMm !== null) {
			items.push({
				icon: 'precipitation',
				value: `${weather.precipitationMm} mm`,
				label: 'Precipitation'
			});
		}
		if (weather.humidityPercent !== null) {
			items.push({ icon: 'humidity', value: `${weather.humidityPercent}%`, label: 'Humidity' });
		}
		if (weather.windSpeedKmh !== null) {
			const direction =
				weather.windDirectionDeg !== null ? ` ${windDirectionLabel(weather.windDirectionDeg)}` : '';
			items.push({
				icon: 'wind',
				value: `${weather.windSpeedKmh} km/h${direction}`,
				label: 'Wind'
			});
		}
		if (weather.uvIndex !== null) {
			items.push({
				icon: 'sun',
				value: String(weather.uvIndex),
				label: `UV · ${uvCategory(weather.uvIndex)}`
			});
		}
		if (weather.airQualityIndex !== null) {
			items.push({
				icon: 'aqi',
				value: String(weather.airQualityIndex),
				label: `AQI · ${aqiCategory(weather.airQualityIndex)}`
			});
		}
		return items;
	});

	// Shared by the metrics and daily rows below — both want "one row, sized to the real
	// count" (see the comments at each call site), so the column-count math lives once.
	function equalColumnsStyle(count: number): string {
		return `grid-template-columns: repeat(${count}, 1fr)`;
	}

	// weather.daily's index 0 is today — skipped here since there's no separate "Today"
	// section left on this panel to make repeating it here redundant against; today's
	// current conditions are already covered by the block above.
	let dailyWithLabels = $derived(
		weather.daily.slice(1).map((day) => ({
			...day,
			weekday: weekdayAbbrev(day.date),
			dayNumber: dayNumber(day.date)
		}))
	);
</script>

<!-- Full-bleed, not a sidebar (unlike GroceryPanel/MusicPanel) — Alex's ask was
     specifically a "full screen weather report", and there's meaningfully more to show
     here (today's metrics, a multi-day row) than fits alongside the screensaver's photo in
     a narrow strip. The hourly breakdown lives on the screensaver's own weather strip, not
     repeated here — Alex's ask, once this panel existed as a separate place to look.
     Translucent (bg-black/70), not opaque — Alex's ask: the screensaver photo underneath
     should still show through. Same white text as the screensaver itself, since this only
     ever opens from there.

     The whole panel is the close target, no ✕ at all — nothing inside it is otherwise
     interactive (no controls to protect from an accidental close), so there's no reason to
     make someone find a small corner target instead of tapping anywhere. A real <button>
     here, not a div+onclick, for the same reason every other tap target in this app is
     one. -->
<button
	type="button"
	onclick={onClose}
	aria-label="Close weather"
	class="scrollbar-hide absolute inset-0 z-30 flex flex-col overflow-y-auto bg-black/70 text-left text-white"
>
	<div class="flex flex-1 flex-col items-center gap-10 px-8 pt-10 pb-10">
		<!-- Current conditions -->
		<div class="flex flex-col items-center gap-1">
			<WeatherIconGlyph icon={weather.icon} class="h-20 w-20" />
			<p class="text-7xl leading-none font-light tabular-nums">{weather.temperatureC}°</p>
			<p class="text-xl text-slate-300">{weather.condition}</p>
			{#if weather.feelsLikeC !== null}
				<p class="text-sm text-slate-400">Feels like {weather.feelsLikeC}°</p>
			{/if}
		</div>

		<!-- One row, not a 3-column wrap — Alex's ask: shrink these to fit side by side
		     rather than spilling to a second row. Sized to the real visible count (metrics
		     is built in the script above), same "no partial/awkward wrap" reasoning as the
		     hourly/daily rows below. -->
		{#if metrics.length > 0}
			<div class="grid w-full max-w-3xl gap-2" style={equalColumnsStyle(metrics.length)}>
				{#each metrics as metric (metric.icon)}
					<div class="flex min-w-0 flex-col items-center gap-1 rounded-lg bg-white/10 py-3">
						<WeatherIconGlyph icon={metric.icon} class="h-6 w-6" />
						<p class="truncate text-lg font-medium tabular-nums">{metric.value}</p>
						<p class="truncate text-xs text-slate-400">{metric.label}</p>
					</div>
				{/each}
			</div>
		{/if}

		{#if dailyWithLabels.length > 0}
			<!-- A fixed grid, not a scrolling row — forecast_days (weather.ts) is a known,
			     small count, so every day can just fit at once. A scrolling row here had a
			     partial day visibly cut off at the edge with no scrollbar left to hint that
			     (Alex's ask, once the scrollbar itself was hidden) that there was more to see
			     — this sidesteps that entirely rather than trying to make a cut-off tile look
			     intentional. -->
			<div class="flex w-full max-w-3xl flex-col gap-2">
				<h2 class="text-sm font-medium text-slate-400">Coming up</h2>
				<div class="grid gap-2" style={equalColumnsStyle(dailyWithLabels.length)}>
					{#each dailyWithLabels as day (day.date)}
						<div class="flex min-w-0 flex-col items-center gap-1">
							<p class="truncate text-sm text-slate-400">{day.weekday} {day.dayNumber}</p>
							<WeatherIconGlyph icon={day.icon} class="h-6 w-6" />
							<p class="truncate text-base font-medium tabular-nums">
								{day.highC}° <span class="text-slate-400">{day.lowC}°</span>
							</p>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</button>

<style>
	/* Kiosk hardware has no mouse (Alex's ask) — a scrollbar here is a visual artifact, not
	   a control anyone uses. Scrolling itself still works via touch drag — only the
	   track/thumb are hidden. Applied to the panel's own vertical overflow, in case the
	   metrics grid plus the daily forecast row together run taller than the viewport. */
	.scrollbar-hide {
		scrollbar-width: none;
		-ms-overflow-style: none;
	}
	.scrollbar-hide::-webkit-scrollbar {
		display: none;
	}
</style>
