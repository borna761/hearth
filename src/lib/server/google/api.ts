// Thin Google Calendar API client. Deliberately not the googleapis SDK: that package is
// tens of megabytes of generated code for every Google service, and this runs on a board
// with ~277MB for the whole app (DESIGN.md §2.1). Two endpoints do not justify it.

const API_BASE = 'https://www.googleapis.com/calendar/v3';

export class GoogleApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(`Google Calendar API ${status}: ${message}`);
		this.name = 'GoogleApiError';
		this.status = status;
	}

	/**
	 * 410 GONE means the stored syncToken is too old to be useful. The only correct
	 * recovery is to drop it and run a full sync (DESIGN.md §3.1), so callers branch on
	 * this rather than treating it as a transient failure worth retrying.
	 */
	get isSyncTokenExpired(): boolean {
		return this.status === 410;
	}
}

export interface GoogleApiOptions {
	fetchFn?: typeof fetch;
	searchParams?: Record<string, string | undefined>;
}

export async function googleApiRequest<T>(
	path: string,
	accessToken: string,
	options: GoogleApiOptions = {}
): Promise<T> {
	const { fetchFn = fetch, searchParams = {} } = options;
	const url = new URL(API_BASE + path);
	for (const [key, value] of Object.entries(searchParams)) {
		// Undefined entries are dropped rather than stringified: syncToken and
		// timeMin/timeMax are mutually exclusive and sending "undefined" would 400.
		if (value !== undefined) url.searchParams.set(key, value);
	}

	const response = await fetchFn(url.toString(), {
		headers: { authorization: `Bearer ${accessToken}` }
	});

	if (!response.ok) {
		let message = `HTTP ${response.status}`;
		try {
			const body = (await response.json()) as { error?: { message?: string } | string };
			if (typeof body.error === 'string') message = body.error;
			else if (body.error?.message) message = body.error.message;
		} catch {
			// Non-JSON error body; the status alone is the useful part.
		}
		throw new GoogleApiError(response.status, message);
	}

	return (await response.json()) as T;
}

/**
 * The authorized account's address, used to label the connection. The `calendar.readonly`
 * scope cannot reach the userinfo endpoint, but the primary calendar's id *is* the
 * account address, so this gets the same answer without widening scope.
 */
export async function fetchPrimaryCalendarId(
	accessToken: string,
	options: { fetchFn?: typeof fetch } = {}
): Promise<string> {
	const calendar = await googleApiRequest<{ id: string }>('/calendars/primary', accessToken, {
		fetchFn: options.fetchFn
	});
	return calendar.id;
}

export interface GoogleCalendarListEntry {
	id: string;
	summary: string;
	backgroundColor?: string;
}

/** Every calendar the account can see — DESIGN.md §4. Paginates to completion. */
export async function listGoogleCalendars(
	accessToken: string,
	options: { fetchFn?: typeof fetch } = {}
): Promise<GoogleCalendarListEntry[]> {
	const calendars: GoogleCalendarListEntry[] = [];
	let pageToken: string | undefined;

	do {
		const page = await googleApiRequest<{
			items: GoogleCalendarListEntry[];
			nextPageToken?: string;
		}>('/users/me/calendarList', accessToken, {
			fetchFn: options.fetchFn,
			searchParams: { pageToken }
		});
		calendars.push(...page.items);
		pageToken = page.nextPageToken;
	} while (pageToken);

	return calendars;
}
