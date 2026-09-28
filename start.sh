#!/bin/sh
# Foreground process. Last line MUST be exec.
# Bare `exec node app/server.js` runs in PM2 cluster mode, so server.js calls
# app.listen with a callback (acts as the ready signal). Env names use APP_*
# so the container's injected PORT/HOSTNAME don't clobber them.
# The platform injects APP_PORT (may NOT be 3000, and changes during blue-green).
# Bind to it; health.sh reads the same APP_PORT the platform injects.
set -e
cd "$(dirname "$0")"

export APP_PORT="${APP_PORT:-3000}"
export APP_HOSTNAME="${APP_HOSTNAME:-0.0.0.0}"
export NODE_ENV=production

exec node app/server.js
