import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { setRestrictedTaskProjectId } from '$lib/server/settings';
import { publishState } from '$lib/server/state/publisher';

/** Settings screen's "restrict to project" picker — the single project users.taskAccess's
 * 'only-one'/'all-but-one' modes are relative to. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const projectId = typeof body?.projectId === 'string' ? body.projectId : '';

	if (!projectId) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await setRestrictedTaskProjectId(db, projectId);
	await publishState();

	return json({ ok: true });
};
