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
(`which node`) because GUI apps don't inherit your shell PATH. For phones and other computers see
[Use it from anywhere](#use-it-from-anywhere-phone-watch-any-laptop).

Times are shown in your club's local time zone (auto-detected from the app; `ALTEA_TZ` overrides).

Then ask naturally: "what's on at Altea tomorrow evening?", "next Hot Yin?", "book me into the 9 am Main Stage
Ride", "cancel my Sunday class". The assistant will confirm before it books or cancels.

## Use it from anywhere (phone, watch, any laptop)
The stdio server above only serves the Mac it runs on. To reach the same tools from the Claude iOS/Android apps,
claude.ai on any computer, or Claude Code elsewhere, run the **remote** server on a Mac that stays on (a Mac
mini, an old laptop) and add it to claude.ai as a custom connector. Anthropic's servers talk to it over HTTPS, so
it needs a public URL; [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) gives you one for free (no domain,
valid certificate, only the port you choose is exposed). Cloudflare Tunnel or any TLS reverse proxy works too.

What you get: the full tool set over Streamable HTTP at `<public-url>/mcp`, behind OAuth 2.1 (dynamic client
registration, PKCE) with a single passphrase you type once per client. Tokens are stored hashed under
`~/.altea/oauth`; access tokens last 7 days and refresh silently for 180 days.

**Port 443 only.** claude.ai's connector client silently ignores servers on any other port (Claude Code is
fine with `:8443`), so the public URL must be `https://<hostname>/…` with no port. A Mac's own MagicDNS name can
carry one Funnel per port; if its 443 is free, use it directly. If something else already serves 443 on that
Mac, give the endpoint its own node name first:
```bash
bash scripts/remote-tailscale-node.sh --hostname altea      # userspace tailscaled as a launchd agent, no root;
                                                            # prints a login URL: open it to approve the node
```

**Own a domain on Cloudflare?** A Cloudflare Tunnel is the other way to get a port-443 URL, and the one to use when
this Mac's Tailscale name cannot carry the Funnel: `cloudflared tunnel login` once, then
`bash scripts/remote-cloudflare-tunnel.sh --hostname altea.example.com` (tunnel + DNS record + launchd agent), and
run the installer below with `--public-url https://altea.example.com --tunnel-label com.altea.cloudflared` and no
`--funnel`.

**On the serving Mac** (Tailscale installed and signed in, [Funnel enabled](https://tailscale.com/kb/1223/funnel#setup)):
```bash
git clone https://github.com/noorabdalla04/altea-mcp.git && cd altea-mcp
bash scripts/remote-install.sh --public-url https://<hostname>.<tailnet>.ts.net --funnel --member "Your Name" \
     [--tailscale-socket ~/.altea/tailscale/tailscaled.sock]   # only with a dedicated node
```
This installs a launchd agent (`com.altea.mcp-http`, restarts on failure and at login), starts the server on
`127.0.0.1:8788`, turns the Funnel on for port 443, and prints the **passphrase**. Bookings open a real Chrome
window on that Mac (`ALTEA_WINDOW=visible`), which nobody is looking at anyway. Public DNS for a new Funnel name
can take 10 minutes to appear.

**On the Mac where you sign in** (the serving Mac never sees your Altea password):
```bash
node bin/altea.mjs login                                   # once, and again when the session expires
node bin/altea.mjs remote push user@serving-mac            # copies ~/.altea/{cookies,actions,meta}.json over ssh
bash scripts/install-push-agent.sh user@serving-mac        # optional: do the push automatically after every login
```
The running server picks up a pushed session on its next request. In practice the session renews itself while
the server is used (the app extends the cookie on every request), so re-logins are rare.

**Connect a client** (once per client; the passphrase page appears in your browser):
* claude.ai → Settings → Connectors → *Add custom connector* → URL `https://<hostname>.<tailnet>.ts.net/mcp`.
  The connector then shows up in the Claude apps on your phone and in Claude Desktop automatically (connectors are
  added on the web and synced; the free plan allows one custom connector).
* Claude Code: `claude mcp add --transport http altea https://<hostname>.<tailnet>.ts.net/mcp`, then `/mcp` to sign in.
* Any other MCP client that speaks Streamable HTTP + OAuth (MCP Inspector, Cursor with an allowed redirect host).

Staying up: the launchd agent restarts the server on failure and at login; a second agent (`com.altea.watchdog`,
every 5 minutes) restarts it if `/healthz` fails, relaunches Tailscale (the app, or the dedicated node's daemon)
if it stopped, and re-enables the Funnel if it or its public DNS record disappears. The server also refreshes the gym session every 4 hours
(`ALTEA_KEEPALIVE_MIN`, 0 disables), which keeps the sliding-window cookie alive indefinitely. For a Mac that must
survive reboots unattended, turn on automatic login for that user (System Settings → Users & Groups; requires
FileVault off) and disable key expiry for the machine in the Tailscale admin console.

Operations: `node bin/altea.mjs remote status <url>` (health, registered clients, live tokens),
`remote revoke` (sign every client out), `remote passphrase --rotate`. Logs: `~/.altea/logs/http.log`.
Only claude.ai / claude.com and loopback redirect URIs are accepted at registration; add hosts with
`ALTEA_OAUTH_REDIRECT_HOSTS=host1,host2`. Five wrong passphrases lock the sign-in page for 15 minutes.

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
| `ALTEA_PUBLIC_URL` | `http://localhost:<port>` | remote server: the public origin clients use (OAuth issuer + resource) |
| `ALTEA_HTTP_PORT` / `ALTEA_HTTP_HOST` | 8788 / 127.0.0.1 | remote server bind address (keep it on loopback behind the tunnel) |
| `ALTEA_OAUTH_DIR` / `ALTEA_OAUTH_REDIRECT_HOSTS` | `~/.altea/oauth` / claude.ai,claude.com | token store; extra hosts allowed as OAuth redirect targets |
| `ALTEA_ACCESS_TOKEN_TTL_S` / `ALTEA_REFRESH_TOKEN_TTL_S` | 604800 / 15552000 | token lifetimes (7 days / 180 days) |
| `ALTEA_TRUST_PROXY` | `1` | set `0` when the remote server is not behind a reverse proxy |

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
