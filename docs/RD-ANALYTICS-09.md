# RD-ANALYTICS-09 — Revenue Intelligence

**Status:** implemented, gated, browser-validated.
**Date:** 2026-09-05
**Scope:** the Revenue analytics module (financial data + dedicated UI) on the normalized
contract. No payment/checkout/refund-execution/payout change, no ledger schema change, no
rules or index change, no route migration, no Overview redesign.

---

## 1 · Audit findings

### 1.1 The canonical confirmed-revenue source

`sumConfirmedRevenueFromLedgerChecked(eventSlug)` in
`lib/firebase/firestore/registrationCounters.ts`:

```ts
adminDb.collection('registrations')
  .where('eventSlug', '==', eventSlug)
  .where('status',    '==', 'confirmed')
  .aggregate({ s: AggregateField.sum('amount') })
```

One `sum()` aggregate — **zero documents transferred**. Refund-STABLE by construction: a
refund leaves `status: 'confirmed'` and does not change `amount`, so this figure does not
move when money goes back. `{ ok: false }` means the read failed and the caller must not
display the 0 it returns alongside it. Dashboard, Events, Finance and Analytics all read
through this one helper.

### 1.2 The canonical refund source

`getRefundTotals(scope)` in `lib/finance/financeAnalytics.ts`, over
`listOrganizerRefunds` — the same reader the refund exports use. Returns `count`,
`amount: MaybeMoney`, `unlinked`, `recovered`, `complete`.

Two properties that matter here:

* nothing in that path reads a registration status — *"a refund is not a cancellation"*;
* over `REFUND_READ_CAP` the rows are withheld and the amount becomes
  `gone('out_of_budget')` while the **count stays exact**. A capped sum is never presented
  as a total.

### 1.3 Competing revenue definitions — the whole point of the audit

Five figures in this codebase are called, or could be mistaken for, "revenue":

| # | figure | basis | population |
|---|---|---|---|
| 1 | `sumConfirmedRevenueFromLedgerChecked` | Σ `amount` | CONFIRMED registrations — **canonical** |
| 2 | `registrationCounters.revenuePaise` | Σ `amount` | same definition, denormalized; may be un-backfilled |
| 3 | `organizerDailyStats.revenuePaise` | Σ `amount`, attributed per day, reversed on cancel | same definition, **daily** |
| 4 | `aggregateValueByPass(...).salesPaise` | Σ `amount` | confirmed, **per pass** |
| 5 | `platformTransactions` gross / fees / net | gateway captures | a **different population** |

1–4 share one basis and reconcile. **5 does not**, and RD-ANALYTICS-02 already fixed a
defect where it silently substituted for 1. This phase keeps them apart and never lets a
gateway figure carry the word "Revenue" unqualified.

### 1.4 The financial authorization boundary (RD-02)

`financeAllowed = authz.permissions.includes('transactions')`, decided in the route and
passed **into** `getEventAnalytics` as `includeFinancial`, so financial reads are never
issued for a caller who may not see them. `EventAnalytics.financial` is then absent, and
`normalizeEventAnalytics` writes the `revenue` key only `if (a.financial)` — so an
unauthorized payload does not carry `revenue: null`; the key does not exist. Same for
`period.revenuePaise`, which is dropped at the read boundary.

### 1.5 MaybeMoney / null semantics

`lib/finance/gatewayFee.ts`: `MaybeMoney = { ok: true; paise } | { ok: false; reason }`,
with `money()` truncating to integer paise and `gone(reason)` carrying why. Every financial
figure in the contract is `MaybeMoney`; counts are `number | null`.

### 1.6–1.8 Range, comparison and coverage

All three exist and are reused unchanged: `PRESET_DAYS` 7/30/90 and `normalizeRange`;
`previousPeriod` + `compareMetric` + `computeDelta` (which returns `pct: null` for an empty
baseline rather than ∞); `readCoverage` + `coveragePartial` + `baselineOutsideCoverage`.

**The period revenue comparison already exists** as `overview.revenuePaise` — period
against preceding period, both summed from the same rollup rows, omitted entirely without
the permission. This module consumes it rather than adding a second one.

### 1.9 Existing revenue UI

`AnalyticsOverview` renders a "Confirmed revenue" rail metric and a "Revenue trend" panel,
both behind `showRevenue`. `Primitives.tsx` supplies `inr()`, `RailMetric`, `RailMovement`,
`DeltaChip`, `Section`; `TrendPanel` takes a `format` function and is currency-ready.
RD-ANALYTICS-08's `useAnalyticsScope` and `ModuleChrome` supply the fetch and the controls.
All are reused; nothing is re-implemented.

### 1.10 Remaining direct transaction reads — **a real defect**

```ts
await adminDb.collection('platformTransactions')
  .where('entityId', '==', eventId).limit(CAP).get()      // CAP = 5000
...
if (!ptx.empty) { /* sum every doc */ ledgerAvailable = true }
```

Two problems, both of which produce a confident wrong number:

1. **Truncation is undetected.** An event with more than 5,000 platform transactions sums
   the first 5,000 and sets `ledgerAvailable = true`. Gross, fees and net are then a
   partial sum presented as a total — and `profitEstimate`, which consumes `net`, inherits
   it. This is the same class of defect RD-ANALYTICS-03 removed for registrations.
2. **A successful EMPTY read is reported as unavailable.** `ledgerAvailable` only becomes
   true when `!ptx.empty`, so an event that genuinely collected nothing shows "Unavailable"
   rather than a measured ₹0 — the mirror image of the rule, and it makes a free event look
   broken.

Both are fixed in this phase (§ below) without changing the schema, the index or the cap's
justification: the query is issued as `limit(CAP + 1)`, and over the cap the ledger figures
become `gone('out_of_budget')` with `limits.ledger = false` — exactly what `getRefundTotals`
already does over its own cap.

### 1.11 Pass / category revenue

`aggregateValueByPass` sums `amount` over confirmed registrations per pass — the **same
canonical basis as #1**, via two `sum()` aggregates per pass against a caller budget, and it
reports `complete: false` rather than returning a partial map. It is therefore financially
canonical and safe to display, but it is **lifetime**: there is no per-pass daily rollup, so
it can never be a selected-period figure.

### 1.12 Communication spend and the profit estimate

`communicationCostPaise` is Σ `costPaise` over `emailLogs` for the event, capped at CAP —
so it carries the same truncation question, already reflected in `limits.communications`.

`profitEstimatePaise` = `netSettlement − completedRefunds − communicationSpend`, published
**only** when all three inputs read successfully. RD-ANALYTICS-02 established that rule
because subtracting across bases from a partially-read input produced a number with no
defensible interpretation labelled "Profit". The formula is preserved exactly.

### 1.13 What the data cannot support

**Completed refunds by day does not exist.** There is no daily refund rollup, and the refund
ledger read is itself capped — bucketing a capped set by day would draw a chart from a
partial population. The revenue trend therefore shows confirmed revenue per day only, from
the rollups, and the module says so. Building it would require either a scan or a new
rollup, and both are out of scope.

---

## 2 · Financial source of truth

| figure | source | reader |
|---|---|---|
| **Confirmed revenue** | Σ `amount` over CONFIRMED registrations | `sumConfirmedRevenueFromLedgerChecked` — one `sum()` aggregate, 0 documents |
| **Completed refunds** | the refund ledger (`registrationRefunds`) | `getRefundTotals` → `listOrganizerRefunds` |
| **Net revenue** | confirmed revenue − completed refunds | derived in the producer, integer paise, both inputs required |
| **Revenue per day** | `organizerDailyStats.revenuePaise` | `readDailyStats` — one `getAll`, one doc per day |
| **Revenue per pass** | Σ `amount` over confirmed, per pass | `aggregateValueByPass` — budgeted `sum()` aggregates |
| **Gross / fees / net settlement** | `platformTransactions` | bounded read, **a different population** |

Nothing reads `registration.price`, `categoryPrice`, a Razorpay order/payment amount, or a
client-side total. Every figure is integer paise end to end; `inrPaise` is the single place
a number becomes currency text.

## 3 · KPI definitions

| KPI | definition | basis |
|---|---|---|
| Confirmed revenue | ticket value of confirmed registrations | lifetime, refund-STABLE |
| Completed refunds | money returned, from the refund ledger | lifetime |
| Net revenue | confirmed revenue less completed refunds | lifetime |
| Revenue in the window | Σ daily rollup revenue over the range | **period**, with comparison |
| Gross collected | captured by the payment gateway | lifetime, gateway population |
| Platform fee / GST / Gateway fee | the ledger's own components | lifetime, gateway population |
| Net settlement | what the gateway settles after its fees | lifetime, gateway population |
| Estimated retained | net settlement − completed refunds − communication spend | lifetime, all inputs required |
| Paid / Free / Awaiting payment / Refund in progress / Refunded | registration **counts** by `paymentStatus` | lifetime, counts — never amounts |
| Revenue by pass | confirmed ticket value per pass | **lifetime**, captioned as such |

The gateway group is rendered in its own panel, captioned *"Captures for this event — a
different population from ticket revenue"*, so the reader is not invited to subtract across
that boundary. No gateway figure is labelled "Revenue".

The paying population is published as counts beside the money, never with rupee values
attached: a paid registration may since have been cancelled and a confirmed one may be free,
so "paid registrations" is not "confirmed revenue".

## 4 · Refund semantics

Completed refunds come from the refund ledger and only from there. A **pending** refund is a
registration count (`paymentStatus === 'refund_pending'`) shown in the paying-population
panel, and it is never subtracted from anything — only completed refunds participate in net
revenue. A refund-only event reports a **negative** net rather than clamping to zero, because
clamping would hide a real accounting state behind a comfortable number.

## 5–7 · Range, comparison and coverage

The shared 7/30/90 model, the RD-07 comparison and the RD-07 coverage model, all reused
unchanged. The period revenue metric is `overview.revenuePaise` — period against preceding
period, both summed from the same rollup rows — consumed rather than re-derived, so there is
exactly one financial comparison in the product and it is omitted for an unauthorized caller
by construction.

Zero baseline yields `pct: null`, never +∞%. Zero in both windows is flat. A drop to zero is
a real −100%. An unmeasured window is `not_measured`; a baseline before the coverage floor is
`outside_coverage` and is explained in words. Lifetime figures carry no chip at all.

## 8 · Authorization model

`financeAllowed = permissions.includes('transactions')` is decided in the route, **before**
any read, and passed into the producer as `includeFinancial`. The consequences are structural
rather than cosmetic:

* the `platformTransactions` query object is never constructed without the permission;
* `EventAnalytics.financial` is `undefined`, so `normalizeEventAnalytics` never writes the
  `revenue` key — the payload does not carry `revenue: null`;
* `period.revenuePaise` is dropped at the read boundary, so no financial comparison exists;
* the module renders an explicit refusal rather than an empty shell, and contains no
  permission logic of its own — a guard fails if it ever references a permission list.

Verified on the wire, not just on screen: a manager's payload and a direct probe with their
own bearer both carry no `Paise`, no `revenue`, no `profitEstimate`, no `netSettlement`, no
`gatewayFee`, and `financialAllowed: false`. Check-in staff receive **403** from the endpoint.

## 9 · Performance and read behaviour

The module itself adds **no data access** — no `adminDb`, no `collection(`, no `.limit(`, no
client-side financial aggregation. Everything is served by the one request the workspace
already makes.

**The one transaction read, and its bound.** `platformTransactions` is read once, filtered to
the event, with `.limit(CAP + 1)`. That extra document is the whole point: over the cap the
producer publishes **nothing** — every gateway figure becomes `gone('out_of_budget')`,
`limits.ledger` goes false, and the profit estimate inherits the refusal. Previously it summed
the first 5,000 and presented the result as a total.

Proven against real Firestore in `tests/emulator/revenueLedgerBound.emu.test.ts`: 4,000
transactions produce an exact total; 5,001 produce nothing, and the partial sum appears
nowhere in the payload. The 20k-registration scale suite still passes with its
document-transfer bound unchanged.

**No new collection, index, rule or schema change was required or made.**

## 10 · Files changed

| file | change |
|---|---|
| `lib/analytics/eventAnalytics.ts` | ledger read `limit(CAP + 1)` with truncation detection; empty successful read is now a measured ₹0; `netRevenuePaise`; `ledgerMoney` distinguishes `out_of_budget` from `query_failed` |
| `lib/analytics/contract.ts` | `RevenueAnalytics.netRevenue`, `RevenueAnalytics.byPassBasis` |
| `lib/analytics/normalize.ts` | maps both new fields |
| `lib/analytics/revenueModel.ts` | **NEW, pure.** `inrPaise`, `displayMoney`, `moneyUnavailableNote`, `revenueHeadlines`, `gatewayRows`, `gatewayAvailability`, `periodRevenue`, `revenueByPass`, `payingPopulation` |
| `components/analytics/revenue/RevenueAnalytics.tsx` | **NEW.** The module |
| `app/(dashboard)/dashboard/analytics/revenue/page.tsx` | **NEW** route |

**Tests** — `tests/unit/analyticsRevenue.test.ts` (new, 42);
`tests/emulator/revenueLedgerBound.emu.test.ts` (new, 6); the fake Firestore in
`analyticsFinancialTruth` and `analyticsUnavailable` now honours `limit`; five guards
re-anchored (see below).

**QA** — `scripts/qa/rd-analytics-09-seed.mjs`, `rd-analytics-09-shots.mjs` (new).

No API route was added or changed. No payment, checkout, verification, refund-execution,
payout or ledger-schema code was touched.

### Guards re-anchored, and why

| guard | was | is |
|---|---|---|
| `analyticsOverview` 30, `analyticsRegistrations` 29, `analyticsNormalize` 33 | banned the STRING `limit(CAP + 1)` | assert `registrations` is never queried, and that every read of that shape belongs to `platformTransactions` |
| `analyticsAuthorization` "the ledger publishes whether it actually read" | pinned the old one-reason `ledgerMoney` line | pins the two-reason version |
| `analyticsUnavailable` 8 | **asserted the defect**: an empty ledger had to be `ok: false` | an empty *successful* read is a measured ₹0; a **failed** read (test 7) is still `ok: false`; new test 8b covers truncation |

The blanket string ban would have forbidden the fix rather than the defect: `limit(CAP + 1)`
is now how truncation is *detected*. The rule is stated precisely instead.

Test 8's old assertion was wrong on its own terms. The architecture's rule is "a failed read
must not become a zero"; the converse — "a successful read of nothing must become a failure"
— is a different claim, and an untrue one that made every free event look broken.

## 11 · Tests and exact results

| gate | result |
|---|---|
| `tests/unit/analyticsRevenue.test.ts` (new) | **42 / 42** |
| all nine analytics suites | **313 / 313** |
| full unit suite | **318 files, 8563 passed, 1 skipped, 0 failed** |
| `tests/emulator/revenueLedgerBound.emu.test.ts` (new) | **6 / 6** |
| `tests/emulator/analyticsScale.emu.test.ts` (20k) | **18 / 18** |
| `npm run test:emu` (whole suite, clean emulator) | **41 files, 801 passed, 1 failed** |
| `tsc --noEmit` | 0 errors |
| `eslint` (all touched source, tests, QA scripts) | 0 problems |
| production `next build` | see the report |

The one emulator failure is `capturedRecovery.emu.test.ts` test 15 — pre-existing,
unrelated to analytics, and payments-recovery code was explicitly out of scope.

### Test-count change from RD-ANALYTICS-08

RD-ANALYTICS-08 finished at 317 files / 8506 passed. This phase adds:

* `tests/unit/analyticsRevenue.test.ts` — **+1 file, +42 tests**
* `analyticsFinancialTruth` — **+1** (`20b2`, the empty-ledger measured zero)
* `analyticsUnavailable` — **+1** (`8b`, the truncation refusal)
* five guards re-anchored in place — **no count change**

8506 + 42 + 1 + 1 = **8550**. The suite reports **8563**, a further **+13** in files this
phase did not modify. That is the same unattributed drift recorded in RD-ANALYTICS-08 §10
(which found +8 by the same arithmetic); per-file counts are stable across repeated runs,
and every analytics suite is individually accounted for above. It is recorded here rather
than papered over.

The emulator suite grows from 40 files / 794 cases to **41 / 802**: one new file with six
tests, plus the two added to the analytics scale suite in RD-ANALYTICS-08.

## 12 · Browser QA

Real emulator, real production build, Playwright, three viewports, viewport screenshots
only. Fixtures add a 120-row payment ledger, four completed refunds and a genuinely free
event to the RD-07/08 seeds.

| case | 1440 | 834 | 390 | result |
|---|---|---|---|---|
| owner, 7D / 30D / 90D | ✓ | ✓ | ✓ | confirmed ₹7,20,000 · net ₹7,14,000 · period ₹2,52,000 ↑50% |
| free event | ✓ | ✓ | ✓ | ₹0 / ₹0 / ₹0 as **measurements**, "No revenue recorded in this period." |
| refunds present | ✓ | ✓ | ✓ | net differs from confirmed by exactly the seeded ₹6,000 |
| partial coverage | ✓ | ✓ | ✓ | gap disclosed at 30D/90D, not at 7D; refused baseline explained |
| manager (no `transactions`) | ✓ | — | — | endpoint 200, `financialAllowed:false`, no `Paise`/`revenue`/`profitEstimate`/`netSettlement`/`gatewayFee` in the payload; page states why |
| checkin_staff | ✓ | — | — | direct endpoint probe with their own bearer: **403** |

Asserted, not merely photographed: currency is Indian-grouped with no `NaN`/`Infinity`/
exponent forms; confirmed revenue, completed refunds, net revenue, gross collected and net
settlement are all present and distinct; no delta chip sits inside the lifetime headline
section; the pass panel states its lifetime basis. No console errors, no page errors, no
horizontal overflow at any viewport.

The gateway figures reconcile against the fixture: 120 × ₹1,500 = ₹1,80,000 gross, which is
visibly **not** the ₹7,20,000 confirmed revenue — the two populations stay apart on screen.

## 13 · Known limitations

1. **Completed refunds by day is not shown.** No daily refund rollup exists, and the refund
   ledger read is itself capped — bucketing a capped set by day would draw a chart from a
   partial population. Building it needs either a scan or a new rollup, both out of scope.
2. **The gateway figures are capped at 5,000 transactions.** Over that they are withheld
   rather than approximated. Raising the ceiling needs an aggregate form for
   `platformTransactions` (a `sum()` per component) — a real follow-up, not a config change.
3. **`netRevenue` subtracts across two collections** — ticket value from `registrations`,
   refunds from the refund ledger. Stated in the UI as "Confirmed revenue less completed
   refunds" rather than presented as a single accounting primitive, and withheld unless
   both inputs were measured. It is the same cross-source rule `profitEstimate` follows.
4. **Revenue by pass is lifetime only.** No per-pass daily rollup exists; the basis travels
   in the payload (`byPassBasis`) and is printed in the caption.
5. **Communication spend remains capped** at CAP `emailLogs` rows, reflected in
   `limits.communications`. The profit estimate inherits that bound.
6. **The workspace-wide dashboard adapter publishes no `netRevenue`** — it has no refund
   total of its own. The field is only produced on the event path.

## 14 · Deferred work

* Operations, Communications, Participants and Reports modules.
* The route migration in `lib/analytics/routes.ts`, including renaming the contract endpoint
  and retiring the old Event Insights page.
* Navigation entries for the Revenue and Registrations modules; both are reachable directly
  and by the event selector today, and the sidebar belongs with the IA migration.
* An aggregate reader for `platformTransactions` so gateway figures survive above 5,000
  captures (limitation 2).
* A daily refund rollup, which would make refunds-by-day possible (limitation 1).
* Coupon performance is already produced by the pipeline and gated as a `revenue` panel in
  `ANALYTICS_PANELS`; surfacing it is a later phase.
