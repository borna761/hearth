# Phase 8 — Tend as a second task provider: plan

Scope agreed 2026-10-10: Hearth gets [Tend](https://tendapp.ca) as a task provider **alongside**
Todoist, not instead of it. Settings has a provider choice and exactly one provider is active at a
time. Tend behaves the way the Todoist integration does (docs/phase-6-todoist-plan.md): one
account and one token for the household, overdue plus due today, tap to complete (no add, uncheck
or remove), the existing `taskAccess` / restricted-project split, a 5-minute poll. Rollout order is
deliberately left for later (§7).

This spans two repos. Tend has no API today (it is Firestore-only, with every rule in Dart on the
devices), so most of the work is on Tend's side: an API key, a small HTTPS function, and a
TypeScript port of task completion. Hearth's side is a second adapter behind the boundary
`todoist/client.ts` already draws, plus the provider switch.

## 1. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Whose tasks | One Tend account for the household, like the one Todoist token. |
| 2 | Auth | A per-account API key, created in Tend under Settings → Account, pasted into Hearth like the Todoist token. |
| 3 | The Alex/Sam split | Unchanged: `users.taskAccess` plus `settings.restrictedTaskProjectId`, now holding a Tend project id when Tend is active. |
| 4 | Which tasks | Overdue plus today. |
| 5 | Writes | Complete only. A recurring task advances to its next occurrence, exactly as completing it in Tend does. |
| 6 | Freshness | 5-minute poll, a full overdue-and-today snapshot each time (§3.4). |
| 7 | Switching provider | Clear and resync. Nothing carries over. |
| 8 | Both providers | Yes; the user picks one in Settings. |
| 9 | Rollout | Later. |
| 10 | Overdue | Overdue means the **due** date has passed, as in Tend. See §2.1. |
| 11 | Who can use the API | Premium accounts only. See §2.2. |
| 12 | Keys per account | One. "Create key" when there is none, "Replace key" (revokes the old one) and "Revoke" otherwise. |
| 13 | Timed tasks | Shown as plain "today"; not marked overdue once the time passes. See §2.3. |

## 2. Notes on the decisions

### 2.1 Overdue

Tend places a task on a day by its *do date* if it has one, else its due date (`dayOfTask`, Tend
DESIGN.md §3), and only calls it overdue once the *due* date has passed. Todoist has no do date,
so Hearth has only ever compared one date. The API returns both `day` (where Tend places it) and
`due`. Hearth puts a task under Overdue when `due < today` and under Today otherwise, so a task
Tend shows on Today with a do date of yesterday doesn't appear on the board as overdue. This needs
a second date on `list_items` (§4.3).

### 2.2 Premium only

The function costs reads and invocations for every account that uses it, and the server would
otherwise have to enforce the free-account limits itself (§3.5). Without Premium, a key can't be
created (the row in Settings → Account shows the locked prompt, Tend DESIGN.md §15.7), and an
existing key gets 403 from the endpoint. The key is kept, so it works again on upgrade, as every
other Premium feature behaves (Tend DESIGN.md §15.10). Hearth shows a 403 as its usual stale
state, with the error saying why.

### 2.3 Timed tasks

Tend tasks can have a due time; Todoist's in this household never did. Hearth has no time column,
so "due today at 14:00" shows as plain "today", and isn't marked overdue once 14:00 passes. A
timed task due before the end of the day on the next date ("due tonight") is still on Today,
because the API's selection follows `dayOfTask`.

## 3. Tend side

### 3.1 API keys

- Format: `tend_` + 32 random bytes, base64url. Shown **once** at creation, never stored in
  plain text.
- Stored as its SHA-256 hash (a fast hash is right for a 256-bit random secret; Argon2 is for
  human passwords), in a top-level `apiKeys/{hash}` document: `{uid, createdAt, lastUsedAt}`.
  The account sees its key's metadata (created, last used, never the key) in
  `users/{uid}/apiKey/current`.
- Created, replaced and revoked by **callable functions** (`createApiKey`, `revokeApiKey`), never by
  a client write. A client that could write `apiKeys/` could point a key of its own at someone
  else's uid. Security rules deny all client access to `apiKeys/` and client writes to
  `users/{uid}/apiKey/`, with rules tests (`npm run test:rules`).
- `lastUsedAt` is written at most once an hour, not on every poll (288 writes a day otherwise).
- Account deletion removes both documents (`account_deletion.dart`, and the server-side cleanup that
  already runs on `user.delete`).
- UI: Settings → Account, a "Hearth / API key" row with create, copy-once, replace and revoke.
  Round-trip test per Tend's CLAUDE.md (reopening shows the existing key's metadata; nothing
  changes without an action).

### 3.2 The endpoint

One `onRequest` function, `tasksApi`, `us-central1`, 256 MiB, `maxInstances: 2`, like
`stripeWebhook`. `Authorization: Bearer <key>`; an unknown or revoked key gets 401, an account
without Premium gets 403 (§2.2).

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/tasks/today` | Open tasks on today or earlier: `{id, title, projectId, projectName, due, day}`, plus `today` (the account's day) |
| GET | `/v1/projects` | Every live, unarchived project: `{id, name}` (for the restricted-project picker) |
| POST | `/v1/tasks/{id}/complete` | `{nextDue}` or `{nextDue: null}`; body `{due}` (§3.3) |

"Today" is computed on the **account's** clock: `settings/prefs.timeZone`, and `dayEndHour` when the
account has Premium. Which tasks are returned follows Tend's own Today list (the `dayOfTask` rule,
including "due tonight" for a timed task due before the end of the day). Tombstones (`deleted: true`)
and orphaned subtasks (`withoutOrphanedSubtasks`) are excluded the same way the app excludes them.
Tasks with no project are reported under project name "Inbox" with a fixed id (`_inbox`, matching
the key places already uses).

That rule now exists in Dart and TypeScript. To keep them from drifting (Tend's CLAUDE.md "Shared
logic"), the cases go in one JSON fixture file that both test suites run against: Dart tests check
`dayOfTask` against it, and functions tests check the TypeScript port against it.

Reads per poll: the account's settings, its premium status, two range queries on open tasks
(`checked == false` with `doDate <= today`, and with `due <= tomorrow` for due-tonight), and only the
projects those tasks reference (`getAll` by id, not the whole collection). Roughly 10 to 60 reads a
poll, or 3k to 17k a day for one household. Needs composite indexes on `(checked, doDate)` and
`(checked, due)` in `firestore.indexes.json`, deployed by the user.

### 3.3 Completing a task on the server

`TaskCompletionService.completeTask` (Tend `lib/data/task_completion_service.dart`) is the
algorithm, and the server has to do all of it, in one Firestore transaction:

- `completedCount + 1`, `lastCompletedOn` = the account's today, `checked = !reschedules`.
- The next due date by `mode` (`fromDueDate` vs `fromCompletion`, Tend DESIGN.md §4), a missing due
  date standing in as today, `COUNT` stepping down by one (`recurrenceAfterCompletion`), `UNTIL`
  or a spent `COUNT` ending the series.
- The do date keeping its lead over the due date.
- A `completions/{id}` record and the `completionDays/{year}` increment.
- Spawn rules (Tend DESIGN.md §6), Premium only.
- **`updatedAt` set to the server time on every task write.** The devices' delta sync
  (`lib/data/delta_sync.dart`) only sees documents whose `updatedAt` moved; without it, a task
  completed from Hearth stays open on every device until a full re-read.
- **The task's unsent reminders deleted** (`reminders/{taskId}_*` with `sent == false`).
  `sendReminders` doesn't check the task, and reminders are planned by the devices. With no device
  open, a task completed from Hearth would still get its push reminder.
- **Stale completions refused.** The request carries the `due` Hearth saw. If the task's `due` has
  changed (completed elsewhere and moved on), the server returns 409 and does nothing. This is the
  same guard Tend's notification "Mark as complete" has (Tend DESIGN.md §13). Without it, a
  completion queued on Hearth while the task was also completed on a phone would skip the next
  occurrence. Hearth treats 409 as done (§4.2).

Recurrence is the risky part. Tend's DESIGN.md §4.1 chose RFC 5545 via a package because occurrence
maths is the largest silent-bug surface, and this ports it to a second language. Use the `rrule` npm
package (a dependency of `functions/` only, never on the Pi), wrapped behind one
`nextDueDateAfterCompletion` function. Share a fixture of completion cases (rule, mode, due,
completedOn, expected next due, expected rule after) generated from the Dart tests, checked by both
suites. Every rule shape in Tend DESIGN.md §4.2 must be in it, plus short months, `UNTIL`, `COUNT`,
late and early completion, and a missing due date.

### 3.4 Why a snapshot, not a delta

Tend has what a delta needs (`updatedAt` on every write, tombstones for deletes). But "overdue plus
today" is a window over time: at midnight a task due tomorrow becomes due today with no write, so a
"changed since" feed never reports it. Hearth would need a daily full read anyway. A narrow snapshot
every 5 minutes is cheap (§3.2), matches what Hearth already does with Todoist, and the endpoint can
take a `since` parameter later without breaking anything.

(Hearth's own DESIGN.md §4 table says Todoist uses `/sync` with a `sync_token`. The code never did;
`todoist/client.ts` calls `GET /tasks/filter?query=overdue | today` every cycle. Fix the table in
the same PR.)

### 3.5 Free accounts are out of scope

The server bypasses security rules, so serving free accounts would mean enforcing Tend DESIGN.md
§15.5's places itself: refuse to complete a locked task, free the task's place on a completion that
doesn't reschedule, and give a spawned subtask a place. That would mean porting `PlaceKeeper` too.
Premium-only (§2.2) avoids all of it, because with Premium every write is allowed. Every request
checks `premium/status` before doing anything else. That includes a completion, so an account whose
Premium lapses between Hearth's poll and its completion gets 403, never a write the rules would have
refused.

### 3.6 Tend docs

- DESIGN.md: a new section for the API (keys, endpoint, server completion, the shared fixtures), the
  `apiKeys` and `apiKey` entries in §10, and the indexes.
- **Privacy policy** (`site/privacy/index.html`, with its "Last updated" date): an account can now
  send its task titles, dates and project names to a server it chooses, through a key it creates.
  Tend's CLAUDE.md requires this in the same PR.

## 4. Hearth side

No new runtime dependency: Tend's API is plain HTTPS through Node's `fetch`, like Todoist's and
Open-Meteo's. Nothing new to smoke-test on the Pi beyond the adapter itself working there.

### 4.1 Provider boundary

- `src/lib/server/tasks/provider.ts`: a `TaskProvider` interface with what `TodoistClient` already
  has (`fetchOverdueAndDueToday`, `completeTask`, `listProjects`) and a provider-neutral `Task`
  type. `todoist/client.ts` implements it unchanged in behaviour.
- `src/lib/server/tend/client.ts`: the Tend implementation. Like `todoist/client.ts`, the only file
  that talks to Tend, and no raw response shape leaves it. A cheap call (`GET /v1/projects`) at
  connect time to reject a bad key early.
- `tasksRuntime.ts`, `todoist/scheduler.ts`, `tasksQueue.ts`, `todoist/projects.ts` and
  `todoist/resolve.ts` take a `TaskProvider` instead of a `TodoistClient`. The provider-neutral
  ones move out of `todoist/`.

### 4.2 Completing

- `PendingWritePayload` for tasks gains the `due` the board showed, which the Tend adapter sends
  (§3.3). Todoist ignores it.
- The Tend adapter treats 409 (the task already moved on) as success: the write is dropped, and the
  next reconcile shows whatever is true now.

### 4.3 Data

- `connections.provider` gains `'tend'`. Check whether drizzle's SQLite text enum emits a `CHECK`
  constraint; if it does, this needs a migration.
- A new setting, `activeTaskProvider` (`'todoist' | 'tend' | null`), in the key/value `settings`
  table. Both connections can be stored; only the active one runs.
- `list_items` needs the `day` alongside `dueDate` (§2.1, a migration),
  and `buildTasksSnapshot` classifies Overdue on `dueDate < today`, everything else as Today.
  Todoist rows set `day = dueDate`, so their behaviour doesn't change.
- `resolveTasksSource`'s `externalId` and `displayName` become per provider (`'tend-tasks'`,
  `'Tend tasks'`).

### 4.4 Switching provider

One server-side function, in one transaction:

1. Delete the old tasks `sources` row, which cascades to its `list_items`. Delete its
   `pending_writes`.
2. **Clear `settings.restrictedTaskProjectId`.** A Todoist project id means nothing in Tend.
   Left in place, 'only-one' users would see nothing (safe), but 'all-but-one' users would see
   *every* project, including the one that was restricted, until someone picks it again. The
   settings screen should then say plainly that the restricted project needs picking again.
3. Set `activeTaskProvider` and restart `tasksRuntime` against the new provider, which resolves a
   new source and runs a cycle.

A completion still queued in `pending_writes` is lost by step 1 ("nothing carries over"). The
switch should say so when there are any, and ask to go ahead.

### 4.5 Settings UI

`TodoistSection.svelte` becomes a "Tasks" section: a provider choice (None / Todoist / Tend),
then the token or key field for the chosen one. "Todoist" wording elsewhere (`TasksPanel`,
`TaskAccessSection`, the "No Todoist projects discovered yet" text) becomes provider-neutral or names
the active provider.

### 4.6 Unchanged

The Google Calendar exclusion of the "Todoist" calendar (§4 of Hearth's DESIGN.md) stays: it's about
Todoist's own calendar sync, which still exists whether or not Hearth reads Todoist. Tend has no
equivalent calendar.

## 5. Build order

Each step is its own PR, TDD throughout.

1. **Tend: keys.** Callables, rules and rules tests, Settings → Account UI, account deletion. Useful
   on its own (nothing reads a key yet).
2. **Tend: read endpoint.** `GET /v1/tasks/today` and `/v1/projects`, the shared `dayOfTask`
   fixture, indexes, DESIGN.md, privacy policy.
3. **Tend: completion.** The TypeScript completion with the shared recurrence fixture, reminders
   clean-up, the 409 guard.
4. **Hearth: provider boundary.** The interface and Todoist moved behind it, no behaviour change.
5. **Hearth: Tend adapter, provider switch, settings.** Including the `list_items` change for
   the `day` column (§2.1).

Steps 1–3 and step 4 don't depend on each other and can run in parallel sessions, one per repo.

## 6. Testing

- Tend functions: `npm test` for the endpoint, key hashing, today/overdue selection and completion,
  against the shared fixtures. `npm run test:rules` for `apiKeys/` and `apiKey/`.
- Tend app: `flutter test` for the Settings → Account row and the Dart side of both fixtures.
- Hearth: `tend/client.test.ts` against recorded responses (synthetic data only, never the real
  account), the provider switch (sources, items, pending writes and the restricted project
  cleared), and reconcile with `day` and `due`.
- One live check per step on a test Tend account: a recurring task completed from Hearth shows its
  next occurrence on a phone without a restart (the `updatedAt` stamp), and its reminder doesn't
  fire.

## 7. Rollout (to plan later)

Things it will need to cover: Tend function and index deploys (by the user), the new Hearth
setting, which must be in place before switching, and the Hearth deploy. Also the order relative
to the Tend app release that adds the key UI, and when, if ever, Todoist support is removed.
