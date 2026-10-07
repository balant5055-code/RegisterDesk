# RD-ANALYTICS-12-26 — Revenue Intelligence Audit

**AUDIT ONLY.** No source, test, schema, index or rule was modified. This document is the only
artifact. Baseline captured before inspection: branch `master`, HEAD `b7e5fdf`, 715 working-tree
entries, 0 staged — unchanged throughout.

---

## 1. Executive Summary

**The financial foundation is materially stronger than a codebase of this age usually has.** The
vocabulary is disciplined, the unavailable-versus-zero distinction is enforced at nearly every
boundary, the permission gate precedes every financial read, and the once-fatal registration scan
is gone — replaced by counters and budgeted `sum()` aggregates that report truncation rather than
summing a partial set.

What is missing is **breadth, not correctness**. RegisterDesk can tell an organizer *what this
event earned*, *what came back*, and *what the gateway settled*. It cannot tell them *how fast
money is arriving*, *what an average buyer is worth*, or *how this event compares with their last
one*.

**Verdict: APPROVED WITH CONDITIONS.** No P0. No P1. Two P2 findings should be closed before
intelligence is layered on top, because both would silently corrupt a derived metric:

| # | Finding | Severity |
|---|---|---|
| **F-1** | Analytics substitutes an all-zero coupon object on read failure, with `discountUnavailable: false` — a measured "₹0 discount" claim. The Dashboard hit the same trap and fixed it; Analytics did not. | **P2** |
| **F-2** | The guarded counter decrement (RD-12-23) can still leave a counter **above** ledger truth, and four surfaces read the counter. Analytics does not, so the same event can legitimately show two different revenue figures on two screens. | **P2** |

**Not currently available**, and to be stated plainly rather than approximated: **revenue
velocity** and **average order value**. Neither exists. What exists under the name "velocity" is
*registration* velocity.

## 2. Revenue Surface Inventory

| Metric | Module | Source | Unit | Scope | Permission | Canonical? | Measured? | Can be unavailable? | Refunds | Cancellations | Pending |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `confirmedRevenuePaise` (events list/detail) | `api/organizer/events*` | counter → ledger fallback | paise | lifetime | `transactions` | **yes** | measured | yes (`revenueUnavailable`) | excluded (stable) | excluded | excluded |
| `confirmedRevenuePaise` (DashboardEvent) | `api/organizer/dashboard` | counter → ledger fallback | paise | lifetime | `transactions` | **yes** | measured | yes (flag) | stable | excluded | excluded |
| `financial.confirmedRevenuePaise` | `lib/analytics/eventAnalytics` | **ledger aggregate, always** | paise | lifetime | `transactions` | **yes** | measured | yes (`MaybeMoney`) | stable | excluded | excluded |
| `financial.netRevenuePaise` | ″ | confirmed − completed refunds | paise | lifetime | `transactions` | yes | derived, both inputs required | yes | **subtracted** | excluded | excluded |
| `financial.grossPaise` | ″ | payment ledger captures | paise | lifetime | `transactions` | yes | measured | yes | n/a | **different population** | n/a |
| `financial.platformFee/gst/gatewayFee/netPaise` | ″ | ledger components | paise | lifetime | `transactions` | yes | measured/estimate blend | yes | n/a | n/a | n/a |
| `financial.refundsPaise` | `getRefundTotals` | **refund ledger** | paise | lifetime | `transactions` | yes | measured | yes (`out_of_budget`) | — | — | — |
| `byPass[].valuePaise` | `aggregateValueByPass` | Σ `amount` per pass, confirmed | paise | **lifetime only** | `transactions` | yes | measured | yes (`complete:false` → empty) | stable | excluded | excluded |
| `overview.revenuePaise` | `normalize.ts` | **daily rollup, windowed** | paise | **selected period** | `transactions` | yes for its own question | measured | yes (absent) | see §4 | see §4 | excluded |
| `trendDays[].revenuePaise` | `organizerDailyStats` | per-day delta | paise | **per day** | `transactions` | yes for its own question | measured | via `trendUnavailable` | see §4 | **decrements** | excluded |
| `totalRevPaise` (KPI) | dashboard | counters, Σ scoped | paise | lifetime | `transactions` | yes | measured | **`null`** | stable | excluded | excluded |
| `todayRevPaise` / `monthRevPaise` | dashboard | rollups | paise | day / MTD | `transactions` | yes | measured | partially | see §4 | decrements | excluded |
| `totalDiscountPaise` | `couponPerformance` | Σ `discountAmount` | paise | lifetime | `transactions` | yes | measured | **`discountUnavailable`** (see F-1) | n/a | included | included |
| `Event360.counters.revenuePaise` | admin 360 | **counter only, no fallback** | paise | lifetime | admin | no — a view of the counter | measured | `statsComplete` | stable | excluded | excluded |
| `licenses.revenuePaise` / `licenseSales.revenuePaise` | admin | `eventLicenses.amountPaise` | paise | lifetime | admin | yes | measured | catch → 0 | n/a | n/a | n/a |
| media-credits `revenuePaise` | `features/media-credits` | Σ purchase `amountPaise` | paise | lifetime | admin | yes | measured | n/a | n/a | n/a | n/a |
| Finance module (wallet / settlements / transactions) | `lib/finance/financeAnalytics` | ledger + settlements | paise | range | `wallet`/`settlements`/`transactions` | yes | measured | yes (`gone`) | separate | separate | separate |

**Sixteen distinct revenue quantities.** Four are the *same* question (confirmed ticket revenue)
from three different readers; the rest answer genuinely different questions.

## 3. Canonical Revenue Definition

Traced from UI to source. **Confirmed ticket revenue** is:

> `Σ registrations.amount` where `status == 'confirmed'`, in integer paise.

| Question | What the code actually does |
|---|---|
| Which transactions qualify? | None — it is not a transaction read. It sums the **registration's own `amount`** |
| Which payment statuses qualify? | **None are consulted.** `status` (the registration lifecycle field) is the only filter |
| Free registrations | Included, contributing `0` — they are confirmed registrations with `amount: 0` |
| Pending registrations | **Excluded** — status is not `confirmed` |
| Failed payments | **Excluded** — the registration never reaches `confirmed` |
| Cancelled registrations | **Excluded** — leaving `confirmed` removes the value |
| Refunded transactions | **Included, unchanged.** A refund alters neither `status` nor `amount` — the figure is *refund-stable* by design |
| Partial refunds | Same: no effect |
| Refund pending | Same: no effect |
| Discounts / coupons | **Net of discount.** `amount` is the price actually charged; `discountAmount` is recorded separately |
| Convenience / platform fee | **Excluded.** Those live on the payment ledger (`platformFeePaise`), not on the registration |
| GST / tax | **Excluded**, same reason |
| Gross or net? | **Gross ticket value as sold** — after coupon discount, before gateway and platform deductions, before refunds |

**The precise English:** *"what this event sold, at the prices actually charged"*. It is
deliberately not *"what the organizer kept"* (`netSettlement`), not *"what the gateway captured"*
(`grossCollected`), and not *"what remains after returns"* (`netRevenue`). The code names all
four and refuses to let "Revenue" stand unqualified for any of them.

## 4. Counter vs Ledger

Three readers, one definition:

| Reader | Path | Used by |
|---|---|---|
| **Counter-first** | `registrationCounters.revenuePaise` when `statsVersion >= EVENT_STATS_VERSION`, else the ledger aggregate | events list, event detail, DashboardEvent, dashboard KPI |
| **Ledger-always** | `sumConfirmedRevenueFromLedgerChecked` every time | **Analytics** |
| **Counter-only** | the raw counter, **no fallback** | Admin Event360 |

| Question | Answer |
|---|---|
| **A. Authoritative?** | The **ledger** — the counter is a maintained cache of exactly that aggregate |
| **B. Fallback?** | The ledger aggregate, for counter-first readers |
| **C. When?** | When `getEventStats().complete` is false (`statsVersion` below the current version) |
| **D. Can they disagree?** | **Yes** — see F-2 |
| **E. Stale counters detected?** | **Only schema staleness.** `statsVersion` detects an un-backfilled *shape*, never a drifted *value* |
| **F. Can a stale counter silently overstate?** | **Yes** — F-2 |
| **G. Can refunds/cancellations diverge?** | Refunds cannot (no writes). **Cancellations can** |
| **H. Backfill/reconciliation?** | **Yes** — `lib/reconciliation/events.ts` compares counters against recomputed aggregates and can repair |
| **I. Observable consistency signal?** | **Only inside reconciliation.** No surface shows counter-vs-ledger agreement |

### F-2 · The guarded decrement is still live — **P2**

`lib/firebase/firestore/registrations.ts:563`:

```ts
if (amt > 0 && currentRev >= amt) updates.revenuePaise = FieldValue.increment(-amt)
```

Cancelling a confirmed registration decrements the counter **only if the counter is already at
least as large as the amount**. The guard exists to prevent a negative counter — reasonable in
isolation — but when it skips, the decrement is **lost permanently**: nothing retries, and
`statsVersion` is unchanged, so `complete` stays true and the inflated counter is trusted forever.

**Where it surfaces:** the events list, event detail, DashboardEvent, the dashboard KPI and Admin
Event360 would all report the **inflated** figure. Analytics, reading the ledger directly, would
report the **correct** one. Two screens, one event, two numbers, no explanation — which §13 flags
as the thing to avoid.

Reconciliation can repair it, but nothing routinely runs it against this field and no surface
exposes the discrepancy. **Documented, not fixed** — RD-12-24's brief explicitly placed this out
of scope, and it remains out of scope here.

## 5. Revenue Trend Audit

| Figure | Source | Scope | Boundary |
|---|---|---|---|
| Lifetime | counters/ledger | all time | n/a |
| Daily | `organizerDailyStats` | one IST day | `dayKey` fixed to **IST** |
| 7/30/90-day | rollup rows summed | window, IST days | inclusive of both ends |
| MTD | rollup days in the calendar month | string-prefix comparison on `YYYY-MM-DD` | IST |
| Period + previous | `period` / `baseline` rollups | window vs preceding window | both sides from the **same rows** |

**Lifetime is not confused with period.** The separation is explicit and defended in source:
`revenueModel.periodRevenue` deliberately reuses `overview.revenuePaise` rather than deriving its
own, with the comment that re-deriving would create "a second financial comparison that could
disagree with the Overview's". `byPassBasis` exists for the same reason — to stop a lifetime
per-pass figure being captioned as a period one.

**Daily stats ARE used for financial intelligence** (period revenue, the trend chart, MTD), and
their semantics **differ from the headline in one respect**: `deltaFor` applies
`reverse_confirm → revenuePaise: -amount` **unconditionally**, whereas the counter's decrement is
guarded (§4). So `Σ dailyStats ≠ counter` after any skipped guard. Both are defensible for their
own question — day-attribution versus lifetime — but they are **not interchangeable**, and no
surface currently reconciles them.

**Timezone:** `dayKey` is pinned to IST with an explicit comment that a UTC server would put
every post-18:30 registration in the wrong day. Correct, and consistently applied.

## 6. Revenue Velocity Audit

> ## NOT CURRENTLY AVAILABLE

No revenue velocity metric exists. The `velocity_up` / `velocity_down` / `velocity_flat` /
`velocity_total` insight kinds in `reports/page.tsx` are **registration** velocity, built by
`buildPerformanceInsights` from registration counts. No formula, window, baseline or unit for
revenue-per-unit-time exists anywhere in the codebase.

The raw material is present — `organizerDailyStats` carries per-day revenue in IST days — but
nothing derives a rate from it.

## 7. Average Order Value Audit

> ## NOT CURRENTLY AVAILABLE

No AOV, average ticket value, or revenue-per-registration metric exists. Searched
`averageOrderValue`, `avgOrderValue`, `AOV`, `perRegistrationPaise`, `averageTicket` — no hits in
`app/`, `lib/` or `components/`.

**This absence is arguably deliberate.** `payingPopulation` publishes the paying population as
**counts only**, with a comment stating why: *"'Paid registrations' and 'confirmed revenue' are
related and different: a paid registration may since have been cancelled, a confirmed one may be
free... Publishing these as counts beside the money — rather than attaching rupee values to them —
is what keeps the two measures from being read as one."*

Any future AOV must therefore **declare its denominator in the payload**, exactly as
`byPassBasis` declares its basis. Candidate denominators are not interchangeable: confirmed
registrations (includes free → depresses AOV), paid registrations (excludes free), or gateway
transactions (a different population entirely).

## 8. Pass / Category Revenue Audit

`aggregateValueByPass` is **genuine revenue semantics**, not merely "registration value":

```ts
base.where('passId','==',passId).where('status','==',status)
    .aggregate({ amount: AggregateField.sum('amount') })
```

Same field, same population, same filter as the canonical headline — split by pass, plus a
parallel `cancelled` sum.

| Property | Behaviour |
|---|---|
| Refunds | stable (no effect) |
| Cancellations | excluded from `salesPaise`, reported separately as `cancelledPaise` |
| Date range | **lifetime only** — there is no per-pass daily rollup, and `byPassBasis` says so |
| Free registrations | contribute `0` |
| Pending | excluded |
| Unavailable | `complete: false` → **empty map**, never zeros |
| Scale | **2 aggregates per pass**, `PASS_VALUE_BUDGET = 60` → ~30 passes; beyond that, `complete: false` |

Share percentages are taken against the **sum of the passes shown**, not against
`confirmedRevenue` — deliberately, so a rounding or timing difference between two readers cannot
surface as a share that fails to reach 100%.

**Category / ticket-type / registration-type revenue does not exist** — only per-pass.

## 9. Payment Mix Audit

`payingPopulation` publishes five counts:

| Key | Label | Definition |
|---|---|---|
| `paid` | Paid registrations | Payment completed |
| `free` | Free registrations | No payment required |
| `awaiting` | **Awaiting payment** | Payment not yet completed |
| `refundPending` | Refund in progress | Refund requested, not yet completed |
| `refunded` | Refunded | Registration whose payment was returned |

**The terminology correction holds.** The label is *"Awaiting payment"*, not *"Registration
pending"* — the payment dimension is not conflated with the registration lifecycle. Verified in
`revenueModel.payingPopulation`.

**Mutually exclusive?** Yes within `paymentStatus`. **Exhaustive?** Not quite — `failed` is not
surfaced as its own row; a failed payment presents as `awaiting`. **Internally consistent?** Yes,
and each row is a `Count` (`number | null`), so an unreadable split is distinguishable from zero.

**Payment method is not available** — no card/UPI/netbanking breakdown exists.

## 10. Refund Intelligence Audit

| Metric | Available | Source |
|---|---|---|
| Total refunded | **Yes** | `getRefundTotals` — the gateway **refund ledger**, the canonical reader |
| Refund count | **Yes** | same |
| Pending refunds | **Count only** (`refundPending`), no amount |
| Partial refunds | Included in the amount; not distinguished as a class |
| Refund rate | **No** — derivable but not derived |
| Period attribution | **No** — refunds are lifetime only, never windowed |
| Net revenue | **Yes** — `netRevenue = confirmed − refunds`, published only when **both** inputs are measured |
| Canonical or estimated? | **Canonical** — explicitly not `registration.paymentStatus`, and not `refundAmount ?? amount` |
| Failure → false zero? | **No** — `gone('out_of_budget')` when the read cap is exceeded |

**Can the surface distinguish gross/confirmed from refunds from net?** **Yes, clearly.**
`revenueHeadlines` publishes all three side by side, each with a one-line definition, and
`gatewayRows` is kept in a *separate group* precisely so a reader does not subtract across the
registration/capture boundary.

**The gap:** refunds cannot be attributed to a period, so a "refunds this month" question is
unanswerable today.

## 11. Coupon / Discount Intelligence Audit

| Capability | Status |
|---|---|
| Coupon usage / redemptions | **Yes** — per-coupon rows, ranked |
| Discount amount | **Yes** — Σ `registrations.discountAmount` via `sum()` aggregate |
| Revenue after discount | **Yes** — that *is* `confirmedRevenue` (`amount` is post-discount) |
| Revenue before discount | **Derivable** (`confirmed + discount`) but **not published** |
| Coupon performance | **Yes** — state, uses, active/redeemable counts |
| Impact on paid registrations | **No** — no attribution of registrations to coupons in the revenue model |
| Canonical? | Discount total is canonical (registration-sourced, not coupon-document-sourced) |

### F-1 · Analytics turns a failed coupon read into a measured ₹0 — **P2**

`getCouponPerformance` handles its *inner* failure impeccably:

```ts
} catch {
  // A missing index or an unsupported backend must not turn into "₹0 of discount given",
  // which is a claim rather than an absence. The flag lets the UI say so.
  discountUnavailable = true
}
```

But the Analytics caller wraps the whole thing:

```ts
// lib/analytics/eventAnalytics.ts:707
await getCouponPerformance(eventId, organizerUid).catch(() => EMPTY_COUPON_PERFORMANCE)
```

and `EMPTY_COUPON_PERFORMANCE` is all zeros **with `discountUnavailable: false`**. So if the
outer read fails — the `events/{slug}/coupons` collection read, a permission error, a transport
failure — Analytics renders *"0 coupons, 0 redemptions, ₹0 discount"* as measured fact, and the
UI's `discountUnavailable` branch never fires.

**The Dashboard hit this exact trap and fixed it**, one line and a comment:

```ts
// app/api/organizer/dashboard/route.ts:1746
).catch(() => ({ ...EMPTY_ORGANIZER_COUPON_PERFORMANCE, unavailable: true }))
```

with a comment noting that the EMPTY constant "carries `unavailable: false`, because it is…".
The same treatment was never applied to the Analytics call site. This is the F1 defect class —
absence rendered as a measurement — in a surface that has otherwise eliminated it.

**Documented, not fixed.**

## 12. Free vs Paid Audit

| Risk | Status | Why |
|---|---|---|
| Free registrations inflate paid revenue | **Safe** | They contribute `amount: 0`; counts are published separately as `free` |
| Pending registrations inflate revenue | **Safe** | `status != 'confirmed'` excludes them everywhere |
| Failed payments inflate revenue | **Safe** | Never reach `confirmed` |
| Refunds counted as new revenue | **Safe** | Refunds are a subtraction from a separate ledger; they never add |
| Legitimate ₹0 distinguishable from unavailable | **Safe on every organizer surface** — `revenueUnavailable`, `MaybeMoney`, `complete:false`, `Count` null | **Except F-1** (coupons) and the admin licence rollup's `catch → 0` |

Checked across all aggregators, not only the Dashboard: events list/detail, DashboardEvent, the
KPI total, Analytics financial, per-pass, refunds, and the Finance module.

## 13. Revenue Comparison Audit

| Comparison | Available | Same definition? | Same timezone? | Same coverage? | Same permission? |
|---|---|---|---|---|---|
| Previous period | **Yes** | yes — both sides from the same rollup rows | IST both | guarded by `baselineOutsideCoverage` | yes |
| Previous event edition | **No** | — | — | — | — |
| Event-to-event | **No** | — | — | — | — |
| Category comparison | **No** | — | — | — | — |
| Custom date range | **Yes** (window is the caller's) | yes | IST | yes | yes |

**The coverage distinction is preserved.** `coveragePartial` and `baselineOutsideCoverage` are
separate fields with a source comment explaining that they "disagree in the common case: a 7-day
window can sit entirely inside coverage while its baseline does not". `normalize.ts` derives
`baselineReason` from the dedicated flag, not from `coveragePartial`, and **no delta is emitted
when the baseline is genuinely unavailable** — `compareMetric` receives `null` and the comparison
is omitted.

## 14. Dashboard / Analytics / Reports Consistency

| Surface | Metric | Reader | Agrees with Analytics? |
|---|---|---|---|
| Dashboard KPI `totalRevPaise` | lifetime confirmed | counters | **Usually — see F-2** |
| DashboardEvent `confirmedRevenuePaise` | per-event lifetime | counter → ledger | **Usually — see F-2** |
| Events list / detail | per-event lifetime | counter → ledger | **Usually — see F-2** |
| Analytics `financial.confirmedRevenuePaise` | per-event lifetime | **ledger always** | authoritative |
| Analytics `overview.revenuePaise` | **period** | rollups | different question, correctly labelled |
| Reports hub total | Σ of DashboardEvent | counters | inherits F-2 |
| Admin Event360 "Revenue" | counter only | **no fallback** | can differ on an un-backfilled event |

**Two documented, legitimate divergences:**

1. **Admin Event360 renders two revenue figures on one page** — "Revenue" (counter-only) and
   "Revenue (confirmed)" (Analytics ledger). They can legitimately differ, and nothing on the page
   explains why. Carried from the RD-12-23 audit; still true.
2. **Counter-vs-ledger drift (F-2)** can make the Dashboard and Analytics disagree about the same
   event with no visible explanation.

Everything else is consistent by construction: one definition, one helper, and `periodRevenue`
deliberately reusing the shared overview metric rather than re-deriving it.

## 15. Authorization Matrix

`ROLE_PERMISSIONS`: owner = all · finance = `wallet, settlements, transactions` ·
admin = `events, registrations, broadcasts, certificates, checkin, walkin, participants` ·
manager = `events, registrations, checkin, walkin, participants` · gate roles = `checkin[, walkin]`.

**The financial gate is `transactions` everywhere.**

| Surface | Route gate | Financial gate | owner | finance | admin | manager | gate roles |
|---|---|---|---|---|---|---|---|
| `/api/organizer/dashboard` | `authorizeAnyWorkspace` | `transactions` | ✅ money | ✅ money | ❌ null | ❌ null | 403 |
| `/api/organizer/events` | `authorizeAnyWorkspace` | `transactions` | ✅ | ✅ | ❌ null | ❌ null | 403 |
| `/api/organizer/events/[eventId]` | `authorizeWorkspace('events')` | `transactions` | ✅ | **403 at the route** | ❌ null | ❌ null | 403 |
| `/api/organizer/analytics/[eventId]` | `authorizeAnyWorkspace` + event scope | `transactions` → `includeFinancial` | ✅ | ✅ | ❌ block absent | ❌ block absent | 403 |
| Analytics **export** | same | **same** | ✅ | ✅ | ❌ section absent | ❌ section absent | 403 |
| Reports hub | via dashboard | inherits | ✅ | ✅ | ❌ | ❌ | — |
| Finance module | `wallet`/`settlements`/`transactions` | own | ✅ | ✅ | ❌ | ❌ | — |
| Admin Event360 | admin auth | admin-only | — | — | — | — | — |

**Verified properties:**

- **The gate precedes the read.** `financeAllowed` is resolved before the aggregate is issued, and
  the purely-financial reads are *skipped* for a denied caller — money is not computed and then
  hidden.
- **Unauthorized is never zero.** `null` on the organizer row contracts; the whole `financial`
  block is **omitted** in Analytics.
- **Exports follow the same model** — the financial section is absent for a caller without
  `transactions`, with a source comment stating that this is so "UI and export cannot disagree
  about who may see money".
- **No unprotected secondary endpoint** surfaces revenue: every `revenuePaise`-bearing organizer
  route was enumerated in RD-12-25 and each is gated.
- Workspace and event boundaries are enforced upstream (`authorizeAnyWorkspace` /
  `requireEventScope`), proven end to end by 27 emulator tests with real tokens across two
  workspaces.

## 16. Zero vs Unavailable Audit

| Surface | measured +ve | measured zero | authorized-unavailable | unauthorized |
|---|---|---|---|---|
| DashboardEvent | number, flag false | `0`, flag false | **`0` + `revenueUnavailable: true`** (locked) | `null`, flag false |
| Events list / detail | number | `0` | `0` + flag | `null` |
| Dashboard KPI `totalRevPaise` | number | number | **`null`** | n/a (payload gated) |
| Analytics financial | `{ok:true}` | `{ok:true, paise:0}` | `{ok:false, reason}` | **block absent** |
| Per-pass | value | `0` | **empty map** (`complete:false`) | absent |
| Refunds | value | `0` | `gone('out_of_budget')` | absent |
| Counts (`Count`) | number | `0` | `null` | absent |
| **Coupons (Analytics)** | value | `0` | **`0` with `discountUnavailable: false`** ⚠ **F-1** | absent |
| Coupons (Dashboard) | value | `0` | flag `unavailable: true` ✅ | absent |
| Admin licence rollup | value | `0` | **`catch → 0`**, no signal (P3) | n/a |

The locked DashboardEvent contract (`0` + `revenueUnavailable: true`) is intact and **not
proposed for change here**.

## 17. Date Range / Timezone Audit

| Range | Implementation | Finding |
|---|---|---|
| 7 / 30 / 90 days | `dayKeyRange(end, days)` over IST day keys | **Sound** |
| Custom range | caller-supplied window, same rollups | **Sound** |
| Previous period | preceding window of equal length, same rows | **Sound** |
| MTD | string-prefix match on `YYYY-MM-DD` | **Sound** — timezone-stable because every key is already an IST day |
| Day boundary | `dayKey` fixed to **IST**, documented | **Sound** |

**No UTC truncation, off-by-one or midnight-boundary defect was found** in the revenue paths.

**One real attribution mismatch (not a bug, a semantic difference to carry forward):** the daily
rollup attributes a cancellation's revenue reversal to the **original** day
(`reverse_confirm → -amount` on that day), while the cancellation *event* is recorded on today.
This is deliberate and documented. But it means **refund and cancellation dates are handled
differently across metrics**: refunds are lifetime-only and never attributed to a period at all
(§10), while cancellations *are* retro-attributed in the daily series. A future "net revenue this
month" metric would have to choose, and the two sources answer differently.

## 18. Failure-Handling Audit

| Site | Behaviour | Verdict |
|---|---|---|
| `sumConfirmedRevenueFromLedgerChecked` | `{ value: 0, ok: false }` — caller must check `ok` | **Correct** |
| Dashboard self-healing aggregate | `.catch(() => null)` — null means unmeasured | **Correct** (the RD-12-21 fix) |
| Analytics financial | `gone('query_failed')` / `gone('out_of_budget')` | **Correct** |
| Per-pass value | `complete:false` + **empty map**, never zeros | **Correct** |
| Refund totals | `gone('out_of_budget')` beyond the read cap | **Correct** |
| Gateway fee coverage | blends actual + estimate and **says so** in a note | **Correct** |
| Coupon discount (inner) | `discountUnavailable = true` | **Correct** |
| **Coupon (Analytics outer)** | `.catch(() => EMPTY_COUPON_PERFORMANCE)` → zeros, flag false | **F-1 — P2** |
| Admin licence rollup | `catch → { total:0, active:0, revenuePaise:0 }` | **P3** — admin-only, no unavailable signal |
| `dailyStats` missing field | `num(d.revenuePaise)` → 0 | **Acceptable** — an absent rollup day genuinely had no activity |

**One genuine instance** where a failed financial read can masquerade as ₹0 on an organizer
surface: **F-1**. Everything else on the organizer path carries an explicit absence signal.

## 19. Scale Audit

The decisive fact: **the registration scan is gone.** RD-ANALYTICS-03 removed a
`.limit(CAP + 1)` read that derived every count, chart and per-pass figure from a page of
documents — *"a 20,000-person event showed roughly a quarter of itself"*.

| Path | Cost | 5k | 20k | 50k | Class |
|---|---|---|---|---|---|
| Confirmed revenue (counter) | 1 document read | O(1) | O(1) | O(1) | **SAFE** |
| Confirmed revenue (ledger fallback) | 1 `sum()` aggregate, index-served | O(1) | O(1) | O(1) | **SAFE** |
| Dashboard events | 1 counter doc per event + bounded fallback | fine | fine | fine | **SAFE** |
| Per-pass value | **2 aggregates per pass**, budget 60 | fine | fine | fine | **SAFE** (caps at ~30 passes, then `complete:false`) |
| Refund totals | bounded by `ORGANIZER_REFUND_READ_CAP` | fine | fine | **`out_of_budget`** | **SAFE** — degrades honestly |
| Ledger components | bounded read, reports truncation | fine | fine | **`out_of_budget`** | **SAFE** |
| Daily rollups | ≤ 90 documents | O(1) | O(1) | O(1) | **SAFE** |
| Secondary collections (`CAP = 5000`) | bounded | fine | fine | truncates with a reason | **SAFE** |
| Client-side financial aggregation | `reports/page.tsx` sums ≤ page of events | trivial | trivial | trivial | **SAFE** |

**No P0 or P1 scale finding.** No unbounded read, no N+1, no per-registration aggregation and no
raw scan remains on any revenue path. The one structural ceiling — ~30 passes for the per-pass
split — degrades to "unavailable", not to a wrong number.

**WARNING (P3):** at very large events the refund and ledger reads return `out_of_budget`, so
`netRevenue` and the gateway group silently become unavailable for exactly the organizers with the
most money at stake. Honest, but the most valuable case is the one that degrades.

## 20. Cache / Performance Audit

| Question | Finding |
|---|---|
| Is Analytics revenue recomputed every request? | **Yes** — the route sets `Cache-Control: no-store` and holds no server-side cache |
| Are counters used? | Yes, for the organizer row contracts — but **not** by Analytics, which always re-aggregates |
| Are daily stats used? | Yes, for period/trend figures |
| Is transaction aggregation repeated? | **Yes**, on every Analytics request |
| Short-TTL cache? | **None anywhere** |
| Cache key scope / isolation | n/a — no cache exists |

**Highest-value opportunities**, in order:

1. **Analytics event financial block** — the most expensive read on the platform (ledger
   aggregate + refunds + per-pass sums + coupon aggregate) recomputed per request. A 30–60s TTL
   keyed by `(organizerUid, eventId, window, financeAllowed)` would cut it dramatically. **The
   permission must be part of the key** or a cached entitled response could be served to a denied
   caller.
2. **Dashboard counter fan-out** — one counter document per event per load.
3. **Per-pass value** — 2 aggregates per pass, unchanged between loads.

Not implemented, per scope.

## 21. Data Coverage Matrix

| Capability | Status |
|---|---|
| Confirmed revenue | **A — fully supported** |
| Refunds (lifetime) | **A** |
| Net revenue (lifetime) | **A** |
| Gross collected / fees / settlement | **A** |
| Revenue trend (daily, period, comparison) | **A** |
| Per-pass revenue (lifetime) | **A** |
| Payment mix (counts) | **B — partial**: no `failed` row, no payment method |
| Coupon impact | **B — partial**, and **D on failure** (F-1) |
| Gross-vs-net distinction | **A** — arguably the strongest part of the model |
| Period comparison | **A** |
| Refund rate | **C — unavailable** (derivable, not derived) |
| Refunds by period | **C** |
| Revenue velocity | **C** |
| AOV | **C** |
| Event-to-event comparison | **C** |
| Category/ticket-type revenue | **C** |
| Counter-vs-ledger consistency signal | **C**, and **D** in the drift case (F-2) |

## 22. Product-Value Assessment

Judged on correctness, completeness, actionability, clarity, trustworthiness — not polish.

**Correctness: strong.** Every figure is defined, sourced and refuses to fabricate. **Clarity:
unusually strong** — each row carries a one-line definition, and the gateway group is separated
from the headline group specifically to prevent invalid subtraction. **Trustworthiness: strong**,
with the two documented exceptions.

**Completeness and actionability: weak.** An organizer can answer *"what did this event earn, and
what came back?"* — and almost nothing else. They cannot answer:

> *Am I selling faster or slower than last week? · What is a buyer worth to me? · Which pass
> actually drives my revenue over time? · Is this event ahead of my last one? · What did coupons
> cost me in revenue terms?*

**Top five highest-value missing capabilities**, all supportable from existing data:

| # | Capability | Data source that exists today |
|---|---|---|
| **1** | **Revenue velocity** — revenue/day over the window, against the preceding window | `organizerDailyStats` (IST days, already windowed and compared for registrations) |
| **2** | **Average order value**, with an explicit declared denominator | `confirmedRevenue` ÷ `registrations.paid` — both already published |
| **3** | **Refund rate and refunds-by-period** | refund ledger; needs period attribution, which the ledger's timestamps support |
| **4** | **Event-to-event comparison** | every per-event figure already exists; needs only a multi-event read and one definition |
| **5** | **Revenue before discount / coupon revenue impact** | `confirmed + totalDiscountPaise` — both measured today; needs F-1 closed first |

Deliberately excluded as unsupported by existing data: payment-method mix, per-category revenue
(no category dimension on registrations), cohort/LTV (no cross-event identity in the revenue
model), forecasting.

## 23. Event-Type Compatibility

`eventType` is read into `AnalyticsEventIdentity` and used **only** to resolve *capabilities*
(which panels appear). **No revenue calculation, definition, gate or label is
event-type-specific** — searched `eventAnalytics.ts` and `revenueModel.ts` for `eventType`
branching in the financial path: none.

Revenue intelligence is therefore **universal** across community, conference, sports, workshop,
exhibition, cultural, awards, fundraising and meetup. The codebase actively defends this: a
capability comment records that *"Gating on `eventType === 'conference'` was rejected: workshops,
cultural…"*, and the gallery module notes it contains *"no `if (eventType === 'sports')`"*.

**One event-type-adjacent gate exists and is correct:** `isFreeEvent` short-circuits the revenue
display to "Free" before any figure is consulted — a pricing property, not an event type.

## 24. Financial Semantics Map

| Metric | Meaning | Source | Scope | Refunds | Pending | Permission | Absence state |
|---|---|---|---|---|---|---|---|
| **Confirmed ticket revenue** | what the event sold, at prices charged | counter → ledger (Analytics: ledger always) | lifetime | **stable** — unaffected | excluded | `transactions` | `0`+flag / `MaybeMoney` / `null` when denied |
| **Refund amount** | money actually returned | **refund ledger** | lifetime | — | — | `transactions` | `gone('out_of_budget')` |
| **Refund pending** | refund requested, not completed | registration `paymentStatus` | lifetime | — | — | `transactions` | `Count` null |
| **Net revenue** | confirmed − completed refunds | derived, both required | lifetime | **subtracted** | excluded | `transactions` | `gone` if either input is |
| **Gross collected** | captured by the gateway | payment ledger | lifetime | not subtracted | n/a | `transactions` | `gone` |
| **Platform fee / GST / gateway fee** | deductions on captures | payment ledger | lifetime | n/a | n/a | `transactions` | `gone`; fee may blend actual+estimate |
| **Net settlement** | what the gateway settles | payment ledger | lifetime | n/a | n/a | `transactions` | `gone` |
| **Period revenue** | revenue inside the selected window | **daily rollups** | **window (IST days)** | cancellation reversals retro-attributed | excluded | `transactions` | absent |
| **Daily revenue** | revenue attributed to one IST day | `organizerDailyStats` | one day | reversal on the **original** day | excluded | `transactions` | `trendUnavailable` |
| **Per-pass revenue** | confirmed ticket value per pass | Σ `amount` per pass | **lifetime only** | stable | excluded | `transactions` | empty map |
| **Discount given** | Σ `discountAmount` | registrations | lifetime | n/a | included | `transactions` | flag — **F-1** |
| **Licence revenue** | organizer→platform licence income | `eventLicenses.amountPaise` | lifetime | n/a | n/a | admin | `catch → 0` (P3) |
| **Media-credit revenue** | platform media-credit sales | purchase `amountPaise` | lifetime | n/a | n/a | admin | n/a |

**Never combine across rows of this table without a stated reason.** Confirmed revenue and gross
collected count different populations; period and lifetime answer different questions; licence and
media-credit revenue flow in the opposite direction.

## 25. Findings by Severity

**P0 — none.**

**P1 — none.**

| ID | P | Finding | Surfaces | Proposed future correction |
|---|---|---|---|---|
| **F-1** | **P2** | Analytics `.catch(() => EMPTY_COUPON_PERFORMANCE)` renders a failed coupon read as a measured "₹0 discount, 0 redemptions" — `discountUnavailable` stays false | Analytics coupon panel | Mirror the Dashboard's one-line fix: `.catch(() => ({ ...EMPTY_COUPON_PERFORMANCE, discountUnavailable: true }))` |
| **F-2** | **P2** | Guarded counter decrement can skip permanently, leaving the counter above ledger truth; `statsVersion` cannot detect value drift | events list/detail, DashboardEvent, dashboard KPI, Event360, Reports | Decide deliberately: routine reconciliation for this field, an unguarded decrement with a floor, or a surfaced consistency signal |
| **F-3** | **P3** | Admin licence rollup `catch → 0` with no unavailable signal | Admin organizer360, licence centre, platform monitor | Add an availability flag, admin-only |
| **F-4** | **P3** | Admin Event360 shows counter-only "Revenue" beside ledger "Revenue (confirmed)" with no explanation of why they can differ | Admin Event360 | Label the basis, as `byPassBasis` does |
| **F-5** | **P3** | No caching anywhere; the most expensive financial read recomputes per request | Analytics | Short-TTL cache keyed including `financeAllowed` |
| **F-6** | **P3** | Ledger/refund reads degrade to `out_of_budget` exactly at the largest events | Analytics | Raise or paginate the budget |
| **F-7** | **P3** | Payment mix omits `failed`; failed payments present as "Awaiting payment" | Analytics | Add the row, or document the merge |

## 26. Recommended Implementation Sequence

### A. Must fix before adding intelligence

| Item | Why | Source | New data? | Scale | Authorization | Schema/index? |
|---|---|---|---|---|---|---|
| **F-1 coupon false zero** | Any "coupon impact on revenue" metric would inherit a fabricated ₹0 | existing | no | none | unchanged | no |
| **F-2 decision** (not necessarily a fix) | Velocity, AOV and comparison all read counter-derived figures. Building on a value that can silently overstate makes every derived metric inherit the drift | existing | no | none | unchanged | no |

### B. Core revenue intelligence

| Item | Why | Current source | Expected source | New data? | Scale | Auth | Schema |
|---|---|---|---|---|---|---|---|
| **Revenue velocity** | the single most actionable missing figure | none | `organizerDailyStats`, same windows as registration velocity | no | O(1) — ≤90 docs | `transactions` | no |
| **AOV with declared denominator** | "what is a buyer worth" | none | `confirmedRevenue` ÷ `registrations.paid`, denominator named in the payload like `byPassBasis` | no | O(1) | `transactions` | no |
| **Refund rate + refunds by period** | closes the only asymmetry in the headline trio | refunds lifetime-only | refund ledger with date attribution | no | bounded read | `transactions` | **possibly an index** on refund date |

### C. Advanced intelligence

| Item | Why | Source | New data? | Scale | Auth | Schema |
|---|---|---|---|---|---|---|
| **Event-to-event comparison** | the most requested organizer question this model cannot answer | per-event figures already exist | no | N counter reads — bound it | `transactions` | no |
| **Revenue before discount** | quantifies coupon cost in revenue terms | `confirmed + discount`, both measured | no | O(1) | `transactions` | no |
| **Per-pass revenue over time** | currently lifetime-only | **would need a per-pass daily rollup** | **YES — new write path** | rollup fan-out per pass | `transactions` | **new collection** |

### D. Performance / caching

Short-TTL cache for the Analytics financial block, keyed by
`(organizerUid, eventId, window, financeAllowed)`. **The permission must be in the key.** No
schema change. Highest value per unit of work of anything in this list.

### E. UI presentation

Deliberately last, and out of scope for this audit. One note carried from §14: two screens showing
different numbers for the same event needs an explanation on the screen, not only in a document.

## 27. Final Verdict

## APPROVED WITH CONDITIONS

The foundation is sound: no P0, no P1, no scale defect, no authorization gap, and an
unavailable-versus-zero discipline that is better than most of the industry. Revenue intelligence
can be built on it.

**Conditions, both P2:**

1. **Close F-1** before publishing any coupon-derived revenue metric. The fix is one line and
   already exists on the Dashboard; leaving it means a derived metric would inherit a fabricated
   zero.
2. **Make a deliberate decision about F-2.** It need not be fixed, but it must be *chosen* —
   velocity, AOV and event comparison would all be computed from counter-derived figures that can
   silently overstate, and a derived metric multiplies a drift rather than exposing it.

Neither condition blocks design work, and neither requires a schema, index or rule change.

---

### Scope compliance

Read-only throughout. No source, test, schema, migration, index, rule or configuration file was
modified; no metric was corrected, no calculation changed, no UI touched. Nothing was committed,
pushed or deployed.

Worktree entries went **715 → 720** across this audit. Reported precisely rather than as proof of
anything: **one** is this document, and the other **four** belong to the concurrent
authentication/login UI workstream, which continued writing while the audit ran. Every revenue
source file retains its pre-audit timestamp — `eventAnalytics.ts` 9 Sep, `revenueModel.ts` 5 Sep,
`couponPerformance.ts` 27 Aug, `revenueState.ts` 10 Sep, and `dashboard/route.ts` 11 Sep 12:58
from RD-12-25 — so nothing in the financial path was touched here.
