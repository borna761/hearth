import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { upsertConnection } from '$lib/server/connections';
import { startGroceries } from '$lib/server/sync/runtime';

/**
 * DESIGN.md §7.5 / docs/phase-5-plan.md M6 — the settings screen's AnyList connect form.
 * No pre-save validation login: `upsertConnection` saves first, then `startGroceries`
 * attempts the real login and, on failure, marks the connection `status: 'error'` with
 * `lastError` via `initGroceriesRuntime` — the same status/lastError the existing
 * Connections list already renders for every other provider. A separate validation-only
 * login here would mean two logins for the success case and a second error-reporting path
 * to keep in sync with that one.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const email = typeof body?.email === 'string' ? body.email.trim() : '';
	const password = typeof body?.password === 'string' ? body.password : '';

	if (!email || !password) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await upsertConnection(db, {
		provider: 'anylist',
		label: email,
		secrets: { email, password }
	});

	// Wires up the live connection immediately, rather than leaving groceries dark until
	// the next full process restart — sync/runtime.ts's own boot-time attempt only ever
	// fires once, and DESIGN.md §1 promises "updates never require touching the tablet."
	const connected = await startGroceries();

	return json({ ok: true, connected });
};
