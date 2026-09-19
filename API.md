# myaltea.app — reverse-engineered API reference (2026-09-19)

Platform: white-label "Greco Fitness Platform" (Firebase project `greco-fitness-platform`,
backend on App Engine) fronted by a Next.js App Router site on Vercel. The browser never
talks to the backend directly: **all data arrives as React Server Component (RSC) payloads
and all writes are Next.js Server Actions.** There is no REST/GraphQL surface to call.

## Auth
- Sign-in at `https://auth.myaltea.app/?returnTo=…` (email+password or Google) → Firebase
  custom token → session cookies on `myaltea.app` (HttpOnly). No tokens in localStorage/IndexedDB.
- Every path returns HTTP 200 even when signed out (the auth redirect is client-side).
  Signed-in payloads contain `"currentUser"` / `"eventsPromise"` / `"bookingsPromise"` /
  `"bookingContextPromise"`; signed-out ones contain the `auth.myaltea.app` redirect target.
- Cookie `tz=America%2FToronto` selects the rendering time zone (`x-user-tz` on responses).
- Kasada/Vercel BotID guards exactly `{"method":"POST","path":"/booking/*"}`: POSTs to an
  event page must carry an `x-is-human` proof minted by the in-page SDK (`/149e9513-…/p.js`).
  Everything else (all GETs, POSTs to `/`) is unguarded.

## Reads (GET + header `RSC: 1`, response `text/x-component`)
| Purpose | Path | Notes |
| --- | --- | --- |
| Day schedule | `/booking?date=DD-MM-YYYY&calendarGroup=<group>&communityId=<com_…>` | 100–170 KB. Events array is the row whose JSON is `[{"id":"evt_…"…}]`. Also carries event-type tags (`evttag_…`), instructor list (`res_…`), and the communities/calendar-groups list. Visible ≥30 days ahead. |
| Event detail + my booking context | `/booking/<evt_id>` | Row `{activeBookings, context, possibleBookings, waitlistedUsers}` (see below) plus the event object. |
| My bookings | `/?date=DD-MM-YYYY` | Row `[{canCancel, date, event:{…}, id: bkg_…, isCurrentUser, isWaitlist, perk:{cancellationWindow, cancellationPrice, …}, status, title, user}]` = ALL upcoming bookings (today → +3 months, whatever the date); row `[["YYYY-MM-DD",{"bookings":n,"linked":n,"waitlist":n}],…]` = per-day counts for the calendar month of `date`. Past details are not served. |
| Account / access | `/account`, `/access` | not used |

RSC row format: `id:<json>\n` or `id:T<hexByteLen>,<raw text>` (text rows have no newline
terminator → parse by byte length; see `src/rsc.mjs`). References: `"$@42"` promise → row 42.

### Event object (schedule + detail)
`id` (`evt_<series>_<epochMs>`), `type` (EVENT_SERIES_INSTANCE), `status`, `recurrence` (RRULE),
`communityId`, `communityName`, `imageUrl`, `startDate` (UTC ISO), `endDate`, `instanceDate`
(local), `timezone`, `title`, `duration` (min), `checkInWindow` (min), `calendar` (= studio),
`tags` {evttag_… → {label}}, `resources` {res_… → {name, imageUrl, description}} (= instructors),
`rooms`, `description` (HTML), `userBookingStatus` (null | "CONFIRMED" …), `waitlisted`, `spotsLeft`.

### Booking context (event detail)
```
activeBookings: [[ {id: userId, displayName, isChild, photoURL},
                   {id: "bkg_…", status: "CONFIRMED", bookedById, perk:{id, title, price, taxes,
                    cancellation:{enabled, refund, cancellationPrice (cents), cancellationWindow (min)}}} ]]
context.currentUser: { id, perks:[{perkId, userPerkId, title, price, unlimited, disabled,
                       bookingWindow (min before start when booking opens), dailyMaxUsages,
                       dailyUsages, expiryDate, cancellation:{…, shortText, longText}}],
                       paymentMethods:[{id: "pm_…", label "**** 1234", model, default, expired}],
                       signedAgreementIds, unsignedAgreements, eventConflicts, alerts, waitlist, booking }
context.bookingOptionAgreements / eventAgreements: waiver texts per perk
possibleBookings: [{ id: userId, defaultSelectedPerk: "<userId>__own__<perkId>|<userPerkId>|<price>|<unlimited>", … }]
waitlistedUsers: [...]
```
Observed policy (Ottawa Gold): cancellationWindow 480 min (8 h), fee $10.00 (Boutique) / $20.00
(LF3 Tread). `bookingWindow` 2940 min ≈ 49 h before start for LF3 Tread; check per perk.

## Writes (Next.js Server Actions)
`POST <page path>` with headers `Next-Action: <id>`, `Accept: text/x-component`,
`Content-Type: text/plain;charset=UTF-8`; body = JSON array of arguments. Response row 0 is
`{"a":"$@1",…,"b":"<buildId>"}`; row 1 is the return value; `x-action-revalidated: 1` when the
page was re-rendered. **Ids are per-deploy content hashes** → `src/discover.mjs` rediscovers them
from the JS chunks (`createServerReference("<id>",…,"<name>")`).

| Action (name in bundle) | Args | Route to post to |
| --- | --- | --- |
| `confirmBookingAction` | `[{eventId, bookings:[{agreements:[], equipment:"$undefined", paymentMethodId, perkId, perkUserId:userId, price, userPerkId, userId}]}]` | `/booking/<evt_id>` (guarded → in-page) |
| cancel (module `default` in the Cancel-Booking dialog chunk) | `[{bookingId}]` | `/` (unguarded, fast) |
| `joinWaitlistAction` | `[{eventId}]` (assumed) | `/booking/<evt_id>` |
| `leaveWaitlistAction` | `[{eventId}]` | `/` |
| `inviteGuestAction`, `setHomeCommunityIdAction`, `refreshAlertsAction` (`[]`), payment-method actions | — | — |

Build seen: `f3dOAM1S79fMn2A9ef5Tj` — confirm `7f381e56…`, cancel `7fb5b26a…`,
joinWaitlist `7f7026b6…`, leaveWaitlist `7f163105…`.

## Communities (Ottawa = `com_6ETcyzRKh3aCzpjKKhdT`)
Calendar groups at Altea Ottawa: Active Kids Club, Aquatics, Boutique Fitness (default),
Personalized Performance, Pickleball, Recovery & Wellness. Other clubs: Altea Toronto, West6,
Winnipeg, AVANT Yorkville, LF3 Little Italy, LF3 Online.

## Speed notes
- One day ≈ 120 KB, 150–400 ms from Node; 7 days in parallel ≈ 1 s. Parse cost is negligible.
- Cancel from Node ≈ 0.7–0.9 s. Booking needs a real page: ≈ 4 s visible, 5–8 s hidden. Headless Chrome passes
  the edge check and is accepted for `joinWaitlistAction`, but `confirmBookingAction` answers "unable to process
  your booking" (server-side bot verdict). Posting either guarded action to `/` or `/booking` from Node never
  gets a response (tarpit) — the in-page `x-is-human` proof is mandatory.
- Client-side filtering (instructor, type, studio, time, availability) is free; the app's own
  filter UI is purely client-side too.
- Be gentle with polling for spots (≥ 60 s); every day fetch renders a full page server-side.
