import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getConnection } from '$lib/server/connections';

export const load: PageServerLoad = async () => {
	const connection = await getConnection(db, 'google');
	return {
		account: connection?.label ?? null,
		status: connection?.status ?? null
	};
};
