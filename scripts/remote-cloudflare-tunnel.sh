#!/usr/bin/env bash
# Expose the remote server on port 443 through a Cloudflare Tunnel, for people who have a domain on Cloudflare.
# Creates a named tunnel, a proxied DNS record for the hostname, a private config, and a launchd agent
# (com.altea.cloudflared, restarts on failure and at login). Nothing else in ~/.cloudflared is touched.
#
#   cloudflared tunnel login                       # once, if ~/.cloudflared/cert.pem does not exist yet
#   bash scripts/remote-cloudflare-tunnel.sh --hostname altea.example.com [--port 8788] [--name altea]
#
# Then: bash scripts/remote-install.sh --public-url https://altea.example.com --tunnel-label com.altea.cloudflared ...
set -euo pipefail
HOSTNAME_CF=""; PORT=8788; NAME="altea"; LABEL="com.altea.cloudflared"
while [ $# -gt 0 ]; do case "$1" in
  --hostname) HOSTNAME_CF="$2"; shift 2;; --port) PORT="$2"; shift 2;; --name) NAME="$2"; shift 2;;
  *) echo "unknown option $1"; exit 1;; esac; done
[ -n "$HOSTNAME_CF" ] || { echo "--hostname is required (a first-level subdomain of a zone on your Cloudflare account)"; exit 1; }
ALTEA_HOME="${ALTEA_HOME:-$HOME/.altea}"; mkdir -p "$ALTEA_HOME/logs"
CF="$(command -v cloudflared || true)"; [ -x "${CF:-/nonexistent}" ] || { echo "cloudflared not found (brew install cloudflared)"; exit 1; }
[ -f "$HOME/.cloudflared/cert.pem" ] || { echo "not logged in: run  cloudflared tunnel login  first"; exit 1; }

# tunnel (idempotent): reuse an existing tunnel of that name. Every cloudflared call below passes our own config
# file: with a ~/.cloudflared/config.yml present (another tunnel on the same Mac) cloudflared would otherwise
# apply that tunnel's id and ingress to these commands.
CONF="$ALTEA_HOME/cloudflared.yml"
UUID="$("$CF" tunnel list -o json 2>/dev/null | python3 -c "import json,sys; t=[x for x in json.load(sys.stdin) if x.get('name')=='$NAME']; print(t[0]['id'] if t else '')")"
if [ -z "$UUID" ]; then "$CF" tunnel create "$NAME" >/dev/null; UUID="$("$CF" tunnel list -o json | python3 -c "import json,sys; print([x for x in json.load(sys.stdin) if x.get('name')=='$NAME'][0]['id'])")"; fi
CRED="$HOME/.cloudflared/$UUID.json"; [ -f "$CRED" ] || { echo "credentials file $CRED missing (tunnel created elsewhere?)"; exit 1; }
cat > "$CONF" <<YML
tunnel: $UUID
credentials-file: $CRED
no-autoupdate: true
ingress:
  - hostname: $HOSTNAME_CF
    service: http://127.0.0.1:$PORT
    originRequest:
      connectTimeout: 30s
      noTLSVerify: false
  - service: http_status:404
YML
chmod 600 "$CONF"
"$CF" tunnel --config "$CONF" route dns --overwrite-dns "$UUID" "$HOSTNAME_CF" 2>&1 | grep -v -i "warn" || true

UID_N="$(id -u)"; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"; mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$CF</string><string>tunnel</string><string>--config</string><string>$CONF</string><string>run</string><string>$NAME</string></array>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ALTEA_HOME/logs/cloudflared.log</string>
  <key>StandardErrorPath</key><string>$ALTEA_HOME/logs/cloudflared.log</string>
</dict></plist>
PL
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
for i in $(seq 1 10); do launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
launchctl bootstrap "gui/$UID_N" "$PLIST" 2>/dev/null || launchctl kickstart -k "gui/$UID_N/$LABEL"
for i in $(seq 1 30); do sleep 2; curl -fsS -m 10 "https://$HOSTNAME_CF/healthz" >/dev/null 2>&1 && break; done
if curl -fsS -m 10 "https://$HOSTNAME_CF/healthz"; then echo; echo "Tunnel up: https://$HOSTNAME_CF (agent $LABEL, log $ALTEA_HOME/logs/cloudflared.log)"; else echo "tunnel not answering yet; see $ALTEA_HOME/logs/cloudflared.log (DNS can take a minute)"; fi
echo "Next: bash scripts/remote-install.sh --public-url https://$HOSTNAME_CF --tunnel-label $LABEL --member \"Your Name\""
