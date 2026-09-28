#!/bin/sh
# Loopback health check (does not go through the Guard reverse proxy).
# The platform injects APP_PORT when it runs this script, and during blue-green
# deploys that port is the standby port (base+1), NOT a fixed 3000. Probe
# $APP_PORT, falling back to 3000. NEVER hardcode the port — a mismatched probe
# fails the health gate even though the app is up.
curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${APP_PORT:-3000}/health" || exit 1
