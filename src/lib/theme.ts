// Sunrise/sunset theme computation — DESIGN.md §5.3: "the interface follows the sun."
// Pure and isomorphic (used server-side, where the server "owns the decision" per §5.3,
// and equally safe to unit-test without a server or a real clock) — computed locally via
// suncalc from the household's pinned coordinates, no network call, so the theme never
// depends on Open-Meteo being reachable.

import { getTimes } from 'suncalc';
import { DEFAULT_HOUSEHOLD_LOCATION, type HouseholdLocation } from './location';

export type Theme = 'light' | 'dark';
export type ThemeMode = 'auto' | 'light' | 'dark';

const ONE_DAY_MS = 24 * 60 * 60_000;

/**
 * `light | dark`, above the fixed `light`/`dark` override — DESIGN.md §5.3: "theme_mode
 * setting — auto | light | dark, default auto." `auto` computes from the actual sun
 * position; the light/dark boundary is [sunrise, sunset) — light exactly at sunrise,
 * already dark exactly at sunset, not still light one tick into it.
 *
 * Checks both "now"'s own suncalc day and the previous one, not just one getTimes() call.
 * suncalc keys a day's sunrise/sunset off `now`'s UTC calendar date, but a household west
 * of UTC (Springfield's EDT/EST, the default) regularly has local evening hours fall on
 * UTC's *next* calendar date — e.g. 20:30 EDT is already 00:30 UTC the next day. A single
 * getTimes(now, ...) call would then compute tomorrow's sunrise/sunset, whose sunrise
 * hasn't happened yet, and wrongly call still-bright summer evenings "dark". Checking
 * yesterday's UTC day's window too catches exactly that case, since its sunset (also
 * computed in UTC) is the one that actually extends into tonight's local evening.
 */
/** True when `now` falls in this suncalc day's [sunrise, sunset). suncalc types sunrise/
 * sunset as nullable because they genuinely can be, at high enough latitudes to lose a
 * sunrise or sunset entirely for stretches of the year (polar day/night) — the default
 * Springfield location (45°N) is nowhere near the 66.5° polar circles where that happens,
 * but a household-configured location could be closer. Treating a missing value as "not
 * light" is a safe, inert fallback either way, not something worth designing further
 * around for a case this app's one household is unlikely to actually hit. */
function isWithinDaylight(now: Date, times: ReturnType<typeof getTimes>): boolean {
	return (
		times.sunrise !== null && times.sunset !== null && now >= times.sunrise && now < times.sunset
	);
}

export function computeTheme(
	now: Date,
	mode: ThemeMode,
	location: HouseholdLocation = DEFAULT_HOUSEHOLD_LOCATION
): Theme {
	if (mode === 'light' || mode === 'dark') return mode;
	const yesterday = new Date(now.getTime() - ONE_DAY_MS);
	const today = getTimes(now, location.latitude, location.longitude);
	const priorDay = getTimes(yesterday, location.latitude, location.longitude);
	const isLight = isWithinDaylight(now, today) || isWithinDaylight(now, priorDay);
	return isLight ? 'light' : 'dark';
}
