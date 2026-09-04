// Guest mode's screensaver photo source — DESIGN.md §7.4/§5, using Picsum Photos
// (picsum.photos) rather than Unsplash: no developer account, no API key, and none of
// Unsplash's per-photo attribution/download-tracking-ping obligations.
//
// Unlike family photos (photos.ts, phase 4 milestone 5), the server never fetches or
// caches image bytes here — Picsum's seeded URLs are directly loadable by the tablet's
// own <img> tag, so this module's only job is picking a stable URL for the current slide.

/** DESIGN.md §6 — the panel's physical resolution; landscape derivatives target this. */
const WIDTH = 1280;
const HEIGHT = 800;

/**
 * A fresh Picsum URL for the current slide. `/seed/{seed}/...` returns the same image for
 * the same seed, which is what makes this URL stable for the 60s a slide is shown, rather
 * than Picsum handing back a different photo on every request for the same slide.
 *
 * Takes its randomness as a parameter (defaulting to Math.random) so a fixed source makes
 * this deterministic in tests, the same pattern weather.ts uses for `fetch`.
 */
export function nextGuestPhotoUrl(randomSource: () => number = Math.random): string {
	const seed = randomSource().toString(36).slice(2, 10);
	return `https://picsum.photos/seed/${seed}/${WIDTH}/${HEIGHT}`;
}
