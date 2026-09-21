#!/usr/bin/env bash
# Run ON the Mac where you do `altea login`. Installs a launchd agent that copies the signed-in session to the
# serving Mac whenever ~/.altea/cookies.json changes (and every 6 h as a safety net), so after a re-login the
# remote server is updated without you doing anything.
#   bash scripts/install-push-agent.sh user@serving-mac
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-}"; [ -n "$TARGET" ] || { echo "usage: $0 user@serving-mac"; exit 1; }
NODE="$(command -v node)"; [ -n "$NODE" ] || { echo "node not found"; exit 1; }
LABEL="com.altea.push-session"; ALTEA_HOME="${ALTEA_HOME:-$HOME/.altea}"; mkdir -p "$ALTEA_HOME/logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"; mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/bin/altea.mjs</string><string>remote</string><string>push</string><string>$TARGET</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
    <key>ALTEA_HOME</key><string>$ALTEA_HOME</string>
  </dict>
  <key>WatchPaths</key><array><string>$ALTEA_HOME/cookies.json</string></array>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$ALTEA_HOME/logs/push.log</string>
  <key>StandardErrorPath</key><string>$ALTEA_HOME/logs/push.log</string>
</dict></plist>
PL
UID_N="$(id -u)"
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
launchctl bootstrap "gui/$UID_N" "$PLIST" 2>/dev/null || launchctl kickstart -k "gui/$UID_N/$LABEL"
echo "Installed $LABEL: pushes $ALTEA_HOME/{cookies,actions,meta}.json to $TARGET on change and every 6 h (log: $ALTEA_HOME/logs/push.log)."
