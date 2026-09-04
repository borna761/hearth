// Normalizes hex color input for scripts/seed-users.mjs. A value missing its leading '#'
// is silent CSS poison, not an error — `background-color: 5484ED` is invalid and gets
// ignored by the browser, leaving the element's background transparent. On this app that
// meant every avatar chip (Lock, Settings) rendered as white text on the white card behind
// it: invisible, no error anywhere. Found on the real deploy after seeding real users.

/** Returns the normalized '#rrggbb' form, or null if `raw` isn't a valid hex color either
 * way (with or without a leading '#'). */
export function normalizeHexColor(raw) {
	const withHash = raw.startsWith('#') ? raw : `#${raw}`;
	return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash : null;
}
