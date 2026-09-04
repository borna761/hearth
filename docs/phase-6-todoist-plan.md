# Phase 6 (remainder) — Todoist tasks: implementation plan

Scope confirmed with Alex 2026-08-26: read overdue + due-today tasks, tap to complete
(no add, no uncheck, no remove), one personal Todoist account/token for the household, and
a hardcoded per-user split rather than a general visibility setting — Alex sees every
project except "👧 Sam"; Sam sees only that project. No visual-regression tooling, no
offline work beyond what phase 6's earlier PRs already shipped.

## 1. The schema already expects this — no migration needed

**Correction from M2, once this was actually implemented:** this claim was wrong on the
one column that mattered. `dueAt` (`timestamp_ms`) would have stored an all-day Todoist due
date (`due.date`, a bare `YYYY-MM-DD` with no time component) as midnight-UTC — exactly the
class of bug `datetime.ts`'s own header comment already warns about and that this codebase
already fixed once for all-day calendar events. Caught before shipping; `dueAt` became
`dueDate: text('due_date')` instead (two real migrations,
`drizzle/0005_amazing_iron_lad.sql` and `drizzle/0006_good_whizzer.sql`). Separately, a
first draft filtered the Alex/Sam split on `listItems.category` (the resolved project
*name*, per §1's plan below) — fragile, since a Todoist project rename would silently
change who sees what. Added `listItems.projectId` (the stable id) instead and filter on
that; `category` is display-only now. See §4's own correction for the filtering code that
actually shipped.

`src/lib/server/db/schema.ts` was written with this in mind well before phase 5 existed:

- `sources.kind` is `enum(['calendar', 'tasks', 'groceries'])` — `'tasks'` has been sitting
  there unused.
- `listItems`' own comment: *"Groceries (and, later, Todoist tasks) — one row per checkable
  item."* It already carries `dueAt` (`timestamp_ms`), which groceries has never written to.
- `pendingWrites.action` is `enum(['add', 'check', 'uncheck', 'remove'])` — `'check'` is
  exactly "mark complete."

So this reuses `listItems` and `pendingWrites` directly, the same way groceries does, with
one new `sources` row (`kind: 'tasks'`, one row for the whole Todoist connection — not one
per project, since the Alex/Sam split is hardcoded application logic, not a
`visibility`-table concern per Alex's explicit call). `listItems.category` gets reused to
hold the Todoist **project name** — a stretch on the column's original "AnyList category"
meaning, but both are "a grouping label for this item," and reusing it avoids a migration
for what would otherwise be an identical column.

**Genuinely new:** a `connections` row for `provider: 'todoist'` (the enum already lists
it), and the settings screen's connect form for it (mirrors the AnyList one — a single
token field here instead of email+password).

**Reversal, post-M2:** the hardcoded Alex/Sam split above was deliberately rejected in
favor of a general setting once — Alex asked for it back. The replacement isn't a
per-project visibility matrix (mirroring the calendar `visibility` table) either; that was
the first draft and Alex asked for something simpler and identity-free instead: a new
`users.taskAccess` enum column (`'all-but-one' | 'only-one' | 'none'`, default
`'all-but-one'`) plus a single admin-picked "restricted project"
(`settings.restrictedTaskProjectId`, via the existing key/value `settings` table). No join
table, no per-project row per user — each person is just one of three states relative to
the one designated project. The default reproduces every existing user's prior (hardcoded)
behavior automatically, so this shipped with **no migration/backfill** — the one manual
step after deploy is switching the household's simple-view user to `'only-one'` in the new
Settings → "Task access" section. `SAM_PROJECT_ID` and every other explicit reference to
that specific project/person are gone from the code — see §4's own correction.

## 2. Adapter boundary: `src/lib/server/todoist/client.ts`

Same isolation rule M1 established for AnyList — this is the only file that talks to
Todoist's REST API directly; everything else sees a small domain type.

```ts
interface TodoistTask {
  id: string;
  title: string;       // Todoist's `content`
  projectName: string; // resolved from the separate /projects endpoint, not on the task itself
  dueAt: Date | null;   // null tasks are never fetched at all — see §4
}
```

**Two things to verify live, against a real token, before trusting them** — repeated
web-doc lookups tonight gave inconsistent answers for both Fully Kiosk and (just now)
Todoist's exact schema, so this plan does not build on unverified scraped docs:

- The exact shape of a task's `due` object (`date` vs `datetime`, timezone handling,
  whether an all-day due date needs different parsing than a timed one).
- Whether `GET /tasks` accepts a server-side `filter=overdue | today` query that's actually
  reliable against *our* household's timezone, or whether we're better off fetching every
  incomplete task with *any* due date and classifying overdue-vs-today ourselves — almost
  certainly the latter, matching how `buildWeekSnapshot` never trusts a third party's
  notion of "today" and computes it against `getHouseholdTimeZone` instead. Plan assumes
  this; confirmed once M1's smoke script runs.

`GET /projects` (id → name) gets called once per reconcile alongside `/tasks`, the same
shape as `categoryNameFor` resolving AnyList category names from a side-channel — except
simpler, since Todoist's project id is already the natural join key, no `identifier` vs
`categoryMatchId` trap to fall into twice in one night.

## 3. Reconcile: a new `tasks.ts`, not a generalized `groceries.ts`

Considered generalizing `groceries.ts`/`groceriesQueue.ts` into shared `listItems.ts`/
`listItemsQueue.ts` modules, since both domains now target the same two tables. Decided
against it: groceries' real complexity (four write actions, id-remapping on the
reuse-checked-item rule, `collapseCheckTogglePairs`) has no equivalent here — tasks are a
single idempotent action (`check`), no remap, no "add" at all. Forcing both domains through
one generalized module would mean threading groceries' irrelevant complexity through
tasks' code path for marginal reuse. A parallel `tasks.ts` (reconcile) and a much smaller
`tasksQueue.ts` (single-action drain) read clearly on their own, at the cost of a small
amount of structural duplication with their grocery counterparts — same tradeoff
`screensaverPublisher.ts` vs `publisher.ts` already makes in this codebase.

`reconcileTaskList`: fetch every incomplete task with a due date (no due date → skip
entirely, per Alex's "anything without a due date should be ignored" — never even reaches
`listItems`), upsert into `listItems` (`title`, `category` ← project name, `dueAt`,
`checked: false` always, since a fetched task is by definition still incomplete — Todoist's
`GET /tasks` only returns active tasks to begin with), prune anything no longer fetched
(completed, or its due date was removed) **unless** a pending `check` write targets it —
identical shape to `reconcileGroceryList`'s own prune-with-pending-exception rule.

## 4. Snapshot: overdue/due-today split, hardcoded per user

New `buildTasksSnapshot(db, userId)` (parameterized by user, unlike
`buildGroceriesSnapshot` which has no per-user concept at all — groceries are shared,
tasks are filtered per §1's hardcoded split):

```ts
const SAM_PROJECT_ID = 'REPLACE_ME'; // resolved from the given project URL once a
// token exists — the slug (sam-6CrcrPvHMJcH93mM) is not confirmed to be parseable into
// Todoist's real project id without checking a live /projects response first.

function visibleTasksFor(userId: number, tasks: TaskRow[]): TaskRow[] {
  const isSam = /* Sam's user id */;
  return isSam
    ? tasks.filter((t) => t.projectId === SAM_PROJECT_ID)
    : tasks.filter((t) => t.projectId !== SAM_PROJECT_ID);
}
```

Then split by `dueAt` against `getHouseholdTimeZone` + "now," same as every other
today-relative decision in this codebase: `dueAt < startOfToday` → overdue, `startOfToday
<= dueAt < startOfTomorrow` → due today, anything later is already excluded (never
fetched, §3).

`TasksSnapshot` shape: `{ overdue: TaskItem[], dueToday: TaskItem[], count: number,
stale: boolean }` — `count` is `overdue.length + dueToday.length` (matches "show tasks
overdue + due today" on the TopStrip badge), `stale` mirrors groceries' connection-status
signal.

**Shipped, with two changes from the sketch above.** `buildTasksSnapshot(db, isSimpleView,
now)` takes the view-mode boolean already used to discriminate Alex/Sam everywhere else
in this codebase (`SimpleView.svelte`'s own `large` prop, `GroceryPanel`'s sizing), not a
raw `userId` — consistent with there being no general per-user visibility concept here, just
"is this the simple-view tablet session or not." And the filter is `row.projectId ===
SAM_PROJECT_ID` / `!==`, not `category` — see §1's correction. `now` is an injectable
third parameter (defaulting to `new Date()`) rather than read internally, matching
`runGroceriesCycle`/`publishState`'s own convention — needed once tests wanted a fixed
`NOW` rather than the real clock.

**Superseded again, post-M2 (see §1's reversal note).** `isSimpleView`/`SAM_PROJECT_ID`
are gone entirely. `buildTasksSnapshot(db, userId, now)` takes a real `userId`, looks up
that user's `taskAccess` (`'all-but-one' | 'only-one' | 'none'`, `users.taskAccess`) and the
household's single `restrictedTaskProjectId` (`settings` table), and filters:

```ts
if (taskAccess === 'none') return null;
// ...
const visible = rows.filter((row) => {
	if (!restrictedProjectId) return taskAccess === 'all-but-one'; // not configured yet
	return taskAccess === 'only-one'
		? row.projectId === restrictedProjectId
		: row.projectId !== restrictedProjectId;
});
```

**Corrected again:** the first cut of `'none'` returned a real, empty `TasksSnapshot`
rather than `null`, reasoning that `null` should stay reserved for "Todoist never
connected." Alex asked for the badge/button to disappear entirely for `'none'`, not show
"✅ 0" — and nothing downstream ever needed to tell "not connected" and "opted out" apart,
so the distinction was unneeded complexity. `'none'` now returns `null` too, short-circuited
before the source/rows queries even run. The Settings screen's "restricted project" dropdown is
backed by `todoist/projects.ts`'s `listTodoistProjectOptions(db)`, a live call through a
freshly-constructed `TodoistClient` (new `listProjects()` method) — an earlier version
derived the list from `list_items` instead (cheaper, no network call) but that only ever
holds projects with a currently-overdue/due-today task, undercounting a real account
significantly (client.ts's own header comment: 29 projects on the account this shipped
against). Alex caught this live once the dropdown only showed 8.

## 5. Write path: complete-only, reusing the queue shape

`enqueueComplete(db, sourceId, taskId)`: one `pending_writes` row, `action: 'check'`,
optimistic `listItems.checked = true` in the same transaction — identical to groceries'
own enqueue. `tasksQueue.ts`'s drain is the single-action subset of
`drainPendingWrites`: call `client.completeTask(taskId)`, and on a "task already
gone/completed" error, treat it as success rather than a hard failure — completing an
already-completed task is a no-op state, not a real conflict, the same reasoning
`removeItem`'s idempotent-missing-item handling already uses for groceries.

No `collapseCheckTogglePairs` equivalent needed — there is no "uncheck," so two `check`
writes for the same task in one drain pass are already idempotent as-is.

**Shipped, with the "already gone/completed" question resolved live rather than guessed
at.** Function is `enqueueCompleteTask(db, sourceId, taskId, now)`, otherwise as planned.
Live-tested against the real account (2026-08-26): called `completeTask` on a real task,
then called it again on the same now-completed task id. **Todoist's `POST
/tasks/{id}/close` is idempotent** — the second call succeeded with no error, connection
stayed `ok`. So unlike `removeItem`'s AnyList precedent, `todoist/client.ts`'s
`completeTask` needed no special-casing at all; the plain "any non-2xx throws"
implementation already does the right thing, because Todoist's own API absorbs the
idempotency rather than requiring the adapter to fake it.

Also shipped: `buildTasksSnapshot` filters `checked = false` — a divergence from
`buildGroceriesSnapshot` (which keeps checked items visible for review/uncheck) that tasks
needs since there's no uncheck and a completed task should vanish from the panel
immediately, not linger until the next reconcile prunes it.

## 6. UI

- **`TasksPanel.svelte`** — new component, not a generalized `GroceryPanel`. Same sidebar
  shell (backdrop, tap-outside-to-close, `large` prop for the simple view) but the content
  differs enough (two fixed sections — Overdue, Due Today — no add form, no category
  grouping, no autocomplete) that forcing a shared component would mean threading a lot of
  "is this groceries or tasks" branching through one file. Each task row: title, project
  name, and — overdue section only — the due date. Tap anywhere on the row completes it
  (optimistic, matching groceries' tap-to-check).
  **Shipped, one change from the sketch above:** kept the leading empty-checkbox glyph
  `GroceryPanel` uses after all, rather than omitting it — a bare row with no tap affordance
  at all reads as plain text, not a button, on first glance; the checkbox is what signals
  "tappable" even though (unlike groceries) it never shows a checked state, since a
  completed task just leaves the list on the next snapshot instead.
- **`TopStrip.svelte`** (standard view, Alex) — a second badge next to the groceries one,
  `✅ {count}`, opening `TasksPanel`. Same `{#if tasks}` dead-button guard groceries uses
  for "AnyList not connected yet."
- **`SimpleView.svelte`** (Sam) — the existing full-width `🛒 Groceries · N` button
  splits into two half-width buttons: groceries stays left, a new `✅ Tasks · N` sits right,
  per Alex's spec. Same `large` sizing `TasksPanel` shares with `GroceryPanel`.
- **Settings screen** — a Todoist connect form (one token field), mirroring the AnyList
  form added in M6, and the same free "shows up in the existing Connections list" win that
  form got for status/last-synced — no new code needed there, `listConnections` is already
  provider-agnostic.

## 7. Runtime wiring

Mirrors `groceriesRuntime.ts`/`sync/runtime.ts`'s exported, idempotent `startGroceries`
pattern exactly (M6 built that specifically so a settings-screen connect works live,
without a restart — this reuses it, not reinvents it): `startTasks()`, guarded the same
way, called both at boot and from the new connect route. Poll interval: proposing 15
minutes, matching groceries' own freshness guarantee — tasks are lower-urgency than
groceries (no one's standing at a tablet waiting to see a task they just completed
elsewhere reflected instantly, unlike unpacking groceries against a live list), so no
push-channel equivalent is needed at all; Todoist's REST API has no comparable websocket
push to wire up regardless.

## 8. Milestones

1. **Adapter + Pi smoke test** (`todoist/client.ts`, `scripts/todoist-smoke.mjs`,
   `scripts/connect-todoist.mjs`) — resolves §2's open schema questions against a real
   token before anything else is built on top of them, matching the M1 gate CLAUDE.md
   requires for every new dependency.
2. **Read path + settings connect form** — `tasks.ts` reconcile, `buildTasksSnapshot`,
   `TasksPanel.svelte` (read-only for now), TopStrip badge, SimpleView split button,
   settings form. Verified live against the real account before the write path is added,
   same "prove the read side before the write side" order M2→M3 followed in phase 5.
3. **Write path** — `tasksQueue.ts`, tap-to-complete wired into `TasksPanel`.
4. **Deploy + verification** — same live-tablet checklist M6 used for groceries: complete
   a task from the tablet, confirm it clears; kill the network mid-tap, confirm it drains
   once reconnected.

Smaller than phase 5's six milestones throughout — most of the hard architectural
decisions (queue mechanics, the sidebar pattern, the settings-connect-form pattern, the
`startX()`-is-idempotent-and-exported pattern) are already proven working code being
reused, not invented fresh.

**All four milestones shipped 2026-08-26 (PRs #68-74).** M4 deployed to the Pi and
confirmed working against the real tablet — tap-to-complete clears a task live. Phase 6 is
complete; see the reversal note under §1 for the one significant scope change along the way
(the hardcoded Alex/Sam split became a general per-user `taskAccess` setting, not part
of the original milestone breakdown above).
