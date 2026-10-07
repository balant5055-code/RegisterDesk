# RD-ANALYTICS-12-23 — Revenue Field Semantic Convergence Audit

**AUDIT ONLY.** No source, type, contract, serializer, test, UI, permission, index or rule was
modified. This document is the only artifact.

---

## Headline

**The question "are `revenuePaise` and `confirmedRevenuePaise` the same concept?" has a false
premise.** `confirmedRevenuePaise` names *one* quantity. `revenuePaise` is not a name — it is a
**suffix pattern** (`<subject>Paise`) reused across at least **six** unrelated quantities, one of
which is money flowing in the opposite direction.

Exactly **one** pair is genuinely equivalent, and it is the pair RD-12-22 already left
half-converged. Renaming `revenuePaise` globally would be actively wrong in five places.

## 1. Complete Inventory

Traced to source calculation, not matched by grep. File counts: `revenuePaise` 63 ·
`confirmedRevenuePaise` 38 · `estimatedRevenue` 7 (tests/docs only) · `RevenueState` 7 ·
`MaybeMoney` 16 · `revenueUnavailable` 21 · `toLegacyRevenueFields` 3 ·
`toConfirmedRevenueFields` 6.

### Every distinct declaration of a `revenuePaise` field

| # | Site | Actual source calculation | Concept |
|---|---|---|---|
| 1 | `registrationCounters.revenuePaise` (**stored Firestore field**) | `increment(amountPaise)` on confirm; `increment(-amt)` on cancel-of-confirmed | confirmed ticket revenue |
| 2 | `DashboardEvent.revenuePaise` (`dashboard/route.ts:168`) | counter #1, ledger fallback | **confirmed ticket revenue** |
| 3 | `trendDays[].revenuePaise` (`dashboard/route.ts:626`) | `organizerDailyStats` rollup | **day-attributed** confirmed revenue |
| 4 | `DailyStats*.revenuePaise` (`lib/dashboard/dailyStats.ts:111,122,135`) | `deltaFor()` per lifecycle event | **day-attributed** confirmed revenue |
| 5 | `AnalyticsResponse.overview.revenuePaise` (`normalize.ts:336,518`) | `period` rollup sum, or the 7-day trend range | **windowed period** revenue |
| 6 | `organizer360.licenses.revenuePaise` (`organizer360Service.ts:224`) | Σ `eventLicenses.amountPaise` | **platform licence income** |
| 7 | `adminAnalytics.licenseSales.revenuePaise` | licence orders | **platform licence income** |
| 8 | `Event360.counters.revenuePaise` (`admin/events/[slug]/360/route.ts:108`) | `num(counter?.revenuePaise)` — **counter only, no fallback** | confirmed ticket revenue |
| 9 | `StatsResult.revenuePaise` (`events/[eventId]/route.ts:315`) | internal accumulator | input to `RevenueState` |
| 10 | `LegacyRevenueFields.revenuePaise` (`revenueState.ts:111`) | serializer output key | wire encoding |

### Every declaration of `confirmedRevenuePaise`

| Site | Source | Shape |
|---|---|---|
| `EventListItem.confirmedRevenuePaise` | counter, ledger fallback | `number \| null` + `revenueUnavailable?` |
| `EventDetailResponse.confirmedRevenuePaise` | same | same |
| `EventAnalyticsFinancial.confirmedRevenuePaise` | **always** the live ledger aggregate | `MaybeMoney`, block omitted on denial |

`estimatedRevenue` survives only in absence-assertions and migration documents — zero runtime
references, as RD-12-20 left it.

## 2. Actual Semantics

| Field | Classification |
|---|---|
| #1, #2, #8 | **confirmed ticket revenue** — Σ `amount` over registrations whose status is *currently* `confirmed` |
| #3, #4 | confirmed ticket revenue **attributed to a calendar day** |
| #5 | confirmed ticket revenue **within a window**, compared against the preceding window |
| #6, #7 | **licence revenue** — what organizers pay RegisterDesk |
| `financial.confirmedRevenuePaise` | confirmed ticket revenue, always ledger-derived |
| `financial.grossPaise` | **gateway/ledger collection** — captures, a different population |
| `financial.netRevenuePaise` | confirmed revenue **less completed refunds** |

Not one of these is "estimated". Three separate concepts wear the same `revenuePaise` name, and
the ticket-revenue family itself splits three ways by aggregation window.

**Refund vs cancellation, stated precisely** — the two are routinely conflated and are not the
same: confirmed ticket revenue is **refund-stable** (a refund leaves `status: 'confirmed'` and
does not touch `amount`) but **not cancellation-stable** (a cancelled registration leaves the
confirmed set and its revenue goes with it).

## 3. Calculation Equivalence

Comparing the two convergence candidates — **#2 `DashboardEvent.revenuePaise`** and
**`EventListItem.confirmedRevenuePaise`**:

| Dimension | #2 Dashboard | Events list | Same? |
|---|---|---|---|
| Source collection | `registrationCounters` | `registrationCounters` | ✅ |
| Counter field | `revenuePaise` | `revenuePaise` | ✅ |
| Fallback | ledger aggregate | ledger aggregate (`sumConfirmedRevenueFromLedgerChecked`) | ✅ |
| Included status | `confirmed` only | `confirmed` only | ✅ |
| Excluded | pending, cancelled, rejected, waitlisted | same | ✅ |
| Refunds | stable (no effect) | stable | ✅ |
| Partial refunds | stable | stable | ✅ |
| Cancellations | removed | removed | ✅ |
| Free registrations | contribute `0` | contribute `0` | ✅ |
| Chargebacks | no distinct handling either side | same | ✅ |
| Unit / rounding | integer paise, no conversion | integer paise | ✅ |
| Currency | INR | INR | ✅ |
| Backfill | `statsVersion >= EVENT_STATS_VERSION` gates the counter | same gate | ✅ |
| Zero handling | measured `0` | measured `0` | ✅ |
| Unavailable | `revenueUnavailable: true` (since 12-21) | `revenueUnavailable: true` | ✅ |
| Authorization | `transactions` | `transactions` | ✅ |

**`revenuePaise` (#2) === `confirmedRevenuePaise` is a true semantic invariant.**

For the wider family it is **not**:

- **#3/#4 (daily)** apply `reverse_confirm → revenuePaise: -amount` **unconditionally**, while
  the counter's decrement is guarded by `if (amt > 0 && currentRev >= amt)`. Under a drifted or
  un-backfilled counter, the guard skips and the two aggregations diverge permanently. They also
  answer a different question (*"what did January earn?"* vs *"what has this event earned?"*).
- **#5 (windowed)** is explicitly documented in `normalize.ts:327-331` as deliberately **not**
  the lifetime figure: *"NOT the lifetime `confirmedRevenue` headline compared against a windowed
  baseline, which would divide two different quantities and call the result growth."*
- **#6/#7 (licence)** sum a different collection entirely.
- **#8 (Event360)** reads the counter with **no ledger fallback**, so on an un-backfilled event it
  can differ from #2 while both are "correct" for their own contract.

## 4. State Contract

| State | Dashboard #2 | Events list/detail | Analytics `MaybeMoney` |
|---|---|---|---|
| authorized + positive | `number`, flag `false` | `number`, flag `false` | `{ok:true, paise}` |
| authorized + zero | `0`, flag `false` | `0`, flag `false` | `{ok:true, paise:0}` |
| authorized + unavailable | `0`, flag **`true`** | `0`, flag **`true`** | `{ok:false, reason}` |
| unauthorized | `null`, flag `false` | `null`, flag `false` | **whole block absent** |

**Since RD-12-22 the two convergence candidates have an identical state contract** — both derive
from one `RevenueState` through `toLegacyRevenueFields`. Before 12-21 they did not: #2 could not
express "unavailable" at all, which was defect F1.

Analytics remains structurally different (compiler-enforced narrowing; denial by block omission)
and correctly so — `MaybeMoney` cannot express a per-field denial.

## 5. Authorization

| Producer | Route authorization | Field gate | Read before authz? | Unauthorized output |
|---|---|---|---|---|
| Dashboard | `authorizeAnyWorkspace` | `transactions` | No — gate precedes the aggregate | `null` |
| Events list | `authorizeAnyWorkspace` | `transactions` | No | `null` |
| Events detail | `authorizeWorkspace(req,'events')` | `transactions` | No | `null` (finance: **403 at the route**) |
| Analytics | `authorizeAnyWorkspace` + event scope | `transactions` → `includeFinancial` | No | block absent |
| Admin Event360 | admin auth | admin-only | n/a | n/a |

**Field-level authorization is identical** across every organizer producer: `transactions`,
resolved before the financial read, with the purely-financial aggregate skipped for a denied
caller. The only difference is the **route** boundary on event-detail, where `finance` receives
403 for lacking `events` — pre-existing since RD-12-17 and unrelated to naming.

No public route, webhook or unauthenticated surface exposes either field.

## 6. Consumer Behaviour

| Consumer | Field | Use |
|---|---|---|
| `reports/page.tsx` EventRow | #2 | **display** |
| `reports/page.tsx` summary | #2 | **KPI sum** — guarded by `every(!== null && !revenueUnavailable)` |
| `normalize.ts` dashboard adapter | #2 (`events[]`) | **carried but never read for money** — only `capacity`/`registered` feed the fill rate |
| `presentation.revenueDisplay` → `EventCard` | events list | display |
| `eventOverview.revenueMetric` | events detail | display |
| `EventCommandCenter` | events detail | display + donation-split arithmetic |
| `ReportsTab` | events detail | display |
| `analytics/page.tsx` | Analytics `MaybeMoney` | display |
| Admin Event360 `PageClient:296` | #8 counter | display, labelled **"Revenue"** |
| Admin Event360 `PageClient:477` | Analytics `MaybeMoney` | display, labelled **"Revenue (confirmed)"** |
| Admin licence surfaces ×3 | #6/#7 | display, labelled "License revenue" |
| `TrendPanel` | #3 | chart |

**No consumer uses any revenue field for sorting, filtering, eligibility, settlement, refunds or
business logic.** Every use is display, a guarded KPI sum, or a chart series. That materially
lowers convergence risk: a rename cannot change behaviour, only labels.

**Flagged for any future convergence:**

1. `reports/page.tsx` — the only consumer of #2, in two places.
2. `normalize.ts:366` — its adapter type declares `events[].revenuePaise` and would need the
   key renamed even though the value is never read for money.
3. **Admin Event360 shows two revenue figures on one page** (#8 counter, and Analytics ledger)
   under labels a reader will assume are the same number. They can legitimately differ on an
   un-backfilled event. Not caused by naming, not in scope, but a rename that made both read
   `confirmedRevenuePaise` would make the discrepancy *look* like a bug.

## 7. Serializer Analysis

`toLegacyRevenueFields(s)` — the sole encoder of the legacy pair.

`toConfirmedRevenueFields(s)` — verified to be **a pure key adapter and nothing more**:

```ts
const { revenuePaise, revenueUnavailable } = toLegacyRevenueFields(s)
return { confirmedRevenuePaise: revenuePaise, revenueUnavailable }
```

It changes **no** semantics, **no** state, **no** authorization, **no** unavailable handling. It
exists solely because the two contracts spell the same figure differently.

**One serializer could replace both — and that is the entire practical payoff of convergence.**
If #2 is renamed to `confirmedRevenuePaise`, `toLegacyRevenueFields` becomes unused for organizer
event contracts and `toConfirmedRevenueFields` becomes the single encoder (or vice versa).
Removing either **today** would be a breaking wire change, because each is the sole producer of a
live field name.

## 8. Name Analysis

**"confirmed" is ESSENTIAL, not redundant.** The repository contains, on the *same* payloads, at
least four other revenue concepts a bare `revenuePaise` would be ambiguous against:

- `grossPaise` — gateway collection (captures, not registrations)
- `netRevenuePaise` — confirmed less refunds
- `netPaise` / `platformFeePaise` / `gatewayFeePaise` — ledger components
- `licenses.revenuePaise` — platform income

A reader who sees `revenuePaise` cannot tell which of these it is without opening the producer.
`confirmedRevenuePaise` is self-describing: it names the population (confirmed), the quantity
(revenue) and the unit (paise). `EventCommandCenter` relies on that last part —
`ticketRevenuePaise + event.donationTotalPaise` is correct only because both are paise, and the
suffix is what makes the line self-checking.

**The name that is wrong is `revenuePaise`, and only where it means confirmed ticket revenue.**
Where it means licence income or windowed revenue it is fine in context, though `licenseRevenuePaise`
and `periodRevenuePaise` would be better — out of scope, and not worth a phase on their own.

## 9. Backward Compatibility

| Dependency | Finding |
|---|---|
| External API consumers | **None** — no `app/api/v1`, no OpenAPI, no SDK |
| Public routes / webhooks | **None** — zero occurrences under `app/api/public`, `app/api/webhooks`, `public/` |
| Browser persistence | **None** — the only `localStorage` key near events is `rd_event_draft_id` |
| Cached payloads / service worker | **None registered** — `public/sw.js` exists but nothing calls `serviceWorker.register` |
| Generated files / historical exports | **None** — no report or analytics export emits either field name as a column |
| Stored documents | **YES — `registrationCounters.revenuePaise` is a persisted Firestore field**, written by `increment` in two places |

**The persistence finding is the one that constrains the design.** The *stored* field and the
*wire* field share a name but are different artifacts. Renaming the wire field is a code change;
renaming the stored field would be a data migration across every counter document plus a
dual-read window — and **it is not required** for convergence. Any future phase must state
explicitly that `registrationCounters.revenuePaise` stays as it is.

Convergence of the wire field would therefore be **internal-only + additive**, executable as a
dual-field migration exactly like RD-12-19: emit both, migrate the two consumers, remove in a
dedicated commit.

## 10. Duplication / Drift

**Genuine duplication:**

- Two serializer entry points for one encoding (§7) — the direct cost of the two names.
- Three source strategies for one quantity: counter+fallback (#2, events), ledger-always
  (Analytics), counter-only (#8 Event360).

**Drift risks, in severity order:**

1. **The guarded counter decrement.** `if (amt > 0 && currentRev >= amt)` skips silently when the
   counter is already low, leaving it **above** the ledger truth. `statsVersion` gates *staleness
   of schema*, not *correctness of value*, so nothing detects this. Both #2 and #8 would report
   the inflated figure; Analytics, reading the ledger directly, would not. **This is the most
   likely cause of a real-world discrepancy between two fields this audit otherwise calls
   equivalent** — and it is a data-integrity question, not a naming one.
2. **Daily vs lifetime** (#3/#4 vs #2) decrement under different rules (§3), so
   Σ daily ≠ lifetime after any skipped guard.
3. **Two labels, one page** — Admin Event360's "Revenue" and "Revenue (confirmed)" (§6.3).

**Evidence that keeping both names is justified — considered seriously:**

- For #5, #6, #7: **yes, decisively.** They are different quantities and must not converge.
- For #8: **partially.** It is the same definition under a deliberately different read strategy.
- For #2 versus `confirmedRevenuePaise`: **no.** Identical definition, source, fallback, unit,
  status filter, refund behaviour, authorization and — since RD-12-22 — identical state contract,
  built from the same `RevenueState` and encoded by the same function through a key adapter. The
  two names carry no information that distinguishes them. This is untidiness with a cost
  (a redundant serializer, and a reader who must check which of six `revenuePaise` they are
  looking at), not merely untidiness.

## 11. Future Migration Design

**Recommendation: OPTION B, scoped to exactly one field.**

| | |
|---|---|
| **Canonical field name** | `confirmedRevenuePaise` |
| **Canonical internal type** | `RevenueState` (`lib/finance/revenueState.ts`) |
| **Canonical state model** | `{ok:true, paise} \| {ok:false, reason:'unavailable'\|'unauthorized'}` |
| **Wire encoding** | `confirmedRevenuePaise: number \| null` + `revenueUnavailable?: boolean`, derived only by `toConfirmedRevenueFields` |
| **Affected route** | `app/api/organizer/dashboard/route.ts` — `DashboardEvent.revenuePaise` **only** |
| **Affected consumers** | `app/(dashboard)/dashboard/reports/page.tsx` (2 sites); `lib/analytics/normalize.ts:366` (adapter type key) |
| **Explicitly NOT touched** | #1 stored counter · #3/#4 daily · #5 windowed · #6/#7 licence · #8 Event360 · Analytics `MaybeMoney` |

**Migration order**

1. Emit `confirmedRevenuePaise` beside `revenuePaise` on `DashboardEvent`, both from the one
   `RevenueState` (impossible to contradict — same guarantee RD-12-22 established).
2. Migrate the two `reports/page.tsx` sites and the `normalize.ts` adapter key.
3. Deploy once.
4. Remove `revenuePaise` from `DashboardEvent` in a **dedicated commit**, and delete
   `toLegacyRevenueFields` (or fold it into `toConfirmedRevenueFields`) so one encoder remains.

**Compatibility strategy** — dual-field for one deploy. Justified by the same `₹NaN` evidence as
RD-12-19: every consumer guards on `=== null`, and `undefined !== null`, so a stale bundle reading
a renamed payload would slip past the guard into a formatter.

**Tests** — extend `revenueState.test.ts` with dashboard-keyed cases mirroring A–G; add an absence
assertion for `revenuePaise` on `DashboardEvent` at step 4; keep the F1 reproduction untouched.

**Removal criteria** — no consumer reads `DashboardEvent.revenuePaise`; both fields proven
identical on real payloads; one deploy elapsed.

**Rollback** — steps 1-3 revert cleanly (both fields present, every consumer works either way).
After step 4 rollback means re-adding the field, which is why it is its own commit and deploy.

**Do not, in that phase or any other, rename `revenuePaise` where it means licence income,
windowed revenue, or day-attributed revenue.** Those are different quantities and the current
names, while imprecise, are not wrong.

## Verdict

**APPROVED WITH CONDITIONS.**

Equivalence is proven for exactly one pair and disproven for five other fields sharing the name.
Migration is safe only if it is scoped to `DashboardEvent.revenuePaise` alone; a global rename
would merge licence income, windowed revenue and day-attributed revenue into a name that means
none of them.

## Scope Compliance

No file was modified other than the creation of this document. No commit, push or deployment. No
Firestore rules or index change. `git status --short` unchanged at 709 entries, all pre-existing
or concurrent-session work.
