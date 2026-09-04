import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { setUserTaskAccess, type TaskAccess } from '$lib/server/users';
import { publishState } from '$lib/server/state/publisher';

const TASK_ACCESS_VALUES: readonly TaskAccess[] = ['all-but-one', 'only-one', 'none'];

/** Settings screen's per-user task access change — same "he configures the whole
 * household" pattern as user-color/pin. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const userId = Number(body?.userId);
	const taskAccess = body?.taskAccess as TaskAccess;

	if (!Number.isInteger(userId) || !TASK_ACCESS_VALUES.includes(taskAccess)) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await setUserTaskAccess(db, userId, taskAccess);

	// Same "always safe" reasoning as the visibility matrix's own route: if the edited
	// user isn't the tablet's current active session, the rebuilt snapshot is identical
	// and the broadcaster's dedup skips sending it.
	await publishState();

	return json({ ok: true });
};
