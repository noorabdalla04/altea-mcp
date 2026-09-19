# Altea MCP

Personal MCP server + CLI for the **Altea Active** booking app (myaltea.app), built for Altea Ottawa.
Lets Claude answer things like *"which sessions does Omar run on Monday?"*, *"how many spots are left
in the next Hot Yin?"*, *"any pickleball courts open tomorrow at 3 pm?"*, and book, cancel or
waitlist on request. See `docs/questions.md` for the question → tool cookbook and `API.md` for the
reverse-engineered protocol.

## Membership rules the tool enforces
| Rule | Behaviour |
| --- | --- |
| **8-hour cancellation** | `cancel` refuses inside the window unless `force`; every booking carries its free-cancel deadline (start − 8 h) and the fee. |
| **48-hour booking window** | `book` refuses before the window opens and says when it opens; `event`/`next` report `bookableFrom` / `bookableNow`. The app itself reports 2940 min (49 h) for the Gold perk; the app's value wins when present. |

## Layout
```
bin/altea.mjs        CLI                      src/client.mjs   Altea client (schedule/find/next/who/event/bookings/book/cancel/waitlist)
bin/mcp-server.mjs   MCP stdio server         src/session.mjs  cookie jar, fast fetch, Chrome profile (login + guarded POSTs)
skills/altea/        Claude skill             src/rsc.mjs      React Flight payload parser        src/discover.mjs  server-action id discovery
scripts/install.sh   deps + MCP + skill       scripts/make-fixture.mjs  scrubbed fixtures     scripts/mcp-smoke.mjs  stdio smoke test
browser/inpage.js    read-only pane helper    test/            node --test (parser, time, filters, rules, fixtures)
~/.altea/            profile/ (signed-in Chrome), cookies.json, actions.json, meta.json   (never in git)
```

## Setup
```bash
git clone git@github.com:noorabdalla04/altea-mcp.git ~/Projects/altea-mcp && cd ~/Projects/altea-mcp
bash scripts/install.sh          # npm install, `claude mcp add -s user altea …`, copies the skill to ~/.claude/skills/altea
node bin/altea.mjs login         # opens Chrome once; sign in; cookies persist
node bin/altea.mjs status        # signedIn: true
npm test                         # 11 unit tests, no network
```
Requires macOS with Google Chrome and Node 22+. The MCP tools appear in Claude Code sessions started after registration.

## CLI
```bash
altea who omar mon                                   # everything Omar teaches next Monday, all groups
altea next hot yin                                   # next Hot Yin: spots, waitlist, bookable now?
altea schedule tomorrow --group pickleball --at 3pm --available   # courts open at 3 pm
altea schedule tomorrow --days 3 --instructor timo   # Boutique Fitness by default
altea schedule sat --all --tod evening               # every group, evening band
altea find "reformer level 2" --days 7
altea event evt_…                                    # description, my booking, policy, options, waitlist
altea bookings                                       # upcoming 30 days with free-cancel deadlines
altea book evt_… | altea cancel evt_… [--force] | altea waitlist join|leave evt_…
altea meta | rules | actions --refresh | status
```
`node bin/altea.mjs …` if not linked. Dates: `YYYY-MM-DD | today | tomorrow | mon..sun | next mon | +N`.
Times: `15:00 | 3pm | 3:30pm`. `--json` for machine output, `--verbose` for timings, `--community toronto` for another club.

## MCP tools
`altea_status`, `altea_schedule`, `altea_find`, `altea_next`, `altea_instructor`, `altea_event`, `altea_bookings`,
`altea_book`, `altea_cancel`, `altea_waitlist`, `altea_meta`, `altea_actions`. Filters shared by the read tools:
`instructor`, `type`, `studio`, `query`, `availableOnly`, `mine`, `after`, `before`, `at` (+`near`), `timeOfDay`,
`group` (`"all"` for every calendar group of the club).

## Measured (2026-09-19, Altea Ottawa)
| Call | Path | Time |
| --- | --- | --- |
| one day, one group (100–170 KB payload) | Node fetch | 1.2–1.7 s (server render) |
| one day, all 6 groups | Node fetch, parallel | 1.9 s |
| 5 days, one group | Node fetch, parallel | 2.5 s |
| `next hot yin` (3-day chunks, all groups, + detail) | Node fetch | 2.5 s |
| cancel / waitlist leave | Node `POST /` | 0.7–0.9 s |
| book / waitlist join | headed Chrome, in-page `POST /booking/<id>` | 3.9–4.0 s |
Repeated reads within 45 s are served from an in-process cache (`ALTEA_CACHE_TTL_MS`); writes clear it.

## How it works
* No public API: the site is Next.js. Reads are React Server Component payloads; writes are server
  actions whose ids are per-deploy hashes, discovered from the JS bundles and cached per build.
* Auth is HttpOnly cookies, exported once from the Chrome profile after `login`. All reads and the
  cancel / waitlist-leave actions run from Node with that jar.
* `POST /booking/*` is guarded by Vercel BotID (Kasada). Booking and waitlist-join therefore run inside a
  real page of the persistent profile; **headless Chrome is refused by the backend** ("unable to process
  your booking"), so those two calls open a visible Chrome window for ~4 s and close it.
* Nothing personal is returned by the tools (no address, phone, card details), and fixtures are scrubbed.

## Known limits
* Session expiry → `NOT_SIGNED_IN` → `node bin/altea.mjs login`.
* A redeploy that changes payload shapes needs a parser patch; changed action ids are handled (`actions --refresh`).
* Two processes cannot share the Chrome profile; the second falls back to a temporary context seeded from `cookies.json`.
* The built-in Claude browser pane cannot book/cancel (its tools are classifier-gated); use the MCP/CLI.
