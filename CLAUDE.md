# Working on Hearth

## Read these first

- **[DESIGN.md](DESIGN.md)** is canonical — architecture, data model, access model,
  performance budget, build phases. Several decisions look arbitrary without the
  constraints in §2 that produced them, so read those before changing anything they
  explain. Its own changelog (right below the title) is the up-to-date record of what's
  actually shipped — trust it over any phase-status claim elsewhere, including README.md.
- **`docs/phase-*-plan.md`** are historical per-phase plans (groceries, Todoist, music,
  ...), not a pointer to current work — as of this writing all of DESIGN.md §12's planned
  phases are built and deployed. Each carries decisions and hardware gates from when it
  was built that DESIGN.md doesn't always immediately absorb into its own body — check the
  relevant one if DESIGN.md's description of something seems stale against real behavior.

## A new runtime dependency is not proven until it runs on the Pi

The target is a Raspberry Pi Zero 2 W: 1GHz quad **Cortex-A53**, 463MB shared with
Pi-hole, 64-bit Raspberry Pi OS Lite. "It works on the Mac" has already been wrong twice,
for two unrelated reasons:

- `npm ci` on the build machine installed the **Mac's** native optional dependencies, so
  napi-rs-style packages (one npm package per platform) shipped zero Linux binary. Fixed
  in `scripts/deploy.sh` with `--os=linux --cpu=arm64 --libc=glibc`.
- `@node-rs/argon2`'s `linux-arm64-gnu` prebuild died with `Illegal instruction`. These
  Cortex-A53 cores lack the ARMv8.1 LSE atomics the prebuild assumes every aarch64 chip
  has. Replaced with `hash-wasm`, which runs through V8's WASM compiler and cannot have a
  CPU-specific binary problem.

So: **when a phase adds a dependency, smoke-test it on the actual Pi before building on
top of it.** A throwaway script that imports the thing and exercises its main call is
enough, and it is much cheaper than discovering the problem four milestones deep with
working code on top of it. This applies to pure-JS dependencies too — a lower risk, not a
zero one, especially for packages old enough to predate Node 22.

Say so explicitly when a phase introduces one, rather than assuming whoever is driving
remembers.

## The Pi

- `raspberrypi.lan` (not `hearth.local` — the hostname was never changed).
  `HEARTH_HOST=raspberrypi.lan ./scripts/deploy.sh`.
- **`/etc/hearth/hearth.env` does not auto-update.** After any phase that adds a variable
  to `deploy/hearth.env.example`, add it to the live file by hand. Never wholesale-replace
  it — it holds the real `SECRETS_KEY` and `DATABASE_URL`. `scripts/deploy.sh` runs
  `scripts/check-deploy-drift.mjs` after every deploy (read-only — it only ever reads key
  names off the Pi, never values) and warns if the live file, or the Pi's installed
  systemd units, have fallen behind what's in `deploy/` — so you no longer have to
  remember to check by hand, but adding the missing var/unit is still manual.
- Anything touching the live database runs as the `hearth` user, not `pi` — connect with
  `ssh hearth@raspberrypi.lan`, or use `sudo -u hearth`. The `pi` user can log in but
  cannot write `/var/lib/hearth/hearth.db`.
- **Ask before deploying, restarting, or migrating.** This board serves the household's
  DNS; a wedged deploy is not a private mistake.

## Conventions

- Feature branch and a PR for every change, never a direct commit to `main`.
- `npm test`, `npm run lint`, and `npm run check` (typecheck) before opening one — all
  three also run in CI on every push and PR.
- Tests use an in-memory `better-sqlite3` with `migrate()` per test — see
  `src/lib/server/visibility.test.ts` for the shape.
- Schema changes go through `npm run db:generate`, and the generated migration is
  committed.
