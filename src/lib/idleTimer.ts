// Pure(ish) idle-timer and heartbeat logic pulled out of +page.svelte's idle-timeout
// effects — same reasoning panelIdle.ts already follows for the timeout-selection logic:
// testable without a component-testing setup. `target` defaults to `window` in real use
// but is injectable so tests can watch/fire activity events without a DOM.

export interface ActivityTarget {
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

const ACTIVITY_EVENTS = ['touchstart', 'click', 'keydown'] as const;

/**
 * Resets a timer on every activity event, calling `onIdle` once `timeoutMs` passes with no
 * activity. `onActivity`, if given, fires on every activity tick before the timer resets —
 * +page.svelte uses this for its own throttled heartbeat. Returns a cleanup function that
 * clears the timer and removes the activity listeners.
 */
export function watchIdle(
	timeoutMs: number,
	onIdle: () => void,
	onActivity?: () => void,
	target: ActivityTarget = window
): () => void {
	let idleTimer: ReturnType<typeof setTimeout>;
	const resetIdle = () => {
		onActivity?.();
		clearTimeout(idleTimer);
		idleTimer = setTimeout(onIdle, timeoutMs);
	};

	resetIdle();
	for (const eventName of ACTIVITY_EVENTS) target.addEventListener(eventName, resetIdle);

	return () => {
		clearTimeout(idleTimer);
		for (const eventName of ACTIVITY_EVENTS) target.removeEventListener(eventName, resetIdle);
	};
}

/**
 * Pings the session-heartbeat endpoint and calls `onExpired` if the server reports the
 * session already expired. Swallows a network failure silently — a heartbeat is best-effort
 * upkeep, not something a transient failure should surface as an error.
 */
export function sendHeartbeat(onExpired: () => void, fetchFn: typeof fetch = fetch): void {
	fetchFn('/api/auth/heartbeat', { method: 'POST' })
		.then((res) => res.json())
		.then((body: { expired?: boolean }) => {
			if (body.expired) onExpired();
		})
		.catch(() => {});
}
