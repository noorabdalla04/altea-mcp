#!/usr/bin/env bash
# Run ON the always-on Mac that will serve the remote MCP endpoint (a Mac mini, an old laptop that stays open).
# Installs dependencies, a launchd agent that keeps `bin/mcp-http.mjs` running, and (optionally) a Tailscale
# Funnel so the endpoint gets a public HTTPS URL for free.
#
#   bash scripts/remote-install.sh --public-url https://<machine>.<tailnet>.ts.net:8443 [--funnel] \
#        [--port 8788] [--member "Your Name"] [--window visible] [--community "Altea Toronto"]
#
# Afterwards: copy the signed-in session here from the Mac where you ran `altea login`
#   node bin/altea.mjs remote push user@this-mac
# and add <public-url>/mcp as a custom connector in claude.ai (you will be asked for the passphrase printed below).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8788; PUBLIC_URL=""; MEMBER=""; COMMUNITY=""; FUNNEL=0; WINDOW="visible"; LABEL="com.altea.mcp-http"
while [ $# -gt 0 ]; do case "$1" in
  --public-url) PUBLIC_URL="$2"; shift 2;;
  --port) PORT="$2"; shift 2;;
  --member) MEMBER="$2"; shift 2;;
  --community) COMMUNITY="$2"; shift 2;;
  --window) WINDOW="$2"; shift 2;;
  --funnel) FUNNEL=1; shift;;
  *) echo "unknown option $1"; exit 1;;
esac; done
[ -n "$PUBLIC_URL" ] || { echo "--public-url is required (the origin clients will use, e.g. https://mini.tail1234.ts.net:8443)"; exit 1; }
case "$PUBLIC_URL" in https://*) ;; *) echo "--public-url must be https"; exit 1;; esac
NODE="$(command -v node)"; [ -n "$NODE" ] || { echo "node not found (need Node 22+; brew install node)"; exit 1; }
[ "$(uname)" = "Darwin" ] || { echo "this installer targets macOS launchd; on Linux run bin/mcp-http.mjs under systemd with the same variables"; exit 1; }

cd "$ROOT" && npm install --no-fund --no-audit --omit=dev
ALTEA_HOME="${ALTEA_HOME:-$HOME/.altea}"
mkdir -p "$ALTEA_HOME/logs"

PASS_OUT=""
if ! "$NODE" -e "import('$ROOT/src/oauth.mjs').then(m => process.exit(new m.FileOAuthProvider().hasPassphrase() ? 0 : 1))"; then
  PASS_OUT="$("$NODE" "$ROOT/bin/altea.mjs" remote passphrase)"
fi

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
{
cat <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/bin/mcp-http.mjs</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
    <key>ALTEA_HOME</key><string>$ALTEA_HOME</string>
    <key>ALTEA_PUBLIC_URL</key><string>$PUBLIC_URL</string>
    <key>ALTEA_HTTP_PORT</key><string>$PORT</string>
    <key>ALTEA_WINDOW</key><string>$WINDOW</string>
PL
[ -n "$MEMBER" ] && echo "    <key>ALTEA_MEMBER_NAME</key><string>$MEMBER</string>"
[ -n "$COMMUNITY" ] && echo "    <key>ALTEA_COMMUNITY</key><string>$COMMUNITY</string>"
cat <<PL
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ALTEA_HOME/logs/http.log</string>
  <key>StandardErrorPath</key><string>$ALTEA_HOME/logs/http.log</string>
</dict></plist>
PL
} > "$PLIST"

UID_N="$(id -u)"
# (re)load a launchd agent: bootout is asynchronous, so wait until the job is gone before bootstrapping again
load_agent() { # label plist
  launchctl bootout "gui/$UID_N/$1" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do launchctl print "gui/$UID_N/$1" >/dev/null 2>&1 || break; sleep 1; done
  launchctl bootstrap "gui/$UID_N" "$2" 2>/dev/null || launchctl kickstart -k "gui/$UID_N/$1"
}
load_agent "$LABEL" "$PLIST"

# watchdog: every 5 minutes, restart the server / relaunch Tailscale / re-enable the Funnel if any of them dropped
WD_LABEL="com.altea.watchdog"; WD_PLIST="$HOME/Library/LaunchAgents/$WD_LABEL.plist"
cat > "$WD_PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$WD_LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$ROOT/scripts/remote-watchdog.sh</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>ALTEA_HOME</key><string>$ALTEA_HOME</string>
    <key>ALTEA_PUBLIC_URL</key><string>$PUBLIC_URL</string>
    <key>ALTEA_HTTP_PORT</key><string>$PORT</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$ALTEA_HOME/logs/watchdog.log</string>
  <key>StandardErrorPath</key><string>$ALTEA_HOME/logs/watchdog.log</string>
</dict></plist>
PL
load_agent "$WD_LABEL" "$WD_PLIST"
for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; done
curl -fsS "http://127.0.0.1:$PORT/healthz" || { echo "server did not come up; see $ALTEA_HOME/logs/http.log"; exit 1; }
echo

if [ "$FUNNEL" = 1 ]; then
  TS="$(command -v tailscale || true)"; [ -n "$TS" ] || TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  [ -x "$TS" ] || { echo "tailscale CLI not found; enable the Funnel by hand: tailscale funnel --bg --https=<port> http://127.0.0.1:$PORT"; exit 1; }
  HTTPS_PORT="$(printf '%s' "$PUBLIC_URL" | sed -E 's#^https://[^:/]+:?([0-9]*).*#\1#')"; HTTPS_PORT="${HTTPS_PORT:-443}"
  "$TS" funnel --bg --https="$HTTPS_PORT" --set-path=/ "http://127.0.0.1:$PORT"
fi

echo "Installed: launchd agents $LABEL and $WD_LABEL (logs: $ALTEA_HOME/logs/http.log, watchdog.log)"
echo "MCP endpoint: $PUBLIC_URL/mcp"
[ -n "$PASS_OUT" ] && { echo; echo "$PASS_OUT"; }
echo
echo "Next: on the Mac where you signed in, run   node bin/altea.mjs remote push $(whoami)@$(hostname -s)"
echo "then add $PUBLIC_URL/mcp as a custom connector in claude.ai."
