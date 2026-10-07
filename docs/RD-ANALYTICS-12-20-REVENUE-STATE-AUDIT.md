# RD-ANALYTICS-12-20 — Revenue State Contract Audit

**AUDIT ONLY.** No source file was modified. This document is the only artifact.

> **Filename note.** The phase number collides with the completed alias-removal work already
> recorded in `RD-ANALYTICS-12-20-IMPLEMENTATION.md`. That file was left untouched and this
> audit written alongside it, rather than overwriting a delivered record.

---

## 1. Objective

Decide whether the current revenue-state representation is safe enough as it stands, or whether
it should eventually become a discriminated union — with the test being whether future code can
confuse **authorized zero**, **authorized value**, **read failure**, and **authorization
denial**.

**Answer in one line:** the current model is *correct today and structurally fragile*, it has
**already been confused once in code that is live right now**, and the codebase has independently
converged on the union shape twice — but the union as proposed in the brief would be a breaking
wire change and needs amending before anyone implements it.

## 2. Complete State Inventory

Every construction site of a revenue state, traced in source.

| # | Site | Representation | Denial | Failure |
|---|---|---|---|---|
| 1 | `api/organizer/events` (list) | `confirmedRevenuePaise: number \| null` + `revenueUnavailable?: boolean` | `null` | `0` + flag `true` |
| 2 | `api/organizer/events/[eventId]` | same | `null` | `0` + flag `true` |
| 3 | `api/organizer/dashboard` — `events[]` | `revenuePaise: number \| null`, **no flag** | `null` | **`0`, unsignalled** ⚠ |
| 4 | `api/organizer/dashboard` — KPI `totalRevPaise` | `number \| null` | n/a | **`null`** |
| 5 | `api/organizer/dashboard` — internal `revBySlug` | `Map<string, number \| null>` | n/a | `null` |
| 6 | `EventAnalytics.financial.confirmedRevenuePaise` | `MaybeMoney` | **block absent** | `{ok:false, reason}` |
| 7 | `presentation.revenueDisplay` (client) | `MetricDisplay{text, unavailable, reason?}` | `reason:'restricted'` | `reason:'unreadable'` |
| 8 | `eventOverview.revenueMetric` (client) | `MetricValue{text, unavailable, sub}` | `sub:'Requires finance access'` | `sub:null` |
| 9 | `EventCommandCenter.ticketRevenuePaise` (local) | `number \| null` | `null` | `null` (merged) |

**Nine sites, five different shapes, for one quantity.**

## 3. Revenue Contracts

Three server contracts publish this figure, and they do not agree with each other:

- **Events list / detail** — `confirmedRevenuePaise` + a sibling boolean. Three states expressible.
- **Dashboard `events[]`** — `revenuePaise`, `number | null`, **no sibling flag**. Only two states expressible.
- **Analytics `financial`** — `MaybeMoney`, plus whole-block omission for denial. Three states expressible, and the compiler enforces the check.

The field is also called two different names on the wire (`confirmedRevenuePaise` versus the
Dashboard's `revenuePaise`) for the same quantity from the same counter.

## 4. State Matrix

| # | State | Revenue value | `revenueUnavailable` | reason | authorized |
|---|---|---|---|---|---|
| 1 | confirmed positive | `number > 0` | `false` | — | yes |
| 2 | confirmed zero | `0` | `false` | — | yes |
| 3 | read failure | `0` | `true` | — | yes |
| 4 | unauthorized | `null` | `false` | — | no |
| 5 | free event | `0`/any | `false` | — | yes (short-circuited before the gate) |
| 6 | **unpublished (no slug)** | `0` | `false` | — | yes |
| 7 | **Dashboard read failure** | **`0`** | **absent** | — | yes |

**Two pairs share a serialized representation.**

- **States 2, 3 and 6 all serialize their value as `0`.** 2 and 6 are genuinely measured zeros;
  3 is not, and is distinguished *only* by the sibling boolean. Drop the boolean and a failed
  read is indistinguishable from an empty event.
- **States 2 and 7 are byte-identical on the Dashboard contract** — `revenuePaise: 0` with no
  flag in existence. There is nothing to drop, because the signal was never carried.

## 5. Collision Analysis

### F1 · A live collision, on the Dashboard, today — MEDIUM

`app/api/organizer/dashboard/route.ts:1430`

```ts
revenuePaise: financeAllowed ? (slug ? (revBySlug.get(slug) ?? 0) : 0) : null,
```

`revBySlug` is `Map<string, number | null>` and **`null` there means UNMEASURED** — set by the
self-healing fallback's `.catch(() => null)` at line 1160, whose own comment explains that the
former `.catch(() => 0)` was the bug. `null ?? 0` evaluates to **`0`**. So an unmeasured event's
revenue is republished on the per-event payload as a measured-looking **₹0**, and
`DashboardEvent` has no `revenueUnavailable` field to say otherwise.

The same response gets it right one field over: `totalRevPaise` (line 1184-1187) checks
`.some(v => v === null)` and correctly returns `null`. **One payload, two answers** — the KPI says
"unavailable", the event row underneath it says "₹0".

Reachability: needs a counter predating the backfill **and** its fallback aggregate to throw.
Empty in steady state — which is exactly why it survives review, and exactly the scenario the
three-state contract exists for.

*This is reported, not fixed. Audit-only.*

### Patterns searched, and what they turned out to be

| Pattern | Where | Verdict |
|---|---|---|
| `revBySlug.get(slug) ?? 0` | dashboard:1430 | **F1 — the collision above** |
| `revBySlug.get(slug) ?? 0` | events list:411 | **Safe** — the map holds only `number`; absence is a real zero and `revenueUnavailable` carries failure separately |
| `revBySlug.get(slug) ?? 0` | dashboard:1187 | **Safe** — guarded by the `.some(=== null)` check on the line above |
| `e.revenuePaise ?? 0` | reports/page:409 | **Safe** — guarded by `every(e => e.revenuePaise !== null)` on line 407 |
| `c?.revenuePaise ?? 0` | events list:317 | **Safe** — only entered when `st.complete` |
| `(r.data().s ?? 0)` | dashboard:1160 | **Safe and correct** — Firestore returns null for a sum over an empty set; the `.catch` is what carries failure |
| `d.revenuePaise ?? 0` | dashboard:1147 | **Safe** — gated on `statsVersion >= EVENT_STATS_VERSION` |
| Boolean coercion of revenue | reports/page:293 | **Safe** — `event.revenuePaise ? …` chooses a *class name* only; the value beneath is rendered by an explicit `=== null` ternary on the next line |
| `Number()` / `parseInt` / `parseFloat` on revenue | — | **none found** |
| Destructuring defaults on revenue | — | **none found** |
| Spread overwriting revenue | — | **none found** |

### F2 · `number | null` means three different things — structural

Inside `dashboard/route.ts` alone:

- `events[].revenuePaise` — `null` = **unauthorized** ("Never a zeroed figure")
- `totalRevPaise` — `null` = **unmeasured**
- `revBySlug` values — `null` = **unmeasured**

And in the events routes, `confirmedRevenuePaise === null` = **unauthorized**. The same type
annotation carries opposite meanings in adjacent scopes. F1 is what happens when someone reads
one and writes the other.

### F3 · The contract is convention-safe, not compiler-safe — structural

Nothing in the type system requires a consumer of `confirmedRevenuePaise` to consult
`revenueUnavailable`. The flag is `revenueUnavailable?: boolean` — **optional** — so
`undefined` is a valid, falsy, silently-"available" value. A consumer that reads only the number
compiles cleanly and is wrong exactly in the failure case.

Both routes *do* always emit the flag (verified at events:456-457 and detail:586), so the
optionality is type-level looseness rather than a live hole — but it means no consumer can rely
on presence, and none is forced to look.

Contrast `MaybeMoney` at `analytics/page.tsx:39`:

```ts
const rupeesOf = (m: MaybeMoney): string => (m.ok ? rupees(m.paise) : UNAVAILABLE)
```

`.paise` is unreachable without narrowing `ok`. The check is not a convention; it is the only way
to compile.

## 6. `reason` Audit

| | `MaybeMoney.reason` | `MetricDisplay.reason` |
|---|---|---|
| Type | `Unavailable` — 4 literals | `'unreadable' \| 'restricted'` — 2 literals |
| Optional? | **No** — required on the `ok:false` arm | **Yes** (`reason?:`) |
| Created by | Analytics producers | `revenueDisplay` / `registrationsDisplay` (client) |
| Consumed by | `rupeesOf` and peers | `EventCard.tsx:381,386` |
| Expresses denial? | **No** — denial is whole-block omission | **Yes** — that is why it was added |
| On the wire? | **Yes** | **No — derived client-side** |
| Exhaustiveness enforced? | By the union arm | **No** — optional, no `never` check |

**`reason` is not a transported discriminator.** It is a presentation-layer reconstruction,
introduced by the alias-removal phase to repair a card that captioned every dash as a failed
read. It works, and it is confined to one resolver — but it means the distinction is
*re-derived* at each boundary rather than carried. Every future surface must redo that
derivation correctly or repeat the same defect.

(The `json.reason` values in the publish flow and the check-in history `reason` are unrelated
error/audit vocabularies and are out of scope — noted only so a future search does not conflate
them.)

## 7. MaybeMoney Audit

```ts
export type Unavailable =
  | 'no_authoritative_field' | 'requires_index' | 'query_failed' | 'out_of_budget'
export type MaybeMoney = { ok: true; paise: number } | { ok: false; reason: Unavailable }
```

- **Absence:** `{ok:false, reason}` — with a machine-readable cause.
- **Failure:** `reason: 'query_failed'`.
- **Authorization denial:** **cannot be expressed.** Analytics says it by omitting the entire
  `financial` block (`financial?: EventAnalyticsFinancial`, assigned `undefined` when
  `includeFinancial` is false, and dropped by JSON serialization).

**Can `MaybeMoney` represent all current Organizer states?** Value ✅, zero ✅, failure ✅,
**denial ❌**. It would need a fifth `Unavailable` member or an outer wrapper. This is the single
reason the Organizer contract was not widened to `MaybeMoney` during the rename, and that
reasoning still holds.

## 8. Analytics Contract

`EventAnalyticsFinancial.confirmedRevenuePaise: MaybeMoney`. Distinguishes zero from unavailable
structurally; carries a reason; forces the check at every call site. Denial is handled one level
up by block omission.

**Analytics already has the safer model** — on the two axes that matter (compiler-enforced
narrowing, machine-readable cause). Its one gap is denial, which it solves at a different level.

## 9. Organizer Contract (post alias-removal)

Verified in this audit:

- `confirmedRevenuePaise: number | null` on both routes.
- `estimatedRevenue`: **zero occurrences** in `app/`, `lib/`, `components/`. Not reintroduced.
- Denial `null`, authorized zero `0` + `false`, failure `0` + `true` — all three intact.
- Gate is `authz.permissions.includes('transactions')`, evaluated before the financial read.

## 10. API Serialization

`source → authorization → calculation → internal state → response object → JSON`.

- **No state is lost on the events routes.** Both always emit `revenueUnavailable` explicitly, so
  the optional field is never actually absent, and `null` survives JSON intact.
- **State *is* lost on the Dashboard**, but before serialization, not by it — F1 destroys the
  distinction at line 1430; JSON faithfully transmits the resulting `0`.
- `undefined` risk: `financial?:` set to `undefined` is dropped by `JSON.stringify`, which is
  Analytics' intended denial signal — correct, though it makes denial an *absence*, which a
  consumer must test for rather than switch on.

## 11. Client Resolution

Every client-side revenue resolver was inspected. **None performs an unsafe collapse.**

| Resolver | Handling |
|---|---|
| `revenueDisplay` | `=== null` → restricted; then flag → unreadable; else format |
| `revenueMetric` | same order, plus an explanatory `sub` |
| `ReportsTab` | `revenueRestricted` + `revenueKnown` folded into one unknown path |
| `EventCommandCenter` | collapses both absences into one `number | null` local **deliberately** |
| `reports/page.tsx` | `every(!== null)` before summing; explicit `=== null` render |
| `rupeesOf` (Analytics) | compiler-forced `ok` narrowing |

The client layer is in good shape. The exposure is on the server.

## 12. UI Representation

| State | Events card | Event detail | Analytics | Dashboard |
|---|---|---|---|---|
| positive | `₹34,44,737` | figure + "Confirmed registrations" | figure | figure |
| zero | `₹0` | `₹0` | `₹0` | `₹0` |
| unavailable | `—` + "…try again shortly" | `—`, no sub | `—` | KPI `—` / **row `₹0`** ⚠ |
| unauthorized | `—` + "requires finance access" | `—` + "requires finance access" | block absent | `—` |

Every surface except the Dashboard row **can** distinguish "not authorized" from "unavailable",
and after the alias-removal phase they all **do**. The Dashboard row cannot, because its contract
never carried the signal (F1).

## 13. Security Analysis

**No leak found.** For a caller without `transactions`:

- the value is `null` on every Organizer contract, regardless of the underlying amount;
- `revenueUnavailable` is pinned to `false` on denial, so the flag reveals nothing;
- the financial read is **skipped** entirely (`if (financeAllowed && incompleteSlugs.length)`),
  so no aggregate is issued on their behalf;
- Analytics omits the whole block.

A resolver could only reveal *existence* if it branched on something derived from the amount
while denied — and there is nothing to branch on, because the amount never enters the response.
Manager, admin and gate roles were all confirmed against the role matrix in the preceding phases'
emulator runs (27 tests, real tokens).

## 14. Data Inference

| Channel | Rating | Why |
|---|---|---|
| `null` vs `0` | **NONE** | Denial is `null` unconditionally; it does not vary with the amount |
| `revenueUnavailable` | **NONE** | Forced to `false` on denial |
| `reason` | **NONE** | Client-derived, never transported |
| Count fields (`totalRegistrations`) | **LOW** | Registration counts *are* returned and correlate loosely with revenue — but they are a separate, deliberately ungated data class, unchanged since before this line of work |
| UI labels | **NONE** | "requires finance access" states entitlement, not amount |
| Timing | **LOW** | The skipped aggregate makes denied responses measurably faster — this reveals the caller's own permission, which they already know, not the figure |
| Response shape | **NONE** on Organizer; **LOW** on Analytics | A missing `financial` block reveals that you lack `transactions` — again, self-knowledge |

No channel is rated MEDIUM or above. **No additional privacy behaviour is warranted.**

## 15. Proposed Discriminated Union — Evaluation

The brief's sketch:

```ts
type RevenueState =
  | { status: 'authorized';   confirmedRevenuePaise: number }
  | { status: 'unavailable';  confirmedRevenuePaise: null; reason: RevenueUnavailableReason }
  | { status: 'unauthorized'; confirmedRevenuePaise: null }
```

**Verdict: right shape, wrong for the wire as literally written.**

**What it gets right.** It makes all four states mutually exclusive and compiler-checked; it
promotes `reason` from a client reconstruction to a transported fact; it makes F1 unrepresentable
(there is no way to produce a `0` that means "unmeasured"); and it unifies the meaning of `null`,
killing F2.

**Two defects to fix before anyone implements it.**

1. **It changes the wire contract for the failure state**, from `0` to `null`. The events-list
   type comment is explicit that the numeric fields keep their types "so all eight consumers of
   this endpoint are unaffected", with the flags "ADDITIVE, never load-bearing". Shipping this
   union would break that promise for every consumer that reads the number without the flag — the
   exact population the additive design was protecting. This is not fatal, but it makes the change
   a **breaking migration**, not a refactor, and it should be planned like the rename was:
   dual-emit, migrate consumers, then remove.
2. **`status: 'unauthorized'` carries the denial in-band on a per-field basis**, which is a
   different architecture from Analytics' whole-block omission. Two denial encodings in one
   codebase is how F2 started. Either accept the divergence explicitly and document it, or add a
   fifth `Unavailable` member and let `MaybeMoney` carry all four states so there is **one**
   money-absence vocabulary.

**Convergent evidence that the union is the right destination.** Two independent parts of this
codebase already reinvented it without coordination:

- `MaybeMoney` — a two-arm union with a reason, for exactly this problem.
- `EventCommandCenter.ticketRevenuePaise` — a local that folds both absences into one
  `number | null`, with a comment stating the motive outright: *"A VALUE rather than a flag, so
  the narrowing the compiler needs and the guard the reader sees are the same fact."*

That is the union's thesis, written by hand, twice, because the contract did not supply it.

## Verdict

**NOT SUFFICIENTLY SAFE — MIGRATE, BUT NOT AS DRAFTED.**

The Organizer model is correct in every surface that exists today and is defended by real tests,
so nothing is on fire. But its correctness rests on discipline rather than on types, and the
discipline has already failed once in shipped code (**F1**), in the one contract that lacks the
sibling flag — producing a payload whose KPI and whose event row disagree about the same event.
`reason` is a client-side patch over the same gap, and `number | null` now means three different
things within a single file.

A discriminated union is the right destination, and the codebase has twice reached for it
unaided. It should be adopted deliberately — with the wire-compatibility problem in §15.1 solved
first, and with a decision made about whether money-absence gets one vocabulary or two.

## Recommended Next Phases

1. **Fix F1 first, on its own** — it is a live, reachable defect and is independent of any
   redesign. Either give `DashboardEvent` a `revenueUnavailable` flag matching the events routes,
   or make its `revenuePaise` `null` on unmeasured and let the existing client `=== null` render
   handle it. One route file, one small change, no contract redesign. *(Not done here: audit-only.)*
2. **Then decide the money-absence vocabulary** — one (`MaybeMoney` extended with a denial
   reason) or two (Organizer union + Analytics `MaybeMoney`, divergence documented). This decision
   gates the union's design, so it should precede implementation, not follow it.
3. **Then migrate the union**, as a dual-emit rename-style migration rather than a hard cutover,
   with the Dashboard's `revenuePaise` folded into the same canonical name and shape so the third
   contract stops being a third contract.

## Scope Compliance

No source file was modified. No API contract, field, type, permission, calculation, Firestore
file, Admin, Reports or Analytics file was touched. `MaybeMoney` unchanged. No discriminated
union implemented. Nothing committed, pushed or deployed. `git status --short` is unchanged at
692 entries, all pre-existing or concurrent-session work.
