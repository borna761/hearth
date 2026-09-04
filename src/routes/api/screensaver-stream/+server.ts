import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { screensaverBus, publishScreensaverState } from '$lib/server/state/screensaverPublisher';
import { createSseResponse } from '$lib/server/state/sse';

/**
 * Deliberately public — DESIGN.md §5's access diagram labels the screensaver "no household
 * data," visible before any PIN. Unlike /api/stream, there is no `locals.session` check
 * here; this route only ever carries weather and the current photo slide.
 */
export const GET: RequestHandler = async () => {
	// Make sure the very first connection has something to hand over, same reasoning as
	// /api/stream's own call to publishState.
	await publishScreensaverState(db).catch(() => {
		/* An empty or unreachable database still deserves an open stream. */
	});

	return createSseResponse(screensaverBus);
};
