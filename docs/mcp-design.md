# MCP design notes — research, cross-validation, decisions (2026-09-19)

## What makes a strong MCP server (synthesis of sources)
1. **Every tool is a contract**: stable namespaced `name` (action + object), human `title`, a description that
   explains what it does, when to use it, when *not* to, what each parameter means, and caveats ("explain it to a
   new hire"; Anthropic: 3–4+ sentences). Descriptions decide tool selection more than anything else.
2. **Schemas are strict and self-describing**: every field `.describe()`d, enums for fixed sets, real min/max,
   unknown fields ignored by the SDK (kept out of the docs promise), few required fields, optional filters. `outputSchema` + `structuredContent` so
   results are typed; keep a JSON text block for compatibility.
3. **Annotations on every tool**: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
   Defaults are pessimistic (unannotated = destructive + open-world), so reads must say `readOnlyHint: true`.
   Hints are UX signals, not enforcement: the server still validates and guards.
4. **Read/write separation, few thoughtful tools**: one verb, one object, one annotation set per tool; consolidate
   multi-step workflows into one tool (e.g. `next` instead of "list days, then filter, then detail").
5. **Token-lean results**: return high-signal fields, offer `detailed` vs `concise`, paginate/limit and say when
   truncated (Claude Code caps tool output at ~25k tokens); compact text can be ~40–60% smaller than JSON.
6. **Actionable errors**: `isError: true` with the failing field/constraint, whether a retry is safe, and the next
   valid action; never stack traces; distinguish protocol errors from execution errors.
7. **Server instructions** carry cross-tool rules and sequencing so tool descriptions stay short and stable.
8. **Resources for reference data, prompts for repeatable workflows**; deterministic `tools/list` ordering and
   stable descriptions (prompt caching); no secrets or PII in any result channel.
9. **Operational hygiene**: validate inputs, rate-limit upstream calls, timeouts, serialise risky mutations,
   log to stderr only (stdio), graceful shutdown, version from package.json.
10. **Layered testing**: metadata tests (names/annotations/schemas), handler tests with valid/invalid/edge inputs
    in-process (`InMemoryTransport` + `Client`), realistic evals (real questions), and a real-host smoke test.

Sources: MCP spec *Tools* (2025-06-18); MCP blog *Tool Annotations as Risk Vocabulary* (2026-03); Anthropic
*Define tools* docs and *Writing effective tools for agents*; sunpeak *Designing Claude Connector Tools* (2026-08);
KanseiLink *MCP Tool Schema Design Guide 2026*; Salesforce hosted-MCP best practices; ECC skills
`mcp-server-patterns` and `agent-harness-construction` (status/summary/next_actions observation contract).

## Cross-validation of altea-mcp v0.2.0 (see CHANGELOG 0.4.0 for the audit follow-up)
| Principle | v0.2.0 | Action (v0.3.0) |
| --- | --- | --- |
| Namespaced names, read/write split | ✅ `altea_*`, separate book/cancel/waitlist | keep |
| Titles | ❌ | add `title` to every tool |
| Descriptions with when / when-not / examples | partial | rewrite in "new hire" form, keep stable |
| Strict schemas, described fields | ✅ zod + `.describe()` | add `limit`, `format`; reject unknown fields |
| Output schemas + structuredContent | ❌ | add for every tool |
| Annotations | ❌ (all tools looked destructive + open-world) | reads `readOnlyHint`, cancel `destructiveHint`, book/cancel/waitlist `idempotentHint`, all `openWorldHint` |
| Token-lean results | ❌ verbose JSON, no limit | `format: concise` default (text lines + minimal structured list), `limit` + truncation notice |
| Actionable coded errors | partial (messages only) | `AlteaError{code, retryable, next}` → `ERROR[CODE]: … Next: …` |
| Server instructions | ❌ | rules (8 h / 48 h), sequencing, confirmation policy |
| Resources / prompts | ❌ | `altea://rules`, `altea://meta`, `altea://bookings/upcoming`; prompts `altea-day-brief`, `altea-book-request` |
| Mutex + timeouts | ❌ | mutations serialised; 60 s reads / 150 s page actions |
| Deterministic tool order, stable text | ✅ | keep |
| PII hygiene | ✅ tools never return address/phone/card | keep; fixtures scrubbed |
| Metadata + handler tests in-process | ❌ | `test/mcp.test.mjs` with a stub client over `InMemoryTransport` |
| Real-question evals | partial (manual) | `scripts/mcp-smoke.mjs --live` runs the three canonical questions |

## Decisions
- Quiet mutations: `hidden` window mode by default (Chrome hidden via System Events), `visible` fallback on bot
  refusal. Evidence (2026-09-19): headless refused for confirmBooking, accepted for joinWaitlist; off-screen
  position clamped by macOS; cross-route POST tarpitted.
- stdio only: the server runs on the member's Mac next to the signed-in Chrome profile; no remote transport.
- `concise` is the default format because Claude Code is the client and reads text well; `detailed` returns the
  full event objects (ids, urls, instructor ids) for chained calls.
- Error codes: `NOT_SIGNED_IN`, `BAD_INPUT`, `NOT_FOUND`, `WINDOW_NOT_OPEN`, `LATE_CANCEL`, `EVENT_FULL`,
  `CONFLICT`, `UNSIGNED_AGREEMENT`, `NO_MEMBERSHIP`, `UNKNOWN_ACTION`, `UPSTREAM`, `TIMEOUT`.
- Waitlist stays one tool with an `action` enum (one object, two additive/undo actions, same shape).
