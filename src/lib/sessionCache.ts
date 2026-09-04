// A read-only rendering fallback for the gap between a page load and the first real SSE
// message — never a decision cache. week/viewMode.ts's own comment rejects localStorage
// for anything that's actually a decision ("several people share the one tablet," and
// DESIGN.md §5.3 says the server owns those). This is different in kind: nothing here ever
// influences behavior, and a real SSE push always overwrites it the instant one arrives —
// it exists purely so a reload shows the last-known week/groceries instead of a blank
// "Loading…" while waiting for the stream to (re)connect, which matters most exactly when
// the Pi is slow to come back (a deploy, a restart) rather than merely absent.
//
// Scoped by userId so switching who's logged in on the same tablet never shows the
// previous person's data, not even for a frame — the cache is simply unusable for anyone
// but the userId it was saved under.

import type { WeekSnapshot } from './server/state/snapshot';
import type { GroceriesSnapshot } from './server/groceries';
import type { TasksSnapshot } from './server/tasks';

const KEY = 'hearth:sessionCache';
// Generous enough to cover the Pi being down for a while (a stuck deploy, a long power
// blip) without showing something actively wrong — the tablet's job is a glance at "what's
// happening today," not an archive of who-knows-how-old data.
const MAX_AGE_MS = 6 * 60 * 60_000;

interface CacheEntry {
	userId: number;
	savedAt: number;
	snapshot: WeekSnapshot;
	groceries: GroceriesSnapshot | null;
	tasks: TasksSnapshot | null;
}

/** Exported for testing — the one piece of this module with real logic in it. */
export function isUsableCacheEntry(
	entry: CacheEntry | null,
	userId: number,
	now: number,
	maxAgeMs = MAX_AGE_MS
): entry is CacheEntry {
	if (!entry) return false;
	if (entry.userId !== userId) return false;
	return now - entry.savedAt <= maxAgeMs;
}

export function saveSessionCache(entry: {
	userId: number;
	snapshot: WeekSnapshot;
	groceries: GroceriesSnapshot | null;
	tasks: TasksSnapshot | null;
}): void {
	if (typeof localStorage === 'undefined') return;
	try {
		const record: CacheEntry = { ...entry, savedAt: Date.now() };
		localStorage.setItem(KEY, JSON.stringify(record));
	} catch {
		// Storage full, disabled, or a private-browsing quota — this cache is a nice-to-have
		// fallback, never load-bearing, so failing silently here is correct.
	}
}

export function loadSessionCache(userId: number): {
	snapshot: WeekSnapshot;
	groceries: GroceriesSnapshot | null;
	tasks: TasksSnapshot | null;
} | null {
	if (typeof localStorage === 'undefined') return null;
	let parsed: CacheEntry | null;
	try {
		const raw = localStorage.getItem(KEY);
		parsed = raw ? (JSON.parse(raw) as CacheEntry) : null;
	} catch {
		return null;
	}
	if (!isUsableCacheEntry(parsed, userId, Date.now())) return null;
	return { snapshot: parsed.snapshot, groceries: parsed.groceries, tasks: parsed.tasks };
}

export function clearSessionCache(): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.removeItem(KEY);
	} catch {
		// Same reasoning as saveSessionCache.
	}
}
