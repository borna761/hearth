// The household's pinned coordinates — DESIGN.md §5.3/§7.1, used by weather.ts (Open-Meteo
// requests) and theme.ts (sun-based auto theme). A single definition so the two settings
// (and the household_location override in server/settings.ts) can't drift apart.

export interface HouseholdLocation {
	latitude: number;
	longitude: number;
}

/** Springfield, until changed in Settings. */
export const DEFAULT_HOUSEHOLD_LOCATION: HouseholdLocation = {
	latitude: 45.5,
	longitude: -75.5
};
