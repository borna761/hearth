// The entire Todoist REST API surface lives behind this file — same strict adapter
// boundary DESIGN.md §2.5 established for AnyList. Nothing outside src/lib/server/todoist
// talks to api.todoist.com directly, and no raw Todoist response shape escapes this
// module; every exported method takes and returns this file's own domain types.
//
// No npm dependency needed at all, unlike AnyList — Todoist's REST API is official,
// documented, and plain HTTP; Node's built-in `fetch` is enough (same choice
// src/lib/server/weather.ts already makes for Open-Meteo).
//
// docs/phase-6-todoist-plan.md §2's flagged unknowns, resolved against a real token
// (2026-08-26) before this was written: `due.date` is a plain 'YYYY-MM-DD' string (no
// `datetime` field seen on any task in the real account, though Todoist's docs mention one
// exists for time-specific due dates — handled defensively below, never assumed absent).
// `GET /tasks/filter?query=overdue | today` works and is what this uses, rather than
// fetching every task and filtering client-side — the account has 29 projects and the
// unfiltered /tasks endpoint alone returned 50 tasks on its first page, so letting Todoist
// do the filtering avoids paginating through everything just to throw most of it away.
// Overdue-vs-today is still classified independently below, against the household's own
// timezone, not trusted from Todoist's own bucketing — same reasoning `buildWeekSnapshot`
// never trusts a third party's notion of "today".
//
// A real data quirk worth knowing, not a bug: a neglected recurring task's `due.date` can
// be years in the past (Todoist only advances it once an occurrence is completed), so an
// "overdue" recurring task can look far more overdue than its actual recurrence interval
// suggests.

const API_BASE = 'https://api.todoist.com/api/v1';

export interface TodoistCredentials {
	token: string;
}

export interface TodoistTask {
	id: string;
	title: string;
	projectId: string;
	projectName: string;
	/** 'YYYY-MM-DD', household-timezone-independent — classification into overdue/today
	 *  happens in tasks.ts against getHouseholdTimeZone, not here. */
	dueDate: string;
}

export interface TodoistProject {
	id: string;
	name: string;
}

export interface TodoistClient {
	/** Every incomplete task Todoist itself considers overdue or due today. Does not
	 *  distinguish the two — tasks.ts does that classification against the household's own
	 *  timezone, per the module comment above. */
	fetchOverdueAndDueToday(): Promise<TodoistTask[]>;
	/** Marks a task complete — for a recurring task, this is documented to behave the same
	 *  as completing it from the app (advances to the next occurrence) rather than ending
	 *  the series, but that specific behavior has not yet been live-verified against a real
	 *  recurring task; re-check before trusting it silently if a recurring task's next
	 *  occurrence doesn't reappear after a completion in production. */
	completeTask(taskId: string): Promise<void>;
	/** Every project on the account, not just ones with a currently-overdue/due-today task
	 *  — the settings screen's "restricted project" picker (todoist/projects.ts) needs the
	 *  real, complete list (per the module comment above, this account alone has 29) to let
	 *  Alex pick a project that has nothing due right now. */
	listProjects(): Promise<TodoistProject[]>;
}

interface RawProject {
	id: string;
	name: string;
}

interface RawTask {
	id: string;
	content: string;
	project_id: string;
	due: { date: string; datetime?: string } | null;
}

interface RawPage<T> {
	results: T[];
	next_cursor: string | null;
}

function clientError(message: string): Error {
	return new Error(`Todoist: ${message}`);
}

async function todoistFetch(token: string, path: string): Promise<unknown> {
	const res = await fetch(`${API_BASE}${path}`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		throw clientError(`${path} failed with ${res.status}: ${await res.text()}`);
	}
	return res.json();
}

async function fetchAllPages<T>(token: string, path: string): Promise<T[]> {
	const out: T[] = [];
	let cursor: string | null = null;
	do {
		const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
		const page = (await todoistFetch(token, `${path}${query}`)) as RawPage<T>;
		out.push(...page.results);
		cursor = page.next_cursor;
	} while (cursor);
	return out;
}

export async function connectTodoist(credentials: TodoistCredentials): Promise<TodoistClient> {
	const { token } = credentials;

	// A cheap, read-only call that fails fast on a bad token — same role
	// connectAnyList's login() call plays, catching a bad credential at connect time
	// rather than on the first real fetch deep inside a reconcile cycle.
	await todoistFetch(token, '/projects?limit=1');

	return {
		async fetchOverdueAndDueToday() {
			const [projects, tasks] = await Promise.all([
				fetchAllPages<RawProject>(token, '/projects?'),
				fetchAllPages<RawTask>(
					token,
					`/tasks/filter?query=${encodeURIComponent('overdue | today')}&`
				)
			]);
			const projectNames = new Map(projects.map((p) => [p.id, p.name]));

			return tasks
				.filter((task) => task.due !== null)
				.map((task) => ({
					id: task.id,
					title: task.content,
					projectId: task.project_id,
					projectName: projectNames.get(task.project_id) ?? 'Unknown',
					dueDate: task.due!.date
				}));
		},

		async completeTask(taskId: string) {
			const res = await fetch(`${API_BASE}/tasks/${taskId}/close`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` }
			});
			if (!res.ok) {
				throw clientError(`complete ${taskId} failed with ${res.status}: ${await res.text()}`);
			}
		},

		async listProjects() {
			const projects = await fetchAllPages<RawProject>(token, '/projects?');
			return projects.map((p) => ({ id: p.id, name: p.name }));
		}
	};
}
