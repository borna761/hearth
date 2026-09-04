import { describe, it, expect, vi } from 'vitest';
import {
	googleApiRequest,
	GoogleApiError,
	fetchPrimaryCalendarId,
	listGoogleCalendars
} from './api';

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
	return vi.fn(
		async (_url: string, _init?: RequestInit) =>
			({
				ok: init.ok ?? true,
				status: init.status ?? 200,
				json: async () => body,
				text: async () => JSON.stringify(body)
			}) as Response
	);
}

describe('googleApiRequest', () => {
	it('sends the bearer token', async () => {
		const fetchFn = stubFetch({ ok: true });
		await googleApiRequest('/users/me/calendarList', 'access-1', {
			fetchFn: fetchFn as unknown as typeof fetch
		});

		const init = fetchFn.mock.calls[0]?.[1];
		expect((init?.headers as Record<string, string>).authorization).toBe('Bearer access-1');
	});

	it('appends search params and omits undefined ones', async () => {
		// Undefined must vanish rather than serialize as "undefined" — syncToken and
		// timeMin are mutually exclusive (they 400 together), so callers pass one as
		// undefined and rely on it disappearing.
		const fetchFn = stubFetch({});
		await googleApiRequest('/calendars/x/events', 'access-1', {
			fetchFn: fetchFn as unknown as typeof fetch,
			searchParams: { singleEvents: 'true', syncToken: undefined, maxResults: '250' }
		});

		const url = new URL(fetchFn.mock.calls[0]![0]);
		expect(url.searchParams.get('singleEvents')).toBe('true');
		expect(url.searchParams.get('maxResults')).toBe('250');
		expect(url.searchParams.has('syncToken')).toBe(false);
	});

	it('returns the parsed body', async () => {
		const fetchFn = stubFetch({ items: [{ id: 'a' }] });
		const result = await googleApiRequest<{ items: { id: string }[] }>('/x', 'token', {
			fetchFn: fetchFn as unknown as typeof fetch
		});
		expect(result.items).toEqual([{ id: 'a' }]);
	});

	it('throws a GoogleApiError carrying the status code', async () => {
		const fetchFn = stubFetch({ error: { message: 'Not Found' } }, { ok: false, status: 404 });
		await expect(
			googleApiRequest('/x', 'token', { fetchFn: fetchFn as unknown as typeof fetch })
		).rejects.toThrow(GoogleApiError);
	});

	it('exposes 410 GONE distinctly, since it means the sync token must be discarded', async () => {
		// DESIGN.md §3.1 syncs by token; Google answers 410 when a token is too old, and the
		// only correct response is a full re-sync. The caller needs to tell that apart from
		// a generic failure.
		const fetchFn = stubFetch(
			{ error: { message: 'Sync token is no longer valid' } },
			{
				ok: false,
				status: 410
			}
		);

		let caught: GoogleApiError | undefined;
		try {
			await googleApiRequest('/x', 'token', { fetchFn: fetchFn as unknown as typeof fetch });
		} catch (e) {
			caught = e as GoogleApiError;
		}

		expect(caught).toBeInstanceOf(GoogleApiError);
		expect(caught?.status).toBe(410);
		expect(caught?.isSyncTokenExpired).toBe(true);
	});

	it('does not treat other errors as sync-token expiry', async () => {
		const fetchFn = stubFetch({ error: { message: 'backend error' } }, { ok: false, status: 503 });
		let caught: GoogleApiError | undefined;
		try {
			await googleApiRequest('/x', 'token', { fetchFn: fetchFn as unknown as typeof fetch });
		} catch (e) {
			caught = e as GoogleApiError;
		}
		expect(caught?.isSyncTokenExpired).toBe(false);
	});
});

describe('fetchPrimaryCalendarId', () => {
	it('returns the primary calendar id, which is the account email', async () => {
		// Used to label the connection. calendar.readonly cannot call userinfo, but the
		// primary calendar's id is the account address, which is the same thing.
		const fetchFn = stubFetch({ id: 'alex@example.com', summary: 'Alex' });
		const email = await fetchPrimaryCalendarId('access-1', {
			fetchFn: fetchFn as unknown as typeof fetch
		});
		expect(email).toBe('alex@example.com');
	});
});

describe('listGoogleCalendars', () => {
	it('returns the calendarList items', async () => {
		const fetchFn = stubFetch({
			items: [{ id: 'a@group.calendar.google.com', summary: 'Family', backgroundColor: '#fbe983' }]
		});
		const calendars = await listGoogleCalendars('access-1', {
			fetchFn: fetchFn as unknown as typeof fetch
		});
		expect(calendars).toEqual([
			{ id: 'a@group.calendar.google.com', summary: 'Family', backgroundColor: '#fbe983' }
		]);
	});

	it('follows pagination and returns every page', async () => {
		const calls = [
			{ items: [{ id: '1', summary: 'One' }], nextPageToken: 'p2' },
			{ items: [{ id: '2', summary: 'Two' }] }
		];
		let i = 0;
		const fetchFn = vi.fn(
			async () => ({ ok: true, status: 200, json: async () => calls[i++] }) as Response
		) as unknown as typeof fetch;

		const calendars = await listGoogleCalendars('access-1', { fetchFn });
		expect(calendars.map((c) => c.id)).toEqual(['1', '2']);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
});
