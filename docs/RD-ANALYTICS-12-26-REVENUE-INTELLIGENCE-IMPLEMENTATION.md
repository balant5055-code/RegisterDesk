# RD-ANALYTICS-12-26 — Revenue Intelligence (Implementation)

Both P2 foundations addressed — one fixed, one deliberately deferred with a proof — and four of
the five priority metrics implemented on canonical sources. Not committed, not pushed, not
deployed.

---

## A. Verdict

## IMPLEMENTED — CONDITIONS REMAIN

One condition remains, and it is the one the brief anticipated: **F-2 was not fixed, because no
local write is uniformly closer to ledger truth than the current guard** — only reconciliation is,
and reconciliation already exists and is scheduled. It is documented below with the analysis,
pinned by regression tests, and stated as the remaining condition.

Everything else is complete: F-1 is closed, and revenue velocity, AOV, refund rate, refunds by
period, and ticket value before discount are live on the Analytics Revenue module, proven at
20,000 registrations and photographed at three widths.

## B. F-1 Resolution — closed

**Previous behaviour.** `lib/analytics/eventAnalytics.ts` wrapped the coupon read as
`.catch(() => EMPTY_COUPON_PERFORMANCE)`. That constant carries `discountUnavailable: false`,
because it describes an event with genuinely no coupons — so a *failed* read (a permission error,
a transport failure, the coupons collection unreadable) rendered *"0 coupons, 0 redemptions, ₹0
discount"* as measured fact. The inner reader already handled its own aggregate failure
correctly; the outer catch defeated it.

**New behaviour.** One line, mirroring the fix the Dashboard already had:

```ts
.catch(() => ({ ...EMPTY_COUPON_PERFORMANCE, discountUnavailable: true }))
```

| State | `totalDiscountPaise` | `discountUnavailable` |
|---|---|---|
| success | measured | `false` |
| legitimate zero | `0` | `false` |
| **read failure** | `0` (placeholder) | **`true`** |

The empty *shape* is preserved for consumers; only the flag changes. Unrelated coupon semantics
are untouched. The flag then **propagates** into the new `beforeDiscount` metric, which becomes
unmeasured rather than "revenue + ₹0".

**Tests** — 5 cases in `revenueIntelligence.test.ts` (F-1 block): the Analytics call site is
asserted to carry the flag and to no longer contain the bare substitution; the Dashboard call
site is asserted unchanged so the two now agree; the inner reader's distinction is asserted
intact; and the propagation into `beforeDiscount` is proven in both directions — unavailable stays
unavailable, a real zero stays measured.

**One existing assertion repointed**, not weakened: `couponFilterAndPerformance.test.ts` pinned
the exact old expression under the name *"a coupon-performance failure cannot take the analytics
payload down"*. That property — the catch keeps the payload alive — is unchanged; the regex now
accepts the flagged substitute.

**False zero eliminated: yes**, on the Analytics surface, and the UI's existing
`discountUnavailable` branch now actually fires.

## C. F-2 Resolution — deferred, with proof

**The guard, verbatim** (`lib/firebase/firestore/registrations.ts:563`):

```ts
if (amt > 0 && currentRev >= amt)   updates.revenuePaise = FieldValue.increment(-amt)
```

**Every writer to `registrationCounters.revenuePaise` was traced.** There are exactly two:
`registrationCounters.ts:257` increments on confirmation; `registrations.ts:563` decrements on
cancellation of a confirmed registration. Nothing else touches it — refunds do not write to it
(the figure is refund-stable by design), and the daily-stats writers target a different
collection.

**Scenario classification:**

| | Scenario | Can the guard skip? | Why |
|---|---|---|---|
| A | Concurrency / race | **No** | The decrement runs inside a Firestore **transaction** whose `counterSnap` is a transactional read; contention retries the whole transaction. `currentRev` is consistent at commit |
| B | Duplicate decrement | **No** | The same transaction writes `status: 'cancelled'`; a second cancel reads `status !== 'confirmed'` and never enters the branch. **Idempotent by construction** |
| C | Refund | **n/a** | Refunds do not write the counter |
| D | Cancellation | **Yes — only if the counter is already low** | The sole reachable skip: `currentRev < amt` means the counter *already* lacks this registration's contribution |
| E | Repeated transition | **No** | Same as B |
| F | Stale / un-backfilled counter | **Yes** | `statsVersion` gates *schema* staleness; a counter below its true value passes the gate |
| G | Malformed amount | **No** | `amt > 0` excludes null, zero and negative |
| H | Amount edited after confirmation | **Yes** | The counter holds the *original* amount; the decrement uses the *current* one |

**So the guard does not cause drift — it reveals pre-existing drift and refuses to compound it
into a negative counter.** Its own comment says so: *"guarded independently to avoid going
negative on data inconsistency (reconciliation heals any residual drift)"*. That is the intended
architecture, and reconciliation is real: `lib/reconciliation/events.ts` compares `revenuePaise`
against a recomputed aggregate and repairs it, scheduled by `cron-maintenance.yml` at 02:00 daily.

**Why no local fix is safe — the argument that settled it.** Consider the alternative the audit
suggested: clamp instead of skip, `increment(-min(amt, currentRev))`. Call the ledger truth
before cancellation *L* and the drifted counter *C < amt*. After cancellation, truth is *L − amt*.

- **Skip** leaves the counter at *C*.
- **Clamp** takes it to *0*.

If this was the event's only paid registration (*L ≈ amt*), truth is ≈ 0 and **clamp is exactly
right**. If the event has many (*L ≫ amt*), truth is large and **skip is less wrong**. Neither
strategy is uniformly closer to the ledger, because *the counter is already wrong and the write
has no way of knowing by how much*. The only operation that can restore truth is the one that
reads the ledger — reconciliation. Replacing one heuristic with another would change persisted
financial data without making it more correct.

**Decision: deferred.** Per the brief's own instruction — *"if no safe correction can be made
without architectural risk, document F-2 as an explicit remaining condition"* — and with
regression coverage:

- the guard is pinned **verbatim**, so a future change is a decision rather than a drift;
- its transactional context, the `status: 'cancelled'` write that makes it idempotent, and the
  reconciliation reference in its comment are all asserted;
- reconciliation's existence for this field and its cron schedule are asserted;
- **Analytics is asserted to read the ledger, never the counter**, so every metric this phase
  adds is computed from the source that cannot inherit the drift.

**What remains** (the condition): between reconciliation runs, the counter-reading surfaces
(events list/detail, DashboardEvent, dashboard KPI, Event360) can overstate a drifted event
while Analytics does not, with no on-screen signal. The safe remediation is either a
higher-frequency or on-demand reconciliation for this field, or a surfaced consistency signal —
each a dedicated decision, not something to slip into an intelligence phase.

## D. Metrics Implemented

All five live in `RevenueAnalytics.intelligence`, inside the financial section, so the whole
block is **absent** without `transactions`. Each carries a `basis` literal in the payload.

| Metric | Formula | Source | Unit | Scope | Refunds | Denominator | Unavailable when |
|---|---|---|---|---|---|---|---|
| **Revenue velocity** | `period.revenuePaise ÷ rangeLengthDays` | daily rollups — the same windowed figure the Overview compares | integer paise/day, truncated | selected window, IST days | rollup semantics (cancellation reversals retro-attributed) | window days | period unmeasured, or window unresolvable |
| **Average order value** | `confirmedRevenue ÷ paid` | ledger aggregate ÷ payment-status `count()` | integer paise, truncated | lifetime (both inputs are) | **stable** — AOV is what a buyer paid, not what stayed | **paid registrations**, named in payload | revenue unmeasured, paid unmeasured, or **paid = 0** (never Infinity) |
| **Refund rate** | `refunds ÷ confirmedRevenue × 100` | refund ledger ÷ ledger aggregate | percent, 1 dp | lifetime | it *is* the refund figure | confirmed revenue (money) | either unmeasured, or **revenue = 0** (never 0% or ∞) |
| **Refunds in period** | `getRefundTotals` with the window's IST instants | refund ledger, by refund `createdAt` | integer paise + count | selected window | — | — | over read cap (`out_of_budget`) |
| **Ticket value before discount** | `confirmedRevenue + totalDiscountPaise` | ledger aggregate + registrations' `discountAmount` | integer paise | lifetime | stable | — | revenue unmeasured, **or discount unavailable (F-1)** |

Free registrations contribute `0` to revenue and are excluded from the AOV denominator. Pending
and failed payments are excluded from every figure by the `confirmed` status filter upstream.

## E. Metrics NOT Implemented

**Event-to-event comparison — deferred, honestly.** The pure comparison model already declares
`mode: 'event'` with a `baselineEventId`, but **nothing downstream honours it**: the engine's
`comparison` parameter is a boolean (read the preceding window or don't), the route parses only
`format`, and no path reads a second event. Wiring it means a second full `getEventAnalytics`
call per request, an ownership check on the baseline event, and route/contract plumbing — which
is the "new cross-event aggregation architecture" the brief forbids. The model is ready; the
engine is not. Recorded as the next candidate, not faked.

**Refund count in period** is implemented; **refund count-based rate** is not — the rate is
money-based by design (§D), and a count-based rate would be a different metric with a different
denominator.

**Payment-method mix, per-category revenue, cohort/LTV, forecasting** — unsupported by existing
data, as the audit found. Not attempted.

## F. API / UI Changes

| File | Change |
|---|---|
| `lib/analytics/contract.ts` | `RevenueAnalytics.intelligence: RevenueIntelligence` and the `RevenueIntelligence` type, every field documented with its basis |
| `lib/analytics/revenueIntelligence.ts` | **new, pure** — `istRangeBounds`, `revenueVelocity`, `averageOrderValue`, `refundRate`, `refundsInPeriod`, `revenueBeforeDiscount`, `displayVelocity` |
| `lib/analytics/eventAnalytics.ts` | F-1 fix; two windowed `getRefundTotals` reads (period, baseline — the baseline skipped when it would be refused anyway); `intelligence` assembled into `financial` |
| `lib/analytics/normalize.ts` | passes `intelligence` through unchanged |
| `lib/analytics/revenueModel.ts` | `intelligenceRows`, `refundIntelligence`; optional `suffix` on `MoneyRow` |
| `components/analytics/revenue/RevenueAnalytics.tsx` | one new section between totals and trend: three `MoneyMetric` cards plus a refund-rate/refunds-in-window line, using the existing primitives, `DeltaChip` and `UNAVAILABLE_MARK`. Renders nothing for a payload without the block — never rows claiming ₹0 |
| `scripts/qa/rd-analytics-12-26-shots.mjs` | **new** — browser QA |

**Export:** not extended. The brief permits skipping it when unnecessary; adding rows for derived
figures the export does not need was judged completeness for its own sake.

**IST bounds, deliberately not reused.** `lib/reports/format.rangeBounds` is documented as
*"inclusive UTC day bounds"*; the Analytics window is IST day keys. Using it would have placed
every refund between midnight and 05:30 IST in the wrong day — the exact boundary defect the audit
was asked to hunt. `istRangeBounds` derives the instants from `REPORTING_TZ_OFFSET_MINUTES`, the
one place the offset is defined, and a test round-trips it through `dayKey` so the two directions
cannot disagree.

## G. Security

**Authorization unchanged, and every new read gated.** The two windowed refund reads and the
whole intelligence block sit behind the existing `includeFinancial` — the same `transactions`
gate, resolved before any read. A denied caller costs nothing and receives nothing; the block is
inside `financial`, which is **omitted** for them, so its presence cannot even be inferred.

Proven three ways: the source assertions in the test suite; the `organizerAnalyticsAuthz`
emulator suite with real tokens (27 passed); and the browser pass, where the manager's
`/api/organizer/analytics/overview/...` response was captured and asserted **not** to contain
the block while the owner's did.

## H. Scale

**20,000-registration harness: 18 of 18 passed in 7.9s** (`analyticsScale.emu.test.ts`), which
runs the real `getEventAnalytics` — now including the new reads — against a real emulator
population. No regression.

| New read | Cost | Class |
|---|---|---|
| `getRefundTotals` × 2 (period, baseline) | bounded by `ORGANIZER_REFUND_READ_CAP = 1000` each; the baseline read is **skipped** when outside coverage | SAFE — bounded, not N+1, not a scan |
| every derivation | arithmetic over already-measured figures | O(1) |

No registration scan, no `limit(5001)`/`limit(10000)`, no client-side financial aggregation, no
new index. **Honest cost note:** the refund ledger is now read up to three times per Analytics
request (lifetime, period, baseline). Bounded and acceptable, and it is the most obvious cache
candidate on the payload — the audit's D-tier recommendation stands.

## I. Tests

| Gate | Result |
|---|---|
| `revenueIntelligence.test.ts` (new) | **50 passed** — F-1 ×5, F-2 regression ×5, IST bounds ×3, velocity ×7, AOV ×7, refund rate ×5, refunds-in-period ×4, before-discount ×2, presentation ×7, contract discipline ×5 |
| focused — analytics ×N, revenue, dashboard ×N, boundary, reports (33 files) | **1,327 passed** |
| **full unit suite** | **349 files — 9,502 passed, 1 skipped, 0 failed** |
| emulator — `organizerAnalyticsAuthz` + `organizerDataBoundary` | **27 passed** |
| **emulator — 20k analytics scale** | **18 passed** |
| TypeScript `tsc --noEmit` | **PASS** |
| ESLint — 8 touched files | **PASS**, 0 errors, 0 warnings |
| `next build` | **PASS**, exit 0, 36.5s |
| **browser QA** — owner at 1440/834/390, manager at 1440 | **PASS** — all four rows render, `/day` unit present, 0px overflow everywhere, no NaN/Infinity/undefined/null, no console errors, manager receives no block |

Every required category is covered: positive, zero, unavailable, unauthorized, refunds, pending,
free, discount, date range, previous-period, empty population, zero denominator, no false zero.
No `any`, `@ts-ignore`, `@ts-expect-error` or unsafe cast was introduced; no test was skipped or
weakened. One assertion repointed (§B).

**The browser pass cross-checked itself.** Against the seeded Coimbatore Marathon fixture
(₹7,20,000 confirmed, 467 paid, ₹2,52,000 in the window, ₹0 refunds): velocity read
**₹8,400/day** = ₹2,52,000 ÷ 30, matching the trend panel beside it; AOV read **₹1,542** with the
caption *"÷ 467 paid registrations"*, matching the paying-population panel's 467; refund rate read
a **measured 0%** — correct, because revenue is above zero — not the "—" it would show on a ₹0
event; refunds in window **₹0 across 0 refunds** with **no delta chip**, because 0-vs-0 yields no
percentage rather than "+0%".

Two environment obstacles, reported rather than hidden: the Auth emulator had been restarted
empty in RD-12-21, so the seeded login user was gone (re-seeded, idempotent); and the profiling
draft is unpublished, so the 06/07 marathon seed — which publishes it with real registrations —
was applied to get a measured-positive fixture.

## J. Worktree Safety

**723 entries before, 726 after.** The three new entries: `lib/analytics/revenueIntelligence.ts`
and `tests/unit/revenueIntelligence.test.ts` are mine; **`tests/unit/publicChromeUnification.test.ts`
is not** — it belongs to the concurrent workstream and was created while this phase ran.

| Class | Detail |
|---|---|
| **Pre-existing** | ~720 entries carried since before RD-12-19 |
| **RD-12-26** | 8 files: `contract.ts`, `revenueIntelligence.ts` (new), `eventAnalytics.ts`, `normalize.ts`, `revenueModel.ts`, `RevenueAnalytics.tsx`, `revenueIntelligence.test.ts` (new), `couponFilterAndPerformance.test.ts` — plus the QA script and this report |
| **Unrelated active work** | auth/login UI (`login/page.tsx` 11:22, `AuthField.tsx` 11:17) and the new public-chrome test — all untouched |

Every RD-12-26 file was edited in place; both target files that already carried uncommitted state
were changed surgically. **The F-2 site, `lib/firebase/firestore/registrations.ts`, retains its
3 September timestamp — it was read, analysed and pinned, never modified.** `firestore.rules`
(3 Sep) and `firestore.indexes.json` (8 Sep) are untouched; no index was created or deployed.

No `reset`, `clean`, `stash`, `checkout`, `restore` or broad replacement. Nothing committed,
pushed or deployed. The QA dev server was stopped; the build used an isolated `.next-a1226`,
since deleted, with `tsconfig.json` restored byte-for-byte.
