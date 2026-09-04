// Fan-out of state snapshots to connected displays — DESIGN.md §10's SSE transport.
//
// In practice this serves the kitchen tablet and occasionally a phone, so the interesting
// cases are not scale but failure: a half-closed socket, and a client that reconnects in
// a loop.

export type Send = (payload: string) => void;

/**
 * Hard ceiling on concurrent streams. Not about expected load — it is two devices — but
 * about §2.1's rule that a Hearth bug must not exhaust memory and take the household's
 * DNS down with it. A kiosk app auto-reconnecting without bound after a crash or a bad
 * response is the realistic route to that, whether or not it's also relaunching itself
 * (§9.1 — Free Kiosk's own crash-relaunch behavior isn't confirmed either way).
 */
export const MAX_CLIENTS = 8;

export interface Broadcaster {
	/** Returns an unsubscribe function, or null if the connection cap is reached. */
	subscribe(send: Send): (() => void) | null;
	/** True if the payload differed from the last one and was sent; false if deduped. */
	publish(payload: string): boolean;
	readonly clientCount: number;
}

export function createBroadcaster(): Broadcaster {
	const clients = new Set<Send>();
	let lastPayload: string | null = null;

	return {
		subscribe(send) {
			if (clients.size >= MAX_CLIENTS) return null;
			clients.add(send);

			// Bring the newcomer up to date at once. A tablet reconnecting after the nightly
			// 04:00 reload (§9.1) would otherwise show nothing until the next sync changed
			// something, which could be a long time on a quiet day.
			if (lastPayload !== null) {
				try {
					send(lastPayload);
				} catch {
					clients.delete(send);
					return null;
				}
			}

			return () => clients.delete(send);
		},

		publish(payload) {
			// Sync runs every five minutes and usually finds nothing changed; pushing an
			// identical week to a display already showing it is pure waste. Comparing the
			// serialised payload is why buildWeekSnapshot rounds its timestamp to the minute.
			if (payload === lastPayload) return false;
			lastPayload = payload;

			for (const send of [...clients]) {
				try {
					send(payload);
				} catch {
					// A wedged or half-closed socket is dropped rather than retried forever.
					clients.delete(send);
				}
			}
			return true;
		},

		get clientCount() {
			return clients.size;
		}
	};
}
