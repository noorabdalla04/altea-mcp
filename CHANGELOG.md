# Changelog

## 0.2.0 — 2026-09-19
- Standalone repo (moved out of the Personal vault); `scripts/install.sh` registers the MCP server and skill.
- New queries: `next` (next occurrence + next with spots + waitlist + booking window), `who`/`altea_instructor`
  (all groups, "did you mean"), `find` across all groups by default, `--group all`, `at`/`near` time filters,
  natural times ("3pm"), "next mon" dates.
- Membership rules as constants (8 h cancel, 48 h booking window) with fallbacks when the app omits them.
- In-process 45 s read cache; writes invalidate it.
- Headed Chrome by default for the bot-guarded routes (headless is refused by the backend); window closes after the call.
- Deep-search parsing (events, booking context, bookings, reference lists) — robust to nesting changes.
- Unit tests (`npm test`) with scrubbed fixtures; MCP smoke test with `--live` example questions.

## 0.1.0 — 2026-09-19
- First working client: RSC parser, server-action discovery, cookie-jar session, Playwright login,
  schedule/event/bookings reads, book/cancel/waitlist actions, MCP server, CLI.
