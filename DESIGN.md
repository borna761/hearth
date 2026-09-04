# Hearth — Family Wall Display

Design document · v0.29 · 2026-08-31 · status: for review

A Skylight-style family calendar for the kitchen wall. Web app (no APK) on an **8" Android
tablet** (1280×800), served from a Raspberry Pi Zero 2 W on the home LAN, reading photos
from a NAS on the same LAN.

Changes from v0.28: **guest mode sources its own curated NAS library instead of only
ever using Picsum** — the trigger was Picsum going down for ~24h, but the real ask was
structural: a guest staying the week shouldn't be looking at a stock-photo service at
all when there's a real library to show instead. §6's photo pipeline now covers two NAS
source directories, `HEARTH_PHOTOS_DIR` and the new `HEARTH_GUEST_PHOTOS_DIR`
(`/mnt/nas/hearth/guest-pictures/`), scanned by the same nightly job
(`scripts/resize-photos.mjs`) into the same `photos` table — a new `kind` column
(`'family' | 'guest'`) is what keeps the two libraries' rotation, pruning, and
rows completely apart, so guest mode can never show a family photo and vice versa.
`composeNextSlide` (`src/lib/server/photos.ts`) takes `kind` as a parameter now, with
independent rotation state per kind. Picsum drops from "the only source" to "the
fallback for an empty or not-yet-created guest folder" — §7.4 reworded accordingly. The
guest directory is optional and tolerated missing (`resize-photos.mjs` skips it with a
log line rather than failing the whole nightly job) — nothing breaks for anyone who
doesn't set it up.

Changes from v0.27: **two more live-debugging fixes, both about guest mode's actual
durability, chased down after the tablet started failing every PIN-free write again.**

- **Guest and session cookies could get permanently stuck, silently.** Diagnosed by
  temporarily logging every POST's headers (reverted once found): the tablet's every
  request carried both `hearth_guest=1` and a session cookie together, even right after a
  successful PIN login on that device. `/api/auth/login`'s
  `cookies.delete(GUEST_COOKIE, { path: '/' })` — and `/api/auth/logout`'s equivalent for
  `SESSION_COOKIE` — never passed `secure`, so both fell back to SvelteKit's own default:
  `secure: true` for any non-localhost host, including the tablet's plain-HTTP LAN IP. A
  browser must ignore a `Secure`-flagged `Set-Cookie` response received over plain HTTP,
  so the delete silently did nothing — `hearth_guest` stayed stuck long after guest mode
  had ended, permanently blocking every PIN-free action with a 401 that looked exactly
  like a network failure (DNS and `ORIGIN` mismatches were both ruled out first, at real
  cost, before this was found). Fixed with `authCookieOptions(url)`
  (`lib/server/auth/session.ts`), the one place this computation now happens, used by
  every `SESSION_COOKIE`/`GUEST_COOKIE` set and delete call site.
- **Guest mode's "sticky until a PIN" promise (§5) only ever held for the current
  process.** `activeScreensaverMode` was a plain module-scope `let`, the same shape as
  `activeSessionToken` — but unlike a live session (where losing state on a restart and
  needing a fresh PIN is the correct, safe default), guests staying for a week
  shouldn't need Guest mode re-tapped after every deploy or crash restart. Moved to the
  `settings` table (`screensaverPublisher.ts`'s `getActiveScreensaverMode`/
  `setActiveScreensaverMode`, mirroring `theme_mode`/`quiet_hours`'s existing pattern) —
  §5's own wording amended to say so.

Changes from v0.26: **three live-debugging fixes, none of which touch this document's body
directly — tracked here since none had an obvious section to land in.**

- **Music playback was silently failing end-to-end** — `queueLoad` reported success but
  the Cast speaker never actually fetched the track, `playerState` stuck in `IDLE`
  forever. Root cause, confirmed by running Hearth's actual deployed playback code
  directly on the Pi: adapter-node's `handler.js` sets `url.origin` from the `ORIGIN` env
  var *unconditionally* whenever it's set, regardless of the request's actual Host header
  — so every track URL `/api/music/play` built was always based on `ORIGIN`'s hostname
  (`raspberrypi.lan`, a router-DNS name, not a real mDNS `.local` one), never on whatever
  host/IP the browser used to reach the Pi. Browsing straight to the Pi's IP address
  didn't help, since `url.origin` doesn't come from the request either way. Google Cast
  devices don't reliably resolve `raspberrypi.lan`. `HEARTH_STREAM_BASE_URL`
  (`src/lib/server/musicStreamUrl.ts`) already existed to fix exactly this — introduced in
  phase 7 for a `localhost`-in-dev wrinkle — but was only ever documented as a dev
  convenience, never added to `deploy/hearth.env.example` or set in production. Now
  documented as production-required whenever `ORIGIN`'s hostname isn't one Cast devices
  can resolve; see `docs/phase-7-music-plan.md` §5's amendment.
- **`hearth.service` took ~90s to restart on every deploy** — not a graceful stop, but
  systemd's full `TimeoutStopSec` elapsing before it fell back to `SIGKILL`. adapter-node's
  own `SIGTERM` handler already closes the HTTP server gracefully and emits a
  `'sveltekit:shutdown'` event for the app to do its own cleanup, but never calls
  `process.exit()` itself — and nothing was listening, so `sync/runtime.ts`'s several
  `setInterval`s (calendar sync, weather, screensaver, groceries/tasks polling) kept the
  event loop alive forever. Fixed with a small `registerShutdownHandler()`
  (`src/lib/server/shutdown.ts`), wired up in `hooks.server.ts`, that calls
  `process.exit(0)` once that event fires. Restart time confirmed down to ~40s — the
  remainder is adapter-node's own `SHUTDOWN_TIMEOUT` (default 30s) waiting out the
  screensaver's long-lived SSE connection, which is never "idle."
- **Adding/removing a grocery item took up to 30s to show up on the tablet.** Both
  grocery write routes only called `publishState()`, which — with no active session, the
  normal case for §5.1's PIN-free screensaver groceries button — sends the `'locked'`
  envelope, carrying no `groceries` field at all. The screensaver's own groceries widget
  reads from `screensaverPublisher.ts`'s separate bus, which was only ever refreshed by
  `sync/runtime.ts`'s own periodic tick (`SCREENSAVER_TICK_MS`, 30s) — never by the edit
  itself. Fixed with `publishAll()` (`state/publisher.ts`), which pushes to both buses
  together; wired into both write routes and into the AnyList poll/push-echo handlers in
  `sync/runtime.ts`, so an edit reaches both audiences immediately regardless of which
  button made it.

Changes from v0.25: **§5.1's decision reverses — groceries is PIN-free again, but from the
screensaver rather than the lock screen this time.** v0.3 rejected a PIN-free lock-screen
button in favor of putting groceries behind the PIN with everything else, to keep the
access model to one gate. That simplicity was worth less in practice than not having to
log in for a quick add-milk-to-the-list moment, so the button now lives on the resting
screensaver instead — reachable at rest, before even tapping to wake — and disappears in
guest mode the same way the photo source does. The per-session groceries button in
`TopStrip`/`SimpleView` is gone too, consolidated into the one screensaver entry point;
`canAccessPinFreeFeature` (`lib/server/auth/session.ts`, renamed from `canWriteGroceries`
once phase 7's music button started sharing it) is the shared gate the write endpoints
now check instead of requiring a session outright.

Changes from v0.24: **switched kiosk apps, Fully Kiosk → Free Kiosk** (`RushB-fr/freekiosk`,
open-source, no paid tier). §9.1/§9.2 and `deploy/README.md` §11 rewritten for the new
app's settings, checked live against the real tablet rather than its docs (the same
scraped-docs-were-unreliable pattern v0.23 already hit once for Fully Kiosk): one combined
Fullscreen toggle rather than three separate chrome switches; "Reload on Error" exists but
no separate network-reconnect trigger was found; "Return to Start Page on Inactivity" is
the nightly-reload substitute (Fully Kiosk's Auto Reload on Idle's role); no crash-relaunch
equivalent was found in settings — both gaps are flagged as open risks, not silently
assumed covered.

**The backlight now actually sleeps overnight, for the first time in this project.** Free
Kiosk's own Sleep Schedule (22:30–06:30) is free, unlike Fully Kiosk's equivalent, which
turned out to require the paid PLUS license and was never purchased (v0.23). Deliberately
left offset from `quiet_hours` (22:00-07:00) rather than synced to match — confirmed
acceptable rather than kept in sync by hand. Also enabled: Free Kiosk's own screensaver
(dim style, 10% brightness, after 10 minutes of inactivity) — whether its timer is scoped
to the Sleep Schedule window or runs independently around the clock isn't yet confirmed,
worth a daytime check. Motion-detection wake was considered and explicitly declined: it
needs the tablet's own camera running continuously, ruled out as a real privacy
consideration rather than something left for later. Free Kiosk also exposes a REST API
(`/api/screen/on`, `/api/screen/off`, `/api/brightness`, `/api/reload`) that could let
Hearth's own server drive the screen directly — §9.1's long-standing "the app cannot drive
the screen" constraint no longer strictly holds — but with the native Sleep Schedule
already covering the main use case (real screen-off on a clock, no new Pi-reaching-tablet
failure mode), it's no longer the obvious next step either.

Changes from v0.23: **§9.1's "free version still provides" list was wrong — scheduled
screen off/on and motion-based wake are both PLUS-only,** confirmed against the real
Fully Kiosk app (2026-08-26) after its own site gave contradicting answers depending on
which page was checked. Also caught live: `publishState()` suppressed the week snapshot
for *any* reason during quiet hours, including an active session — logging in after 22:00
got stuck on "Loading…" forever, since the server never sent anything (fixed, scoped to
only the no-session/locked branch). Staying on the free tier rather than buying PLUS:
`quiet_hours` alone now drives "dark at night" (§9.2), and the night-clock screensaver
dims itself to 40% opacity so a lit backlight isn't glaring in a dark kitchen; the nightly
reload moved from a fixed 04:00 to Auto Reload on Idle (4h), since the free tier has no
fixed-daily-time option. `deploy/README.md` §11 corrected to match every setting actually
confirmed on the device, not the earlier best-guess menu paths.

Changes from v0.22: **phase 6 (minus Todoist, still undecided): nightly backups are now
verified, and the tablet's Fully Kiosk setup is finally written down.**
`scripts/backup.mjs` runs `PRAGMA integrity_check` plus a non-empty-`users`-table sanity
check against the file it just wrote (`scripts/lib/backup-verify.mjs`), failing the job
loudly rather than discovering a bad backup for the first time during an actual disaster
restore; `npm run backup:verify` runs the same check by hand against any backup, for a
periodic spot check or a real recovery drill. `deploy/README.md` gained §11, the tablet
setup that has only ever lived in whoever configured Fully Kiosk last remembering it — none
of it is Hearth's own code, since the free tier can't drive the screen (§9.1). §9.1's own
screen-schedule example was stale (23:00–06:00) against §9.2's canonical 22:00–07:00;
fixed to match. Phase 5 (groceries) also shipped in full since v0.22 — not yet absorbed
into this document's body, tracked separately.

Changes from v0.21: **the merge from v0.21 also rewrites `source_path`, not just
`cached_path`.** Found the hard way, on the real ~1100-photo backfill: `source_path` is
the column the merge's `ON CONFLICT` matches existing rows on, so leaving it unrewritten
didn't just point at the wrong file — every merged row looked brand new instead of
updating the Pi's already-existing one (31 stale rows from earlier partial Pi-side runs
were left untouched, landing at 1168 total instead of 1137), and the Pi's own next
nightly diff would have failed to recognize any of the 1137 as already-processed against
its own directory walk, reprocessing the whole library and pruning what the merge had
just added. `mergePhotosTable` now takes `rewriteSourcePath` alongside
`rewriteCachePath`; `merge-photos-table.mjs` reads it from a new `SOURCE_PHOTOS_DIR` env
var, mirroring `SOURCE_PHOTOS_CACHE_DIR`.

Changes from v0.20: **a large first-run photo backfill can run on another machine instead
of the Pi, per deploy/README.md §8.1.** Even with v0.20's CPU/IO caps in place, a genuinely
large backfill (the household's real library is ~1100 photos) is a lot of sustained load
for a single-core-constrained Zero 2 W that's also serving DNS — and reports of the board
becoming unresponsive under other heavy tasks, unrelated to this app entirely, suggest
this specific board may simply be at its ceiling for that kind of sustained job regardless
of any scheduling priority tuning. `scripts/lib/merge-photos.mjs` +
`scripts/merge-photos-table.mjs` let the CPU-heavy resize work run anywhere on the LAN,
against a local scratch database, and merges only the resize-derived columns into the
live database afterward — `shown_count`/`last_shown` on any row that already existed
survive untouched, so re-running a partial backfill is safe. The live database is never
touched over the network for this — §3.5's "SQLite over CIFS/NFS is a corruption risk"
rule holds throughout; the merge step only ever runs locally, on the Pi. The merge also
rewrites the `cached_path` prefix it finds (`SOURCE_PHOTOS_CACHE_DIR` → the Pi's own
`HEARTH_PHOTOS_CACHE_DIR`) rather than requiring the other machine to mount the NAS at the
exact same local path — discovered mid-rollout that this can't just be assumed away:
macOS's root filesystem is read-only and can't mount anything at `/mnt` at all, so a
Mac-side run necessarily uses a different local path, and the Pi needs the string in its
own database to match its own mount instead. Going forward,
the *nightly* job only ever has to process a small delta, which is a meaningfully smaller
and shorter workload than the one-time backfill — there's real reason to expect that one
to behave better even if the board can't handle a full-library run.

Changes from v0.19: **§6's resize unit gains `CPUWeight=`/`IOWeight=`/`Nice=`, capping it
to spare capacity only** — the same hard-limit philosophy `MemoryMax=` already used. This
Pi runs Pi-hole DNS for the household and the wall display itself alongside a nightly
resize job that's genuinely CPU-heavy, on a single 1GHz quad Cortex-A53 (§2.1). A live
incident during initial setup — an SSH session dropped mid-manual-run, and the operator's
first instinct was "the Pi OOM'd" — turned out not to be OOM at all on inspection:
`dmesg` had no OOM trace, and the last progress checkpoint was 66MB RSS, nowhere near
`MemoryMax=192M`. The actual mechanism is still unconfirmed (the SSH session itself may
simply have dropped for unrelated reasons), but CPU/IO starvation making the board
*feel* dead — SSH timing out, DNS stalling — without any OOM or reboot involved, is a
real enough possibility on this hardware to guard against regardless of what actually
happened this time. `scripts/resize-photos.mjs`'s own header comment now also steers
Pi operators toward `sudo systemctl start hearth-resize.service` over running the script
directly — only that path gets these caps and survives an SSH disconnect; a bare
`node`/`npm run` in a foreground SSH session dies to `SIGHUP` the instant the connection
drops.

Changes from v0.18, real-hardware polish from actually living with this on the wall:

- **§7.3's strip no longer carries weather.** It was there for "a passing glance", but in
  practice a glance at the calendar is a glance at the calendar — weather already has its
  own dedicated moment on the screensaver and lock screen (§7.1/§7.2), and repeating it
  here was just noise competing with the next-event line for the same small strip.
  `TopStrip.svelte` drops the `weather` prop entirely.
- **The screensaver's "Guest" badge is gone.** It named the mode in the corner of an
  otherwise clean resting screen; guest mode already reads clearly from context (no
  session, no family photos), and the label added visual clutter for no real orientation
  benefit.
- **The lock screen's PIN entry is smaller.** At the real Fully Kiosk viewport (961×601,
  §2.4), the clock + card stack in the wrong-PIN state (clock, avatar, error line, PIN pad)
  measured out to ~613px tall — a real ~12px overflow past the bottom of the visible area,
  cut off on the actual tablet. Shrunk the clock, card padding, and PIN pad buttons/gaps;
  the same worst-case state now measures ~490px, comfortably inside 601px.

Changes from v0.17: **§5.3's sunrise/sunset theme ships** (phase 4 milestone 2) —
`src/lib/theme.ts`'s `computeTheme(now, mode)` computes `light`/`dark` from `suncalc` at
the pinned coordinates, with a `theme_mode` setting (`auto | light | dark`, default
`auto`) and its own admin-gated `/api/settings/theme-mode` endpoint. `theme` now rides in
both SSE envelopes (the session stream and the public screensaver stream) alongside
weather, and every existing screen — `TopStrip`, `WeekGrid`, `HourGrid`, `SimpleView`,
`Lock`, `PinPad`, `Screensaver` — gained the `dark:` Tailwind retrofit this always implied
but that phase 2 never actually built (`@custom-variant dark` in `app.css`, toggled by a
`dark` class the client sets from the value it receives, never computes itself). Two
things worth recording:

- **`suncalc`'s `getTimes(date, lat, lng)` keys a day's sunrise/sunset off `date`'s UTC
  calendar date, not local.** Springfield sits behind UTC, so local evening hours regularly
  fall on UTC's *next* calendar date — a naive single `getTimes(now, ...)` call computes
  tomorrow's sunrise/sunset and wrongly classifies a still-bright summer evening as dark,
  since tomorrow's sunrise hasn't happened yet. Caught by a test built from this
  document's own worked example ("light shortly before sunset on the summer solstice"),
  fixed by checking both `now`'s suncalc day and the previous one and treating either
  window as satisfying "currently light."
- **Theme recomputes on every publish (the existing ~60s state tick) rather than the
  dedicated per-transition timer this section originally described.** A sunrise/sunset
  boundary lands within about a minute either way, which is imperceptible given the ~2s
  crossfade itself, and this avoids a second timer to schedule and reschedule around
  `theme_mode` changes and DST — one clock instead of two, same practical result.

Changes from v0.16: **The screensaver goes live with real family photos** (phase 4
milestone 5) — §7.1's pairing rules (same-day preferred, falling back to any other
portrait, an odd one held over rather than shown alone) are implemented in
`src/lib/server/photos.ts`, sourcing from the `photos` table milestone 4's nightly job
populates. Family mode falls back to Picsum gracefully when that table is still empty (the
job hasn't run yet, or the NAS is unreachable) rather than going blank. Two things worth
recording:

- **§5/§7.4's "Unsplash for guest" is corrected to Picsum throughout this document.** This
  was already decided and built in milestone 3 (picsum.photos needs no developer account,
  no API key, and none of Unsplash's attribution/download-tracking-ping obligations), but
  the changelog note recording *why* never actually landed until now — this entry is that
  note, and every remaining "Unsplash" reference in this document has been corrected to
  match what's actually built. The `connections` table's `provider` enum drops
  `'unsplash'` accordingly; Picsum needs no key, so it never created a row there anyway.
- **A route to actually serve a photo's bytes to the tablet wasn't in the original
  milestone 5 plan, and turned out to be required** — `cachedPath` is a NAS filesystem
  path, not a URL a browser can fetch, unlike Picsum's direct CDN links. Added
  `GET /api/photos/[id]`, public like the rest of the screensaver's content, falling back
  to the local fallback-ring copy if the NAS-hosted derivative can't be read.

Changes from v0.15: **§6's nightly photo resize pipeline is built** (phase 4 milestone 4)
— `scripts/resize-photos.mjs`, its own `hearth-resize.service`/`.timer` pair modeled
directly on the existing backup job, and `sharp`/`blurhash`/`exifr` as new dependencies.
Two things worth recording:

- **`taken_at` comes from the photo's real EXIF capture date, not file mtime**, via
  `exifr` (pure JS, no native binary, so no platform risk). §7.1's "pairs prefer photos
  taken on the same day" would have been quietly wrong against any bulk-imported library —
  which is the normal way a NAS photo folder gets populated, copying years of a camera
  roll in one sitting, giving every photo in that import the same mtime regardless of when
  it was actually taken. Falls back to mtime only when a photo genuinely has no EXIF date
  (a screenshot, or a file stripped of metadata).
- **Checked `sharp`'s ARM64 compile target before deploying it, given the argon2 finding
  two changelog entries up.** Its official prebuild pipeline (`sharp-libvips`) compiles
  linux-arm64 with `-march=armv8-a` — the plain baseline instruction set with no `.1`/LSE
  extension assumed, which is exactly what the Zero 2 W's Cortex-A53 implements. Meaningfully
  more confidence going in than argon2 had, though still something to confirm for real on
  the actual Pi rather than trust blindly, per the pattern that's bitten this project twice
  now with different native dependencies.

Changes from v0.14: **PIN hashing moved from `@node-rs/argon2` (native) to `hash-wasm`
(WebAssembly), found on the real Pi during Phase 3's first actual deploy.** The native
linux-arm64-gnu prebuild loaded fine but crashed with `Illegal instruction` the moment it
ran — the Zero 2 W's Cortex-A53 cores (`CPU part 0xd03`) don't implement the ARMv8.1 Large
System Extensions atomic instructions (`/proc/cpuinfo`'s `Features` line has no `atomics`)
that the prebuild assumes are always present on aarch64. Confirmed on the actual hardware,
not assumed: the shipped binary's sha256 matched the locally-built one exactly, ruling out
a corrupted transfer before concluding it was a genuine CPU incompatibility. `hash-wasm`
runs the identical argon2id algorithm through V8's WASM compiler, which correctly targets
whatever instructions the host CPU actually supports — same hash, same "reused from
elsewhere" rationale in §5.3, zero native binary. `scripts/deploy.sh`'s staging step also
picked up an unrelated, adjacent fix: it ran `npm ci` with no target-platform flags, so a
Mac-run install silently shipped zero Linux optional-dependency binaries at all (a problem
`better-sqlite3` never had, since it bundles every platform inside one package) — worth
keeping for Phase 4 milestone 4's `sharp`/`blurhash`, which have the same per-platform
shape `@node-rs/argon2` did.

Changes from v0.13: **§7.5's settings screen has its own login, deliberately not the
tablet's.** Settings is reachable from a phone over Tailscale, and the tablet's login
(`/api/auth/login`) has a side effect beyond authenticating a request: it marks that
session as the one physical display's *active* session, which is what the SSE publisher
filters the broadcast calendar against. If settings reused that same login, checking it
from a phone would silently reassign what the kitchen tablet is showing to everyone in
the room the moment you entered your PIN. Settings authenticates through a separate
`/api/settings/login` that creates a real, valid session (so `/settings` and its API
routes work normally) without ever touching the tablet's active-session state — the two
concerns share the same session mechanism and cookie, but creating one never implies the
other. Also: a logged-in non-admin visiting `/settings` sees a plain "not authorized"
message, distinct from the login screen, rather than the same picker reappearing as if
their PIN had failed.

Changes from v0.12: **§8 gains a `sessions` table**, which had no equivalent here before.
Phase 3's access model (§5) needs "who's logged in" to survive individual page loads — PIN
lockout and the 2-minute idle timeout are both meaningless if a page reload resets them —
and nothing in the original data model persisted that. The session token is stored raw,
not hashed: a local database reader on this Pi already has access exceeding what a stolen
~2-minute-lived token grants, the same "casual visitors, not adversaries" threat model §5.3
already states for PINs. `users` also gains `is_admin` (marks who can reach the future
settings screen, §7.5), `failed_pin_attempts` and `locked_until` (the lockout state §5's
"five wrong PINs triggers a 60-second lockout" needs somewhere to live). This is
foundational work only — hashing, lockout, and session logic are built and tested, but not
yet wired into any route; the lock screen, idle timeout, and settings screen that use them
land in later Phase 3 milestones.

Changes from v0.11: **football teams keep their own colours again** (§4), reversing v0.8's
decision to force the whole group onto Arsenal's `#ff7537`. That fix was written for an
older sidebar-style layout where four feeds competed for one row; the week view that
actually shipped shows every match as its own full event, so the space-saving reason no
longer applied and unifying the colour only cost the ability to tell teams apart at a
glance. The two real collisions this reintroduces (Barcelona/Holidays in Canada,
Inter Miami/Visitors) are accepted rather than dodged. Grouping under "Football" is kept,
but only for the settings/visibility matrix (§7.5) — one togglable row, not one colour.

Changes from v0.10: **the week view offers an hour grid alongside agenda**, toggled from
the strip rather than chosen once and fixed (§7.3). Checking it against the live account
found real overlapping events — block-style entries with sub-events nested inside them,
same-slot pairs — but that check ran before per-user `visibility` filtering exists, so it
saw every calendar merged rather than what any one person will actually see. Whether
collision layout is worth building is now an open question pending phase 3, not a
decision either way.

Changes from v0.9: **the week grid rolls forward from today instead of showing a fixed
Monday–Sunday block** (§7.3). Nothing in this document ever actually specified Monday-start
— it was an unstated implementation assumption — and it works against the screen's own
stated purpose: a kitchen glance at what's coming up. A calendar-week grid is mostly in
the past by Thursday or Friday.

Changes from v0.8: **the tablet's CSS viewport is measured, and it is 961px, not the
1024px floor this document has assumed since v0.3** (§2.4). That is not wide enough for
§7.3's week grid *and* a right rail, so the rail becomes a strip along the top and the
grid takes the full width. The last open question in §13 is closed.

Changes from v0.7: **calendar sync is corrected against the live API** (§3.1). Google
expands recurrence for us, so the Pi never evaluates an RRULE; and because a sync token
cannot carry a time window, the rolling window only rolls if a nightly full sync
re-anchors it. Both were measured against the real account, not inferred from the docs.

Changes from v0.6: **the memory budget was written against a machine that does not
exist.** The Pi has 463MB usable, not 512MB, and it is not dedicated — it also serves the
household's DNS as a Pi-hole. Every memory figure in §2.1, §3.3 and §6 is revised against
measurements from the actual board — including Pi-hole's real footprint on the 64-bit
reinstall — and the nightly resize moves out of the server process into its own unit so
its spike cannot take the display down.

---

## 1. Goals

- A kitchen display showing the household's combined schedule, groceries and tasks.
- **Nothing sensitive visible until someone enters a PIN.** The kitchen has visitors.
- A one-tap guest mode that shows an attractive screensaver and no household data.
- Three people — Alex, Dana, Sam — each with a configurable set of visible calendars.
- Photo screensaver with clock, date and weather, sourced from the NAS.
- **Groceries are writable by everyone** — adding an item is the most frequent thing
  anyone will do at this display, and it has to be frictionless.
- Web app, so updates never require touching the tablet.

### Non-goals (v1)

- **Writing to calendars.** Events are read-only; no creating or editing from the wall.
- Anything on the NAS beyond file serving.
- Public internet access. This is a LAN appliance.

---

## 2. Constraints

### 2.1 The Pi has 463MB usable, and Hearth is not its only tenant

A 1GHz quad Cortex-A53, wifi only, booting from an SD card. The board is sold as 512MB,
but that is not what the operating system gets, and Hearth does not get what is left.
Measured on the actual device, 64-bit Raspberry Pi OS Lite, `gpu_mem=16`, a freshly
reinstalled Pi-hole:

```
                                              MiB
  nominal                                     512
  VideoCore firmware + kernel reserve         -49   → 463 total
  Pi-hole + base system (measured, 64-bit)   -186   → ~277 for Hearth
```

Three things follow, and they are the reason every memory figure in this document was
wrong until v0.7.

**The 512MB was never real.** The VideoCore is the boot processor, not an optional
peripheral — its firmware brings up the ARM cores and stays resident handling clock and
power management. It cannot be given zero. The floor is `gpu_mem=16`, which selects a
cut-down firmware with no codecs, no 3D and a 1080p@16bpp early framebuffer, all correct
for a headless board. **Set it: the default of 64 costs 48MB for nothing.**

**The Pi also runs Pi-hole**, and that is a deliberate, permanent arrangement rather than
something to migrate away. It serves DNS for the whole household, which makes it more
important than the wall display: a Hearth bug that exhausts memory must not take the
family's internet with it. Hence hard `MemoryMax=` caps on every Hearth unit — a cgroup
ceiling turns "Hearth leaked" into "Hearth restarted" instead of "the house is offline".
Pi-hole's own footprint scales with gravity size and query-log retention: the original
32-bit install here had accumulated a 2.8GB query-log database at the default one-year
retention, which was the actual cause of a 100MB swing seen between two consecutive
`free` readings during triage — not a mysterious leak, just an oversized on-disk file
churning the page cache. The reinstall caps retention at 30 days
(`database.maxDBdays 30`, set immediately after install, before any queries land).
**That cap is load-bearing for the budget below and must survive any future reinstall.**

**~277MB is the real budget for Hearth**, measured rather than projected: `gpu_mem=16`
returns 48MB from the VideoCore's default 64MB split, and a fresh 64-bit Pi-hole install
with capped retention sits at ~186MB, leaving the rest.

Mandatory: **zram swap.** Raspberry Pi OS ships this enabled out of the box now —
`/dev/zram0`, zstd, sized to the full 463MB of RAM — so there is nothing to install;
`deploy/README.md` verifies rather than configures it (§3.3). The caps that follow from
the figures above are `MemoryMax=224M` with a 128MB heap for the server, and a separate
`MemoryMax=192M` with a 64MB heap for the nightly resize (§6).

This is still the dominant constraint. It rules out Docker, rules out building on the
device, rules out on-demand image processing, and pushes sync toward polling rather than
webhooks.

**These figures are measured on the real board**, not projected: 64-bit Raspberry Pi OS,
`gpu_mem=16`, a freshly reinstalled Pi-hole with `database.maxDBdays=30`, two `free -h`
readings a few minutes apart holding within 1MB of each other. That is a short window, not
a multi-hour soak — but the specific instability that made the 32-bit board unreliable to
measure (a 2.8GB query-log database) is structurally gone at a 30-day cap, so there is a
real mechanism behind trusting a short reading here where there wasn't before. Worth
another glance after a week of normal household use; see §13.

### 2.2 The NAS is a file server, not an app host

The NAS is a Marvell ARM appliance with 512MB–1GB of RAM and locked firmware.
Docker on My Cloud OS 5 exists only as a community modification that voids the warranty
and is wiped by firmware updates. Nothing custom gets installed on it.

What it is excellent at is serving files, which is exactly what is needed:

| Device | Role |
|---|---|
| NAS | Photo originals (read-only SMB), nightly SQLite backup target |
| Pi Zero 2 W | App, database, sync, image processing |
| Galaxy Tab | Display |

### 2.3 Photos live on the NAS — and that is a relief

v0.1 planned to pull from Google Drive because Google removed the
`photoslibrary.readonly` scope on 31 March 2025, which killed third-party photo frames and
`rclone`'s Google Photos backend alike.

**None of that applies any more.** Photos are already on the NAS, so the app mounts a
read-only SMB share and walks a directory. No OAuth scope, no quota, no API that can be
deprecated. This note stays in the document only so nobody later "improves" it by
reconnecting Google Photos.

### 2.4 The tablet's actual specs — confirmed

**An 8" Android tablet (2019-era).**

| | |
|---|---|
| Panel | 8.0" **1280×800**, 16:10 |
| SoC / RAM | Snapdragon 429 · **2GB** |
| Android | 11 at its final update — **Chrome is current** |

That closes the question v0.5 left open, and it closes it the right way. The alternative
worth worrying about was an older, 2015-era 4:3 tablet: 1024×768, and stuck on an old
Chrome build after Chrome dropped Android 7 and below, which would have invalidated both
the layout and the CSS this document assumes. None of that applies to the actual device.

The budget is **tighter** than the A7 Lite estimate in v0.3, not looser — the Snapdragon
429 is slower than a Helio P22 and there is only 2GB of RAM:

- **Under ~120KB of gzipped JavaScript.** Server-render; hydrate as little as possible.
- **No `backdrop-filter`, no CSS `blur()`, no large `box-shadow` on scrolling content.**
- Cross-fading two full-screen images is fine — that is compositor work.
- Keep the DOM small. The week view is both the better kitchen glance and the cheaper
  render; a month grid is the likeliest place this device falls over.
- 2GB of RAM makes the **nightly reload** (§9.1) load-bearing rather than hygiene.

**The CSS viewport is measured, and it is narrower than every previous version of this
document assumed.** Read off the device, landscape:

```
  device pixel ratio            1.33125
  CSS viewport, Fully Kiosk       961 × 601      ← the real target
  CSS viewport, Chrome w/ bars    961 × 433      (address bar + system bars cost ~168px)
  physical panel                 1280 × 800
```

1280×800 is the panel, not the viewport: Android reports CSS pixels at the device's
density, and 1280 ÷ 1.33125 = 961. v0.5 guessed the bad case would be DPR 1.5; the real
ratio is 1.33 and it lands outside the old range anyway. **The 1024–1340px fluid range in
previous versions does not cover this panel.** Build fluid across **960–1340px** instead.

Two consequences worth stating plainly:

- **961px is not wide enough for a week grid and a right rail together**, which is why
  §7.3 now puts that content in a strip along the top. Seven columns of the full width are
  137px each; behind a 240px rail they would be 103px, which truncates most event titles.
- **Height is the scarcer axis, and only in Fully Kiosk is it 601px.** Anything built
  against the 433px Chrome figure wastes a third of the panel; anything that *requires*
  601px breaks the moment someone opens it in a normal browser to check something. Treat
  601 as the design target and 433 as the floor that must still be usable.

Photo derivatives are unaffected — they target the physical panel (§6), and 1280×800
scaled into a 961×601 CSS box at DPR 1.33 lands within a pixel of 1:1 at device
resolution, so §6's sizing is confirmed rather than changed.

### 2.5 AnyList has no official API

`kevdliu/anylist` is reverse-engineered, needs an AnyList email and password, and can
break without warning. It is the better of the two options — real-time `lists-update`
events, plus quantities and recipes that upstream `codetheweb/anylist` lacks.

**The household list is "My Grocery List".** AnyList accounts can hold several; the
adapter resolves that name to a list id once at sync and stores it as the `external_id` of
a `sources` row, so nothing downstream matches on a display name that someone could rename
from their phone.

Groceries go behind a strict adapter boundary. An outage degrades one card to a stale
badge, never the page.

**Because groceries are writable, this risk is higher than it was in v0.2.** A broken
library no longer just means stale data — it means someone standing in the kitchen cannot
add milk to the list. Mitigation is a local write queue (§6.1) so items are never lost,
only delayed.

### 2.6 Google OAuth expires refresh tokens in Testing mode

Refresh tokens for an app in "Testing" publishing status expire after seven days.
Set the consent screen to **"In Production"** — calendar scopes are sensitive, so an
unverified production app shows a warning screen once and caps at 100 users, which is
irrelevant here. Tokens then live indefinitely.

Only **one** OAuth grant is needed: `alex@example.com` already has all three personal
calendars plus everything else shared into it.

---

## 3. Architecture

```
   Google Calendar ──┐  poll 5m (syncToken)
   Todoist ──────────┤  poll 5m (sync_token)      ┌──────────────┐  SSE   ┌──────────┐
   AnyList ──────────┤  push (lists-update)  ───► │ Pi Zero 2 W  │ ─────► │ Android  │
   Open-Meteo ───────┘  poll 30m                  │ Node+SQLite  │        │ Tablet   │
                                                  └──────────────┘        └──────────┘
                                                     │        ▲
                                        SQLite backup│        │ CIFS ro
                                                     ▼        │
                                              ┌──────────────────┐
                                              │ NAS              │
                                              │ photo originals  │
                                              └──────────────────┘
```

The tablet holds no credentials and talks to nothing but the Pi. It receives state over
SSE and renders. In v1 it sends nothing back except PIN attempts and view changes.

### 3.1 No public ingress

Webhooks would need a public HTTPS endpoint and therefore `cloudflared` on a 463MB device
already sharing its memory with Pi-hole.
Both providers support cheap delta polling instead:

| Source | Mechanism | Cadence |
|---|---|---|
| Google Calendar | `events.list` with `syncToken` per calendar — deltas only | 5 min |
| Google Calendar | full windowed re-sync, re-anchoring the window | nightly 02:00 |
| Todoist | `/sync` with `sync_token` | 5 min |
| AnyList | library's `lists-update` listener | push |
| Open-Meteo | plain fetch, no key | 15 min |
| NAS photos | directory walk, mtime/size diff | nightly 03:00 |

#### Why Google Calendar needs two cadences, not one

Verified against the live account on 2026-08-22, because the documentation does not
settle either point.

**Google expands recurrence, not the Pi.** `events.list` with `singleEvents=true` returns
individual instances, and — contrary to a widely repeated claim — it still returns a
`nextSyncToken`. The token appears only on the *last* page, which is the likely origin of
reports that the two are incompatible. This matters more than it sounds: it hands Google
`EXDATE`, `RECURRENCE-ID` overrides for singly-edited occurrences, cancelled instances,
and DST-correct instance times. Expanding RRULEs on the Pi would mean owning all of that,
and it is the richest source of silent, wrong-by-one-hour calendar bugs there is. The
requirement in §8 is only that *the tablet* never evaluates an RRULE; nothing requires
the expansion to happen on our server rather than Google's.

**A sync token cannot carry a time window**, so the window does not roll. Sending
`timeMin` with a `syncToken` is rejected — *"Sync token cannot be used with other request
restrictions"* (HTTP 400). An initial sync may be windowed, but the token does not
remember the window, and the parameters cannot be restated. So if `timeMax` is pinned at
+12 months on the day of the first sync, month thirteen is never fetched and no
incremental sync will ever reveal it. **A periodic full sync is therefore structural, not
hygiene.** It runs nightly at 02:00 — inside quiet hours (§9.2), an hour before the photo
resize so the two memory spikes do not overlap — and re-anchors the window.

Incremental responses may contain instances outside the window (editing a long-running
recurring event can return far-future occurrences). They are filtered on write rather
than trusted, so the stored set always matches the window.

A `410 GONE` on an incremental call means the token has aged out; the only correct
recovery is to discard it and run the full sync early.

### 3.2 Networking

- **Tablet → Pi:** plain HTTP over LAN, `http://hearth.local:8080`. No TLS required —
  see §9 for why the tablet needs no secure context.
- **Admin and OAuth → Pi:** Tailscale Serve, giving real HTTPS on a `*.ts.net` hostname
  with no inbound firewall rules. `tailscaled` costs ~30MB, which is affordable where
  `cloudflared` is not. This exists solely so Google has a valid OAuth redirect URI and
  so settings are reachable from a phone.
- **Pi → NAS:** CIFS mount at `/mnt/nas`, credentials in `/etc/hearth/smb.cred` mode 0600.
  See §3.5 for what lives where.

### 3.3 Deployment

**Never build on the Pi.** Build on the Mac, ship artifacts:

```
npm run build
./scripts/deploy.sh     # rsync build/ to the Pi, restart the unit
```

systemd unit with `Restart=always`, `MemoryMax=224M`, and
`Environment=NODE_OPTIONS=--max-old-space-size=128` — sized in §2.1, not guessed. Expected
resident set is ~178MB: the heap plus roughly 50MB of V8 overhead.

**64-bit Raspberry Pi OS is required, and the reason is `better-sqlite3`, not Node.**
Node 22 does publish `linux-armv7l` builds, so 32-bit would run. `better-sqlite3` v13
bundles prebuilds for exactly eight targets and 32-bit ARM is not among them — its
`PREBUILD_ARCHS` is `['x64', 'arm64']` — and the package sets `"gypfile": false`, so npm
will not compile a fallback either. On `armv7l` the first database open throws
`MODULE_NOT_FOUND`. Pinning back to v12 would work (it ships a `linux-arm` prebuild) but
v12 predates the N-API migration, so its binary is welded to one Node ABI and its source
no longer compiles against current V8 — a frozen artifact, on a platform Node itself
dropped at v24. 64-bit avoids the whole class.

### 3.5 Storage layout

The NAS is mounted at `/mnt/nas` on the Pi.

```
/mnt/nas/hearth/
    pictures/          originals — the app NEVER writes here
    cache/             derivatives, written nightly — 1280×800 landscape, 640×800 portrait
    backups/           nightly SQLite dumps, 14 kept

/var/lib/hearth/                    ← on the Pi's SD card
    hearth.db          the live database
    fallback/          ~30 recent derivatives for when the NAS is away
```

The mount must be read-write for `cache/` and `backups/`, so the read-only mount from
v0.2 is replaced by an application rule: nothing under `pictures/` is ever opened for
writing, and that path is treated as immutable in code.

**The live database must not live on the NAS.** SQLite's locking depends on POSIX file
locks that CIFS and NFS do not implement faithfully; running a live database over a
network mount is a well-known route to a corrupted file, and this one holds the PIN
hashes and every provider's sync tokens. `hearth.db` stays on the Pi's SD card and is
*copied* to the NAS nightly with `VACUUM INTO`, which produces a consistent snapshot
without stopping the app.

That still gives the durability that motivated putting it on the NAS — the SD card can
die and the most that is lost is a day of sync tokens, which simply re-sync.

### 3.4 SD card longevity

Only SQLite and the application live on the SD card; photo derivatives live on the NAS
(§6). Use `journal_mode=WAL` and `synchronous=NORMAL`, batch each sync into one
transaction, never write per-event, and skip writes when a delta produces no change. Set
journald to `Storage=volatile` and mount `/tmp` as tmpfs. Back up the database to the NAS
nightly.

---

## 4. Calendars

Read from the live account. Fifteen calendars, of which two must be excluded.

**The matrix below is a seed, not a fixture.** Alex configures it — the settings screen
in phase 3 edits the `visibility` table directly, so any of these can change without a
deploy. What follows is only a sensible starting point.

| Calendar | ID | Alex | Dana | Sam |
|---|---|:-:|:-:|:-:|
| Alex | `alex@example.com` | ● | ● | ● |
| Dana | `dana@example.com` | ● | ● | ● |
| Sam | `sam@example.com` | ● | ● | ● |
| Family | `family0218…@group` | ● | ● | ● |
| Joint | `joint@example.com` | ● | ● | ● |
| Visitors | `ljdcq3hn…@group` | ● | ● | ● |
| Other people | `cn9lramk…@group` | ● | ● | ○ |
| Holidays in Canada | `en.canadian#holiday` | ● | ● | ● |
| Culture calendar | `t6umnds9…@group` | ● | ● | ● |
| Football (Arsenal, Barcelona, Inter, Inter Miami) | 4 feeds | ● | ○ | ○ |
| ~~Todoist~~ | `l1krleul…@group` | ✕ | ✕ | ✕ |
| ~~Weather for Springfield~~ | `bgo27o84…@import` | ✕ | ✕ | ✕ |

● visible · ○ hidden by default · ✕ excluded entirely

**Two exclusions, both deliberate:**

- **Todoist calendar.** Todoist's calendar-sync feature writes tasks into a Google
  calendar. Rendering both it and the Todoist panel would show every task twice.
- **Weather for Springfield.** An ICS weather feed, redundant with Open-Meteo and far less
  useful than a live reading.

**Four football feeds are grouped under one "Football" label for the settings/visibility
matrix (§7.5) only** — Alex toggles all four as one row rather than four — **not for
colour.** Each team keeps its own Google colour on the actual display. Collapsing them
onto one shared colour was tried in an earlier revision of this document and reversed:
the space-saving reasoning was written for an older sidebar-style layout, but the week
view that actually shipped (§7.3) shows every match as its own full event with its own
title, so unifying the colour only cost the ability to tell Arsenal from Barcelona at a
glance, for no remaining space benefit.

**Colours** come from `calendarList.list`, which returns `backgroundColor` per calendar.
Existing Google colours are used as-is; nothing to configure by hand.

**Google's colours are not unique, and two collisions are real and accepted.** Read from
the live account, `#d06b64` is both *Holidays in Canada* and *Barcelona*, and `#b99aff`
is both *Visitors* and *Inter Miami CF*. (`#16a765` is *Joint* and *Weather for
Springfield*, which is excluded anyway, so it never renders.) Both collisions involve a
football feed and were previously dodged by forcing the whole group onto Arsenal's unique
`#ff7537` — reversed along with the colour-unification above. Distinct per-team colour is
worth more than avoiding this collision; per-calendar colours are otherwise untouched.

Worth knowing for the theme work in phase 4: *Inter* is `#000000` and the excluded
*Todoist* calendar is `#ffffff`. Pure black and pure white chips disappear against one
end of the light/dark switch (§5.3). Todoist never renders (excluded), but *Inter* now
does — its own colour is no longer hidden inside the football group — so this is a live
concern for phase 4, not a dormant one.

### 4.1 Timezone normalisation

The account's calendars disagree about timezones — Family is `UTC`, the Culture calendar
is `America/Los_Angeles`, Dana's is `America/New_York`, Visitors is `Asia/Jerusalem`.
Left alone, all-day events land on the wrong day.

- Household timezone is **`America/Toronto`** — Springfield's zone — stored in settings.
  Open-Meteo is queried at **45.5, -75.5** with the same zone.
- **Timed events** store a UTC epoch and render in the household timezone.
- **All-day events** store a `YYYY-MM-DD` local date string, never an epoch. This is the
  actual fix; treating an all-day event as midnight-UTC is the classic off-by-one-day bug.

---

## 5. Access model

The kitchen is a semi-public room. v0.1 treated PINs as personalization; that was wrong
for this placement. **No household data is visible without a PIN, except the shared
grocery list** (§5.1).

```
        ┌──────────────────────────┐
        │  SCREENSAVER (family)    │ ◄── default resting state
        │  photos · clock · weather│
        │  groceries r/w           │     the one exception — §5.1
        └───────────┬──────────────┘
                    │ tap                          ▲
                    ▼                              │ idle 2 min
        ┌──────────────────────────┐               │
        │  LOCK                    │               │
        │  Alex  Dana  Sam     │               │
        │  [ Guest mode ]          │               │
        └─────┬──────────────┬─────┘               │
              │ avatar + PIN │ Guest               │
              ▼              ▼                     │
   ┌────────────────────┐  ┌──────────────────┐    │
   │ SESSION(user)      │  │ SCREENSAVER      │    │
   │ calendar           │  │ (guest)          │────┘
   │ groceries r/w      ├──┘ Picsum           │
   └────────────────────┘    no household data
```

Everything but groceries sits behind one gate.

- **Resting state is the family screensaver** — photos, clock, date, weather, and (§5.1)
  a groceries button. No events, no calendars, no names.
- **Tap** wakes the lock screen: three avatars and a Guest button. Still no calendar data.
- **Avatar → PIN → session.** The session shows only that person's visible calendars.
- **Guest mode is sticky, durably.** It swaps the screensaver to Picsum and stays there
  until someone enters a PIN, so family photos are not on display while visitors are over
  — and the groceries button disappears too (§5.1), so a visitor sitting through guest
  mode gets nothing. Which mode is active is settings-table-backed, not in-process memory
  (`screensaverPublisher.ts`'s `getActiveScreensaverMode`/`setActiveScreensaverMode`) — a
  guest staying the week must not need Guest mode re-selected after every deploy or crash
  restart.
- **Idle for two minutes** ends the session and returns to the screensaver.
- Five wrong PINs triggers a 60-second lockout.

### 5.1 Groceries are PIN-free from the screensaver

v0.3 proposed a PIN-free `+ Groceries` button on the lock screen; that was rejected in
favor of putting groceries behind the PIN like everything else, to keep the access model
simple. That decision is now reversed: **groceries is reachable straight from the resting
screensaver, no tap or PIN required.** It's a shared household list, not per-person data
like calendars or tasks, so the single-gate argument that motivated keeping it behind the
PIN doesn't actually apply to it the way it does to everything else.

- The button lives on the **screensaver**, not the lock screen — reachable at rest, before
  even tapping to wake.
- It shows only in **`family` mode** (`screensaverPublisher.ts`'s `activeScreensaverMode`).
  **Guest mode hides it entirely** — same cookie-driven flag that already swaps the photo
  source to Picsum, so a visitor sees neither photos nor groceries.
  `canAccessPinFreeFeature` (`lib/server/auth/session.ts`, renamed from `canWriteGroceries`
  once phase 7's music button started sharing it) is the corresponding gate on the write
  endpoints: any request without a session is allowed unless guest mode is active.
  Everyone with a session can also still read/write it, same as before — this only adds a
  PIN-free path on top, not a restriction.
- **Music (phase 7) deliberately does *not* share this gate**, unlike groceries — reversed
  from the original phase 7 design, which did use the same guest-excluded gate. It's
  visible and fully controllable in guest mode too: a visitor can browse playlists, pick a
  song, and change which speaker it plays on, with no PIN. The reasoning that exempted
  groceries applies even more directly here — which speaker plays what is shared household
  routing, not data a visitor shouldn't see — and unlike groceries, a guest changing the
  music has no lasting effect worth gating behind a PIN. `screensaverPublisher.ts`'s
  `musicFolders`/`musicSpeakers` are populated regardless of mode (only music-hours/quiet-
  hours still hide them), and none of the `/api/music/*` routes check
  `canAccessPinFreeFeature` at all. Playback itself is a single household-wide singleton
  with no session affinity (`googleCast/playbackSession.ts`), so whatever's playing
  continues unaffected across a guest ↔ family transition — nothing in login/guest/logout
  ever touches it.
- A signed-in session no longer has its own groceries button in the header — the
  screensaver's button is the one consolidated entry point, session or not.

### 5.2 Sam's simple view, specified

Sam is a young child. A week grid is a scheduling tool for someone managing commitments;
a young child wants to know **what they have to do and when**. So `view_mode = 'simple'`
on their user row selects a different layout from the same data — not a separate code
path, not a separate app.

Top to bottom:

1. **Date header.** "Wednesday" set large, "August 21" beneath. No week number, no grid.
2. **Next up.** The single next event, occupying roughly a third of the screen: title,
   time, and a relative phrase — "in 2 hours", "at 4:30", "now". A colour bar from the
   owning calendar. This is the one thing they came to the tablet for.
3. **Rest of today.** Up to four more rows, each `time · title · colour dot`, with rows
   at least 64px tall.
4. **Tomorrow.** A single compressed muted line — "Tomorrow · Swimming 5:00 · Piano 6:30"
   — so they know to pack a bag tonight.
5. **Groceries.** A full-width button at the bottom. They can add to the list like anyone
   else.

Empty state is plain: "Nothing scheduled today." When tomorrow is also empty, it pairs
with a second muted line reaching further into the week — "Next: Friday · Piano 5:00" —
so the display doesn't go blank for days at a time just because nothing is happening in
the next 48 hours.

Type runs about 1.6× the standard view and touch targets are at least 56px. Their visible
sources are their own calendar, Family, Joint, Visitors, Holidays and Culture calendar — no "Other
people", no football.

They keep a PIN. A young child will happily tell a friend what it is, which is fine — the
threat model here is casual visitors, not adversaries.

### 5.3 The interface follows the sun

A bright white 8" panel is a nightlight in a kitchen people walk through at night, and a
dark one is hard to read in a sunlit room at noon. So the theme is not a fixed choice —
it tracks sunrise and sunset.

- **Computed locally** with `suncalc` from the pinned coordinates (45.5, -75.5).
  No network call: the theme must not depend on Open-Meteo being reachable, and an
  astronomical calculation is deterministic and works offline. Weather stays a separate
  concern.
- **The server owns the decision.** It emits `theme` in the SSE state, recomputed on the
  same ~60s tick as everything else rather than a separate timer for the next transition
  — see the v0.18 changelog note for why. The client stays dumb, and the behaviour is
  testable by feeding the calculation a date.
- **Crossfade over about two seconds.** An instant flip in a dark kitchen is unpleasant.
- **`theme_mode` setting** — `auto | light | dark`, default `auto`.
- **After sunset the screensaver dims photos to roughly 80% brightness**, which helps
  burn-in and stops the display dominating a dark room.

Springfield makes this more than cosmetic, because the winter case is extreme:

```
        00    03    06    09    12    15    18    21    24
21 Jun  ▓▓▓▓▓▓▓▓░░░│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│░░▓▓▓▓
                   ↑ 05:13 sunrise          20:54 ↑
21 Dec  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░│░░░░░░░░░░░░░░░│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
                       ↑ 07:39     16:21 ↑
        ██████████████                    ████████████████
        screen off (22:00–07:00)          screen off

        ░ light theme    ▓ dark theme    █ display off
```

On 21 December the sun sets at 16:21, so the display is dark-themed through the whole of
dinner and the evening. On 21 June it stays light until nearly bedtime. Both are right —
the point is that the panel matches the room it is in.

**Threat model, stated honestly:** this stops dinner guests and visiting relatives from
reading the family's schedule off the kitchen wall. It does not stop a determined attacker
who has physical access to the tablet, and a PIN typed in a kitchen is observable. That is
the right level of protection for the actual risk. PINs are argon2-hashed because they
will be reused from elsewhere.

---

## 6. Photo pipeline

Photos live at `/mnt/nas/hearth/pictures/`. The app walks that tree and never
writes to it. Guest mode's own library lives at a sibling directory,
`/mnt/nas/hearth/guest-pictures/` (`HEARTH_GUEST_PHOTOS_DIR`) — same pipeline,
same `photos` table, distinguished only by a `kind` column (`'family' | 'guest'`) so
neither library's rotation or pruning can ever see the other's rows, and so guest mode
can never show a family photo. Optional: an empty or missing guest folder just means
guest mode keeps falling back to Picsum (§7.4), the same as it always did.

**The resize runs in its own systemd unit, not in the server process** — a oneshot with
its own timer, the same shape as `hearth-backup.service` (§3.5). libvips works in
*off-heap* memory, so its 40–60MB peak counts against `MemoryMax` while being invisible to
`--max-old-space-size`; run in-process it would put the server within ~18MB of its ceiling
once a night, unattended. Split out, a resize that overruns restarts a batch job at 03:00
instead of killing the wall display. Its cap is `MemoryMax=192M` with a 64MB heap (§2.1).

The two caps deliberately sum above physical RAM. That is what a ceiling is: cgroup limits
bound usage, they do not reserve it, and the only moment both units are warm is 03:00 —
display off, nobody looking, zram absorbing the overlap.

Nightly at 03:00, single-threaded, `sharp.concurrency(1)`, `sharp.cache(false)`:

1. Walk the mounted share; diff against the `photos` table on `(path, mtime, size)`.
2. For each new or changed file, **apply the EXIF orientation before measuring anything**
   (`sharp().rotate()`), then size the derivative from the rotated aspect:
   - **Landscape** (width ≥ height) — `cover` to **1280×800**. One photo fills the panel.
   - **Portrait** (height > width) — `inside` **640×800**, no crop. Two of these sit side
     by side and together fill the same panel (§7.1). Cropping portraits to a fixed
     640×800 instead would take the crop out of the top and bottom of a 9:16 phone photo,
     which is where the faces are.

   Quality 82, mozjpeg, either way. libvips shrink-on-load decodes JPEGs at 1/2, 1/4 or
   1/8 scale directly, so peak memory stays around 40–60MB even for a 12MP source — which
   is what makes a 192MB cap at concurrency 1 survivable.
3. Record the derivative's `width`, `height` and `orientation` on the row, and compute a
   blurhash. Measuring before the rotation is applied is the specific bug this step exists
   to prevent: a phone portrait tagged orientation 6 reports landscape dimensions, so it
   would never be paired and would go to the panel full-bleed and on its side.
4. Write derivatives to `/mnt/nas/hearth/cache/` — **on the NAS**, not the SD
   card. They are ~60KB each; serving them over LAN CIFS is instant.
5. Keep the 30 most recently shown derivatives in `/var/lib/hearth/fallback/` so the
   screensaver still works if the NAS is unreachable. Portraits are kept there in pairs;
   half a slide is not a slide.

At display time the server streams a pre-sized file with a long cache header, and the
tablet preloads the next image so transitions never stutter. **Nothing is resized at
request time.**

**Format:** the library is all JPEG, confirmed. `sharp`'s prebuilt binaries handle that
natively with shrink-on-load, so no libvips rebuild and no conversion step. If HEIC ever
enters the library the pipeline will silently skip those files — worth a log line rather
than a silent drop.

### 6.1 The grocery write queue

Because groceries are writable and AnyList is the least reliable dependency, writes never
go straight through:

1. The mutation is written to a local `pending_writes` table and applied optimistically.
2. A worker drains the queue against the AnyList adapter with exponential backoff.
3. The UI shows a small pending mark on unsynced items; nothing is ever lost, only delayed.
4. On the next `lists-update` event, server state reconciles and the pending mark clears.

This is what makes an AnyList outage survivable rather than infuriating.

---

## 7. Screens

### 7.1 Screensaver — the resting state

Full-bleed photo cross-fading every 30s. Overlay carries the time set large, the date, and
the current temperature and condition. The overlay **drifts slowly around the screen**, a
few pixels per minute: static bright text held in one position for months causes image
retention on an LCD.

**A slide is not always one photo.** The panel is 1280×800 landscape and the library is
mixed, so a slide is either one **landscape** photo full bleed, or **two portrait** photos
shown side by side, each taking half the width:

```
   ┌──────────────────────────┐   ┌────────────┬─────────────┐
   │                          │   │            │             │
   │    landscape 1280×800    │   │  portrait  │  portrait   │
   │                          │   │   640×800  │   640×800   │
   └──────────────────────────┘   └────────────┴─────────────┘
```

A portrait alone on this panel is either letterboxed with two thirds of the screen empty
or cropped into a strip. Pairing avoids both, and two portraits from the same afternoon
read as a spread rather than an accident. What follows from that:

- **The server composes slides**, the same way it owns the theme (§5.3). The SSE payload
  carries either one photo or a pair; the client only cross-fades what it is handed.
- **Pairs prefer photos taken on the same day**, falling back to the next portrait in the
  shuffled queue when there is no same-day partner.
- **An odd portrait is held over rather than shown alone.** It becomes the first candidate
  of the next cycle, and the queue reshuffles each cycle, so nothing is starved.
- **Each half letterboxes against its own blurred backdrop**, expanded from the blurhash
  already on the row (§6). Phone portraits are narrower than 4:5, so some gutter is
  unavoidable; nothing extra has to be generated to fill it.
- **`shown_count` and `last_shown` update for both halves**, so a paired photo is not
  quietly favoured over a landscape one by the rotation.
- **The tablet preloads the whole next slide** — up to two files rather than one. 30s is
  plenty of time for ~120KB over LAN.

### 7.2 Lock

Three name chips in household colours — **Alex, Dana, Sam**, set in type rather than
photographs for now — a Guest button, and the same clock and weather. No event names, no
counts, nothing that leaks.

Avatar images are deferred; names are unambiguous on a three-person display and remove an
asset pipeline from v1. `users.avatar_path` exists for later.

### 7.2.1 Groceries

Opened from the screensaver's own button (§5.1) — no session required — or from inside a
session, both over the same overlay. The list, a text field, and a done button. Android's
on-screen keyboard handles input; items append optimistically through the write queue in
§6.1. Available to all three users, and to anyone at the screensaver outside guest mode.

### 7.3 Session

Default view is the week, which suits a kitchen glance and is the cheaper render (§2.4).
Calendars filtered by the `visibility` table, chips tinted by Google's own calendar
colours. Calendars are read-only; groceries are read/write for everyone. The week is the
default and only calendar view; there is no month grid, for the performance reason in
§2.4 and because a week is the right span for a kitchen.

**The rail is a strip along the top, not a column down the side.** v0.8 specified a right
rail; the measured 961px viewport (§2.4) cannot carry one and still leave seven legible
day columns — it would cut them from 137px to 103px, which truncates most event titles.
Laid horizontally the same content costs height instead, which there is comparatively
more of.

**The seven days roll forward from today; they are not a fixed Monday–Sunday block.**
The point of this screen is "what's coming up", and a calendar-week grid is mostly in the
past by Thursday or Friday — dead space on a display whose whole purpose is a forward
glance. Today is always the first column, tomorrow the second, and so on:

```
  ┌──────────────────────────────────────────────────┐
  │  Monday, Aug 24 · Next: Swimming 4:30             │  ~80px
  ├───────┬───────┬───────┬───────┬───────┬───────┬──┤
  │  Sat  │  Sun  │  Mon  │  Tue  │  Wed  │  Thu  │Fr│
  │ today │       │       │       │       │       │  │
  │ 137px │ 137px │ 137px │ 137px │ 137px │ 137px │  │  ~520px
  └───────┴───────┴───────┴───────┴───────┴───────┴──┘
                        961px
```

- The strip carries **the next event**, which is what a passing glance is actually for.
  Weather lives on the screensaver and lock screen (§7.1/§7.2) only — v0.19 dropped it from
  here, since repeating it competed with the next-event line for the same small strip
  without adding anything a glance at the calendar didn't already have its own moment for.
  Groceries no longer has a button here — it moved to the screensaver (§5.1), the one
  consolidated entry point whether or not a session is open. Todoist, for Alex only,
  joins the strip.
- **Day columns can be agenda lists or an hour grid — a toggle in the strip, not a design
  decision made once and fixed.** Agenda is the default: it costs less DOM (§2.4 — a time
  grid spends nodes on hours nobody has anything in) and reads faster at the ~137px column
  width. The hour grid trades that for showing the *shape* of a day — gaps, clustering,
  duration — bounded to 07:00–22:00, since the screen is dark outside that window anyway
  (§9.2). Which one earns its place is a real empirical question for this household's
  actual density, not something to settle by reasoning about it in the abstract, so both
  exist rather than picking one and hoping.
- **The hour grid does not lay overlapping events out side by side.** Checked against the
  live account and found real overlaps — a "Florence" block (5 hours) with
  "Schoolwork"/"Stretching" nested inside it, a same-slot "Kitowin"/"Dinner" pair — but
  that check ran before `visibility`-table filtering exists (§7.5, phase 3), so it saw
  every enabled calendar merged into one stream. That is strictly denser than what any
  actual session will show: each of Alex, Dana and Sam sees only their own configured
  subset, never the union of all three. Whether real per-user overlap is common enough to
  justify interval-graph collision layout is still open, and now specifically **needs
  re-checking once phase 3 filtering exists** — not before, and not by reasoning about it
  in the abstract.
- At ~44px a row, agenda's 520px of height shows about eleven events in a day; the grid
  must stay usable at the 433px floor either way, where roughly six agenda rows fit.
- There is deliberately no way to glance backward at this screen — yesterday and earlier
  simply scroll off. A record of what already happened is a different feature from a
  kitchen glance at what's ahead, and this screen is only the second one.

Users with `view_mode = 'simple'` get the layout specified in §5.2 instead.

### 7.4 Guest mode

Sources from `HEARTH_GUEST_PHOTOS_DIR` when it has anything scanned into it — a curated,
guest-appropriate library on the NAS, same pipeline as family photos (§6), same clock,
date and weather overlay. Falls back to Picsum (picsum.photos — see the v0.17 changelog
note for why, not Unsplash) when that library is empty or hasn't been created: no key, no
attribution, no download-tracking ping — the server just hands the client a seeded Picsum
URL directly, nothing proxied or cached locally the way real photos are. Sticky until a
PIN is entered.

### 7.5 Settings

The **visibility matrix editor** lives here — Alex picks which calendars each person
sees, per §4. Also connection status, screensaver timing, `theme_mode`, `quiet_hours`,
and PINs.

Reachable two ways: from a phone over Tailscale, and from the tablet inside Alex's
session behind their PIN. The phone is the better place to do the initial configuration —
editing a 12×3 matrix on an 8.7" panel with a finger is not pleasant.

---

## 8. Data model

```sql
CREATE TABLE users (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,          -- Alex | Dana | Sam
  color               TEXT NOT NULL,
  avatar_path         TEXT,
  pin_hash            TEXT NOT NULL,          -- argon2id
  view_mode           TEXT NOT NULL DEFAULT 'standard',  -- standard | simple (Sam)
  sort_order          INTEGER NOT NULL DEFAULT 0,
  is_admin            INTEGER NOT NULL DEFAULT 0,  -- can reach the settings screen, §7.5
  failed_pin_attempts INTEGER NOT NULL DEFAULT 0,  -- §5's five-strikes lockout
  locked_until        INTEGER                      -- epoch ms; NULL when not locked out
);

-- A logged-in tablet session (§5: avatar + PIN -> session). Added v0.13; no equivalent
-- existed before Phase 3 needed idle-timeout/lockout state to survive a page load.
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,     -- opaque token, also the session cookie's value
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,     -- drives the 2-minute idle timeout
  expires_at    INTEGER NOT NULL      -- hard cap independent of idle-timeout; created_at + 12h
);

-- Grocery writes are queued, never applied straight through. See §6.1.
CREATE TABLE pending_writes (
  id          INTEGER PRIMARY KEY,
  source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,          -- add | check | uncheck | remove
  payload     TEXT NOT NULL,          -- json
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE connections (
  id           INTEGER PRIMARY KEY,
  provider     TEXT NOT NULL,         -- google | todoist | anylist | unsplash
  label        TEXT NOT NULL,
  secrets      BLOB NOT NULL,         -- AES-256-GCM, key from env
  status       TEXT NOT NULL DEFAULT 'ok',
  last_success INTEGER,
  last_error   TEXT
);

CREATE TABLE sources (
  id            INTEGER PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,        -- calendar | tasks | groceries
  external_id   TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  color         TEXT,                 -- from calendarList.backgroundColor
  group_label   TEXT,                 -- e.g. 'Football' collapses four feeds
  sync_token    TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  UNIQUE (connection_id, external_id)
);

CREATE TABLE visibility (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  visible   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, source_id)
);

CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  starts_at  INTEGER,                 -- UTC epoch; NULL for all-day
  ends_at    INTEGER,
  local_date TEXT,                    -- 'YYYY-MM-DD' for all-day; NULL otherwise
  local_end_date TEXT,                -- inclusive last day of an all-day span; see below
  all_day    INTEGER NOT NULL DEFAULT 0,
  location   TEXT,
  status     TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX events_window ON events (starts_at, ends_at);
CREATE INDEX events_allday ON events (local_date, local_end_date);

CREATE TABLE list_items (
  id         TEXT PRIMARY KEY,
  source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  quantity   TEXT,
  category   TEXT,
  checked    INTEGER NOT NULL DEFAULT 0,
  due_at     INTEGER,
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE photos (
  id          INTEGER PRIMARY KEY,
  source_path TEXT NOT NULL UNIQUE,   -- path on the NAS share
  mtime       INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  cached_path TEXT NOT NULL,          -- derivative in cache/
  width       INTEGER NOT NULL,       -- of the derivative, after EXIF rotation
  height      INTEGER NOT NULL,
  orientation TEXT NOT NULL,          -- 'landscape' | 'portrait' — square is landscape
  blur_hash   TEXT,
  taken_at    INTEGER,
  shown_count INTEGER NOT NULL DEFAULT 0,
  last_shown  INTEGER
);

CREATE INDEX photos_rotation ON photos(orientation, last_shown);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Recurring events are stored as individual instances across a rolling window — one month
back, twelve forward — so the tablet never evaluates an RRULE. Google does the expanding
(`singleEvents=true`), which is why no RRULE column exists here; see §3.1 for why that is
both allowed and strongly preferable to expanding them on the Pi.

**`local_end_date` is inclusive, and Google's is not.** An all-day event needs a span, or
a five-day vacation renders only on the day it starts — the live account has nineteen
such events in the current window, including an eleven-day one. Google reports the end of
an all-day event *exclusively*: a single-day event on the 21st comes back with
`end.date` of the 22nd. That is converted exactly once, on the way in, so nothing
downstream has to remember it. A single-day event therefore stores the same value in both
columns, and a range query is the plain `local_date <= end AND local_end_date >= start`.

---

## 9. Tablet

An **8" Android tablet (2019-era)** — 1280×800, Snapdragon 429, 2GB, Android 11 with
current Chrome. See §2.4; it is the binding constraint on the frontend.

**The CSS viewport was 961 × 601 in Fully Kiosk, 961 × 433 in Chrome with its bars** — DPR
1.33125, measured on the device (§2.4). Not re-measured against Free Kiosk's own
fullscreen mode after the 2026-08-26 switch (§9.1) — its single-toggle Fullscreen could
plausibly hide chrome slightly differently than Fully Kiosk's three separate switches did.
Layout targets CSS pixels and is built fluid across **960–1340px** specifically so a small
viewport discrepancy like this doesn't require a layout change either way; photo
derivatives target the panel's physical 1280×800, unaffected regardless.

### 9.1 Kiosk setup, at no cost

**Free Kiosk** (`RushB-fr/freekiosk`, open-source, MIT-licensed, no paid tier at all —
switched 2026-08-26 from Fully Kiosk, which this section described until then). Provides:

- Launch on Boot
- Fullscreen, one combined toggle (no separate status/nav/action-bar switches the way
  Fully Kiosk had)
- Reload on Error (deploy/README.md §11)
- "Return to Start Page on Inactivity" — the nightly-reload substitute (see §9.2)
- **A real Sleep Schedule** (§9.2) — free here, unlike Fully Kiosk's equivalent, which
  turned out to be PLUS-only and was never purchased.
- A REST API (`/api/screen/on`, `/api/screen/off`, `/api/brightness`, `/api/reload`, and
  more) that genuinely can drive the tablet's screen from Hearth's own server — unlike
  Fully Kiosk's free tier, which could not. **Not used, and no longer the obvious next
  step either:** the native Sleep Schedule above already gets real screen-off on a clock,
  without a new failure mode where the Pi has to reliably reach the tablet twice a day for
  it to work.

**Two things Fully Kiosk's free tier covered that Free Kiosk, checked directly against the
real app (2026-08-26), does not appear to:** a crash-relaunch equivalent (none found in
settings), and a reload specifically on network reconnect (only "Reload on Error" exists,
no separate network-reconnect trigger). Neither is confirmed impossible — only that they
weren't found in the settings screen — so treat both as open risks to watch for, not
settled facts. deploy/README.md §11 has the live detail.

Because no PWA install is needed, the app does not need a secure context, which is why
plain LAN HTTP is fine.

Also: a small JS bundle, and no animation beyond opacity fades.

### 9.2 Display schedule

**The backlight actually sleeps overnight now** — Free Kiosk's own Sleep Schedule, free
and set to 22:30–06:30, unlike Fully Kiosk's equivalent ("Schedule Wakeup and Sleep",
PLUS-only, never purchased — §9.1). `quiet_hours` (Settings, default `22:00-07:00`) is a
second, independent window, not synced to match:

- During `quiet_hours`, the screensaver switches to a plain night-clock view — no photos,
  no weather — dimmed to 40% opacity (`Screensaver.svelte`), so what's on screen is a
  soft, unobtrusive clock rather than a full-brightness photo screensaver, whether or not
  the tablet happens to be physically asleep at that exact moment.
- **The two windows are deliberately left offset**, not a bug: `quiet_hours` starts 30
  minutes before Sleep Schedule and ends 30 minutes after it, so there's a brief window on
  each side where the dimmed night-clock shows on an otherwise-still-awake (or
  just-woken) screen before/after the device's own sleep actually kicks in. Confirmed
  acceptable rather than something to keep in sync by hand — if that changes, either value
  is a one-line fix; the two don't depend on each other.
- **Free Kiosk's own screensaver is a separate, third thing** — dim style, 10% brightness,
  after 10 minutes of inactivity (deploy/README.md §11). Whether its timer only applies
  within the Sleep Schedule window or runs independently around the clock isn't confirmed;
  if the latter, it would also dim the display during ordinary daytime gaps in touch
  interaction, which matters for a glance-only wall display far more than it would for an
  interactive kiosk.
- **Motion-detection wake, considered and declined** — Free Kiosk supports it, using the
  tablet's own camera to detect presence, which was ruled out deliberately rather than
  something not yet gotten to: a camera continuously watching the kitchen isn't a decision
  to make by default.

The maintenance jobs still fall inside this window — the photo resize runs at 03:00 — but
the **nightly reload is not pinned to a fixed clock time**: deploy/README.md §11 uses Free
Kiosk's "Return to Start Page on Inactivity" instead, the same role Fully Kiosk's free-tier
Auto Reload on Idle played. On a 2GB tablet the reload itself is still load-bearing, not
hygiene; it's just guaranteed to land at least once during any night nobody's touched the
tablet for long enough, rather than at exactly 04:00.

---

## 10. Stack

| Layer | Choice | Reasoning |
|---|---|---|
| Runtime | Node 22 LTS arm64 | The AnyList library is Node-only |
| Framework | SvelteKit | Small client bundle; server routes host sync in-process |
| Database | SQLite + Drizzle | One file, no service to keep alive in 463MB shared with Pi-hole |
| Styling | Tailwind | Purged output is tiny |
| Images | sharp / libvips | shrink-on-load keeps peak memory survivable |
| Sun times | suncalc | Local, offline, deterministic — the theme must not depend on a network call |
| Process | systemd | Docker is not affordable here |
| Transport | SSE + POST | The tablet mostly receives; grocery mutations go back by POST |

---

## 11. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| AnyList library breaks | High | Groceries cannot be added | Write queue (§6.1) so nothing is lost; adapter isolation; stale badge |
| Tab A 8.0 too slow | Medium | Janky UI | <120KB JS, no blur/backdrop-filter, week view only, small DOM, nightly reload |
| Zero 2 W too slow | Medium | Sluggish sync | Nightly image work, derivatives on NAS; escalate to a Pi 4 |
| Hearth starves Pi-hole | Medium | **Household loses DNS** | Hard `MemoryMax=` on every Hearth unit; resize split out (§6); zram |
| Pi-hole grows into Hearth's budget | Low | OOM restarts | `database.maxDBdays=30` caps it; re-check after a week of normal use |
| ~~CSS viewport narrower than 1024px~~ | **Occurred** | Fluid range did not cover the panel | Measured at 961px; range moved to 960–1340px and the right rail became a top strip (§2.4, §7.3) |
| SD card wear-out | Low | Data loss | Only SQLite on card; WAL; nightly NAS backup |
| Screen burn-in | Medium | Permanent artifacts | Drifting overlay, dimmed night-clock view, nightly reload, and a real scheduled screen-off overnight (§9.1/§9.2) |
| PIN observed by a guest | Medium | Schedule visible | Accepted; see §5 threat model |
| OAuth refresh token loss | Low | Calendars stop | Production publishing status; alert card on failure |

---

## 12. Build phases

1. **Foundations** — repo, schema and migrations, systemd unit, zram, CIFS mount, deploy
   script, secret encryption, health endpoint. Ends with a Pi surviving a reboot.
2. **Calendar slice** — Google OAuth in production status, calendar discovery with
   colours, two-tier delta sync (§3.1), timezone normalisation, SSE, week view. Proves
   the hardest plumbing end to end. Recurrence expansion is no longer on this list: §3.1
   establishes that Google does it.
3. **Access model and configuration** — screensaver, lock screen, PIN entry, sessions,
   idle timeout, guest mode, Sam's simple view, and the **settings screen that edits the
   visibility matrix**. Early, because it is what makes the display usable in a kitchen at
   all, and because Alex needs to configure who sees what without a deploy.
4. **Screensaver and theme** — NAS walk, the two-shape resize pipeline in its **own
   systemd oneshot + timer** (§6), NAS-side cache, local fallback ring, slide composition
   with portrait pairing (§7.1), drifting clock/date/weather overlay, Open-Meteo
   (Springfield), Picsum for guest, and the sunrise/sunset theme switch. The UI shell from phase 2 should be built on
   tokens so this phase is a token swap rather than a rewrite.
5. **Groceries** — AnyList adapter with the write queue, in-session add and check-off for
   all three users. The first write path in the system.
6. **Todoist and polish** — Todoist for Alex via personal token, offline handling,
   Fully Kiosk schedule and reload configuration, backup verification. **Candidate:
   visual/layout regression testing** (e.g. Playwright screenshot diffing) — flagged after
   a real CSS grid-alignment bug in the hour grid (two stacked `grid-cols-7` rows dividing
   different available widths) shipped and was only caught by eye, twice, because nothing
   in this project's test suite can verify actual rendered layout — Vitest's jsdom
   environment has no real CSS layout engine, so `getBoundingClientRect()` returns zeros
   in it. Not a small addition (new tooling, not a unit test), so it belongs here rather
   than bolted onto whatever PR next touches CSS.

Phases 2 and 3 together are the first genuinely useful wall display. Phase 5 is the one
the household will actually use daily.

---

## 13. Open questions

1. **PIN values** — three four-digit PINs, set at first run rather than committed
   anywhere.

Resolved in v0.9: the tablet's CSS viewport is **961 × 601** in Fully Kiosk (961 × 433 in
Chrome with its bars) at **DPR 1.33125**, measured on the device. The fluid range moves to
**960–1340px**, and §7.3's right rail becomes a top strip because 961px cannot carry both
it and seven legible day columns.

Resolved in v0.8, all measured against the live account rather than inferred:
`singleEvents=true` **does** return a `syncToken` (on the last page), so **Google expands
recurrence** and the Pi never touches an RRULE; a sync token **cannot** carry
`timeMin`/`timeMax`, so the rolling window needs a **nightly full re-sync** to move;
Google's calendar colours **collide** (§4) — the football group forcing Arsenal's unique
`#ff7537` to resolve it was the v0.8 fix, later reversed in v0.12 in favour of distinct
per-team colours. The account has the expected fifteen calendars, with the
timezone spread §4.1 assumes — `UTC`, `America/New_York`, `Asia/Jerusalem`,
`America/Los_Angeles`. The probe is committed at
`src/lib/server/google/sync-probe.integration.test.ts` and re-runnable with
`HEARTH_PROBE=1` if Google's behaviour ever changes.

Resolved in v0.7: the board is **463MB, not 512MB**, and is **shared with Pi-hole
permanently**; `gpu_mem=16` reclaims 48MB; 64-bit is required for `better-sqlite3`, not
for Node; **Pi-hole's real footprint is ~186MB**, measured on the actual 64-bit install
with `database.maxDBdays=30`, leaving ~277MB for Hearth — worth another glance after a
week of normal use, but no longer blocking.

Resolved in v0.6: the tablet turned out to be the modern 16:10 panel with current Chrome
described in §2.4, so the 4:3 and old-Chrome risks are gone; the AnyList list is
**"My Grocery List"**.

Resolved since v0.3: groceries stay behind the PIN (reversed in v0.26 — §5.1); NAS paths are
`/mnt/nas/hearth/{pictures,cache,backups}`; the live database stays on the Pi;
weather is 45.5, -75.5; Todoist uses a personal token; avatars are names for now;
the calendar has one view and it is the week.
