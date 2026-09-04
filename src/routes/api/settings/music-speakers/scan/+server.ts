import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { discoverAllSpeakerNames } from '$lib/server/googleCast/discovery';

/** The settings screen's "Scan for speakers" action — lists every discoverable Cast
 * friendly name (individual speakers and groups alike) so the household picks from what's
 * actually on the network rather than typing a name blind. */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const names = await discoverAllSpeakerNames();
	return json({ ok: true, names });
};
