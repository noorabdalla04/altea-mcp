# Changelog

## 0.4.1 — 2026-09-19
- Second-pass review fixes: time-zone-independent date parsing (CI was red on UTC runners); the club's own
  time zone is used for rendering and the `tz` cookie (`ALTEA_TZ` overrides); install script works on macOS
  bash 3.2; fixture script runs again; browser helper detects the club; MCP server shuts down (and closes any
  Chrome) when the host disconnects; real `--help`; unknown commands exit 1; eval queries configurable per club.
- Commit authorship rewritten to the GitHub noreply address.

## 0.4.0 — 2026-09-19 (public release)
- Open-sourced under MIT; personal references removed (member name, home club and rule windows are
  configurable; the home club is auto-detected from the signed-in session).
- Audit fixes: cancel-by-bookingId now checks the 8 h policy; bookings use the app's single upcoming window and
  count past days per month; paid membership options are never chosen implicitly (`PAID_OPTION`) and `force`
  never bypasses waivers; linked-account bookings are no longer mistaken for yours; reference data is unioned
  across days; cookies are written atomically and reloaded after browser use; bounded read cache; non-cancellable
  bookings rendered as such; discovery keeps last-good action ids and warns loudly; bot-SDK readiness is awaited.
- Token-lean results: compact events in concise mode, long slot series (recovery pods, courts) collapsed into one
  line, permissive output schemas; group aliases (courts, recovery, kids, pool, rx); range dates ("this week",
  "next week", "weekend"); ambiguous times and yearless dates are rejected instead of guessed.
- Fixtures scrubbed by `scripts/scrub.mjs` (embedded images and signatures removed; history rewritten); PII test.
- CI workflow, `.nvmrc`, install script with `--member` / `--community`.

## 0.3.1 — 2026-09-19
- Quiet booking: window modes `auto` (hidden → visible fallback), `hidden`, `visible`, `headless`; hidden mode
  hides the Chrome process via System Events right after launch. Measured: headless is refused for bookings
  but accepted for waitlist joins; an off-screen window is clamped on-screen by macOS; posting guarded
  actions to `/` from Node is tarpitted.
- Fetch timeouts on every request (30 s reads, 60 s actions); PII (email, user id) stripped from raw action results.

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
