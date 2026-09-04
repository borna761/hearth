import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { upsertConnection } from '$lib/server/connections';
import { startTasks } from '$lib/server/sync/runtime';

/**
 * The settings screen's Todoist connect form — same shape as the AnyList one (M6): no
 * pre-save validation call, `upsertConnection` saves first, then `startTasks` attempts the
 * real connection and, on failure, marks the connection `status: 'error'` via
 * `initTasksRuntime`, surfaced through the existing Connections list like every other
 * provider. One token field instead of email+password.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const token = typeof body?.token === 'string' ? body.token.trim() : '';

	if (!token) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await upsertConnection(db, {
		provider: 'todoist',
		label: 'personal token',
		secrets: { token }
	});

	const connected = await startTasks();

	return json({ ok: true, connected });
};
