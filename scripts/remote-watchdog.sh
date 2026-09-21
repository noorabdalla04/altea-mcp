#!/usr/bin/env bash
# Watchdog for the remote server on the serving Mac (installed by remote-install.sh as launchd job
# com.altea.watchdog, every 5 minutes). Repairs the three things that can silently take the endpoint down:
#   1. the server process (restart via launchd if /healthz fails),
#   2. Tailscale not running / logged out (relaunch the app),
#   3. the Funnel for our port missing, or its public DNS record gone (re-enable the Funnel; the record re-publishes).
# Env: ALTEA_HTTP_PORT (8788), ALTEA_PUBLIC_URL, ALTEA_HOME (~/.altea). Logs to $ALTEA_HOME/logs/watchdog.log.
set -u
PORT="${ALTEA_HTTP_PORT:-8788}"; PUBLIC_URL="${ALTEA_PUBLIC_URL:-}"; ALTEA_HOME="${ALTEA_HOME:-$HOME/.altea}"
LABEL="com.altea.mcp-http"; STATE="$ALTEA_HOME/logs/watchdog.state"; mkdir -p "$ALTEA_HOME/logs"
TS="$(command -v tailscale || true)"; [ -x "${TS:-/nonexistent}" ] || TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
fixed=0

# 1. server
if ! curl -fsS -m 10 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  log "server: /healthz failed; restarting $LABEL"
  launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>&1 | sed 's/^/  /'
  sleep 5; curl -fsS -m 10 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && log "server: back" || log "server: STILL DOWN (see http.log)"
  fixed=1
fi

# 2. tailscale
[ -x "$TS" ] || { log "tailscale CLI not found at $TS"; exit 0; }
state="$("$TS" status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState",""))' 2>/dev/null)"
if [ "$state" != "Running" ]; then
  log "tailscale: state '$state'; relaunching the app"
  open -a Tailscale 2>/dev/null || true
  sleep 15
  state="$("$TS" status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState",""))' 2>/dev/null)"
  [ "$state" = "Running" ] && log "tailscale: running" || log "tailscale: STILL '$state' (a re-login in the Tailscale app may be needed)"
  fixed=1
fi

# 3. funnel + public DNS (only when a public URL is configured)
if [ -n "$PUBLIC_URL" ] && [ "$state" = "Running" ]; then
  host="$(printf '%s' "$PUBLIC_URL" | sed -E 's#^https?://([^:/]+).*#\1#')"
  hport="$(printf '%s' "$PUBLIC_URL" | sed -E 's#^https?://[^:/]+:?([0-9]*).*#\1#')"; hport="${hport:-443}"
  reenable=0
  if ! "$TS" funnel status 2>/dev/null | grep -q "^https://$host:$hport (Funnel on)\|^https://$host (Funnel on)"; then
    log "funnel: not on for $host:$hport"; reenable=1
  else
    # public DNS: tolerate three consecutive misses (~15 min) before acting, since publication itself can lag
    misses=0; [ -f "$STATE" ] && misses="$(cat "$STATE" 2>/dev/null || echo 0)"
    if dig +short +time=4 @1.1.1.1 "$host" A 2>/dev/null | grep -q '^[0-9]'; then
      [ "$misses" != 0 ] && log "dns: record present again"; echo 0 > "$STATE"
    else
      misses=$((misses + 1)); echo "$misses" > "$STATE"; log "dns: no public A record for $host (miss $misses/3)"
      [ "$misses" -ge 3 ] && { reenable=1; echo 0 > "$STATE"; }
    fi
  fi
  if [ "$reenable" = 1 ]; then
    log "funnel: re-enabling https=$hport -> http://127.0.0.1:$PORT"
    "$TS" funnel --https="$hport" --set-path=/ off >/dev/null 2>&1 || true
    "$TS" funnel --bg --https="$hport" --set-path=/ "http://127.0.0.1:$PORT" 2>&1 | sed 's/^/  /'
    fixed=1
  fi
fi

[ "$fixed" = 0 ] && exit 0
log "watchdog: done"
