import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { setVisibilityForRow } from '$lib/server/visibility';
import { publishState } from '$lib/server/state/publisher';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const userId = Number(body?.userId);
	const sourceIds = Array.isArray(body?.sourceIds) ? body.sourceIds.map(Number) : null;
	const visible = typeof body?.visible === 'boolean' ? body.visible : null;

	if (!Number.isInteger(userId) || !sourceIds || visible === null) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await setVisibilityForRow(db, userId, sourceIds, visible);

	// Always safe, never wrong: if the edited user isn't the tablet's current active
	// session, the rebuilt snapshot is identical to before and the broadcaster's own dedup
	// skips sending it — this is how the tablet updates live when it IS that user, without
	// this route needing to know who's currently active.
	await publishState();

	return json({ ok: true });
};
