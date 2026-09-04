import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getHealthStatus } from '$lib/server/health';
import { stateBus } from '$lib/server/state/publisher';

export function GET() {
	const status = getHealthStatus(db, { streamClients: stateBus.clientCount });
	return json(status, { status: status.status === 'ok' ? 200 : 503 });
}
