#!/usr/bin/env bash
# One-shot setup on a Mac with Chrome + Node 22+: deps, MCP registration (user scope), skill copy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" && npm install --no-fund --no-audit
claude mcp remove -s user altea >/dev/null 2>&1 || true
claude mcp add -s user altea -- node "$ROOT/bin/mcp-server.mjs"
mkdir -p ~/.claude/skills/altea && cp "$ROOT/skills/altea/SKILL.md" ~/.claude/skills/altea/SKILL.md
echo "Installed. Next: node bin/altea.mjs login   (sign in once in the Chrome window)"
