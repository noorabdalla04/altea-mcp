# Question → tool cookbook

How an assistant should map the member's questions onto the `altea` tools (MCP names; CLI equivalents in brackets).

| Question | Call | Answer with |
| --- | --- | --- |
| "Which sessions does Omar run on Monday?" | `altea_instructor {name:"omar", date:"mon"}` (`altea who omar mon`) | one line per session: time, title, studio, spots; note the group when it is not Boutique Fitness |
| "How many spots left in the next Hot Yin?" | `altea_next {query:"hot yin"}` (`altea next hot yin`) | spots or FULL + waitlist size, whether bookable now, and the next one with spots if different |
| "Any pickleball courts open tomorrow at 3 pm?" | `altea_schedule {date:"tomorrow", group:"courts", at:"3pm", availableOnly:true}` | the courts and their spots; if none, drop `availableOnly` and say which are full |
| "What's on tomorrow morning?" | `altea_schedule {date:"tomorrow", timeOfDay:"morning"}` (Boutique Fitness) | grouped by time |
| "Anything with Timo this week?" | `altea_instructor {name:"timo", date:"today", days:7}` | grouped by day |
| "Is there a reformer class Saturday?" | `altea_schedule {date:"sat", studio:"reformer"}` | list + spots |
| "What am I booked into?" | `altea_bookings` | each with free-cancel deadline; flag anything inside 8 h |
| "Book me into the 9 am Main Stage Ride tomorrow" | `altea_find` to get the id → `altea_book {eventId}` | confirm booking id + cancel-by time; a Chrome window flashes |
| "Cancel my Sunday cycle class" | `altea_bookings` → `altea_cancel {bookingId}` | refuse if late (fee) unless the member confirms `force` |
| "Put me on the waitlist for Hot Yin" | `altea_waitlist {eventId, action:"join"}` | position + waitlist size |
| "When can I book Tuesday's 6 pm LF3?" | `altea_event {eventId}` | `options[0].bookableFrom` (48 h rule) |

Rules to state proactively: **cancel before the cancellation window (default 8 h) or a fee applies**; **booking opens 48 h before start**.
Instructor names are matched by substring; unknown names return "did you mean" suggestions.
`group:"all"` costs ~2 s per day (6 parallel fetches) and is the default for `altea_find`, `altea_next`, `altea_instructor`.
