# Pi setup

One-time steps to get a Raspberry Pi Zero 2 W from a fresh Raspberry Pi OS install to
running Hearth under systemd, surviving a reboot. Run on the Pi unless noted otherwise.
Cross-reference: DESIGN.md §2.1 (zram), §3.5 (NAS + backups), §3.3 (deploy).

**Prerequisite:** Raspberry Pi OS Lite, **64-bit**. The Zero 2 W's Cortex-A53 supports it
despite the "Zero" name. The reason it is required is `better-sqlite3`, not Node — Node 22
does ship `linux-armv7l` builds, but better-sqlite3 v13 has no 32-bit ARM prebuild and
compiles no fallback, so the first database open on a 32-bit image throws
`MODULE_NOT_FOUND` (DESIGN.md §3.3).

```bash
uname -m         # must be aarch64, not armv7l
```

**This Pi also runs Pi-hole**, and the memory budget in DESIGN.md §2.1 assumes it. Nothing
below removes or reconfigures it, but the caps in `hearth.service` exist so that a Hearth
leak restarts Hearth rather than taking the household's DNS down.

**Every `hearth.local` below assumes the Pi's hostname is actually `hearth`** — set via
Raspberry Pi Imager's hostname preset, or `sudo raspi-config` → System Options →
Hostname. If this Pi already existed before Hearth entered the picture (e.g. it's shared
with other services, like the Pi-hole above), it most likely still has its original
hostname, and `hearth.local` won't resolve. Check first, from the Mac:

```bash
ping -c 1 hearth.local
```

If that fails, find what actually works — `ping <the-pi's-real-hostname>` for mDNS
(resolves as `<hostname>.local`), or try the bare hostname alone, since some routers
provide their own local DNS that resolves it as `<hostname>.lan` without mDNS at all —
then substitute that address everywhere `hearth.local` appears below: the `scp` and
`ssh-copy-id` commands, `HEARTH_HOST` when running `scripts/deploy.sh`, `ORIGIN` in step
6, and whatever URL you eventually point the tablet's browser at. All of those need to
agree on the same address. Either way, a DHCP reservation for the Pi's IP in your router
keeps it from changing later — relying on a hostname doesn't remove that need, since the
hostname-to-IP mapping still depends on it.

## 0. Get these files onto the Pi

Everything below reads a file from this `deploy/` directory at some point (fstab entries,
systemd units, credential templates), but `scripts/deploy.sh` never copies it there — it
only ships the built app (`build/`, `drizzle/`, `scripts/`, `node_modules`), not the
one-time setup files. From the Mac, in the repo root, before doing anything else on the
Pi:

```bash
scp -r deploy your-pi-user@hearth.local:~/
```

Then on the Pi, `cd ~` so the relative `deploy/...` paths in every step below resolve.

## 1. Reclaim the GPU split

The board reports 426MB of 512MB with the stock `gpu_mem=64`. On a headless Pi the floor is
16, which selects a cut-down firmware with no codecs or 3D — 48MB back, for nothing given
up. The whole budget in §2.1 assumes this is set.

```bash
grep -q '^gpu_mem=' /boot/firmware/config.txt || \
  sudo sh -c 'echo "gpu_mem=16" >> /boot/firmware/config.txt'
sudo reboot
free -h          # expect ~463Mi total, not ~426Mi
```

On Raspberry Pi OS older than Bookworm that path is `/boot/config.txt`.

## 2. Node 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # expect v22.x, arm64
```

## 3. The hearth user and directories

```bash
sudo useradd --system --create-home --shell /bin/bash hearth
sudo install -d -m 0755 -o hearth -g hearth /opt/hearth /opt/hearth/releases
sudo install -d -m 0755 -o hearth -g hearth /var/lib/hearth
sudo install -d -m 0700 -o hearth -g hearth /etc/hearth
```

**A real shell, not `nologin`.** `hearth` is the account `scripts/deploy.sh` SSHes into
(§7) to rsync releases, run migrations and restart the service — `nologin` refuses to exec
anything at all, which would fail the very first deploy. `--system` already keeps it out
of login managers and out of the interactive-user range; the actual privilege boundary is
the sudoers rule below, which grants exactly two commands and nothing else. A working
shell here doesn't widen that.

`/opt/hearth` holds deployed releases (§3.3); `/var/lib/hearth` holds the live SQLite
database, which must stay on the SD card, never the NAS (§3.5); `/etc/hearth` holds
secrets, mode 0700 so only `hearth` and root can read them.

## 4. zram swap (mandatory — §2.1)

Current Raspberry Pi OS Lite images ship this enabled by default. Verify before installing
anything:

```bash
swapon --show   # expect a /dev/zram0 line
zramctl         # expect ALGORITHM zstd
```

If both show up, there is nothing to do. Only if `swapon --show` comes back empty does
`deploy/zram-generator.conf` need installing as a fallback:

```bash
sudo apt install -y systemd-zram-generator
sudo cp deploy/zram-generator.conf /etc/systemd/zram-generator.conf
sudo systemctl daemon-reload
sudo systemctl start systemd-zram-setup@zram0.service
swapon --show   # confirm a zram0 device appears
```

## 5. CIFS mount to the NAS (§3.5)

```bash
sudo apt install -y cifs-utils
sudo install -m 0600 deploy/smb.cred.example /etc/hearth/smb.cred
sudo nano /etc/hearth/smb.cred   # fill in the real username/password
sudo mkdir -p /mnt/nas
```

`deploy/fstab.snippet` has one line to add to `/etc/fstab` — the file listing what mounts
at boot — with two placeholders to fill in first:

- **`NAS_HOST`** — the My Cloud's hostname or IP on your LAN (check your router's device
  list, or the My Cloud dashboard).
- **`SHARE_NAME`** — the SMB share on the My Cloud that contains `hearth/`,
  named whatever you called it when you set up shares in the My Cloud dashboard. If
  you're not sure, list what the NAS actually exposes:
  ```bash
  sudo apt install -y smbclient
  smbclient -L //NAS_HOST -U the-username-from-smb.cred
  ```

With both filled in, append the line to the end of `/etc/fstab` (the existing entries for
the SD card's root filesystem and boot partition stay — this only adds a line, it doesn't
replace the file):

```bash
sudo nano /etc/fstab
# arrow keys to the bottom, paste the edited line from deploy/fstab.snippet, then
# Ctrl+O, Enter to save, Ctrl+X to exit
```

Then test it before rebooting on it — `nofail` in that line keeps a bad entry from
hanging the boot, but better to catch a typo now:

```bash
sudo mount -a
ls /mnt/nas   # confirm the share is visible
sudo mkdir -p /mnt/nas/hearth/cache /mnt/nas/hearth/backups
sudo chown hearth:hearth /mnt/nas/hearth/cache /mnt/nas/hearth/backups
```

**If `mount -a` fails with `mount error(95): Operation not supported`**, check `dmesg |
tail -20` — a NAS confirmed this is an SMB dialect mismatch (`Dialect not
supported by server. Consider specifying vers=1.0 or vers=2.0`), which `deploy/fstab.snippet`
now defaults to `vers=2.0` for. If you're mounting against different NAS hardware and hit
the same error, test a few `vers=` values directly first:
`sudo mount -t cifs //HOST/SHARE /mnt/nas -o credentials=/etc/hearth/smb.cred,vers=X.X`,
before editing `/etc/fstab` to match whichever works.

`pictures/` should already exist on the NAS from however photos get uploaded there —
the app only ever reads it (§6).

## 6. Secrets and config

```bash
sudo install -m 0600 -o hearth -g hearth deploy/hearth.env.example /etc/hearth/hearth.env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
sudo nano /etc/hearth/hearth.env   # paste the key into SECRETS_KEY, review the rest
```

Back the `SECRETS_KEY` value up somewhere off the Pi — losing it makes every stored
OAuth/AnyList credential unrecoverable (it does **not** live in git).

## 7. SSH access for scripts/deploy.sh

From the Mac:

```bash
ssh-copy-id hearth@hearth.local   # or hearth@<pi-ip> before mDNS is confirmed working
```

Then on the Pi, allow that account to restart its own service without a login password:

```bash
sudo install -m 0440 deploy/sudoers-hearth-deploy /etc/sudoers.d/hearth-deploy
sudo visudo -c
```

## 8. systemd units

`deploy.sh` ships the whole `deploy/` folder on every release, so once at least one
deploy has happened these unit files already exist at `/opt/hearth/current/deploy/` on
the Pi itself — no separate copy from the Mac needed. Installing and enabling a unit is
still a deliberate one-time step per unit, not something a deploy does automatically:

```bash
cd /opt/hearth/current
sudo cp deploy/hearth.service deploy/hearth-backup.service deploy/hearth-backup.timer \
	deploy/hearth-resize.service deploy/hearth-resize.timer \
	deploy/hearth-music-scan.service deploy/hearth-music-scan.timer \
	/etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hearth-backup.timer
sudo systemctl enable --now hearth-resize.timer
sudo systemctl enable --now hearth-music-scan.timer
```

Don't `enable hearth.service` yet — it has nothing to run until the first deploy.

To run the photo resize or music scan on demand instead of waiting for 03:00 (first
setup, or after adding photos/music to the NAS):

```bash
sudo systemctl start hearth-resize.service
journalctl -u hearth-resize.service -f

sudo systemctl start hearth-music-scan.service
journalctl -u hearth-music-scan.service -f
```

### 8.1 Bulk backfill from another machine

The nightly job is fine at handling a small delta of new/changed photos, but a large
first-run backfill (hundreds of photos in one go) is real sustained load — CPU, NAS I/O,
and local SD card writes all at once — for a single-core-constrained Pi Zero 2 W that's
also serving DNS for the household (§2.1). If that's proving unreliable, the CPU-heavy
work can run on any other machine on the LAN instead — the Mac used for deploys, say —
and the result merged into the Pi's live database afterward as a separate, safe step.

**Never point `DATABASE_URL` at the live `hearth.db` over a network mount** — §3.5 is
explicit that SQLite's locking doesn't work reliably over CIFS/NFS, and this file holds
real session/PIN/sync-token data, not just photos. The recipe below only ever writes to
the live file locally, on the Pi itself, via the merge script — never remotely.

1. **Mount the NAS share on the other machine.** It does _not_ need to be at the same
   path the Pi uses — macOS in particular can't mount anything at `/mnt` at all (its root
   filesystem is read-only), so this isn't optional there. Any writable local path works;
   step 4's merge corrects the difference.
   ```bash
   mkdir -p ~/nas-mount
   mount_smbfs //USERNAME@NAS_HOST/SHARE_NAME ~/nas-mount   # macOS
   ```
2. **Migrate a fresh, empty scratch database** — not a copy of the Pi's live one, just
   the schema, since the merge step only ever reads the `photos` table out of it:
   ```bash
   DATABASE_URL=./photos-backfill.db npm run db:apply
   ```
3. **Run the resize job against the NAS mount and the scratch database**:
   ```bash
   DATABASE_URL=./photos-backfill.db \
   HEARTH_PHOTOS_DIR=~/nas-mount/hearth/pictures \
   HEARTH_PHOTOS_CACHE_DIR=~/nas-mount/hearth/cache \
   node scripts/resize-photos.mjs
   ```
4. **Copy the scratch database to the Pi and merge it into the live one, on the Pi.**
   `SOURCE_PHOTOS_DIR`/`SOURCE_PHOTOS_CACHE_DIR` tell the merge what to rewrite each
   `source_path`/`cached_path` _from_ — the other machine's mount paths from step 1 — so
   they resolve under the Pi's own `HEARTH_PHOTOS_DIR`/`HEARTH_PHOTOS_CACHE_DIR` (defaulting
   to the resize job's own defaults) afterward. **Both matter, not just the cache one** —
   `source_path` is what the merge matches existing rows on, so an unrewritten one makes
   every row look brand new instead of updating the Pi's matching row, and makes the Pi's
   own next nightly diff fail to recognize any of them at all. The actual files don't move
   — this only corrects the path strings stored in the database.
   ```bash
   scp photos-backfill.db hearth@raspberrypi.lan:/tmp/
   ssh hearth@raspberrypi.lan
   sudo systemctl stop hearth.service   # optional, avoids a concurrent write mid-merge
   SOURCE_PHOTOS_DIR=/Users/YOUR_MAC_USERNAME/nas-mount/hearth/pictures \
   SOURCE_PHOTOS_CACHE_DIR=/Users/YOUR_MAC_USERNAME/nas-mount/hearth/cache \
     node /opt/hearth/current/scripts/merge-photos-table.mjs /tmp/photos-backfill.db
   sudo systemctl start hearth.service
   ```
   The merge only touches resize-derived columns (path, dimensions, orientation, blur
   hash, taken-at) — `shown_count`/`last_shown` on any row that already existed are left
   alone, so it's safe to re-run if the backfill needs a second pass.

## 9. First deploy

From the Mac, in the repo root:

```bash
HEARTH_HOST=hearth.local ./scripts/deploy.sh
```

This builds, rsyncs `build/`, `drizzle/`, `scripts/`, and production `node_modules/`
into a new `/opt/hearth/releases/release-<timestamp>`, symlinks it as
`/opt/hearth/current`, runs `scripts/migrate.mjs`, and (from the second deploy on)
restarts `hearth.service`. The very first time, start it manually on the Pi once:

```bash
sudo systemctl enable --now hearth
systemctl status hearth
curl http://hearth.local:8080/health
```

Every deploy after this is just re-running `./scripts/deploy.sh` from the Mac.

Every deploy also runs a read-only drift check (`scripts/check-deploy-drift.mjs`) and
warns if `/etc/hearth/hearth.env` or the Pi's installed systemd units have fallen behind
what's in this release's `deploy/` folder — only key _names_ are ever read off the Pi,
never values, so a real secret can't end up in the deploy output. A warning still means
adding the missing var (§6) or installing the missing unit (§8) by hand; the check only
catches that something's missing, it doesn't fix it.

## 10. Confirm it survives a reboot

```bash
sudo reboot
# after it comes back:
swapon --show                        # zram present
mount | grep /mnt/nas                # NAS mounted
systemctl is-active hearth           # active
curl http://hearth.local:8080/health # {"status":"ok",...}
```

## 11. The tablet — Free Kiosk setup

Everything below is configured on the tablet itself, in the Free Kiosk app — none of it is
driven by Hearth's own code today (DESIGN.md §9.1). Written down here because none of it
survives a factory reset or a tablet swap, and it has only ever lived in whoever set it up
last remembering it.

**Install:** [Free Kiosk](https://freekiosk.app/) (`RushB-fr/freekiosk`), open-source,
100% free — no paid tier, no feature-gating to work around. Switched to this from Fully
Kiosk 2026-08-26; this section described Fully Kiosk's settings until then, and the exact
setting names below are what actually replaced them, checked live against the real app
rather than assumed from Free Kiosk's own docs (which, like Fully Kiosk's site once did for
this project, gave an incomplete picture from the outside — see DESIGN.md's v0.25 changelog
entry).

In Free Kiosk's settings:

- **Start URL** — `http://<this-pi>:8080` (whatever `ORIGIN` in `/etc/hearth/hearth.env`
  resolves to from the tablet's network).
- **Launch on Boot** — on. Confirmed present and load-bearing, same reasoning as before: a
  tablet that needs a manual relaunch after a power blip defeats the point of a wall
  display nobody has to think about.
- **No crash-relaunch equivalent found in settings.** Fully Kiosk had "Restart Fully After
  Crash"; checked Free Kiosk's settings screen directly and found nothing playing that
  role. Not confirmed impossible, only not found — **open risk**, worth another look if the
  tablet is ever found stuck on a crashed app rather than the dashboard.
- **Sleep Schedule — on, 22:30–06:30.** Unlike Fully Kiosk, where the equivalent
  ("Schedule Wakeup and Sleep") turned out to be PLUS-only, Free Kiosk's is free and
  actually turns the screen off on a fixed clock window — real backlight sleep, not just a
  dimmed view. **Deliberately left offset from `quiet_hours`** (Hearth's own Settings
  screen, default `22:00-07:00`) rather than synced to match — Alex confirmed they're fine
  with the ~30-minute mismatch on each end (the tablet shows the dimmed night-clock view
  briefly before actually sleeping, and again briefly after waking, before `quiet_hours`
  itself ends). If that stops being fine, the fix is a one-line change to either value, not
  a redesign — the two are independent by construction (Free Kiosk owns the schedule
  device-side, `quiet_hours` owns the app-level dimmed view; neither depends on the other
  being correct).
- **Screensaver — dim style, 10% brightness, after 10 minutes of inactivity.** Free
  Kiosk's own screensaver, separate from Hearth's own (`screensaverPublisher.ts`'s photo
  rotation). **Whether this 10-minute timer is scoped to the Sleep Schedule window or runs
  independently around the clock is not yet confirmed** — if it's the latter, the tablet
  would dim to 10% brightness any time nobody's touched it for 10 minutes, which for a
  glance-only wall display is most of the day, not just at night. Worth a daytime check
  (leave the tablet untouched 10+ minutes, see if it dims) before trusting this doesn't
  interfere with normal daytime glanceability.
- **"Return to Start Page on Inactivity" — on.** Free Kiosk's substitute for a fixed-time
  nightly reload, the same role Fully Kiosk's "Auto Reload on Idle (4h)" played — the app
  has no fixed-clock-time reload option either, so this is what bounds how long any single
  page session runs on a 2GB tablet (load-bearing, not hygiene). **Confirm the actual
  duration configured** — verified the setting exists and is on, but not the exact value;
  something in the few-hours range keeps the same reasoning as before (long enough it
  won't fire while anyone's actually glancing at the tablet, short enough to guarantee at
  least one reload during any night's `quiet_hours` window).
- **Reload on Error — on.** Covers a reload landing exactly during `hearth.service`'s own
  ~90-second restart-on-deploy window (it doesn't exit cleanly on `SIGTERM`, so systemd
  waits out the full stop timeout before `SIGKILL` — slow, not broken) without the app
  needing a service worker or HTTPS to recover from it. **Confirm the retry interval** —
  present and enabled, exact seconds-between-retries not yet re-verified; Fully Kiosk used
  30s specifically so retries landed around the 30s/60s/90s marks, close behind the service
  actually coming back up without hammering the Pi.
- **No separate "reload on network reconnect" setting found** — only "Reload on Error"
  exists. Fully Kiosk had these as two distinct free-tier toggles; Free Kiosk's single
  setting may or may not already cover a connectivity-drop case the way the dedicated
  toggle did. **Open risk**, same status as the crash-relaunch gap above — not confirmed
  broken, just not confirmed covered either.
- **Fullscreen — on.** One combined toggle here, unlike Fully Kiosk's three separate
  Show Status Bar / Show Navigation Bar / Show Action Bar switches. No PWA install is
  needed for any of this (plain LAN HTTP is fine, per DESIGN.md §9.1).

**Not used, and no longer the obvious next step either:** Free Kiosk exposes a REST API
(`/api/screen/on`, `/api/screen/off`, `/api/brightness`, `/api/reload`, and 40+ more — see
the project's own `docs/rest-api.md`) that would let Hearth's server drive the tablet's
screen directly, for the first time since this project started (DESIGN.md §9.1's "the app
cannot drive the screen" no longer strictly holds). Considered as a way to get real
screen-off on `quiet_hours`' own schedule — but the native Sleep Schedule above already
does that, with none of the new-failure-mode risk a Pi-calling-the-tablet setup would add
(the Pi being briefly unreachable at 6:30am would mean the screen stays asleep until
something notices, versus the device handling its own schedule regardless of the network).
Motion-detection wake was also considered and declined — it requires the tablet's camera
running continuously, which isn't something to enable in a family kitchen without a
deliberate decision to do so.

None of the reload settings above replace `src/lib/sessionCache.ts` (a reload while the Pi
is slow shows the last-known week/groceries immediately, not a blank "Loading…") — they
solve a different half of the same problem: sessionCache handles what's already on screen
when a page load starts failing, these handle getting a fresh page load to actually succeed
once the Pi's back. Neither reaches the case where the Pi is unreachable for good past
every retry — that would need a service worker, deliberately not taken on (§9.1: "no PWA
install is needed... which is why plain LAN HTTP is fine").
