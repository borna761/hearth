import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { enqueueAdd } from '$lib/server/groceriesQueue';
import { canAccessPinFreeFeature } from '$lib/server/auth/session';
import {
	groceriesSourceId,
	groceriesReadiness,
	runGroceriesCycleNow
} from '$lib/server/groceriesRuntime';
import { publishAll } from '$lib/server/state/publisher';

/**
 * Adds a grocery item — DESIGN.md §5.1: read/write for every signed-in user, and also
 * PIN-free from the screensaver's groceries button outside guest mode (canAccessPinFreeFeature).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!canAccessPinFreeFeature(locals)) {
		return json({ ok: false }, { status: 401 });
	}

	const sourceId = groceriesSourceId();
	if (!sourceId) {
		// §2.5: an outage degrades one card to a stale badge, never the page — this is the
		// write-side equivalent. `reason` distinguishes "AnyList was never connected" from
		// "it's connected but this process is still starting up" (every deploy restarts it,
		// and the real login round trip takes a few seconds) — the two look identical from
		// groceriesSourceId() alone, and a client retrying a few seconds later needs to know
		// which one it's looking at.
		const readiness = await groceriesReadiness(db);
		return json(
			{ ok: false, reason: readiness === 'initializing' ? 'initializing' : 'not-connected' },
			{ status: 503 }
		);
	}

	const body = await request.json().catch(() => null);
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	const quantity =
		typeof body?.quantity === 'string' && body.quantity.trim() ? body.quantity : null;

	if (!name) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	const id = enqueueAdd(db, sourceId, { name, quantity }, new Date());
	// The optimistic apply inside enqueueAdd is what makes this feel instant — push the
	// result out before AnyList has even heard about it. publishAll (not publishState
	// alone) so a PIN-free edit from the screensaver's own groceries button shows up
	// immediately too, not just up to SCREENSAVER_TICK_MS later — a locked envelope
	// carries no groceries field at all, so publishState alone can't reach that display.
	await publishAll();
	// Fire-and-forget: AnyList's own round trip must not hold up this response. Still
	// publishes again once the drain actually finishes, though — without this, the pending
	// mark this enqueue just showed would only clear via the next unrelated tick (up to
	// 60s away) or the 15-minute poll, undermining the whole reason M3 built an eager
	// trigger in the first place. Caught, not awaited: a failed cycle already marks the
	// connection errored inside runGroceriesCycleNow itself, and a failed publish here has
	// nothing more useful to do than log — the next tick still recovers either way.
	void runGroceriesCycleNow(false)
		.then(() => publishAll())
		.catch((err) => console.warn('[groceries] post-write publish failed:', err));

	return json({ ok: true, id });
};
