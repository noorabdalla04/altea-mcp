#!/usr/bin/env bash
# One-shot setup for Claude Code on macOS: deps, MCP registration (user scope), skill copy.
#   bash scripts/install.sh [--member "Your Name"] [--community "Altea Toronto"]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MEMBER=""; COMMUNITY=""
while [ $# -gt 0 ]; do case "$1" in --member) MEMBER="$2"; shift 2;; --community) COMMUNITY="$2"; shift 2;; *) echo "unknown option $1"; exit 1;; esac; done
NODE="$(command -v node)"; [ -n "$NODE" ] || { echo "node not found (need Node 22+)"; exit 1; }
cd "$ROOT" && npm install --no-fund --no-audit
if command -v claude >/dev/null 2>&1; then
  claude mcp remove -s user altea >/dev/null 2>&1 || true
  ENVS=()
  [ -n "$MEMBER" ] && ENVS+=(-e "ALTEA_MEMBER_NAME=$MEMBER")
  [ -n "$COMMUNITY" ] && ENVS+=(-e "ALTEA_COMMUNITY=$COMMUNITY")
  claude mcp add -s user altea ${ENVS[@]+"${ENVS[@]}"} -- "$NODE" "$ROOT/bin/mcp-server.mjs"
  mkdir -p ~/.claude/skills/altea && cp "$ROOT/skills/altea/SKILL.md" ~/.claude/skills/altea/SKILL.md
  echo "Registered MCP server 'altea' for Claude Code and installed the skill."
else
  echo "claude CLI not found; add the server manually (see README: Claude Desktop / other clients)."
fi
echo "Next: node bin/altea.mjs login   (sign in once in the Chrome window), then node bin/altea.mjs status"
