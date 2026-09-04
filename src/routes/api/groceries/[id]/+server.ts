import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { enqueueSetChecked, enqueueRemove } from '$lib/server/groceriesQueue';
import { canAccessPinFreeFeature } from '$lib/server/auth/session';
import {
	groceriesSourceId,
	groceriesReadiness,
	runGroceriesCycleNow
} from '$lib/server/groceriesRuntime';
import { publishAll } from '$lib/server/state/publisher';

/** Checks, unchecks, or removes an existing item — same gate as POST /api/groceries. */
export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!canAccessPinFreeFeature(locals)) {
		return json({ ok: false }, { status: 401 });
	}

	const sourceId = groceriesSourceId();
	if (!sourceId) {
		// See POST /api/groceries — distinguishes "never connected" from "still starting up".
		const readiness = await groceriesReadiness(db);
		return json(
			{ ok: false, reason: readiness === 'initializing' ? 'initializing' : 'not-connected' },
			{ status: 503 }
		);
	}

	const body = await request.json().catch(() => null);
	const action = body?.action;
	if (action !== 'check' && action !== 'uncheck' && action !== 'remove') {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	const now = new Date();
	let found: boolean;
	if (action === 'remove') {
		enqueueRemove(db, sourceId, params.id, now);
		// client.ts's removeItem is documented as a no-op, not an error, when AnyList
		// doesn't have the item either — matching that here rather than treating an
		// already-gone item as a client mistake.
		found = true;
	} else {
		found = enqueueSetChecked(db, sourceId, params.id, action === 'check', now);
	}

	if (!found) {
		return json({ ok: false, reason: 'not-found' }, { status: 404 });
	}

	// publishAll (not publishState alone) — see POST /api/groceries for why: a PIN-free
	// edit from the screensaver's own groceries button needs the screensaver bus refreshed
	// too, not just the session-gated one.
	await publishAll();
	// See POST /api/groceries for why this publishes again once the drain finishes,
	// rather than leaving the pending mark to clear on the next unrelated tick.
	void runGroceriesCycleNow(false)
		.then(() => publishAll())
		.catch((err) => console.warn('[groceries] post-write publish failed:', err));

	return json({ ok: true });
};
