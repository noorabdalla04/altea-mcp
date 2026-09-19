---
name: altea
description: Book, cancel, waitlist, and debrief Altea Active gym classes and courts (myaltea.app, Altea Ottawa) for Noor. Use whenever Noor mentions Altea, "the gym app", "book me into", "cancel my class", "what classes are on", "who's teaching", "who runs", "spots left", "next <class>", reformer / LF3 / cycle / hot yoga / pickleball courts / recovery lounge, waitlists, or wants a schedule debrief. Uses the `altea` MCP tools first; falls back to the CLI at ~/Projects/altea-mcp/bin/altea.mjs.
---

# Altea booking skill

## What this governs
Noor's Altea Active membership at **Altea Ottawa** (`com_6ETcyzRKh3aCzpjKKhdT`). Calendar groups:
Boutique Fitness (default for plain class questions), Pickleball, Aquatics, Recovery & Wellness,
Personalized Performance, Active Kids Club. Use `group: "all"` for instructor questions, courts,
recovery, or anything not obviously a studio class. Times are America/Toronto.

## Membership rules (state them when relevant)
1. **Cancel at least 8 hours before start**, otherwise the late fee applies. `altea_cancel` refuses inside
   the window; tell Noor the deadline and fee and pass `force` only if he confirms.
2. **Booking opens 48 hours before start.** `altea_book` refuses earlier and says when it opens;
   `altea_event` / `altea_next` report `bookableFrom` and `bookableNow`.

## Tools (prefer MCP; CLI is equivalent: `node ~/Projects/altea-mcp/bin/altea.mjs …`)
| Question shape | MCP tool | CLI |
| --- | --- | --- |
| Who teaches / sessions by <name> on <day> | `altea_instructor {name, date, days}` | `who omar mon` |
| Next <class or activity>, spots left | `altea_next {query}` | `next hot yin` |
| Courts / classes at a time, open only | `altea_schedule {date, group, at:"3pm", availableOnly}` | `schedule tomorrow --group pickleball --at 3pm --available` |
| Day / week debrief with filters | `altea_schedule {date, days, instructor, type, studio, timeOfDay, after, before}` | `schedule tomorrow --days 3` |
| Search words across everything | `altea_find {query, days}` | `find "reformer level 2"` |
| One class in depth | `altea_event {eventId}` | `event evt_…` |
| My bookings + cancel deadlines | `altea_bookings` | `bookings` |
| Book / cancel / waitlist | `altea_book`, `altea_cancel`, `altea_waitlist` | `book`, `cancel`, `waitlist join\|leave` |
| Session check | `altea_status` | `status` |

Tool results are concise text + structured data; ask for `format: "detailed"` only when you need ids/urls for a
follow-up call. Errors read `ERROR[CODE]: … Next: …`; follow the Next hint (e.g. WINDOW_NOT_OPEN → say when it opens,
LATE_CANCEL → quote fee + deadline and ask before `force`). If the MCP tools are absent (registered after session
start) use the CLI via Bash. Never use the built-in
browser pane for book/cancel (blocked). `book` and `waitlist join` open a Chrome window for ~4 s; say so.
Reads take 1–2 s per day per group; all-groups ≈ 2 s per day; cancel < 1 s.

## Rules of engagement
1. Announce before any book/cancel/waitlist call (one line). Book or cancel only when Noor asked; for a
   question, answer first, then offer.
2. Never sign waivers, add payment methods, or invite guests on his behalf.
3. Debrief format: one line per event `time  title  studio  instructor  spots/FULL/BOOKED`, grouped by day,
   leading with what matches the ask. Mention waitlist size when full and the next occurrence with spots.
4. `NOT_SIGNED_IN` → tell Noor to run `node ~/Projects/altea-mcp/bin/altea.mjs login` (one-time Chrome
   sign-in). Never type his password.
5. After an Altea redeploy, if book/cancel error with an unknown action: `altea_actions {refresh:true}`, retry once.
6. Log a `manual | altea` entry in `~/Personal/log.md` only for bookings/cancellations actually made.

## Files
Repo `~/Projects/altea-mcp` (README.md, API.md, docs/questions.md), state in `~/.altea/`.
