# Altea MCP

[![test](https://github.com/noorabdalla04/altea-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/noorabdalla04/altea-mcp/actions/workflows/test.yml)

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) server and CLI for the **Altea Active**
booking app (myaltea.app). It lets an AI assistant such as Claude answer *"which sessions does instructor X run on
Monday?"*, *"how many spots are left in the next Hot Yin?"*, *"any pickleball courts open tomorrow at 3 pm?"*,
list your bookings with their cancellation deadlines, and book, cancel or join a waitlist when you ask.

It talks to the app the way your browser does (same session, same requests), runs entirely on your Mac, and
never stores your password. Not affiliated with Altea Active.

## What you need
- macOS with Google Chrome installed (the booking action must run inside a real Chrome page; see *How it works*).
- Node.js 22 or newer.
- An Altea Active membership.
- Optional: [Claude Code](https://docs.anthropic.com/claude-code) or Claude Desktop to use it as an MCP server.

## Quick start
```bash
git clone https://github.com/noorabdalla04/altea-mcp.git && cd altea-mcp
npm install
node bin/altea.mjs login      # opens Chrome once; sign in to myaltea.app; cookies are saved to ~/.altea
node bin/altea.mjs status     # signedIn: true, your home club, session expiry
node bin/altea.mjs schedule tomorrow
```
Everything lives in `~/.altea/` (Chrome profile, cookie jar, caches). Delete that folder to sign out completely.

## Use it from Claude
**Claude Code** (one command, registers the server for every project and installs the skill):
```bash
bash scripts/install.sh --member "Your Name"            # add --community "Altea Toronto" to override the detected home club
```
**Claude Desktop**: add to `~/Library/Application Support/Claude/claude_desktop_config.json` and restart the app:
```json
{ "mcpServers": { "altea": {
    "command": "/opt/homebrew/bin/node",
    "args": ["/absolute/path/to/altea-mcp/bin/mcp-server.mjs"],
    "env": { "ALTEA_MEMBER_NAME": "Your Name" } } } }
```
**Any other MCP client**: stdio transport, command `node bin/mcp-server.mjs`. Use an absolute path to `node`
(`which node`) because GUI apps don't inherit your shell PATH.

Times are shown in your club's local time zone (auto-detected from the app; `ALTEA_TZ` overrides).

Then ask naturally: "what's on at Altea tomorrow evening?", "next Hot Yin?", "book me into the 9 am Main Stage
Ride", "cancel my Sunday class". The assistant will confirm before it books or cancels.

## Membership rules the tool enforces
| Rule | Behaviour | Override |
| --- | --- | --- |
| Cancellation window (default 8 h) | `cancel` refuses inside the window and quotes the fee and deadline; every booking carries its free-cancel deadline | `force` after you confirm; `ALTEA_CANCEL_WINDOW_MIN` |
| Booking window (default 48 h) | `book` refuses before the window opens and says when it opens; `event` and `next` report `bookableNow` | `force`; `ALTEA_BOOKING_WINDOW_MIN` |
| Waivers, paid options, cards | never signed, never bought implicitly, never added; `force` does not bypass these | pass `perkId` explicitly to buy a paid option |
The app's own values (per membership option) take precedence over the defaults whenever it reports them.

## CLI
```bash
node bin/altea.mjs who x mon                          # everything instructor X teaches next Monday, all groups
node bin/altea.mjs next hot yin                          # next Hot Yin: spots, waitlist, bookable now?
node bin/altea.mjs schedule tomorrow --group courts --at 3pm --available
node bin/altea.mjs schedule "this week" --instructor timo
node bin/altea.mjs find "reformer level 2" --days 7
node bin/altea.mjs event evt_…                           # description, my booking, policy, options, waitlist
node bin/altea.mjs bookings                              # upcoming, with free-cancel deadlines
node bin/altea.mjs book evt_…  |  cancel evt_… [--force]  |  waitlist join|leave evt_…
node bin/altea.mjs meta | rules | actions --refresh | status
```
Dates: `YYYY-MM-DD | today | tomorrow | mon..sun | next mon | +N | "this week" | "next week" | "weekend"`.
Times: `15:00 | 3pm | 3:30pm`. Groups: `Boutique Fitness` (default), `Pickleball`/`courts`, `Aquatics`/`pool`,
`Recovery & Wellness`/`recovery`, `Personalized Performance`/`rx`, `Active Kids Club`/`kids`, or `all`.
`--json` for machine output, `--verbose` for timings, `--community "Altea Toronto"` for another club.

## MCP surface
| Tool | Annotations | Purpose |
| --- | --- | --- |
| `altea_status` | read | session, home club, cookie expiry, rules, action ids |
| `altea_schedule` | read | day/range listing with filters (`instructor`, `type`, `studio`, `query`, `availableOnly`, `mine`, `after`, `before`, `at`+`near`, `timeOfDay`, `group` incl. `"all"`) |
| `altea_find` | read | words across all groups for N days |
| `altea_next` | read | next occurrence + next with spots, waitlist, booking window |
| `altea_instructor` | read | an instructor's sessions across all groups, "did you mean" |
| `altea_event` | read | one session in depth: booking, window, options, conflicts, waivers |
| `altea_bookings` | read | upcoming bookings with free-cancel deadlines (past days counted only) |
| `altea_book` | additive, idempotent | book (guards: window, full, conflict, paid option, waiver) |
| `altea_cancel` | destructive, idempotent | cancel (guard: late cancel, always checked) |
| `altea_waitlist` | additive, idempotent | join / leave |
| `altea_meta`, `altea_actions` | read | reference data, action-id refresh |

Results are concise text plus compact `structuredContent`; long runs of identical slots (recovery pods, courts)
collapse into one series line. `format: "detailed"` returns full objects with ids and descriptions; `limit` caps
per-day lists. Errors read `ERROR[CODE]: … Retry safe: yes|no. Next: …` (codes: NOT_SIGNED_IN, BAD_INPUT,
NOT_FOUND, WINDOW_NOT_OPEN, LATE_CANCEL, EVENT_FULL, CONFLICT, UNSIGNED_AGREEMENT, NO_MEMBERSHIP, PAID_OPTION,
UNKNOWN_ACTION, UPSTREAM, TIMEOUT). Resources: `altea://rules`, `altea://meta`, `altea://bookings/upcoming`,
`altea://schedule/{date}`. Prompts: `altea-day-brief`, `altea-book-request`. Design notes and the checklist the
server was validated against: `docs/mcp-design.md`; question → tool cookbook: `docs/questions.md`.

## Configuration (environment variables)
| Variable | Default | Meaning |
| --- | --- | --- |
| `ALTEA_MEMBER_NAME` | `the member` | how the assistant refers to you in tool text |
| `ALTEA_COMMUNITY` | auto-detected home club | club name or `com_…` id |
| `ALTEA_DEFAULT_GROUP` | `Boutique Fitness` | group used for plain schedule questions |
| `ALTEA_CANCEL_WINDOW_MIN` / `ALTEA_BOOKING_WINDOW_MIN` | 480 / 2880 | rule fallbacks in minutes |
| `ALTEA_WINDOW` | `auto` | `auto` (hidden, then visible if refused), `hidden`, `visible`, `headless`; `ALTEA_QUIET_MODE` picks what `auto` tries first; `ALTEA_HEADLESS=1` is shorthand for headless |
| `ALTEA_TZ` | the club's zone (auto-detected; Toronto fallback) | time zone for rendering and for the app's `tz` cookie |
| `ALTEA_HOME` | `~/.altea` | where the profile, cookies and caches live |
| `ALTEA_CACHE_TTL_MS` / `ALTEA_CONCURRENCY` | 45000 / 8 | read cache and parallel fetches |
| `ALTEA_READ_TIMEOUT_MS` / `ALTEA_ACTION_TIMEOUT_MS` / `ALTEA_LAUNCH_TIMEOUT_MS` | 30000 / 60000 / 60000 | request and Chrome launch budgets |

## How it works
* The app is a Next.js site with no public API: reads are React Server Component payloads (parsed by
  `src/rsc.mjs`), writes are Next.js server actions whose ids change on every deploy (discovered from the JS
  bundles by `src/discover.mjs` and cached).
* Auth is the app's own HttpOnly session cookies, exported once from the Chrome profile after `login`; reads and
  the cancel / waitlist-leave actions run from Node with that cookie jar.
* `POST /booking/*` is guarded by Vercel BotID (Kasada), so booking and waitlist-join run inside a real Chrome
  page of the persistent profile. Headless Chrome is refused for bookings, and an off-screen window is clamped
  back on-screen by macOS, so the default `hidden` mode hides the Chrome process via System Events right after
  launch (a blank window can flash for about half a second) and falls back to a visible window if refused.
* Tools never return your address, phone or card details (only masked card labels in the event view). Test
  fixtures are scrubbed with `scripts/scrub.mjs`; a test fails if personal data ever lands in them.

## Measured (Altea Ottawa, 2026-09)
| Call | Path | Time |
| --- | --- | --- |
| one day, one group (100–170 KB payload) | Node fetch | 1.2–1.7 s |
| one day, all 6 groups | parallel | 1.9 s |
| 7 days, all groups | parallel | 7.6 s |
| cancel / waitlist leave | Node `POST /` | 0.7–0.9 s |
| book / waitlist join | hidden Chrome | 5–8 s |

## Development
```bash
npm test          # unit + in-process MCP protocol tests (no network)
npm run eval      # live: real questions through the server with assertions (needs a signed-in session)
npm run smoke     # stdio smoke test; add --live for example calls
node scripts/make-fixture.mjs   # refresh scrubbed fixtures from your own session
```

## Caveats
* Session cookies expire (Firebase, roughly two weeks); tools then return `NOT_SIGNED_IN` and you run `login` again.
* A redeploy that changes payload shapes needs a parser update; changed action ids are handled automatically.
* Two processes can't share the Chrome profile; a second one falls back to a temporary context seeded from the cookie jar.
* Please be considerate: each day fetch is a full server render on Altea's side. Polling every minute for spots is not what this is for.
* Use at your own risk: bookings and cancellations are real, and late cancellations cost money.

## License
MIT. See `LICENSE`.
