# altea — personal MCP + CLI for the Altea Active booking app

Lets Claude (or you, from a shell) read the Altea Ottawa schedule, see who's teaching and how
many spots are left, list your bookings, and book / cancel / waitlist — through the same
requests the web app makes. See `API.md` for the reverse-engineered protocol.

## Layout
```
.bin/altea/
  altea.mjs        CLI  (node altea.mjs <cmd> …)
  mcp-server.mjs   MCP stdio server (registered as `altea` at user scope)
  inpage.js        read-only helper to paste into a logged-in browser tab (fallback)
  lib/rsc.mjs      React Flight payload parser (byte-accurate text rows)
  lib/discover.mjs per-deploy server-action id discovery (+ cache ~/.altea/actions.json)
  lib/session.mjs  cookie jar + fast fetch; Playwright persistent Chrome profile for login
                   and for the bot-guarded booking POST
  lib/client.mjs   Altea client: schedule/find/event/bookings/book/cancel/waitlist/meta/status
  API.md           protocol reference
~/.altea/
  profile/         Chrome user-data-dir (signed-in session)   cookies.json  exported jar
  actions.json     discovered action ids                       meta.json    clubs/types/instructors
```

## Setup
```bash
cd ~/Projects/altea-mcp && npm install          # playwright-core, @modelcontextprotocol/sdk, zod
node altea.mjs login                             # opens Chrome; sign in once; cookies persist
node altea.mjs status                            # signedIn: true
claude mcp add -s user altea -- node ~/Projects/altea-mcp/bin/mcp-server.mjs   # done already
```

## CLI
```bash
node altea.mjs schedule tomorrow --days 3                 # Boutique Fitness, Altea Ottawa
node altea.mjs schedule sat --group pickleball --available
node altea.mjs schedule +2 --instructor timo --type strength
node altea.mjs find "main stage" --days 14
node altea.mjs event evt_…                                # description, my booking, policy, options
node altea.mjs bookings                                   # upcoming 30 days, cancel deadlines
node altea.mjs book evt_…                                 # real booking (default membership + card)
node altea.mjs cancel evt_…  |  cancel bkg_…  [--force]  # refuses late cancels unless --force
node altea.mjs waitlist join|leave evt_…
node altea.mjs meta | actions --refresh | status
```
Dates: `YYYY-MM-DD | today | tomorrow | mon..sun | +N`. Add `--json` for machine output,
`--verbose` for timings, `--community toronto` for another club.

## MCP tools
`altea_status`, `altea_schedule`, `altea_find`, `altea_event`, `altea_bookings`, `altea_book`,
`altea_cancel`, `altea_waitlist`, `altea_meta`, `altea_actions`. New MCP servers load at
session start, so a session started before registration won't have them.

## Measured (2026-09-19, Ottawa)
| Call | Path | Time |
| --- | --- | --- |
| schedule, one day (~105-160 KB) | Node fetch | 1.2-1.7 s (server render dominates) |
| schedule, 5 days | Node fetch, parallel | 2.5 s |
| cancel | Node `POST /` | 0.7-0.9 s |
| book | headed Chrome, in-page `POST /booking/<id>` | 3.9 s warm profile (+ ~2 s cold) |

## How it works (and why it's built this way)
* No public API exists: the site is Next.js; reads are RSC payloads, writes are server actions
  whose ids change every deploy → discovered from the JS bundles and cached per build.
* Session = HttpOnly cookies. They are exported from the Chrome profile once after login;
  every read and the cancel action run from Node with that jar (fast, no browser).
* `POST /booking/*` is guarded by Vercel BotID/Kasada (`x-is-human`). Booking and
  waitlist-join therefore run inside a real page of the persistent profile
  (`page.evaluate(fetch)`), so the site's own SDK mints the proof. Cancel posts to `/`,
  which is unguarded.
* Guardrails in the client: refuses late cancellations (fee) and bookings with unsigned
  waivers / conflicts / closed booking window unless `force`.

## Known limits
* Session expiry (Firebase session cookie) → `NOT_SIGNED_IN` → run `node altea.mjs login`.
* If Altea redeploys and payload shapes change, the parser or payload builder may need a
  patch; action ids alone are handled automatically (`actions --refresh`).
* Headless Chrome IS rejected: the action runs but the backend answers "We are unable to
  process your booking at this time" (bot verdict). Book / waitlist-join therefore open a real
  Chrome window for ~4 s and close it. `ALTEA_HEADLESS=1` forces headless if that ever changes.
* Two processes can't share the profile directory; the second one falls back to a temporary
  context seeded from `cookies.json` automatically.
* Personal data in payloads (address, phone, cards) is never returned by the tools.
