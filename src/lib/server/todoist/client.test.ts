import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectTodoist } from './client';

// Mocks the global fetch rather than a fake library class (unlike anylist/client.test.ts's
// FakeAnyList) — there's no npm library in the middle here, this adapter calls fetch
// directly, so faking fetch itself is the actual seam.

function jsonResponse(body: unknown, ok = true, status = 200) {
	return {
		ok,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body)
	} as Response;
}

const originalFetch = global.fetch;

beforeEach(() => {
	global.fetch = vi.fn();
});

afterEach(() => {
	global.fetch = originalFetch;
});

function mockRoutes(routes: Record<string, unknown>) {
	(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
		for (const [prefix, body] of Object.entries(routes)) {
			if (url.startsWith(prefix)) return jsonResponse(body);
		}
		throw new Error(`unmocked URL: ${url}`);
	});
}

describe('connectTodoist', () => {
	it('succeeds when the validation call succeeds', async () => {
		mockRoutes({ 'https://api.todoist.com/api/v1/projects': { results: [], next_cursor: null } });
		await expect(connectTodoist({ token: 't' })).resolves.toBeDefined();
	});

	it('throws when the token is invalid', async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
			jsonResponse({ error: 'unauthorized' }, false, 401)
		);
		await expect(connectTodoist({ token: 'bad' })).rejects.toThrow(/401/);
	});
});

describe('fetchOverdueAndDueToday', () => {
	it('maps tasks and resolves each project name', async () => {
		mockRoutes({
			'https://api.todoist.com/api/v1/projects': {
				results: [
					{ id: 'p1', name: 'Personal' },
					{ id: 'p2', name: 'Work' }
				],
				next_cursor: null
			},
			'https://api.todoist.com/api/v1/tasks/filter': {
				results: [
					{
						id: 't1',
						content: 'Send book club reminder',
						project_id: 'p1',
						due: { date: '2026-08-25' }
					},
					{
						id: 't2',
						content: 'Ship the report',
						project_id: 'p2',
						due: { date: '2026-08-26' }
					}
				],
				next_cursor: null
			}
		});

		const client = await connectTodoist({ token: 't' });
		const tasks = await client.fetchOverdueAndDueToday();

		expect(tasks).toEqual([
			{
				id: 't1',
				title: 'Send book club reminder',
				projectId: 'p1',
				projectName: 'Personal',
				dueDate: '2026-08-25'
			},
			{
				id: 't2',
				title: 'Ship the report',
				projectId: 'p2',
				projectName: 'Work',
				dueDate: '2026-08-26'
			}
		]);
	});

	it("falls back to 'Unknown' for a task whose project id isn't in the projects response", async () => {
		mockRoutes({
			'https://api.todoist.com/api/v1/projects': { results: [], next_cursor: null },
			'https://api.todoist.com/api/v1/tasks/filter': {
				results: [
					{ id: 't1', content: 'Orphaned task', project_id: 'gone', due: { date: '2026-08-25' } }
				],
				next_cursor: null
			}
		});

		const client = await connectTodoist({ token: 't' });
		const tasks = await client.fetchOverdueAndDueToday();

		expect(tasks[0].projectName).toBe('Unknown');
	});

	it('filters out a task with no due date, even though the overdue|today filter should never return one', async () => {
		mockRoutes({
			'https://api.todoist.com/api/v1/projects': { results: [], next_cursor: null },
			'https://api.todoist.com/api/v1/tasks/filter': {
				results: [
					{ id: 't1', content: 'No due date', project_id: 'p1', due: null },
					{ id: 't2', content: 'Has due date', project_id: 'p1', due: { date: '2026-08-25' } }
				],
				next_cursor: null
			}
		});

		const client = await connectTodoist({ token: 't' });
		const tasks = await client.fetchOverdueAndDueToday();

		expect(tasks.map((t) => t.id)).toEqual(['t2']);
	});

	it('follows next_cursor to fetch every page of tasks', async () => {
		let call = 0;
		(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
			if (url.startsWith('https://api.todoist.com/api/v1/projects')) {
				return jsonResponse({ results: [], next_cursor: null });
			}
			call += 1;
			if (call === 1) {
				expect(url).not.toContain('cursor=');
				return jsonResponse({
					results: [
						{ id: 't1', content: 'Page one', project_id: 'p1', due: { date: '2026-08-25' } }
					],
					next_cursor: 'abc'
				});
			}
			expect(url).toContain('cursor=abc');
			return jsonResponse({
				results: [{ id: 't2', content: 'Page two', project_id: 'p1', due: { date: '2026-08-26' } }],
				next_cursor: null
			});
		});

		const client = await connectTodoist({ token: 't' });
		const tasks = await client.fetchOverdueAndDueToday();

		expect(tasks.map((t) => t.id)).toEqual(['t1', 't2']);
	});
});

describe('completeTask', () => {
	it('posts to the close endpoint', async () => {
		mockRoutes({ 'https://api.todoist.com/api/v1/projects': { results: [], next_cursor: null } });
		const client = await connectTodoist({ token: 't' });

		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({}));
		await client.completeTask('t1');

		expect(global.fetch).toHaveBeenCalledWith(
			'https://api.todoist.com/api/v1/tasks/t1/close',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('throws when the close call fails', async () => {
		mockRoutes({ 'https://api.todoist.com/api/v1/projects': { results: [], next_cursor: null } });
		const client = await connectTodoist({ token: 't' });

		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			jsonResponse({ error: 'not found' }, false, 404)
		);
		await expect(client.completeTask('gone')).rejects.toThrow(/404/);
	});
});

describe('listProjects', () => {
	it('returns every project on the account, not just ones with a due task', async () => {
		mockRoutes({ 'https://api.todoist.com/api/v1/projects': { results: [], next_cursor: null } });
		const client = await connectTodoist({ token: 't' });

		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			jsonResponse({
				results: [
					{ id: 'p1', name: 'Personal' },
					{ id: 'p2', name: 'Finances' }
				],
				next_cursor: null
			})
		);
		const projects = await client.listProjects();

		expect(projects).toEqual([
			{ id: 'p1', name: 'Personal' },
			{ id: 'p2', name: 'Finances' }
		]);
	});

	it('follows next_cursor to fetch every page of projects', async () => {
		mockRoutes({ 'https://api.todoist.com/api/v1/projects': { results: [], next_cursor: null } });
		const client = await connectTodoist({ token: 't' });

		(global.fetch as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce(
				jsonResponse({ results: [{ id: 'p1', name: 'Personal' }], next_cursor: 'cur1' })
			)
			.mockResolvedValueOnce(
				jsonResponse({ results: [{ id: 'p2', name: 'Finances' }], next_cursor: null })
			);
		const projects = await client.listProjects();

		expect(projects.map((p) => p.id)).toEqual(['p1', 'p2']);
	});
});
