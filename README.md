# Hearth

A family calendar and household dashboard for the kitchen wall.

Runs as a web app — no APK, no app store — on a wall-mounted Samsung Galaxy Tab,
served from a Raspberry Pi Zero 2 W on the home LAN, with photos read from the
household NAS.

- **Locked by default.** The kitchen is a semi-public room, so nothing is visible
  until someone enters a PIN. Guest mode is one tap from the lock screen.
- **Three people** — Alex, Dana, Sam — each with a configurable set of visible
  calendars, and a simplified view for Sam.
- **Integrations:** Google Calendar, AnyList groceries, Todoist, Open-Meteo weather,
  Picsum for guest mode.
- **Follows the sun.** Light between sunrise and sunset, dark otherwise, computed
  locally so the theme never depends on a network call.

## Design

The architecture, data model, access model, performance budget and build phases are
in **[DESIGN.md](DESIGN.md)**. Read it before implementing — several decisions look
odd without the constraints in §2 that produced them. DESIGN.md's own changelog (right
below its title) is the up-to-date, dated record of what changed and why — check there
before trusting anything else (including this README) about current status.

A rendered version lives at `docs/design.html`.

`docs/phase-*-plan.md` are historical build-phase plans (groceries, Todoist, music, ...).
Each one carries decisions and hardware gates from when that phase was actually built
that DESIGN.md only absorbs into its own body later, sometimes not immediately — worth a
look if DESIGN.md's description of something seems out of sync with what the app
actually does.

## Development

```bash
npm install
cp .env.example .env       # DATABASE_URL is all you need to just run the app locally
npm run db:apply           # create/upgrade local.db — required before first run
npm run seed:users         # create at least one household member + PIN — the lock
                            # screen has no avatars to tap without this
npm run dev
npm test
```

`db:apply` is not optional on a fresh checkout: `local.db` is gitignored, and an empty
SQLite file is created on first connection whether or not the tables exist, so skipping
it fails at the first query rather than at startup.

`SECRETS_KEY` and the Google OAuth client in `.env.example` are **not** required just to
run and click around the app locally — they're only read the moment something actually
needs them (connecting a real Google Calendar or AnyList/Todoist account). Fill them in
when you're testing one of those integrations specifically, not before.

After changing `src/lib/server/db/schema.ts`, run `npm run db:generate` to write a new
migration, then `npm run db:apply` to apply it.

Before opening a PR: `npm test`, `npm run lint`, and `npm run check` (typecheck) — all
three also run in CI on every push and PR.

## Deploying

Build on the Mac, ship artifacts — see [deploy/README.md](deploy/README.md) for one-time
Pi setup (systemd, zram, the CIFS mount) and `scripts/deploy.sh` for every deploy after
that.

## Status

All of DESIGN.md §12's planned build phases — foundations through the calendar,
screensaver/theme, groceries, and Todoist/music polish — are built and deployed to the
real Pi. Current work is fixes and refinements rather than new phases; see DESIGN.md's
changelog for what's actually landed recently, and `git log` for the day-to-day detail.
