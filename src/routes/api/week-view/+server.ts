import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { setUserWeekView } from '$lib/server/users';

/**
 * The agenda/grid toggle in the strip — session-gated like heartbeat, not admin-gated
 * like the rest of /api/settings, since it's each logged-in person setting their own
 * reading preference for their own session, not a household-wide configuration change.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ ok: false }, { status: 401 });
	}

	const body = await request.json().catch(() => null);
	const weekView = body?.weekView;
	if (weekView !== 'agenda' && weekView !== 'grid') {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await setUserWeekView(db, locals.session.userId, weekView);
	return json({ ok: true });
};
