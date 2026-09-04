import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { setUserColor } from '$lib/server/users';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** DESIGN.md §7.5's "the admin configures the whole household" pattern, same shape as
 * the PIN reset — Alex can change any user's color, not just their own. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.isAdmin) {
		return json({ ok: false }, { status: 403 });
	}

	const body = await request.json().catch(() => null);
	const userId = Number(body?.userId);
	const color = typeof body?.color === 'string' ? body.color : '';

	if (!Number.isInteger(userId) || !HEX_COLOR.test(color)) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	await setUserColor(db, userId, color);
	return json({ ok: true });
};
