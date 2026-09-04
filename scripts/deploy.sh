#!/usr/bin/env bash
# Build on the Mac, ship artifacts — DESIGN.md §3.3: never build on the Pi.
#
# Usage:
#   ./scripts/deploy.sh              # build, rsync, migrate, restart
#   ./scripts/deploy.sh --dry-run    # show what would happen, touch nothing remote
#
# Config (env vars, all optional):
#   HEARTH_HOST=hearth.local  HEARTH_USER=hearth  HEARTH_PATH=/opt/hearth
set -euo pipefail

HEARTH_HOST="${HEARTH_HOST:-hearth.local}"
HEARTH_USER="${HEARTH_USER:-hearth}"
HEARTH_PATH="${HEARTH_PATH:-/opt/hearth}"
KEEP_RELEASES="${HEARTH_KEEP_RELEASES:-5}"
CACHE_DIR="${HEARTH_DEPLOY_CACHE:-$HOME/.cache/hearth-deploy}"
CACHE_KEEP="${HEARTH_CACHE_KEEP:-3}"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RELEASE="release-$(date -u +%Y%m%d%H%M%S)"
REMOTE_RELEASES="$HEARTH_PATH/releases"
REMOTE_RELEASE_DIR="$REMOTE_RELEASES/$RELEASE"
REMOTE="$HEARTH_USER@$HEARTH_HOST"

echo "==> building (npm run build)"
if [[ "$DRY_RUN" == true ]]; then
	echo "    [dry-run] skipped"
else
	npm run build
fi

echo "==> staging production-only node_modules for the Pi's target platform"
echo "    (linux/arm64/glibc) explicitly, not whatever this build machine is."
echo "    better-sqlite3 bundles every platform's prebuild inside the one package,"
echo "    so it never needed this — but @node-rs/argon2 (and sharp/blurhash later)"
echo "    ship one npm package PER platform as an optional dependency, and plain"
echo "    'npm ci' only installs the one matching the machine it runs on. Without"
echo "    these flags a Mac-run 'npm ci' silently ships zero Linux binary and the"
echo "    Pi throws 'Cannot find native binding' the first time anything needs it."
# Cached by lockfile hash so unchanged deps keep the same STAGE dir (and file
# mtimes) across deploys — that's what lets --link-dest below hardlink instead
# of re-transferring node_modules over the network every time.
LOCK_HASH="$(cat package.json package-lock.json | shasum -a 256 | awk '{print $1}')"
STAGE="$CACHE_DIR/node_modules-$LOCK_HASH"
if [[ -d "$STAGE/node_modules" ]]; then
	echo "    reusing cached node_modules (lockfile unchanged: ${LOCK_HASH:0:12})"
elif [[ "$DRY_RUN" == true ]]; then
	echo "    [dry-run] skipped npm ci --omit=dev --os=linux --cpu=arm64 --libc=glibc"
else
	echo "    lockfile changed (or no cache yet), rebuilding: ${LOCK_HASH:0:12}"
	mkdir -p "$STAGE"
	cp package.json package-lock.json "$STAGE/"
	(cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund --os=linux --cpu=arm64 --libc=glibc)
fi
if [[ "$DRY_RUN" != true && -d "$CACHE_DIR" ]]; then
	(cd "$CACHE_DIR" && ls -1dt node_modules-*/ 2>/dev/null | tail -n +$((CACHE_KEEP + 1)) | xargs -r rm -rf --)
fi

echo "==> creating release dir on $REMOTE: $REMOTE_RELEASE_DIR"
if [[ "$DRY_RUN" == true ]]; then
	echo "    [dry-run] ssh $REMOTE mkdir -p $REMOTE_RELEASE_DIR"
else
	ssh "$REMOTE" "mkdir -p '$REMOTE_RELEASE_DIR'"
fi

echo "==> rsyncing build/ deploy/ drizzle/ scripts/ package.json node_modules/"
echo "    (--link-dest against 'current' hardlinks anything unchanged there"
echo "    instead of re-sending it, so a deploy with the same lockfile only"
echo "    ships the build/ output over the network)"
# deploy/ ships so a new/changed systemd unit is already sitting at
# $HEARTH_PATH/current/deploy on the next deploy, rather than needing its own
# manual scp first (caught live: hearth-music-scan.service/.timer existed in the
# repo but nowhere on the Pi, since this list never included deploy/). Installing
# and enabling a unit from there is still a deliberate one-time step, same as
# hearth-resize/hearth-backup already are — this only removes the "get the files
# there at all" half of it.
RSYNC_ARGS=(-az --delete --link-dest="$HEARTH_PATH/current" build deploy drizzle scripts package.json "$STAGE/node_modules" "$REMOTE:$REMOTE_RELEASE_DIR/")
if [[ "$DRY_RUN" == true ]]; then
	echo "    [dry-run] rsync ${RSYNC_ARGS[*]}"
else
	rsync "${RSYNC_ARGS[@]}"
fi

echo "==> switching 'current' symlink, migrating, and restarting hearth.service"
REMOTE_SCRIPT="
set -euo pipefail
ln -sfn '$REMOTE_RELEASE_DIR' '$HEARTH_PATH/current'
node '$HEARTH_PATH/current/scripts/migrate.mjs'
sudo systemctl restart hearth
cd '$REMOTE_RELEASES' && ls -1t | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf --
"
if [[ "$DRY_RUN" == true ]]; then
	echo "    [dry-run] ssh $REMOTE <<'EOF'"
	echo "$REMOTE_SCRIPT" | sed 's/^/      /'
	echo "    EOF"
else
	ssh "$REMOTE" bash -s <<<"$REMOTE_SCRIPT"
fi

echo "==> checking for env/systemd drift on $REMOTE (read-only, non-blocking)"
if [[ "$DRY_RUN" == true ]]; then
	echo "    [dry-run] skipped"
else
	HEARTH_HOST="$HEARTH_HOST" HEARTH_USER="$HEARTH_USER" HEARTH_PATH="$HEARTH_PATH" \
		node scripts/check-deploy-drift.mjs || true
fi

echo "==> done: $RELEASE"
