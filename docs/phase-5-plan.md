# Phase 5 — Groceries: implementation plan

Planning doc for DESIGN.md §12 phase 5: *"AnyList adapter with the write queue, in-session
add and check-off for all three users. The first write path in the system."*

Written to be implemented from directly. Each milestone is one PR. Sections 1–2 are
findings that change what DESIGN.md currently says; sections 3–4 are the decisions an
implementer should not have to re-derive; section 5 is the milestone breakdown.

---

## 1. What the library actually is, verified against the registry

DESIGN.md §2.5 frames this as a choice between `codetheweb/anylist` (upstream) and
`kevdliu/anylist` (a fork with quantities, recipes and `lists-update`). **That framing is
stale.** As of `anylist@0.8.6`, published 2026-05-03, kevdliu is a co-maintainer of the
canonical npm package alongside codetheweb, and the fork's features are in it.

- **`npm i anylist` is the whole install.** No git dependency, no vendored fork, no
  pinning to a commit.
- **Zero native dependencies**: `protobufjs@5.0.3`, `got@11`, `ws@7`,
  `reconnecting-websocket`, `tough-cookie`, `form-data`, `uuid@3` — all pure JS.

That second point is worth stating plainly given this project's history. The two
deployment failures on this Pi (the napi-rs per-platform install bug, and
`@node-rs/argon2` hitting `Illegal instruction` on Cortex-A53 cores without LSE atomics)
were both native-binary problems. **This dependency cannot reproduce either failure mode.**
It is not exempt from a smoke test on the real Pi — `protobufjs@5.0.3` is from 2017 and
has never been asked to run on Node 22 arm64 here — but the smoke test is checking for a
pure-JS incompatibility, not a CPU-instruction one, and it can be a five-minute script
rather than a debugging session.

DESIGN.md §2.5 and the `connections` provider comments should be updated to say this.

## 2. Four things about the library that change the design

### 2.1 The push channel is not durable — §3.1's cadence table is wrong

DESIGN.md §3.1 lists AnyList's mechanism as **push**, with no polling cadence, unlike
every other source in that table. In `lib/index.js`:

```js
this.ws = new WebSocket('wss://www.anylist.com/data/add-user-listener', [], {
    WebSocket: AuthenticatedWebSocket,
    maxReconnectAttempts: 2,
});
```

After two failed reconnect attempts the socket is dead and **nothing revives it** — no
backoff loop, no re-`_setupWebSocket()`. A single home-internet blip during the day
silently ends push for the rest of the process's life. The list would then be stale until
the next restart, with no indication on the tablet that anything was wrong.

This is not a hypothetical for a display that runs for weeks on a shelf. So:

- **Push is an optimisation, not the sync mechanism.** Add a reconciliation poll —
  `getLists()` every 15 minutes — as the actual guarantee of freshness. `lists-update`
  makes it feel instant when the socket is alive; the poll is what makes it correct.
- §3.1's table gains a row: `AnyList | lists-update push + getLists() reconcile | push + 15 min`.

**Correction from M2, once this was actually implemented:** the "track socket liveness via
a `lastSocketMessageAt` timestamp" idea above turned out not to be buildable. The 5s
heartbeat this paragraph describes is the library's own internal `ws.send('--heartbeat--')`
ping — there is no corresponding pong/liveness event exposed on the public API surface, and
`lists-update` itself only fires on a genuine list mutation, which is far too sparse in a
real household (hours apart, easily) to serve as a liveness signal. M2 does not implement
socket-liveness tracking or a forced periodic reconnect at all, and does not need to:
correctness was already coming from the 15-minute poll regardless of push health, per the
bullet directly above this one — a dead socket just means updates take up to 15 minutes to
show instead of feeling instant, silently, until the next process restart. Worth revisiting
only if that degradation turns out to matter in practice.

### 2.2 Every update is a full account refetch

`lists-update` fires `this.emit('lists-update', await this.getLists())`, and `getLists()`
refetches the entire user-data blob — every list, recent items, favourites, recipes — then
protobuf-decodes it. There is no delta.

Two consequences on a 463MB board shared with Pi-hole: someone editing the list on their
phone in a rapid burst (adding six things while walking the aisles) triggers six full
refetches, and the decode is the memory spike, not the HTTP. Handle it with
**debounce/coalesce on the event** (a ~2s trailing debounce collapses a burst into one
refetch) and a single-flight guard so a poll and a push event never decode concurrently.
`createSingleFlight` in `sync/scheduler.ts` already exists for exactly this and should be
reused rather than reimplemented.

### 2.3 The credentials file needs an explicit path

```js
constructor({email, password, credentialsFile = path.join(os.homedir(), '.anylist_credentials')})
```

Under systemd as the `hearth` user this default is wrong, and it fails at *write* time
(after a successful login), which makes it look like an auth problem rather than a
filesystem one.

**Set it explicitly to `/var/lib/hearth/anylist-credentials`** (same directory as
`hearth.db`, already owned by `hearth`). Do not set it to `null`: that disables persistence
and forces a full `auth/token` round trip with the raw email+password on every process
start, which invites rate-limiting or an account lock on a Pi that restarts on every
deploy.

Note that this file is a **second at-rest secret store outside the `connections` /
`SECRETS_KEY` scheme** — the library AES-encrypts it with the account password, so it is
not plaintext, but it is not covered by the project's own crypto either. Two follow-ons:
the account password still goes in `connections.secrets` (encrypted with `SECRETS_KEY`) as
the source of truth, and `scripts/backup.mjs` should be checked — it backs up the
database, and this file should either be included deliberately or excluded deliberately,
not by accident.

### 2.4 Adds must reuse checked-off items

From the library's own README:

> When adding new items, you should reuse existing, checked-off items if possible like the
> official clients do.

AnyList's model keeps checked-off items on the list. Adding "milk" while a checked-off
"milk" is already there produces a duplicate in the real app, visible to everyone on their
phones. The `add` action must `list.getItemByName(name)` first and un-check the existing
item instead of adding a new one when it finds one.

---

## 3. Item identity — the decision that makes reconciliation simple

`list_items.id` is `TEXT PRIMARY KEY`. Use **AnyList's own item identifier** as that id.

The useful part: the library generates identifiers client-side. `new Item(i, ctx)` does
`this._identifier = i.identifier || uuid()`, `createItem(item)` passes the object straight
through, and `addItem` sends `op.setListItemId(item.identifier)`. So **we can generate the
id ourselves at enqueue time and hand it to AnyList**, rather than adding a row with a
temporary id and rewriting it when the write lands.

Match the library's format exactly — its `uuid.js` is `uuidv4().replace(/-/g, '')`, i.e.
32 hex characters with no dashes, so use `randomUUID().replace(/-/g, '')`, not a bare
`randomUUID()`.

What this buys: the optimistic row, the queued write, and the row that comes back from
AnyList all share one primary key. Reconciliation becomes an idempotent upsert, a
pending-write drain never has to rewrite an id the UI is already displaying, and a
double-drain of the same queued add is a no-op on AnyList's side rather than a duplicate.

## 4. Reconciliation vs. the queue

The race that matters: a `lists-update` arrives (or a poll runs) while writes are still
undrained. Reconciling naively means AnyList's truth — which does not yet include the
queued write — overwrites the optimistic row, and the item the user just added visibly
disappears from the wall display and then reappears a few seconds later.

**Rule: reconcile, then re-apply un-drained writes on top, then publish.**

```
lists-update / poll
  → fetch list, upsert into list_items (AnyList is truth)
  → prune list_items rows absent from the fetch AND with no pending write
  → replay pending_writes in id order over the result (in memory or in the same txn)
  → publishState()
```

This is what makes DESIGN.md §6.1 point 4 ("on the next `lists-update`, server state
reconciles and the pending mark clears") actually true: a pending mark clears precisely
when its write leaves the queue, and never flickers before then.

**Backoff needs a column.** `pending_writes` has `attempts` and `last_error` but no
`next_attempt_at`. Without it, backoff state lives only in memory, and since the Pi
restarts on every deploy, a failing queue re-hammers AnyList immediately on every boot.
Add `next_attempt_at INTEGER` in a new drizzle migration (`0003_*`) and select on it.

Other queue rules:

- **FIFO by id, one at a time, single-flight.** Same reasoning as the calendar sync's
  sequential loop: concurrency on this board is not affordable, and out-of-order drains
  turn a check→uncheck pair into the wrong final state.
- **Collapse redundant pairs.** A `check` followed by an `uncheck` on the same item id,
  both undrained, cancel out — drop both rather than making two round trips to arrive
  where the list already is.
- **Never drop on failure.** §6.1 says "nothing is ever lost, only delayed". Cap
  `attempts` around 10 for the backoff ceiling, but leave the row in place with its
  `last_error` set, and surface it as the stale badge rather than deleting it.

---

## 5. Milestones

### M1 — Adapter boundary and a Pi smoke test *(no UI)*

- `npm i anylist`.
- `src/lib/server/anylist/client.ts` — the entire library surface lives behind this file
  and nothing else imports `anylist` (DESIGN.md §2.5: "a strict adapter boundary"). Exposes
  `login`, `fetchItems`, `addItem`, `setChecked`, `removeItem`, `teardown`, and an
  `onListsUpdate` callback registration. Domain types in, domain types out — no `Item` or
  `List` instances escape.
- Credentials via `connections` (`provider: 'anylist'`, secrets `{email, password}`),
  `credentialsFile` pinned per §2.3.
- Resolve `"My Grocery List"` → a `sources` row (`kind: 'groceries'`, `external_id` = the
  list identifier) once at login, per §2.5. Match on the stored id thereafter, never the
  name.
- `scripts/anylist-smoke.mjs` — logs in, lists the lists, prints the grocery list's item
  count, tears down. **Run this on the Pi before M2 starts.** It is the cheap version of
  finding out that `protobufjs@5.0.3` has a problem on Node 22 arm64.
- **Credentials have to get in before M6's settings form exists.** M1 needs a real
  email+password to smoke-test against, and the admin-gated connect form is four milestones
  away. `scripts/connect-anylist.mjs` prompts for the credentials and writes the
  `connections` row, `SECRETS_KEY`-encrypted from the very first run, never sitting in a
  shell history or an env file. It writes with raw `better-sqlite3`, not through
  `upsertConnection` as first planned here — every other `scripts/*.mjs` entry point
  deliberately avoids importing anything under `src/lib/server` (plain `node` can't import
  the TypeScript modules without a build step), and `encryptSecret`'s AES-256-GCM envelope
  is reimplemented inline instead, the same tradeoff `seed-users.mjs` already makes for PIN
  hashing. Mirrors `seed-users.mjs`'s shape otherwise, and M6's form becomes a second way
  in rather than the only one. Run it on the Pi as `hearth`, per the ownership rule for
  anything touching the live database.
- **`npm audit` flags `protobufjs` (a transitive dependency, pinned to the ancient 5.0.3
  legacy Builder API) as a critical CVE** (GHSA-xq3m-2v4x-88gg and several related
  advisories). Read past the severity label before reacting to it: every one of these
  requires the *protobuf schema itself* to be attacker-controlled — "applications that only
  decode messages using trusted, application-defined schemas are not directly affected,"
  per the advisory text. `anylist` loads its schema from a static `definitions.json`
  bundled in the npm package, never from AnyList's server or from anything this app
  controls, so there is no reachable path for a server response to hit the vulnerable
  schema-loading code. Documented at the top of `client.ts` rather than silently
  suppressed — re-verify this reasoning if `anylist` is ever upgraded to a version pulling
  in a newer protobufjs, since the modern reflection API's behaviour differs from 5.x's.

Ships behind no UI and touches nothing existing; safe to merge even if the smoke test
later needs follow-up.

### M2 — Read path

**Shipped.** What follows is the plan as written, with notes on what actually landed —
three things came up during implementation that the plan hadn't anticipated.

- `src/lib/server/groceries.ts` — reconcile a fetched list into `list_items`, per §4's
  ordering. The replay step is a real implementation, not a stub — it's a no-op *in
  practice* only because `pending_writes` is empty until M3 populates it, but the logic
  itself (insert an unconfirmed add, force a check/uncheck, delete a pending remove) is
  fully built and tested now, so M3 doesn't have to come back and restructure reconcile's
  control flow.
- **This is also where `pending_writes.payload`'s JSON shape gets established**, since M2
  is what first has to read it, ahead of M3 actually writing rows. Documented as a
  `PendingWritePayload` type at the top of `groceries.ts`: every action carries at least
  `id` (the item id the write targets), and `add` additionally carries `name`/`quantity` —
  what to create if AnyList hasn't picked the item up by the time a reconcile runs. **M3
  must write rows matching this shape**, not invent its own.
- `src/lib/server/anylist/scheduler.ts` (new, not in the original plan) — a
  `runGroceriesCycle` function that does one reconcile cycle and never throws, marking the
  connection's status either way. This is the AnyList-specific analogue of
  `google/sync.ts`'s `syncCalendar`, kept separate from `sync/runtime.ts`'s timer wiring
  for the same reason Google's sync already is: it's what stays unit-testable without
  touching `setInterval`.
- Wired into `sync/runtime.ts`: starts after `STARTUP_DELAY_MS` like the other tickers,
  inside the existing `started`/`HEARTH_SYNC_ENABLED` guard. An immediate first reconcile
  populates `list_items` right away rather than leaving the count blank for up to 15
  minutes after a restart, then the 15-minute poll and the debounced push handler take
  over.
- **`createSingleFlight` (in `sync/scheduler.ts`) gained the ability to accept arguments** —
  a small, deliberate generalisation, not a new abstraction. §2.2 requires that a poll and
  a push *genuinely* never decode concurrently with each other, not just with themselves.
  Two separate single-flight wrappers (one per trigger) would each only guard against
  overlapping with itself. One shared wrapper, distinguished by a `forceRefresh: boolean`
  argument (`true` for the poll — it must call the adapter's `refresh()` first; `false` for
  a push, which already has fresh data), is what actually delivers that guarantee.
- **`client.ts` gained a `refresh(): Promise<void>` method**, not in M1's original method
  list. `fetchItems` turned out to only ever read the client's already-in-memory cache — a
  push event updates that automatically as a side effect of the library's own `getLists()`
  call inside its event handler, but the poll has no such event to piggyback on and needs
  an explicit way to force a real network fetch. Small, adapter-boundary-respecting
  addition; covered by a new test in `client.test.ts`.
- Extended the `/api/stream` envelope: `{type:'week', snapshot, weather, theme, groceries}`
  where `groceries` is `{items, count, stale} | null` — `count` is unchecked items only
  (§7.3's "🛒 12" is what's still needed, not everything on the list). Never rides in the
  `'locked'` envelope — DESIGN.md §5.1 settles that groceries need a session like
  everything else.
- `TopStrip.svelte`: an inert `<span>` badge, not a `<button>` — "read-only in this
  milestone" means it shouldn't look clickable either, the same principle the comment it
  replaced already stated for a dead grocery button. M4 upgrades it to a real button once
  there's a panel to open.

Navigation, for reference while building M2/M4: two entry points, both already specified.
The `🛒 12` count button in `TopStrip` for the standard view, and a full-width button at
the bottom of `SimpleView` for Sam (§5.2 item 5). Both open the same panel — the second
is not a variant, just a different affordance for the same layer.

### M3 — The write queue

**Shipped.** What follows is the plan as written, with notes on what actually landed.

- Migration: `pending_writes.next_attempt_at`, added as **`0004_equal_agent_zero`**, not
  `0003_*` — a schema change from an unrelated PR claimed `0003` first while M1/M2 were in
  flight. Nullable, not `NOT NULL`, and deliberately so: SQLite's `ALTER TABLE ADD COLUMN`
  rejects `NOT NULL` without a `DEFAULT` the moment the table holds any row, and this
  table's whole reason to exist is to hold rows. `NULL` is queried as "eligible now", the
  same as an explicit past timestamp — this only differs from the plan's literal `NOT NULL`
  in the column's nullability, nothing about how it behaves.
- `src/lib/server/groceriesQueue.ts` — enqueue (with the client-generated identifier from
  §3, and a payload matching the `PendingWritePayload` shape `groceries.ts` established in
  M2), `drainPendingWrites` with exponential backoff (30s doubling to a 30-minute cap,
  10-attempt cap per §4 — never dropped past it, just retried far less often), and
  `collapseCheckTogglePairs`. **Not `groceries/queue.ts`** as earlier drafts of this plan
  had it — `groceries.ts` is a plain file, and a file and a directory can't share a name in
  the same parent.
- **A real bug turned up while testing the id-remap case, and got fixed before this
  shipped**: if an `add` gets redirected onto an existing item by §2.4's reuse rule *and* a
  `remove` for the same pre-remap id lands in the *same drain pass*, the remove must follow
  that redirect — otherwise it targets an id that's already gone from `list_items`, and the
  real AnyList item it should have removed is never touched. `drainPendingWrites` now
  tracks an in-pass remap (`requested id -> confirmed id`) and resolves every subsequent
  action in that pass through it. Across separate passes this can't happen — the tablet
  only ever acts on whatever id the last reconcile actually showed it.
- **Where "single-flight" (§4) actually lives turned out to matter.** Rather than
  `groceriesQueue.ts` owning its own guard, `drainPendingWrites` is called as a second
  step, right after reconcile, inside the *same* `runGroceriesCycle` (M2) that the poll and
  push already share one guard for. Running a drain concurrently with a reconcile against
  the same `AnyListClient` risks the library's own internal `this.lists` cache being read
  mid-write — sequencing them inside one already-guarded pass avoids that outright, rather
  than needing a second, independent guard to reason about.
- **`src/lib/server/groceriesRuntime.ts` (new, not in the original plan)** — moves the live
  `AnyListClient`/sourceId/externalId out of `sync/runtime.ts`'s closure into a small
  process-wide singleton, mirroring `state/publisher.ts`'s own "singleton + exported
  control functions" shape. This exists because an add sitting in the queue for up to 15
  minutes before AnyList even hears about it — the worst case if only the scheduled poll
  ever drained it — felt like a bad first experience for "the first write path in the
  system" (DESIGN.md §12), especially once M4 ships a pending mark implying some
  expectation that it clears promptly. `POST /api/groceries[/​[id]]` now triggers the same
  guarded cycle the background poll and push already use, immediately after enqueueing,
  fire-and-forget — AnyList's own round trip never holds up the HTTP response, since the
  optimistic apply already made it feel instant.
- `POST /api/groceries` (add) and `POST /api/groceries/[id]` (check/uncheck/remove).
  Gated on `locals.session` only — **not** `isAdmin`. §5.1: all three users can write, the
  PIN at the lock screen is the single gate. Neither route gets a direct test — this repo
  has no precedent for testing a `+server.ts` route directly anywhere, and both are thin
  wrappers around already-tested `groceriesQueue.ts` functions.
- The add path implements §2.4's reuse-a-checked-off-item rule — inherited for free, since
  it already lives inside `client.ts`'s `addItem` (M1); the queue just calls it.
- Optimistic local apply + `publishState()` on enqueue, so the tablet reflects the change
  before AnyList has heard about it.

**Reviewed with `/code-review high` before merge, per the agreement above — real findings,
all fixed before this shipped:**

- **`collapseCheckTogglePairs` could silently drop the household's actual intent.** The
  original version pairwise-cancelled adjacent opposite check/uncheck actions like a
  toggle, but check/uncheck are absolute SETs — only the *last* action for an item ever
  determines the correct final state, regardless of what came before it. Pairwise
  cancellation only produces the right answer when a burst is one client's own alternating
  toggle sequence starting from a known confirmed state; §5.1 lets every household member
  write groceries with no per-item lock, so that assumption isn't guaranteed. Under
  concurrent access, an even-length burst could cancel to nothing and permanently,
  silently drop the most recent real intent (the rows were hard-deleted with no retry).
  Corrected to "keep only the last row per item" — unconditionally correct, at the cost of
  one occasionally-redundant round trip in the common single-client case that the old
  version avoided.
- **`client.ts`'s `setChecked` threw when AnyList no longer had the target item**, unlike
  `removeItem`'s documented no-op. Combined with reconcile's rule that a row with an
  outstanding pending write is never pruned, a check/uncheck queued against an item someone
  deleted from their phone before the drain ran would fail every cycle forever — and
  because a drain failure marks the *whole connection* `'error'`, one one-item conflict
  permanently flapped the stale badge for something that was never actually an AnyList
  outage. Now a no-op, matching `removeItem`'s contract and reasoning exactly.
- **A ~10-30s window after every deploy where "AnyList is still starting up" and "AnyList
  was never connected" looked identical** — both returned the same 503. `initGroceriesRuntime`
  doesn't even start until `STARTUP_DELAY_MS` after boot, then does a real login round
  trip; every deploy restarts the process. Added `groceriesReadiness()`, which checks the
  `connections` row directly (independent of whether init has finished) so the routes can
  return a distinct `reason: 'initializing'` a client can treat as "retry shortly" rather
  than "not configured."
- **A single write likely triggered two full reconcile+publish passes.** The route's own
  fire-and-forget cycle, plus — if AnyList's push channel echoes a write back to its own
  writer, which isn't confirmable from outside the library but is the more cautious
  assumption — a second full cycle from the debounced push handler moments later,
  redundantly walking every item in the list twice for one change. Added
  `recentlyCycled()`: the push handler now skips a cycle that lands within 6 seconds of one
  already completing, at the cost of occasionally delaying a genuine concurrent
  third-party change by the same window — bounded, and no worse than the staleness the
  15-minute poll already tolerates by design.
- **The add-branch's id-remap delete+insert wasn't transactional.** Two independent
  statements; a failure between them could leave `list_items` missing a row that genuinely
  existed on AnyList until the next cycle healed it. Wrapped in one `db.transaction`.
- Two small duplications, extracted rather than left: `formatFailures` (shared with
  `sync/scheduler.ts`'s `runSyncCycle`, which had the identical pattern inline) and
  `insertPendingWrite` (the three `enqueue*` functions' identical `pending_writes` insert).
- A dropped `console.warn` on a boot-time AnyList connect failure — restored; every other
  syncable source in `sync/runtime.ts` still logs its own.

### M4 — The grocery panel

`src/lib/components/GroceryPanel.svelte` — the list, a text field, a done button
(§7.2.1). Pending mark on unsynced items (§6.1 point 3), stale badge when the connection
is in `error` (§2.5: "an outage degrades one card to a stale badge, never the page").
Dark-mode variants from the start; §5.3's theme retrofit is done and new components should
not re-open it.

**A gap M3 leaves for this milestone to close:** `groceries.ts`'s `GroceriesItemSnapshot`
(what rides in the SSE envelope) has no `pending` field — M3 only ever needed
`{id, title, quantity, checked}` for a count badge. The pending mark this milestone needs
has to come from somewhere: extend `buildGroceriesSnapshot` to left-join `list_items`
against `pending_writes` (matching on the id embedded in each row's JSON `payload`, per
the `PendingWritePayload` contract) and add `pending: boolean` per item.

**It is a layer inside the session, not a stage and not a route.** `+page.svelte` already
runs a `stage` machine (`screensaver | lock | session`); groceries is a `$state` boolean
within the session branch. A real `/groceries` route would remount the page, tear down and
reopen the `EventSource`, and re-run the load function — a visible stall on a Zero 2 W for
something that should feel instant.

**Layout: a full-bleed sheet over the grid, two-column list.** Checking items off while
unpacking bags is a stand-at-the-tablet task, not a glance, so calendar context earns
nothing and covering the grid buys the full 961px. One column at that width wastes half
the screen and halves the visible item count.

- **The add field is pinned at the top, not the bottom.** Bottom placement is the chat-app
  instinct and it is wrong here: it puts the input exactly where the on-screen keyboard
  appears, and whether it stays visible depends on whether Fully Kiosk resizes the viewport
  or pans it. At the top it never moves.
- **Height budget.** 601px with the keyboard down: ~64px header + ~72px add row + ~465px
  list ≈ 16 rows across two columns. Keyboard up leaves roughly 300px, so ~6 rows — fine,
  because you are typing, not browsing. Verify the split on the real tablet; this is the
  same class of constraint that caught the PIN pad at v0.19, and that one overflowed
  *without* a keyboard involved.
- **Checked items stay visible in a collapsed "Checked · N" section.** Not cosmetic:
  AnyList keeps checked-off items on the list, which is exactly why §2.4's reuse rule
  exists. Hiding them entirely makes a duplicate-item bug invisible to whoever debugs it.
- Touch targets ≥56px in the simple view, per §5.2.

**The idle timeout needs to change while the panel is open.** §5's two-minute idle timer
listens on `touchstart, click, keydown`, so typing keeps a session alive — but standing at
the counter reading the list while putting shopping away touches nothing, and that is the
single most likely real use of this feature. Two minutes in, the session ends, the panel
vanishes and the display drops to the screensaver mid-task. Extend the timeout to five
minutes while the panel is open rather than suspending it: still bounded, and groceries are
the least sensitive data in the system. The panel closes when the session ends either way.

**Swipe-to-open was considered and deferred.** A horizontal swipe from the grid to the
list is the natural gesture, but on Android 10+ gesture navigation an edge swipe *is*
back — Fully Kiosk can try to suppress it, and betting the primary path to a daily feature
on a kiosk setting overriding a system gesture fails in the direction where the user
swipes and something else happens. It is also shear force on a wall mount, where a tap is
perpendicular. And it cannot replace the button regardless, since §5.2 specifies a visible
one for Sam. Revisit as an accelerator once the panel exists and the button has been
lived with — it is self-contained at that point, and would want to be settled alongside
swipe-to-check on list rows, which competes for the same gesture.

**Shipped, verified live against the real ~122-item AnyList account** (add, check, and
remove all confirmed working end to end — remove via a direct API call, since no delete UI
exists; see below). Two real gaps only showed up once there was an actual UI to look at,
neither caught by the server-side test suite because nothing before this milestone rendered
a pending state at all:

- **The pending mark could stay visibly stuck for up to a minute after a write had
  already confirmed.** `POST /api/groceries[/[id]]` published once (showing the item
  optimistically pending) and then fire-and-forgot the reconcile+drain cycle without ever
  publishing again once it finished — so the mark only cleared via the next *unrelated*
  tick (`sync/runtime.ts`'s 60-second state tick, or the 15-minute poll), not because the
  write actually landed. Undermines the exact thing M3's eager-trigger `groceriesRuntime.ts`
  exists for. Fixed: both routes now chain `runGroceriesCycleNow(false).then(() =>
  publishState())`, caught rather than awaited, so the confirmed state reaches the tablet
  within moments of the drain actually finishing.
- **The pending dot could visually read as belonging to the wrong item.** It sat after the
  title's `flex-1` spacer, so a short title (most of them) left it stranded at the row's far
  right edge — for a two-column layout, that's right next to the *adjacent column's* row,
  not its own. The DOM was always correct; only the visual reading was ambiguous. Moved to
  lead right after the checkbox instead, where it's unambiguously "this item, not that one"
  regardless of title length.
- **No remove/delete affordance was built.** DESIGN.md §7.2.1's own spec is deliberately
  narrow — "the list, a text field, and a done button" — so tapping a row only checks or
  unchecks it, matching AnyList's own tap-to-toggle behaviour. The write queue's `remove`
  action (M3) exists and was verified live by calling it directly; there's just no button
  for it yet, on purpose, matching what was actually asked for rather than adding scope.

**Follow-up, after living with it: sidebar instead of full-bleed, checked items hidden
entirely, and category names added.** Explicit user call, reversing two of this
milestone's own documented decisions above — recorded here rather than edited away, since
the reasoning above wasn't wrong given what it knew, it was just superseded by using the
thing:

- **Sidebar (`w-96`, right edge) replaces full-bleed.** The "stand at the tablet" rationale
  for covering the grid didn't hold up in practice — being able to glance at the calendar
  while working through the list mattered more than the extra column.
- **Checked items are no longer shown, not even collapsed.** The "hides a duplicate-item
  bug" concern behind the old "Checked · N" section is real but theoretical; in practice
  the section was just noise on every open. If §2.4's reuse rule ever needs debugging
  again, that's what `anylist:smoke`-style direct inspection and the server logs are for,
  not a permanently-visible UI section.
- **Item category names, resolved and grouped.** AnyList exposes category *names*
  ("Dairy", "Produce", ...) only through an undocumented private field on the library
  instance (`_userData.userCategoriesResponse.categories`) — the public `Item` class never
  surfaces them, only the opaque `categoryMatchId`. `client.ts`'s `categoryNameFor` resolver
  reads this defensively (optional chaining, empty-array fallback, resolved fresh on every
  call rather than cached at connect time) so a future `anylist` version restructuring it
  degrades to "no category names" instead of throwing. **Real bug caught only by testing
  against the live account, not by the unit tests:** a category row's own `identifier` is a
  random per-account id for that row, *not* what an item's `categoryMatchId` points at —
  the shared key both sides actually use is the category's own `categoryMatchId` field
  (e.g. `"dairy"`). The first implementation matched on `identifier` and silently resolved
  every item to "Other"; every fixture in `client.test.ts`'s category-resolution tests now
  deliberately gives a category row a different `identifier` and `categoryMatchId` so this
  can't regress unnoticed again. `list_items.category` (a column the schema already had,
  unused before this) persists it; the panel groups unchecked items under it, "Other" last.

**Second follow-up: category icons and add-item autocomplete.**

- **A hand-written emoji map, keyed by category display name.** AnyList's API exposes no
  icon assets (no image URL, nothing beyond the `icon` slug on the internal category
  object) — the fixed ~20-name set was read directly off the real account (same
  `_userData` source as the category names themselves) and mapped once in
  `GroceryPanel.svelte`. An unrecognised name falls back to the same 🛒 as "Other" rather
  than rendering nothing, so a category AnyList adds later degrades gracefully instead of
  breaking the header row.
- **Add-item autocomplete needed no new endpoint.** `groceries.items` in the SSE snapshot
  was already the full history for the list — checked items aren't pruned until AnyList
  itself drops them — so the suggestion list is a client-side filter over data already on
  the page, not a new query. Suggestions rank a name that's been checked before (evidence
  it's a real recurring item) above one that's only sitting unchecked, then by
  starts-with, then alphabetically; capped to 6. Tapping a suggestion adds it immediately,
  same request the form itself would send — no dedicated "select vs. add" step. The
  dropdown's visibility is keyed to "is there a matching query," not input focus, since a
  blur-driven hide races a touch tap on the suggestion itself (blur fires first) — the
  classic "why didn't my tap register" bug on touch UIs.

### M5 — Sam's simple view

**Shipped.** §5.2 item 5: a full-width grocery button at the bottom of `SimpleView.svelte`,
opening the same `GroceryPanel` sidebar the standard view uses — no separate write path,
just a second place to trigger `groceryPanelOpen`.

- Echoes the standard view's `TopStrip` count (`🛒 Groceries · N`) rather than a bare
  "Groceries" label, and the same "no `groceries` yet → no button" guard — a dead button
  before AnyList's first successful connect is worse than no button, matching every other
  call this codebase makes for a backend that isn't up yet.
- **`GroceryPanel`'s render moved out of the standard-view branch to sit once, after both
  view branches, gated only on `groceryPanelOpen && groceries`.** It was originally nested
  inside the `{:else if snapshot}` (standard-view) block in `+page.svelte`, so opening it
  from the simple view needed either a second copy of that block or hoisting the one that
  existed — hoisting, since the panel needs nothing view-specific (not `snapshot`, not
  `viewMode`) and `<main>`'s own `relative` positioning is all its `absolute inset-y-0
  right-0` sidebar ever needed to anchor to.
- The idle-timeout extension and heartbeat added in M4 for "standing at the counter,
  touching nothing" key off `groceryPanelOpen` alone, not the view branch, so they needed
  no changes to already apply here too.

**Follow-up: `GroceryPanel` gained a `large` variant for the simple view.** The panel was
sized once, for the standard view's denser use — opening it from the simple view rendered
the same compact text and 44px-ish touch targets regardless, out of step with the ~1.6x
type and 56px+ targets everything else in `SimpleView.svelte` already runs at. Rather than
a second component, every size-bearing Tailwind class (sidebar width, header, input,
buttons, category label, checkbox, item row, autocomplete dropdown) now comes from a
`sizes` object keyed by a `large: boolean` prop, and `+page.svelte` passes
`large={sessionViewMode === 'simple'}` — the standard view's branch is byte-for-byte the
same values it always had, so this is additive, not a resize of the thing M4 already tuned.

### M6 — Settings, deploy, and Pi verification

**Settings, `/health`, and `hearth.env.example` shipped.** Pi deploy/live-tablet
verification (this section's last bullet) has not — it needs an explicit go-ahead per
CLAUDE.md ("ask before deploying, restarting, or migrating... a wedged deploy is not a
private mistake"), not something to do in the course of writing code.

- **Settings screen: an AnyList connect form** (email + password, admin-gated like the
  rest of §7.5) — always blank, never pre-filled from an existing connection (secrets never
  travel back to the client), so re-entering credentials doubles as first-time connect and
  password rotation the same way `scripts/connect-anylist.mjs`'s "re-running this rotates
  the password" already did from the command line.
  - **No separate pre-save validation login.** The route saves first via
    `upsertConnection`, then calls `startGroceries()` (see below), which attempts the real
    login and — on failure — marks the connection `status: 'error'` with `lastError` the
    same way every other reconcile failure already does. A dedicated validate-then-save
    step would mean two logins on the success path and a second error-surface to keep in
    sync with the one that already existed.
  - **The connection's status/`last_error` needed no new code at all** — `listConnections`
    already lists every provider generically, so an `anylist` row showing up there was free
    the moment one existed.
  - **A real architectural gap this surfaced: nothing re-ran `initGroceriesRuntime()` after
    boot.** `sync/runtime.ts`'s own connect attempt only ever fires once, `STARTUP_DELAY_MS`
    after process start — so without a change, saving a connection through this new form
    would sit inert until the next full restart, silently defeating the entire point of a
    web-based connect form (DESIGN.md §1: "Web app, so updates never require touching the
    tablet"). Fixed by hoisting `startGroceries` (and the `pushState` it depends on) out of
    `startSyncScheduler`'s closure to module scope and exporting it, guarded by a
    `groceriesStarted` flag — not `groceriesSourceId() !== null`, which would still permit a
    second, redundant `initGroceriesRuntime()` call (a second real login/websocket, the
    first one never torn down) if called again after already succeeding. The scheduler's
    boot-time timer and the new connect route now both call the same exported function.
    Verified live: resubmitting the household's real, already-connected credentials through
    the route returned `{ connected: true }` immediately via the guard's short-circuit, with
    `/health`'s `lastReconcileAt` unchanged — confirming no redundant login actually fired.
- **`/health` gained `groceries.queueDepth` and `groceries.lastReconcileAt`,** not
  `/diagnostics` — that route already exists and is something else entirely (a device CSS
  viewport measurement tool from an earlier phase, DESIGN.md §2.4/§9), not a backend/ops
  page. `/health` was always the right home for a machine-readable ops signal like this one;
  the plan's original wording just hadn't accounted for `/diagnostics` already being spoken
  for. `queueDepth` is a live `pending_writes` row count; `lastReconcileAt` reuses
  `connections.last_success` for the `anylist` row — the same value the settings screen's
  Connections list already renders as "last synced", not a second tracked timestamp.
- **`deploy/hearth.env.example`: `HEARTH_ANYLIST_CREDENTIALS_FILE` added,** commented out at
  its actual default. It already had a working fallback so this changes nothing at runtime,
  but it existed since M1 with no example-file entry to discover it by — worth fixing now
  rather than letting it join `hearth.env`'s pattern of undocumented-until-it-breaks vars.
- **Deploy and verify on the real tablet: not done.** Needs the household's go-ahead before
  touching the Pi — see CLAUDE.md.

---

## 6. Notes for whoever implements this

- **The library logs to `console.info`/`console.error` directly** ("Connected to
  websocket", "Refreshing shopping lists" on every update, "Disconnected from websocket").
  On a display that runs for weeks this is real journald volume. Decide deliberately:
  either accept it, or silence it at the adapter boundary.
- `getVisibleSourceIds` does not filter by `sources.kind`, so a groceries source id will
  appear in the list it returns. Harmless today — `buildWeekSnapshot` joins it against
  `events`, which has no grocery rows — but do not reuse that helper for grocery filtering
  and assume it means the same thing. `getVisibilityRows` already filters to
  `kind='calendar'`, so the settings matrix is unaffected.
- Follow the existing test convention: in-memory `better-sqlite3` + `migrate()` per test,
  as in `src/lib/server/visibility.test.ts`. The AnyList client is the seam to fake — the
  adapter boundary from M1 is what makes the queue and reconciler testable without a
  network.
- DESIGN.md updates this phase should carry: §2.5 (the fork is now the package, and the
  dependency is pure JS), §3.1's cadence table (§2.1), §5 (the idle timeout is no longer a
  flat two minutes — it is five while the grocery panel is open), §6.1 (the
  `next_attempt_at` column and the reconcile-then-replay ordering), §7.2.1 (the panel's
  layout decisions in M4), and §8's schema block.
