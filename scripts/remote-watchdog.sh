#!/usr/bin/env bash
# Watchdog for the remote server on the serving Mac (installed by remote-install.sh as launchd job
# com.altea.watchdog, every 5 minutes). Repairs the three things that can silently take the endpoint down:
#   1. the server process (restart via launchd if /healthz fails),
#   2. Tailscale not running / logged out (relaunch the app),
#   3. the Funnel for our port missing, or its public DNS record gone (re-enable the Funnel; the record re-publishes).
# Env: ALTEA_HTTP_PORT (8788), ALTEA_PUBLIC_URL, ALTEA_HOME (~/.altea), ALTEA_TS_CMD (tailscale CLI, e.g.
# "/opt/homebrew/bin/tailscale --socket=…" for a dedicated node), ALTEA_TS_RESTART (how to relaunch it).
# Logs to $ALTEA_HOME/logs/watchdog.log.
set -u
PORT="${ALTEA_HTTP_PORT:-8788}"; PUBLIC_URL="${ALTEA_PUBLIC_URL:-}"; ALTEA_HOME="${ALTEA_HOME:-$HOME/.altea}"
LABEL="com.altea.mcp-http"; STATE="$ALTEA_HOME/logs/watchdog.state"; mkdir -p "$ALTEA_HOME/logs"
if [ -n "${ALTEA_TS_CMD:-}" ]; then TS="$ALTEA_TS_CMD"; else TS="$(command -v tailscale || true)"; [ -x "${TS:-/nonexistent}" ] || TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"; fi
TS_RESTART="${ALTEA_TS_RESTART:-open -a Tailscale}"
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
state=""
if [ -x "${TS%% *}" ]; then
state="$($TS status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState",""))' 2>/dev/null)"
if [ "$state" != "Running" ]; then
  log "tailscale: state '$state'; relaunching ($TS_RESTART)"
  eval "$TS_RESTART" >/dev/null 2>&1 || true
  sleep 15
  state="$($TS status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState",""))' 2>/dev/null)"
  [ "$state" = "Running" ] && log "tailscale: running" || log "tailscale: STILL '$state' (a re-login in the Tailscale app may be needed)"
  fixed=1
fi
fi

# 3a. a tunnel agent (Cloudflare etc.) in front instead of a Funnel. Its own readiness endpoint decides
#     (cloudflared --metrics: /ready is 200 while at least one edge connection is up); the public URL is only a
#     secondary signal, and a DNS failure on this Mac (curl exit 6) is never treated as a tunnel failure.
if [ -n "${ALTEA_TUNNEL_LABEL:-}" ]; then
  READY="http://127.0.0.1:${ALTEA_TUNNEL_METRICS_PORT:-20241}/ready"
  down=0
  if curl -fsS -m 5 "$READY" >/dev/null 2>&1; then :; else
    curl -sS -m 5 -o /dev/null "$READY" 2>/dev/null; rc=$?
    if [ "$rc" = 7 ] || [ "$rc" = 28 ]; then down=1; log "tunnel: readiness endpoint $READY not answering"; # not listening: agent dead
    else
      # listening but not ready → edge connections gone; give it two checks (10 min) before restarting
      m=0; [ -f "$STATE.tunnel" ] && m="$(cat "$STATE.tunnel" 2>/dev/null || echo 0)"; m=$((m + 1)); echo "$m" > "$STATE.tunnel"
      log "tunnel: not ready (miss $m/2)"; [ "$m" -ge 2 ] && { down=1; echo 0 > "$STATE.tunnel"; }
    fi
  fi
  [ "$down" = 0 ] && echo 0 > "$STATE.tunnel"
  if [ "$down" = 0 ] && [ -n "$PUBLIC_URL" ]; then
    curl -fsS -m 15 -A "altea-watchdog" -o /dev/null "$PUBLIC_URL/healthz" 2>/dev/null; rc=$?
    [ "$rc" = 0 ] || [ "$rc" = 6 ] || log "tunnel: public $PUBLIC_URL/healthz returned curl rc=$rc (tunnel itself ready; not restarting)"
  fi
  if [ "$down" = 1 ]; then
    log "tunnel: restarting $ALTEA_TUNNEL_LABEL"
    launchctl kickstart -k "gui/$(id -u)/$ALTEA_TUNNEL_LABEL" 2>&1 | sed 's/^/  /'
    sleep 20; curl -fsS -m 5 "$READY" >/dev/null 2>&1 && log "tunnel: ready again" || log "tunnel: STILL not ready (see cloudflared.log)"
    fixed=1
  fi
fi

# 3b. funnel + public DNS (only for a Tailscale name)
case "$PUBLIC_URL" in *.ts.net*) ;; *) PUBLIC_URL="";; esac
if [ -n "$PUBLIC_URL" ] && [ "$state" = "Running" ]; then
  host="$(printf '%s' "$PUBLIC_URL" | sed -E 's#^https?://([^:/]+).*#\1#')"
  hport="$(printf '%s' "$PUBLIC_URL" | sed -E 's#^https?://[^:/]+:?([0-9]*).*#\1#')"; hport="${hport:-443}"
  reenable=0
  if ! $TS funnel status 2>/dev/null | grep -q "^https://$host:$hport (Funnel on)\|^https://$host (Funnel on)"; then
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
    $TS funnel --https="$hport" --set-path=/ off >/dev/null 2>&1 || true
    $TS funnel --bg --https="$hport" --set-path=/ "http://127.0.0.1:$PORT" 2>&1 | sed 's/^/  /'
    fixed=1
  fi
fi

[ "$fixed" = 0 ] && exit 0
log "watchdog: done"
