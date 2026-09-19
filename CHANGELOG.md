# Changelog

## 0.3.0 — 2026-09-19 (MCP hardening after research; see docs/mcp-design.md)
- Every tool has a title, a "new hire" description (what / when / when-not / cost), strict described inputs,
  an output schema with `structuredContent`, and behaviour annotations (reads `readOnlyHint`, cancel
  `destructiveHint`, book/cancel/waitlist `idempotentHint`).
- Concise results by default (text lines + minimal structured list, `status`/`summary`), `format: detailed`
  for ids/urls/descriptions, `limit` with truncation notices.
- Typed errors: `ERROR[CODE]` with retry-safety and the next valid action (NOT_SIGNED_IN, BAD_INPUT, NOT_FOUND,
  WINDOW_NOT_OPEN, LATE_CANCEL, EVENT_FULL, CONFLICT, UNSIGNED_AGREEMENT, NO_MEMBERSHIP, UNKNOWN_ACTION, UPSTREAM, TIMEOUT).
- Server instructions (rules, defaults, sequencing, confirmation policy); resources `altea://rules`,
  `altea://meta`, `altea://bookings/upcoming`, `altea://schedule/{date}`; prompts `altea-day-brief`, `altea-book-request`.
- Mutations serialised (mutex) and time-boxed; reads time-boxed; server split into `src/server.mjs` (transport-agnostic).
- In-process protocol tests over `InMemoryTransport` with a stub client (metadata, rendering, errors, resources, prompts, timeout).

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
