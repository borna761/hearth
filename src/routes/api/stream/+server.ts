import type { RequestHandler } from './$types';
import { stateBus, publishState } from '$lib/server/state/publisher';
import { createSseResponse } from '$lib/server/state/sse';

export const GET: RequestHandler = async ({ locals }) => {
	// The actual enforcement boundary (DESIGN.md §5: "no unauthenticated path to any data
	// at all") — the client only ever opens this once it already has a valid session, but
	// that's a UX choice on the client's part, not something this route can trust.
	if (!locals.session) {
		return new Response(null, { status: 401 });
	}

	// Make sure the very first connection has something to hand over: publishState fills
	// the bus's cached payload, which subscribe() then replays to this client.
	await publishState().catch(() => {
		/* An empty or unreachable database still deserves an open stream. */
	});

	return createSseResponse(stateBus);
};
