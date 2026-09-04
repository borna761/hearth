// Shared SSE response plumbing for the two streams — publisher.ts's session-gated
// calendar stream and screensaverPublisher.ts's public one. The heartbeat, reconnect
// directive, and subscribe/cleanup dance are identical between them; only the bus (and
// each route's own auth check) differs, so that part lives once rather than twice.

import type { Broadcaster } from './broadcaster';

/**
 * Keepalive comment interval. Anything in the path — Tailscale Serve for the phone (§3.2),
 * or the tablet's own wifi power management — can drop a connection that says nothing for
 * long enough, and an idle display can legitimately have no state change for hours.
 * Comments are ignored by EventSource but keep the socket warm.
 */
const HEARTBEAT_MS = 25_000;

/** How long the browser waits before reconnecting. EventSource honours this directive. */
const RECONNECT_MS = 5_000;

export function createSseResponse(bus: Broadcaster): Response {
	const encoder = new TextEncoder();
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let unsubscribe: (() => void) | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const send = (payload: string) => {
				// Throwing here is how the broadcaster learns the socket is gone — it drops
				// any client whose send fails, so a closed controller cleans itself up.
				controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
			};

			controller.enqueue(encoder.encode(`retry: ${RECONNECT_MS}\n\n`));

			unsubscribe = bus.subscribe(send);
			if (!unsubscribe) {
				// At the connection cap (§2.1's memory ceiling). Closing immediately is
				// better than holding a socket we will never write to; the client's own
				// retry will find a slot once a stale connection drains.
				controller.enqueue(encoder.encode('event: full\ndata: {}\n\n'));
				controller.close();
				return;
			}

			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': ping\n\n'));
				} catch {
					// Socket died between ticks; cancel() may never fire for this one, so
					// tear down here too rather than leaking an interval per dead client.
					cleanup();
				}
			}, HEARTBEAT_MS);
		},

		cancel() {
			// Fires when the client disconnects — a tablet reload (§9.1), a reboot, wifi
			// dropping. Without this both the interval and the bus entry outlive the socket.
			cleanup();
		}
	});

	function cleanup() {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		unsubscribe?.();
		unsubscribe = null;
	}

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			// Harmless without a proxy, and stops one from buffering the stream into
			// uselessness if anything is ever put in front of the Pi.
			'x-accel-buffering': 'no'
		}
	});
}
