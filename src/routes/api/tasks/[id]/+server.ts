import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { enqueueCompleteTask } from '$lib/server/tasksQueue';
import { tasksSourceId, tasksReadiness, runTasksCycleNow } from '$lib/server/tasksRuntime';
import { publishState } from '$lib/server/state/publisher';

/** Marks a task complete — the only write tasks support (docs/phase-6-todoist-plan.md §5:
 *  complete-only, no add/uncheck/remove), so unlike POST /api/groceries/[id] there's no
 *  `action` in the body. Same gate/eager-drain shape as that route otherwise. */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session) {
		return json({ ok: false }, { status: 401 });
	}

	const sourceId = tasksSourceId();
	if (!sourceId) {
		const readiness = await tasksReadiness(db);
		return json(
			{ ok: false, reason: readiness === 'initializing' ? 'initializing' : 'not-connected' },
			{ status: 503 }
		);
	}

	const found = enqueueCompleteTask(db, sourceId, params.id, new Date());
	if (!found) {
		return json({ ok: false, reason: 'not-found' }, { status: 404 });
	}

	await publishState();
	// See POST /api/groceries/[id] for why this publishes again once the drain finishes,
	// rather than leaving the pending mark to clear on the next unrelated tick.
	void runTasksCycleNow()
		.then(() => publishState())
		.catch((err) => console.warn('[tasks] post-write publish failed:', err));

	return json({ ok: true });
};
