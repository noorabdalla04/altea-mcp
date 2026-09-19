---
name: altea
description: Book, cancel, waitlist, and debrief Altea Active gym classes (myaltea.app, Altea Ottawa) for Noor. Use whenever Noor mentions Altea, "the gym app", "book me into", "cancel my class", "what classes are on", "who's teaching", "spots left", reformer / LF3 / cycle / hot yoga / pickleball courts, waitlists, or wants a schedule debrief. Uses the `altea` MCP tools first; falls back to the CLI at ~/Projects/altea-mcp/bin/altea.mjs.
---

# Altea booking skill

## What this governs
Noor's Altea Active membership at **Altea Ottawa** (`com_6ETcyzRKh3aCzpjKKhdT`). Default calendar
group **Boutique Fitness**; other Ottawa groups: Pickleball, Aquatics, Recovery & Wellness,
Personalized Performance, Active Kids Club. Times are America/Toronto.

## Tools (prefer MCP; CLI is equivalent)
| Need | MCP tool | CLI |
| --- | --- | --- |
| Session check | `altea_status` | `node ~/Projects/altea-mcp/bin/altea.mjs status` |
| Schedule / debrief | `altea_schedule {date, days, group, instructor, type, studio, availableOnly, after, before}` | `altea.mjs schedule <date> --days N …` |
| Search by words | `altea_find {query, from, days}` | `altea.mjs find "…" --days 7` |
| One class in depth | `altea_event {eventId}` | `altea.mjs event evt_…` |
| My bookings | `altea_bookings` | `altea.mjs bookings` |
| Book | `altea_book {eventId}` | `altea.mjs book evt_…` |
| Cancel | `altea_cancel {eventId|bookingId, force}` | `altea.mjs cancel evt_… [--force]` |
| Waitlist | `altea_waitlist {eventId, action}` | `altea.mjs waitlist join|leave evt_…` |
| Reference data | `altea_meta` | `altea.mjs meta` |

If the MCP tools are absent in this session (registered after session start), use the CLI via
Bash. Run mutations through the CLI/MCP only; the built-in browser pane blocks book/cancel.
`book` and `waitlist join` open a real Chrome window for about 4 s (headless is rejected by the
backend); warn Noor a window will flash. Reads take 1-2 s per day, cancel under 1 s.

## Rules
1. **Announce** before any book/cancel/waitlist call (one line). Book or cancel only when Noor
   asked for it; when he asks a question ("is there a reformer class tomorrow?") answer, then
   offer to book.
2. **Late cancellation**: the client refuses cancels inside the policy window (8 h at Ottawa,
   $10–$20 fee). Tell Noor the fee and deadline; pass `force` only if he confirms.
3. **Booking window**: `altea_event` reports `bookableFrom` per membership option (e.g. LF3 Tread
   opens ~49 h before start). If not open yet, say when it opens; do not `force`.
4. **Never** sign waivers, add payment methods, or invite guests on his behalf.
5. Debrief format: one line per class — `time  title  studio  instructor  spots/FULL/BOOKED` —
   grouped by day; lead with what matches his ask (instructor, type, time band). Mention
   waitlist size when a class is full.
6. `NOT_SIGNED_IN` → tell Noor to run `node ~/Projects/altea-mcp/bin/altea.mjs login` (Chrome
   window, one-time sign-in). Never type his password.
7. After an Altea redeploy, if book/cancel error with an unknown action, run
   `altea_actions {refresh:true}` (or `altea.mjs actions --refresh`) and retry once.
8. Log a `manual | altea` entry in `~/Personal/log.md` only for bookings/cancellations made
   (not for reads).

## Read-only fallback in the browser pane
Open `https://myaltea.app/booking` in the built-in browser (must be signed in), then paste the
contents of `~/Projects/altea-mcp/browser/inpage.js` into `javascript_tool`; it installs `window.A` with
`A.schedule(ymd, group)`, `A.days(ymd, n, group)`, `A.event(id)`, `A.bookings(ymd)`.

## Files
`~/Projects/altea-mcp/` (README.md, API.md, altea.mjs, mcp-server.mjs, lib/*), state in `~/.altea/`.
