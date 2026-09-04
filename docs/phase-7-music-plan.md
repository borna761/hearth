# Phase 7 — Music button: NAS-hosted MP3s cast directly to a speaker

## Context and what this replaces

The original ask was a PIN-free screensaver button, next to groceries, that browses
Spotify playlists and starts one playing on a chosen Google Home speaker. That design was
fully scoped and largely built on a since-shelved branch (`google-home-music-button`)
before being rejected: none of Spotify's or Google's APIs expose a "start playing this
content" action without either Spotify Premium (which the household doesn't have) or
standing up a self-hosted OAuth server behind a public Tailscale Funnel endpoint, plus a
hand-built Google Home Routine per speaker — infrastructure whose end effect would be no
richer than saying "Hey Google, play music on \<speaker\>" out loud. Alex reconsidered and
asked not to pursue it (2026-08-2x, paraphrased: *"the more I think about it, the less I
like this solution... it's basically just replacing 'hey google, play music on \[chosen
speaker\].'"*). That branch is preserved untouched, not deleted, in case any of its
research is useful later — this plan does not build on it.

Two things were checked and ruled out before landing on this design, so they don't get
proposed again:

- **A dedicated media server (Jellyfin) on the NAS.** Checked directly against
  this exact NAS model: no vendor Docker/app support, and the community Docker hack that
  exists has documented real breakage (containers crashing on startup, ARM `libseccomp`
  incompatibilities). Not a foundation worth building on.
- **Any media-server layer at all.** Unnecessary — Hearth already has direct filesystem
  access to the NAS mount (the same CIFS mount photos already use) and can serve files
  itself, the same way it already serves photos.

**The approved design:** the household's own MP3s, organized into folders on the NAS (one
folder = one playlist — confirmed workable with Alex, *"I can make that happen"*), served
directly by Hearth, cast straight to a chosen speaker or speaker group over the LAN using
the public, unauthenticated Chromecast (CASTV2) protocol. No Spotify, no Google Home API,
no OAuth, no public internet exposure — the Pi already talks to the NAS and to the tablet
over plain LAN HTTP; this adds one more LAN-only hop, to the speaker.

## 1. NAS access — env var, offline scan, never touched at request time

Same convention as `HEARTH_PHOTOS_DIR`: a new `HEARTH_MUSIC_DIR` env var (default
`/mnt/nas/hearth/music`), read only by a standalone script, never by the
SvelteKit app at request time.

`scripts/scan-music.mjs` mirrors `resize-photos.mjs`'s walk-and-diff shape, but simpler —
no image processing, no derived files, no ID3 tag parsing. The original NAS path *is* the
servable path; a track's title is just its filename minus extension. One level of folder
under `HEARTH_MUSIC_DIR` is one playlist; `walk()` only goes one directory deep (unlike
photos' fully recursive walk). Change detection reuses `diffPhotos` from
`scripts/lib/photo-diff.mjs` directly rather than duplicating it — its `(path, mtime,
size)` diff logic has nothing photo-specific about it. Deleting a folder on the NAS
cascades to prune its tracks (`music_tracks.folder_id` has `ON DELETE CASCADE`) on the
next scan. Runs nightly via `deploy/hearth-music-scan.timer`/`.service` (same shape as
`hearth-resize.*`, `RequiresMountsFor=/mnt/nas`, 03:00 window alongside photos/backup, but
lighter — `MemoryMax=64M` vs photos' 192M, since there's no image decode step), and on
demand via `npm run music:scan`.

## 2. Schema — two new tables, one migration

```ts
export const musicFolders = sqliteTable('music_folders', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	displayName: text('display_name').notNull(),
	folderPath: text('folder_path').notNull().unique()
});

export const musicTracks = sqliteTable('music_tracks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	folderId: integer('folder_id')
		.notNull()
		.references(() => musicFolders.id, { onDelete: 'cascade' }),
	sourcePath: text('source_path').notNull().unique(),
	mtime: integer('mtime', { mode: 'timestamp_ms' }).notNull(),
	size: integer('size').notNull(),
	title: text('title').notNull()
});

export const musicSpeakers = sqliteTable('music_speakers', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	castName: text('cast_name').notNull().unique()
});
```

`musicSpeakers` stores the Cast device's advertised friendly name, not a network address —
see §4 for why a static IP doesn't work for a speaker group. Track order within a folder
is plain alphabetical by title — no explicit position column; a household that wants manual
ordering already has numeric filename prefixes (`01 - Song.mp3`) available for free.
Migration: `drizzle/0008_loud_misty_knight.sql`.

## 3. Serving audio — genuinely new code, no existing pattern to copy

Unlike `api/photos/[id]/+server.ts`'s whole-file `readFile()`, a Cast receiver needs to
seek, so `src/routes/api/music/tracks/[id]/+server.ts` needs real HTTP range support — the
first genuinely new piece of infrastructure this phase adds (a repo-wide search confirmed
zero prior `Range`/`206`/`createReadStream` usage before this).

The range-parsing logic is a pure function, `src/lib/server/httpRange.ts`'s
`computeRange(rangeHeader, totalSize)`, tested independently of any real file or request:
no header → full `200` with `Accept-Ranges: bytes` (a receiver's first request often has
none); a mid-file `bytes=500-999` range → `206` with the correct `Content-Range`/
`Content-Length`; an open-ended `bytes=500-` range; a suffix `bytes=-100` range; and
out-of-bounds, malformed, or `start > end` ranges → `416`. The route itself just calls
`computeRange`, `stat()`s the file for its *live* size (not the cached DB value, in case
the file changed since the last scan), and streams the requested slice via
`fs.createReadStream(sourcePath, { start, end })` bridged to a Web `ReadableStream` via
`Readable.toWeb()`.

No session check on this route — same public-route reasoning `api/photos/[id]` already
documents (DESIGN.md §5/§6: household media served over plain LAN HTTP is already the
model for photos, and the household's own MP3s carry the same sensitivity level as its own
photos, not household calendar/task data). What *is* gated is triggering playback (§5) —
same split responsibility groceries already has between "the panel is PIN-free-but-not-
guest-gated" and "the underlying content isn't independently secret."

## 4. Casting, and why speaker groups need mDNS discovery instead of a static IP

An individual Chromecast/Nest speaker has a stable address a DHCP reservation can pin
down, the same way `hearth.local` is already pinned for this Pi. A Google Home **speaker
group** doesn't — its Cast identity is anchored to whichever member device is currently
acting as the group's leader, which can shift (e.g. on a reboot), so a statically
configured host would silently go stale. The fix used elsewhere (Home Assistant's own Cast
integration, among others): discover by the Cast device's **friendly name** — what shows
up in the Google Home app, for an individual speaker or a group alike — via mDNS, fresh on
every play request, rather than trusting a cached address. This works identically for
individual speakers and groups, so `musicSpeakers.castName` needs no special-casing for
either.

Two new dependencies, both pure JavaScript by dependency-tree inspection (no native
bindings, unlike the `@node-rs/argon2` failure CLAUDE.md documents), both still needing
the Pi smoke-test gate before anything is built on top of them:

- **`castv2-client`** — depends only on `castv2`, which itself depends only on
  `protobufjs` and `debug`. Uses Node's built-in `tls` module to talk to the device on
  port 8009, over the public, documented CASTV2 protocol.
- **`bonjour-service`** — depends only on `multicast-dns` and `fast-deep-equal`, UDP via
  Node's built-in `dgram`. Browses `_googlecast._tcp` mDNS records.

`src/lib/server/googleCast/discovery.ts` exports `resolveSpeakerHost(castName, options)`
and `discoverAllSpeakerNames(options)`, both wrapping `bonjour-service`'s
`Bonjour().find(...)` for a bounded window and both taking an injectable `createBrowser`
factory (mirroring this codebase's existing `fetchFn`-injection convention) so their
name-matching logic is unit-testable without real mDNS traffic. `IPV4_PATTERN` prefers an
IPv4 address when a device advertises both families.

`src/lib/server/googleCast/client.ts` exports `playFolderOnSpeaker(host, port, trackUrls,
options)`: connects, launches `DefaultMediaReceiver` (the universal, no-registration-needed
Chromecast receiver — nothing Spotify/YouTube-specific, nothing requiring authorization),
then calls `queueLoad` with every track in the folder as one ordered queue, so the whole
playlist plays through rather than just the first track. Always closes the client, success
or failure. `castv2-client` has no published types, so
`src/lib/server/googleCast/castv2-client.d.ts` declares only the slice of its API actually
used (`Client`, `DefaultMediaReceiver`), the same narrow-ambient-declaration pattern this
repo already uses for `anylist-lib.d.ts`.

**A real CVE surfaced and got fixed along the way, not just discovered:** installing these
two packages pulled in a critical arbitrary-code-execution vulnerability in `protobufjs`
(GHSA-xq3m-2v4x-88gg) via `castv2`'s dependency chain — the same vulnerable version was
already present separately via `anylist`. Fixed with a `package.json` `overrides` pin
(`"protobufjs": "^7.5.5"`, resolving to 7.6.6) rather than jumping to the latest major,
since an initial attempt at `^8.8.0` broke `castv2`'s real `proto.js` at runtime — verified
by reading `castv2/lib/client.js` and `castv2/lib/proto.js` directly and round-tripping a
real encode/decode, not just confirming the packages import cleanly. A parallel attempt to
also override a vulnerable `uuid` transitively pulled in by `anylist` was reverted after it
broke `anylist`'s own `require('uuid/v4')` subpath usage (removed in uuid v9+) — not worth
trading a moderate-severity issue for breaking groceries.

## 5. The play endpoint

`src/routes/api/music/play/+server.ts`, `POST { speakerId, folderId }`, gated by
`canAccessPinFreeFeature` (renamed from `canWriteGroceries` — same PIN-free-but-not-guest
justification now serves two features, "shared household data/action, not per-person").
Looks up the speaker's `castName` and the folder's tracks (ordered), calls
`resolveSpeakerHost(castName)` for the current host/port (a specific error — *"Can't find
\<name\> on the network right now"* — rather than a generic failure, if discovery times
out), builds each track's absolute stream URL from **the triggering request's own
`url.origin`** (the tablet and the target speaker are on the same LAN and already resolve
the same address, so no new "what's Hearth's own address" config is needed), then calls
`playFolderOnSpeaker`.

**Local-dev-only wrinkle found during live testing against a real speaker.** `url.origin`
is only correct when the browser reaches Hearth at an address other devices can resolve
too — true on the real Pi (`http://hearth.local:8080`), false when testing from the same
Mac that's running `vite dev` at `http://localhost:5173`: "localhost" means "myself" to
the Chromecast device, so `queueLoad` reports success but the device silently fails to
fetch the track. Fixed two ways, both dev-only: a new `HEARTH_STREAM_BASE_URL` env var
(`src/lib/server/musicStreamUrl.ts`'s `resolveStreamBaseUrl`) overrides just the stream
base without requiring the browser to stop using `localhost`; separately, `vite dev`
itself only binds to `localhost` by default (unlike the Pi's production `HOST=0.0.0.0`),
so reaching it at all from another device on the LAN needs `npm run dev -- --host`. Once
both were in place, a real MP3 played audibly on a real Google Home speaker end to end.

**Turned out not to be dev-only, and not fixable by just changing which address you
browse to.** adapter-node's `handler.js` sets `url.origin` from the `ORIGIN` env var
*unconditionally* whenever it's set (`base: origin || get_origin(req.headers)`) — so
`url.origin` inside `+server.ts` is always built from `ORIGIN`'s hostname, never from
whatever host/IP the browser actually used to reach the Pi. This Pi's hostname was never
changed from `raspberrypi.lan` (see CLAUDE.md) — a router-DNS name, not a real mDNS
`.local` one — and `ORIGIN=http://raspberrypi.lan:8080` is correctly set (SvelteKit needs
it for CSRF Origin checks). But Google Cast devices don't reliably resolve
`raspberrypi.lan`, so every track URL built from it is one the speaker can't fetch:
`queueLoad` reports success (that's just a control-channel command to the
already-mDNS-discovered speaker) but `playerState` sits in `IDLE` forever, having never
fetched anything — confirmed live, including that browsing straight to the Pi's IP address
doesn't change the served track URL at all, since `url.origin` doesn't come from the
request either way. Same failure mode as the `localhost` case above, just triggered by a
different address a Cast device can't reach rather than one that means "myself" to it.
`HEARTH_STREAM_BASE_URL` is the fix in production too, precisely because it's the one
thing in this path that isn't derived from `ORIGIN` — set to the Pi's LAN IP in
`/etc/hearth/hearth.env`, not just a dev convenience; see `deploy/hearth.env.example`.

## 6. Screensaver plumbing — mirrors groceries, two real steps

`screensaverPublisher.ts`'s public SSE envelope gained `musicFolders`/`musicSpeakers`
(`{id, displayName}[] | {id, castName}[] | null`), gated on `activeScreensaverMode ===
'family'` exactly like groceries — `null` in guest mode and quiet hours.
`Screensaver.svelte` gets a second circular icon button (a hand-drawn music-note SVG, not
an emoji — the same rendering/contrast lesson the groceries button's icon already
learned), positioned below the groceries button, and — unlike groceries, which shows even
when its list is empty — gated on **both lists being non-empty**, since an unconfigured
library or speaker list means there's nothing to do yet.

`MusicPanel.svelte` is a genuine two-step flow: tap the button → list of folders → tap a
folder → list of speakers → tap a speaker → `POST /api/music/play` → panel stays open with
transport controls visible, inline error on failure (with a back arrow to return to the
folder list). This was the original ask exactly — pick a playlist, then pick a speaker —
and was only a one-step design on the shelved Google Home branch because that design had
no real content to browse yet. The sidebar itself (shared chrome with `GroceryPanel`/
`TasksPanel`) is translucent (`bg-white/70` / `dark:bg-slate-900/70` with a
`backdrop-blur-sm`) rather than solid, at Alex's request, so the screensaver photo behind
it stays visible.

## 6b. Shuffle-by-default, and transport controls (play/pause/next)

Two follow-up requests once the base flow was live-tested: tracks were playing in
alphabetical order (`listTracksInFolder`'s stable browsing order — fine for finding a
folder, not for how it should actually play), and there was no way to pause, resume, or
skip once something started.

**Shuffle.** The play route now shuffles the track list (Fisher–Yates, `Math.random`)
before building stream URLs, so a folder plays in a different order each time. The shuffle
function itself moved out of `photos.ts` (which already had an identical private
`shuffle<T>` for slide rotation) into a shared `src/lib/server/shuffle.ts` rather than
duplicating it — the same "don't duplicate generic logic" call this repo already made for
`diffPhotos`.

**Transport controls needed a real architectural change first.** The original
`playFolderOnSpeaker` closed its Cast connection immediately after `queueLoad` succeeded —
correct for "fire a queue and forget," useless for "pause the thing that's currently
playing," since there was no live connection left to send that command to. It now stays
connected on success (only closing on failure) and returns `{ client, player }` to the
caller.

**`src/lib/server/googleCast/playbackSession.ts`** holds the one active session in module
scope — the same in-memory-singleton pattern this codebase already uses for other
single-tablet state (`screensaverPublisher.ts`'s `activeScreensaverMode`,
`state/publisher.ts`'s `activeSessionToken`), rather than persisting it to the database.
Confirmed with Alex as an acceptable tradeoff: a server restart mid-playback loses this
state the same way the speaker itself would lose it on a power cycle, and surviving a
restart would need meaningfully more work (persisting connection/session identifiers and
re-attaching to a live Cast session, which doesn't always survive a sender reconnect
cleanly anyway) for a home-dashboard feature that doesn't need it. Starting a new session
closes whatever was playing before — only one thing plays at a time, same "no per-user
concept, one shared household state" model as groceries/tasks. It also subscribes to the
player's own `status` events (`MEDIA_STATUS` broadcasts from the device) to track
`playerState`, guarded against a stale event from an already-replaced player still writing
into the session that superseded it.

**Two new endpoints**, both operating on `getPlaybackSession()` rather than trusting
anything the client claims about current state, and both clearing the session (rather than
leaving a dead connection registered) if the underlying command errors:

- `POST /api/music/toggle` — a single toggle rather than separate play/pause endpoints,
  since the button only ever needs to do the opposite of whatever the session's own
  last-known `playerState` says (`playbackAction.ts`'s `nextToggleAction`, a tiny pure
  function: `PLAYING` → `pause`, anything else → `play`). Deciding from server-side state
  rather than client-side "what does the UI currently show" keeps it correct even if
  playback was paused/resumed from outside Hearth (the Google Home app, directly).
- `POST /api/music/next` — `player.queueUpdate([], { jump: 1 }, ...)`. Checked directly
  against `node_modules/castv2-client/lib/controllers/media.js`: the library has no
  dedicated `next()`/`previous()` method at all; `queueUpdate`'s `jump` option (skip or go
  back N items) is CASTV2's own documented mechanism for it.
- `GET /api/music/status` — lets the panel show correct controls when it's (re)opened,
  reading the in-memory session directly (no network round-trip to the device). Fetched
  once when the panel opens and refreshed optimistically after every action the panel
  itself takes; there's no periodic polling, so a state change from outside Hearth won't
  show up until the panel is reopened — an acceptable gap for a first version, revisit if
  it's actually annoying in practice.

`MusicPanel.svelte` gained a footer, shown only while `active` is true: previous/toggle/
next/stop buttons, a volume slider, the current track's progress bar, and the currently
playing track/folder for context.

## 6c. Repeat, volume, previous/stop, and reconnecting after a drop

Four more requests once the transport controls were live:

**Repeat.** A folder used to stop after its last (shuffled) track. `queueLoad`'s own
`options.repeatMode` (checked against `node_modules/castv2-client/lib/controllers/
media.js`: `REPEAT_OFF | REPEAT_ALL | REPEAT_SINGLE | REPEAT_ALL_AND_SHUFFLE`) is CASTV2's
built-in mechanism for this — `playFolderOnSpeaker` now always loads with `REPEAT_ALL`, so
the device loops the same (already client-shuffled) order rather than this app needing to
detect "the queue ended" and reload it itself.

**Volume.** Lives on the *connection* (`Client`/`PlatformSender`), not the media player —
confirmed via `node_modules/castv2-client/lib/senders/platform.js`: `Client` and
`PlatformSender` are literally the same export
(`module.exports.Client = module.exports.PlatformSender`), and `getVolume`/`setVolume`
are its own methods, calling through to `ReceiverController` (`lib/controllers/
receiver.js`). This is the speaker's actual hardware/Google-Home-app volume, shared by
whatever's playing — not a per-track property. `POST /api/music/volume` takes `{level}`
(0-1); the slider debounces to one request ~150ms after the last drag tick rather than
firing on every `input` event.

**Previous and stop.** `previous` reuses the same `queueUpdate({jump: -1})` mechanism as
`next` (extracted into a shared `skipQueue(jump)` in `playbackSession.ts`, since next and
previous are the same operation with an opposite sign). `stop` calls the media player's
own `stop()` and then always ends the session — unlike pause, there's nothing to resume,
so the connection is worth closing rather than left idle.

**Reconnect after a drop.** The first design considered listening for a `'close'` event on
the `Client` to detect an unexpected disconnect — checked directly against
`platform.js`'s `connect()` and found this doesn't hold: `PlatformSender` only uses `close`
internally for its own teardown bookkeeping and never re-emits it publicly. `'error'` is
the only externally visible signal, but it turns out to be the right one anyway: the
library's own built-in heartbeat mechanism (`HeartbeatController`) already converts a
silently-dead connection into an `'error'` ("Device timeout"), not just real socket
errors. `playbackSession.ts` now keeps listening for `'error'` after a session starts (not
just during the initial connect, which is all the original code did), and on the first
drop, re-resolves the speaker via mDNS (in case its address changed) and reloads the exact
same track queue from scratch — simpler than trying to persist and resume an exact
playback position, and consistent with "shuffle fires fresh on every explicit play" already
being the norm here. Capped at one automatic attempt per session: a speaker that keeps
dropping repeatedly is a real problem worth surfacing (the panel just goes back to
"nothing playing"), not something worth retrying forever against. `resolveSpeakerHost`/
`playFolderOnSpeaker` are injectable into `startPlaybackSession` for this — mirrors this
codebase's `createClient`/`createBrowser` convention elsewhere — so the reconnect path is
unit-tested against fakes rather than needing a real flaky connection to exercise it.

## 7. Settings

A new "Music" section, mirroring the existing sections' shape: a **"Scan for speakers"**
button (admin-only, `POST /api/settings/music-speakers/scan`) runs
`discoverAllSpeakerNames()` for a few seconds and lists every discovered Cast friendly
name — individual speakers and any groups already created in the Google Home app show up
identically, since both advertise over mDNS the same way. Each discovered name gets an Add
button (`POST /api/settings/music-speakers`); already-configured speakers list underneath
with a Remove button (`DELETE /api/settings/music-speakers/[id]`). This is a real
improvement over typing a name in blind — the household sees exactly what's discoverable.
Folder/playlist listing needs no settings UI at all; it's entirely driven by
`scan-music.mjs` populating `music_folders`/`music_tracks` from whatever's actually on the
NAS.

## 8. Pi verification (not yet run)

`scripts/cast-smoke.mjs` browses mDNS for a given Cast friendly name (proving
`bonjour-service` actually discovers real devices from the Pi's own network, not just that
it imports cleanly), connects, launches `DefaultMediaReceiver`, and plays the first track
in the already-scanned library — proving the full discovery → TLS handshake → protobuf
framing chain end to end. Worth running against both an individual speaker and an actual
group, since the group case is the one a static-IP approach would have gotten wrong.
Usage: `node --env-file=.env scripts/cast-smoke.mjs "<Cast friendly name>"`.

This step needs the real Pi, the real NAS mount, and real speakers, and has not been run
yet — it's the one piece of this phase's own verification checklist that can't be done
from a dev machine.

## Status

Implemented, unit-tested, and committed on branch `nas-music-button` (schema/migration,
`httpRange.ts`, `musicLibrary.ts`, `googleCast/discovery.ts` + `client.ts`, the
tracks/play routes, the screensaver plumbing, `MusicPanel.svelte`, and the settings
"Music" section) — full test suite and lint clean, PR opened.

**Verified live end to end from Alex's own Mac**, not yet the real Pi: real MP3s scanned
from the real NAS folder, a real Google Home speaker discovered and added via Settings,
and a real track played audibly by tapping the screensaver button — proving the entire
discovery → connect → queueLoad → stream chain works against real hardware, not just
mocks. Caught and fixed two real issues along the way: the `protobufjs`/AnyList regression
(§4) and the `localhost`-isn't-reachable-from-a-device wrinkle (§5), both only surfaced by
this live testing, not by the unit suite. What's left is Pi-specific, not functional: the
real deploy (`HEARTH_MUSIC_DIR` pointed at the actual NAS mount, `scan-music.mjs` and
`cast-smoke.mjs` run as the `hearth` user, the systemd timer) and a tap-through on the
actual tablet.

**A full multi-agent review (ultrareview) of the branch caught six real issues, all
fixed**, none of them functional regressions but worth recording since three were genuine
correctness gaps in code this plan already described as done:

- **Reconnect could tear down the very session it just recovered.** `attemptReconnect`
  swapped `session.client`/`session.player` in place without closing or unwiring the old
  connection first. A delayed event from that abandoned connection (its heartbeat firing
  once more, a queued status message) still passed the `current === session` guard, since
  `session` itself never changed identity — only its `client`/`player` fields did. Fixed by
  binding `wireConnection`'s listeners to the specific client/player instances active *at
  the time of wiring* (`session.client === boundClient`, not just `current === session`),
  and by explicitly closing the old connection before the swap.
- **A stale action could kill a newer session.** `stopPlayback`/`skipQueue`/
  `setPlaybackVolume` (and the toggle route) captured a `session` reference, then called
  the unconditional `clearPlaybackSession()` on their error paths — which acts on whatever
  `current` points to *now*, not the session that was captured. If a new session started
  while an old command was still in flight, its late response could close the new
  connection instead. Fixed by reusing the same `abandonSession(session)` guard the
  reconnect path already had (`if (current !== session) return` before touching anything).
- **A lost device response hung the request forever.** None of the awaited castv2-client
  callbacks had a timeout — if a reply never arrived, the promise never resolved. Added a
  shared `raceCallback` helper (5s timeout) used everywhere a device callback is awaited.
- **`backdrop-blur-sm` on the three side panels violated DESIGN.md §2.4** ("no
  backdrop-filter, no blur, on scrolling content" — this exact hardware's performance
  budget). `Screensaver.svelte`'s own photo overlay already follows this rule; the panels'
  translucency missed it. Removed the blur, kept the flat `bg-white/70` translucency alone.
- **The music button's position assumed groceries is always present.** Hardcoded
  `top-24` assumed the groceries button always sits directly above it; when AnyList is
  disconnected but music is configured, that left a phantom gap. Now derived from whether
  the music button (which moved above groceries, per Alex's ask) is actually showing.
- **DESIGN.md still named the pre-rename `canWriteGroceries`.** Updated both references
  to `canAccessPinFreeFeature`, noting the music button now shares the same gate.

The toggle endpoint's logic also moved from the route into `playbackSession.ts` as
`togglePlayback()` during this pass, so it shares the same timeout and stale-session guards
as every other action instead of duplicating (and, it turned out, not quite replicating)
them inline.
