#!/usr/bin/env bash
# Give the remote server its own Tailscale hostname with Funnel on port 443.
#
# claude.ai's connector client only talks to port 443, and a Mac's own MagicDNS name can carry one Funnel per
# port, so if this Mac already serves something on 443 (another app's `tailscale serve`), the endpoint needs a
# second node name. This script runs a dedicated userspace tailscaled (no root, no network extension, no
# conflict with the Tailscale app) as a launchd agent, joins it to your tailnet under its own hostname, and
# enables the Funnel: https://<hostname>.<tailnet>.ts.net -> http://127.0.0.1:<port>.
#
#   bash scripts/remote-tailscale-node.sh --hostname altea [--port 8788] [--login-only]
#
# The first run prints a login URL: open it (any device) to approve the node; tick "Disable key expiry" for it in
# the admin console afterwards so it never has to re-authenticate. Then re-run scripts/remote-install.sh with
# --public-url https://<hostname>.<tailnet>.ts.net (no --funnel) so OAuth metadata carries the new origin.
set -euo pipefail
NAME="altea"; PORT=8788; LOGIN_ONLY=0
while [ $# -gt 0 ]; do case "$1" in
  --hostname) NAME="$2"; shift 2;; --port) PORT="$2"; shift 2;; --login-only) LOGIN_ONLY=1; shift;;
  *) echo "unknown option $1"; exit 1;; esac; done
ALTEA_HOME="${ALTEA_HOME:-$HOME/.altea}"; DIR="$ALTEA_HOME/tailscale"; LABEL="com.altea.tailscaled"
mkdir -p "$DIR" "$ALTEA_HOME/logs"; chmod 700 "$DIR"
command -v brew >/dev/null || { echo "Homebrew is required (https://brew.sh)"; exit 1; }
brew list tailscale >/dev/null 2>&1 || brew install --quiet tailscale
PREFIX="$(brew --prefix)"; TSD="$PREFIX/bin/tailscaled"; TS="$PREFIX/bin/tailscale"; SOCK="$DIR/tailscaled.sock"
[ -x "$TSD" ] && [ -x "$TS" ] || { echo "tailscaled/tailscale not found under $PREFIX/bin"; exit 1; }

UID_N="$(id -u)"; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"; mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$TSD</string>
    <string>--tun=userspace-networking</string>
    <string>--socket=$SOCK</string>
    <string>--state=$DIR/tailscaled.state</string>
    <string>--statedir=$DIR</string>
    <string>--port=41642</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ALTEA_HOME/logs/tailscaled.log</string>
  <key>StandardErrorPath</key><string>$ALTEA_HOME/logs/tailscaled.log</string>
</dict></plist>
PL
if ! launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then launchctl bootstrap "gui/$UID_N" "$PLIST"; fi
for i in $(seq 1 30); do [ -S "$SOCK" ] && "$TS" --socket="$SOCK" status >/dev/null 2>&1 && break; sleep 1; done

state="$("$TS" --socket="$SOCK" status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState",""))' 2>/dev/null || true)"
if [ "$state" != "Running" ]; then
  echo "Node '$NAME' needs to be approved in your tailnet. Open the login URL below on any device:"
  # `up` blocks until the node is authorized; the URL is printed right away
  "$TS" --socket="$SOCK" up --hostname="$NAME" --accept-dns=false --accept-routes=false --timeout=30m
fi
[ "$LOGIN_ONLY" = 1 ] && exit 0
"$TS" --socket="$SOCK" funnel --bg --https=443 --set-path=/ "http://127.0.0.1:$PORT"
FQDN="$("$TS" --socket="$SOCK" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
echo
echo "Node ready. Public URL (allow ~10 min for DNS the first time): https://$FQDN"
echo "Now: bash scripts/remote-install.sh --public-url https://$FQDN --member \"Your Name\"   (no --funnel)"
echo "and put ALTEA_TS_CMD=\"$TS --socket=$SOCK\" in the watchdog's environment (remote-install.sh --tailscale-socket $SOCK does this)."
