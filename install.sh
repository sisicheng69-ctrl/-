#!/bin/sh
# Runs ONCE on the Pod after unzip. Installs runtime deps + initializes the DB.
# NEVER build here (npm run build is done on the rewriter machine by `guard
# verify`; the static template has no build at all). No dev deps. No public net.
set -eo pipefail
cd "$(dirname "$0")"

# Prefer `npm ci` (reproducible) when a lockfile is present — running
# `guard verify` on the rewriter machine generates package-lock.json and packs
# it. If there's no lockfile (a freshly scaffolded app that skipped verify),
# fall back to `npm install` so install never hard-fails with EUSAGE.
if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
  echo "[install] step: npm ci"
  npm ci --omit=dev
else
  echo "[install] step: npm install (no lockfile present)"
  npm install --omit=dev --no-audit --no-fund
fi

# DB init (skip both lines if this app is stateless and reads no db.properties)
if [ -f ./db.properties ]; then
  echo "[install] step: migrate"
  node app/migrate.cjs
  echo "[install] step: seed"
  node app/seed_db.cjs
fi

echo "[install] done"
