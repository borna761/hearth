// Pure display labels for weather metrics — split out from $lib/server/weather.ts
// specifically so WeatherPanel.svelte (client-side) can import them: SvelteKit refuses to
// bundle anything from $lib/server/* into browser code, even a plain lookup function with
// no server dependency of its own, so these have to live outside that boundary.

/** EPA's own US AQI category labels/breakpoints (airnow.gov) — for the full-screen weather
 * report, alongside the raw number, since 0-500 means nothing to glance at on its own. */
export function aqiCategory(aqi: number): string {
	if (aqi <= 50) return 'Good';
	if (aqi <= 100) return 'Moderate';
	if (aqi <= 150) return 'Unhealthy for sensitive groups';
	if (aqi <= 200) return 'Unhealthy';
	if (aqi <= 300) return 'Very unhealthy';
	return 'Hazardous';
}

/** The standard WHO/EPA UV index category labels — same "raw number means nothing alone"
 * reasoning as aqiCategory above. */
export function uvCategory(index: number): string {
	if (index < 3) return 'Low';
	if (index < 6) return 'Moderate';
	if (index < 8) return 'High';
	if (index < 11) return 'Very high';
	return 'Extreme';
}

const COMPASS_POINTS = [
	'N',
	'NNE',
	'NE',
	'ENE',
	'E',
	'ESE',
	'SE',
	'SSE',
	'S',
	'SSW',
	'SW',
	'WSW',
	'W',
	'WNW',
	'NW',
	'NNW'
];

/** A 0-359 compass bearing (Open-Meteo's wind_direction_10m) to its 16-point abbreviation
 * — "270°" means less at a glance than "W" does. */
export function windDirectionLabel(deg: number): string {
	const index = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
	return COMPASS_POINTS[index];
}
