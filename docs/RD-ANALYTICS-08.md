# RD-ANALYTICS-08 — Registrations Intelligence

**Status:** implemented, gated, browser-validated.
**Date:** 2026-09-05
**Scope:** the Registrations analytics module (data + dedicated UI) on the normalized
contract. No route migration, no Revenue/Operations/Communications/Participants/Reports
work, no Overview redesign, no rules/index/schema change.

---

## 1 · Audit findings

### 1.1 Existing registration analytics / data producers

| producer | scope | state |
|---|---|---|
| `lib/analytics/eventAnalytics.ts` | per event | canonical. Scan-free since RD-03, finance-gated since RD-02, range- and coverage-aware since RD-07. |
| `lib/analytics/dashboardAnalytics.ts` + `/api/organizer/dashboard` | organizer-wide | rollup/counter based, coverage-aware. Not event-scoped. |
| `/api/organizer/analytics/[eventId]` | per event | the OLD Event Insights payload (native `EventAnalytics` shape). Still live, still linked. Out of scope. |
| `/api/organizer/analytics/overview/[eventId]` | per event | serves the normalized `AnalyticsResponse`. **This is the contract endpoint.** |

There is no separate "registrations analytics" producer, and there must not be one: every
registration figure this module needs is already produced by `getEventAnalytics`.

### 1.2 Trusted rollups / counters available for reuse

* `aggregateRegistrationStatusCounts(uid, slug)` — 7 × `count()`; total, confirmed, pending,
  cancelled, waitlisted, rejected, checkedIn. Zero documents transferred.
* `getRegistrationSplit(scope, PAYMENT_STATUSES)` — `count()` per paymentStatus, plus
  `total` and `free` (where `free` there means `amount == 0`, a **price** concept).
* `getRegistrationCounter(slug)` — `passCounts`, confirmed per pass, O(1), maintained at
  write time.
* `readDailyStats(uid, slug, dayKeys)` — one `getAll` of deterministic ids. Each row carries
  `confirmed`, `cancelled`, `revenuePaise`, `checkedIn` **for that day**.
* `readCoverage(uid)` — one document, the day the rollup record begins.
* `aggregateValueByPass` / `aggregateCancelledByPass` / `aggregateWaitlistedCount` — budgeted
  `count()`/`sum()` helpers. Used by the dashboard; **not** needed by this module (see §1.7).

### 1.3 Registration status vs payment status semantics

Two orthogonal fields, and conflating them is the defect RD-07 already fixed once:

* `status` ∈ confirmed | pending | cancelled | rejected | waitlisted — the **registration
  lifecycle**. `pending` = awaiting organizer approval.
* `paymentStatus` ∈ not_required | pending | paid | refund_pending | refunded — the
  **payment lifecycle**. `pending` = awaiting payment.

`eventAnalytics` already maps `paid = payCount('paid')`, `free = payCount('not_required')`,
`paymentPending = payCount('pending')`. Because `paymentStatus` is a single field these
buckets are **mutually exclusive by construction** — which is what makes an honest payment
split possible without double counting.

Note the trap: `getRegistrationSplit.free`/`.paid` are derived from `amount == 0`, a
different definition, and are NOT what the producer publishes. This module uses the
paymentStatus buckets, not the price-derived ones.

### 1.4 Date range / comparison infrastructure (RD-04/05/07)

Complete and reusable as-is:

* `lib/analytics/dateRange.ts` — `PRESET_DAYS` (7/30/90), `presetRange`, `normalizeRange`
  (falls back rather than throwing), `rangeDayKeys`, IST day keys.
* `lib/analytics/comparison.ts` — `previousPeriod` (same length, adjacent, no overlap),
  `compareMetric(value, baseline, reason)`, `ComparedMetric`, `ComparisonUnavailable`,
  and `computeDelta`, which returns `pct: null` for an empty baseline rather than ∞.
* The producer already resolves `period` / `baseline` totals and
  `coverageSince` / `coveragePartial` / `baselineOutsideCoverage`.

**No second date-range or comparison implementation is needed, and none is added.**

### 1.5 Authorization / event scope

`/api/organizer/analytics/overview/[eventId]` establishes the boundary this module inherits
unchanged: `authorizeWorkspace(req, 'events')` → `resolveAnalyticsEventIdentity` (one doc) →
ownership + `requireEventScope(draftId)` → `financeAllowed = permissions.includes('transactions')`
→ only then any analytical read. Gate-only roles hold no `events` and stop before the first
read; a foreign event and a missing event return the same 403 text.

### 1.6 Event capability / type gating

`lib/analytics/modules.ts` already resolves this. Relevant facts:

* `registrations` is a module gated on the `registrations` `ITEM_GATES` key — universal, not
  event-type-exclusive.
* `waitlist` is a **panel** under the `registrations` module, and its availability consults
  `eventHasWaitlist(registrationRules)` — the organizer's own switch. This is exactly the
  signal §5 needs to avoid presenting a fake waitlisted category.
* Timing/BIB are panels under **operations**, restricted to `eventTypes: ['sports']`. Nothing
  in this module may reference them.

### 1.7 Remaining raw registration scans

None in the event analytics path. `grep` over `lib/analytics/` shows `registrations` touched
only by `count()`/`sum()` aggregate helpers (`registrationPassAggregates.ts`,
`couponPerformance.ts`). The producer's remaining `.limit(CAP)` reads are
`platformTransactions`, `emailLogs`, `scheduledReminders` and `certificates` — none of which
this module consumes.

**Consequence:** this module can be built with **zero new reads**. Everything it needs is
already fetched by the one request the Overview makes.

### 1.8 Existing registration analytics UI

* `components/analytics/overview/AnalyticsOverview.tsx` — has a compact `StatusComposition`
  and the registration rail. Stays as the Overview's own summary.
* `components/analytics/overview/Primitives.tsx` and `TrendPanel.tsx` — reusable as-is; this
  module imports them rather than re-deriving a second visual vocabulary.
* `app/(dashboard)/dashboard/analytics/page.tsx` — the OLD Event Insights page (Donut/HBars/
  Funnel, native payload). To be retired by the route migration, **not** by this phase.
* `app/(dashboard)/dashboard/reports/page.tsx` — the current organizer-wide analytics
  dashboard. Untouched.

### 1.9 What the contract is missing for this module

Three gaps, all fillable from data the producer **already reads**:

1. period `cancelled` (the rollup row carries it; only `confirmed`/`checkedIn`/`revenuePaise`
   were summed);
2. a `cancelledByDay` series (same rows, never exposed);
3. an explicit statement that `byPass` is **lifetime confirmed**, because no per-pass daily
   rollup exists and labelling it as period data would be a lie.

### 1.10 What the data genuinely cannot support

**"Total registrations by day" does not exist.** `organizerDailyStats` records net confirmed
starts and cancellations per day — not creations by status. A "total by day" series would
have to be invented. It is therefore not built; the trend offers confirmed and cancelled,
both of which are recorded facts, and the module says so.

---

## 2 · Files changed

**Contract & data (server / pure)**

| file | change |
|---|---|
| `lib/analytics/contract.ts` | `RegistrationPeriodAnalytics`, `RegistrationPassBasis`; `registrations` gains `period`, `cancelledByDay`, `byPassBasis` |
| `lib/analytics/eventAnalytics.ts` | `PeriodTotals.cancelled`; `cancellationsByDay` series; both summed from rollup rows already read |
| `lib/analytics/normalize.ts` | maps the three new fields; `baselineReason` hoisted so `overview` and `registrations.period` explain an absent baseline identically; the dashboard adapter reports them unmeasured rather than synthesising |
| `lib/analytics/registrationsModel.ts` | **NEW, pure.** `statusComposition`, `paymentComposition`, `drawableSegments`, `passDistribution`, `waitlistEnabled`, `share` |

**UI**

| file | change |
|---|---|
| `components/analytics/useAnalyticsScope.ts` | **NEW.** The one fetch, range state, event-scope derivation and window labels, extracted verbatim from the Overview |
| `components/analytics/ModuleChrome.tsx` | **NEW.** Shared header, event selector, range control, refresh, and the pre-data states |
| `components/analytics/registrations/RegistrationsAnalytics.tsx` | **NEW.** The module |
| `components/analytics/overview/Primitives.tsx` | `DeltaChip` gains `invert` — colour only; the arrow and label still report the direction |
| `components/analytics/overview/AnalyticsOverview.tsx` | data layer moved to the shared hook. **No visual change**; its markup is untouched |
| `app/(dashboard)/dashboard/analytics/registrations/page.tsx` | **NEW** route |

**Tests / QA** — `tests/unit/analyticsRegistrations.test.ts` (new, 38);
`tests/emulator/analyticsScale.emu.test.ts` (+2 at 20k); five guards in
`tests/unit/analyticsOverview.test.ts` re-anchored to the shared hook; the fixtures in
`analyticsNormalize` / `analyticsOverview` carry the producer's new fields;
`scripts/qa/rd-analytics-08-shots.mjs` and `rd-analytics-08-staff.mjs` (new).

**No API route was added or changed.** The module consumes the existing
`/api/organizer/analytics/overview/[eventId]`, which already returns the complete
`AnalyticsResponse` — see §13.

## 3 · Data sources

Everything comes from sources that already existed, and the module adds **no read of its own**:

| figure | source | cost |
|---|---|---|
| total / confirmed / pending / cancelled / rejected / waitlisted | `aggregateRegistrationStatusCounts` | 7 x `count()`, 0 documents |
| paid / free / awaiting payment / refunded / refund in progress | `getRegistrationSplit` by `paymentStatus` | `count()` per status, 0 documents |
| registrations & cancellations per day, and their period totals | `readDailyStats` x 2 (window + baseline) | one document per day, 90 max each |
| coverage floor | `readCoverage` | 1 document |
| registrations by pass | `registrationCounters.passCounts` | O(1), 1 document |

## 4 · KPI definitions

| KPI | definition | basis |
|---|---|---|
| Total registrations | every registration in any `status` | lifetime |
| Confirmed | `status === 'confirmed'` | lifetime |
| Registration pending | `status === 'pending'` — awaiting organizer **approval** | lifetime |
| Cancelled / Rejected / Waitlisted | the matching `status` | lifetime |
| Paid | `paymentStatus === 'paid'` | lifetime |
| Free | `paymentStatus === 'not_required'` | lifetime |
| Awaiting payment | `paymentStatus === 'pending'` — payment **not completed** | lifetime |
| Refund in progress / Refunded | `paymentStatus === 'refund_pending'` / `'refunded'` | lifetime |
| Confirmed in the window | sum of rollup `confirmed` over the range | **period** |
| Cancelled in the window | sum of rollup `cancelled` over the range | **period** |
| Registrations by pass | `passCounts`, confirmed per pass | **lifetime**, captioned as such |

`Registration pending` and `Awaiting payment` are never merged, and neither is called bare
"Pending" — the RD-ANALYTICS-07 rule, now enforced by test 1.

Payment rows are values of a **single** field, so a registration belongs to exactly one and
the categories cannot double-count. The price-derived `free`/`paid` that
`getRegistrationSplit` also offers (`amount === 0`) is deliberately **not** used: mixing a
price bucket with a status bucket would let one registration appear in two rows.

Percentages are taken against `total`, never against the sum of the rows shown. That is what
lets the module report "26 registrations in a state not shown above" instead of quietly
rescaling the visible parts to 100% — observed live on the fixture event, whose waitlisted
rows are excluded because that event has no waitlist enabled.

## 5 · Date-range behaviour

The shared model, unchanged: presets 7 / 30 / 90 days, IST day keys, `normalizeRange`
falling back rather than throwing. `useAnalyticsScope` is now the **only** place in the
Analytics UI that holds range state, and every window phrase is built from the range the
**server** reported — never the pressed button, which can differ when a preset falls back.

Period figures are always period figures. No lifetime value is relabelled as a window value,
and the trend caption names the days actually **drawn** (clipped at the coverage floor), not
the days requested.

## 6 · Comparison behaviour

`compareMetric` from RD-ANALYTICS-07, applied to `period.confirmed` and `period.cancelled`.

| case | result |
|---|---|
| baseline > 0 | signed percentage + direction |
| baseline = 0, current > 0 | `pct: null` — no chip. Never +infinity% |
| current = 0, baseline = 0 | `pct: null` — no fabricated change |
| current = 0, baseline > 0 | a genuine -100% |
| window unmeasured | `unavailable: 'not_measured'`, no delta |
| baseline before coverage | `unavailable: 'outside_coverage'`, explained in words |

**No lifetime figure carries a delta.** The KPI row is entirely lifetime and takes no chip;
every chip sits in a section header beside the period figure it was computed from.

A rise in **cancellations** is not painted as good news: `DeltaChip invert` flips the colour
only — the arrow and the accessible label still report the direction the number moved.
Verified in the browser: the chip renders `rgb(220,38,38)` when cancellations rise, while the
registration chip in the same view is green.

## 7 · Coverage behaviour

The RD-ANALYTICS-07 model, reused unchanged. Days before the rollup floor are **withheld**
from the series, never emitted as zeros; a baseline that begins before the floor is
**refused**, never summed; the module states the floor as a readable date. Verified in the
browser in `partial` mode: the 30D and 90D windows disclose the gap while the 7D window —
which sits entirely inside recorded history — correctly claims none, yet still explains its
refused baseline.

## 8 · Authorization behaviour

Unchanged and inherited: `authorizeWorkspace(req, 'events')` runs **before** any analytical
read; then event ownership and `requireEventScope`; then the finance decision; only then the
producer. A foreign event and a missing one answer identically.

* **owner** — the full module.
* **manager / admin** (`events`, no `transactions`) — the **entire module**, because it is
  registration counts. The payload carries no `revenue` key, no `*Paise` field, and
  `financialAllowed: false`. Confirmed in the browser.
* **checkin_staff** (`['checkin']`) — refused. The shell routes them to the check-in console,
  and a **direct probe of the endpoint with their own bearer returns 403**. Both were
  measured, because the shell alone would not have been proof — a URL can be typed.
* **finance** (`transactions`, no `events`) — refused, unchanged.

The financial boundary is not widened: this module reads no money field, and guards fail if
it ever references `data.revenue`, `financialAllowed` or `Paise`.

## 9 · Performance / scaling

No new read, and no read that scales with registrations. Proven at 20,000 registrations
against the real emulator: the existing document-transfer bound still holds with the
cancellation series and period totals in the payload (test 17), and every registration figure
the module renders is measured rather than null (test 18).

A unit guard asserts the producer still issues exactly **two** `readDailyStats` calls —
window and baseline — so a future edit cannot turn the cancellation series into a third
query. Another asserts the module files contain no `adminDb`, no `collection(`, no `.limit(`.

**No schema, collection, index or rules change was required or made.**

## 10 · Tests executed

| gate | result |
|---|---|
| `tests/unit/analyticsRegistrations.test.ts` (new) | **38 / 38** |
| the seven pre-existing analytics suites | **231 / 231** — identical to RD-ANALYTICS-07 |
| full unit suite | **317 files, 8513 passed, 1 skipped, 0 failed** |
| `tests/emulator/analyticsScale.emu.test.ts` (20k) | **18 / 18** (16 before, +2 for this phase) |
| `tsc --noEmit` | 0 errors |
| `eslint` (all touched source, tests and QA scripts) | 0 problems |

### Why the total moved

RD-ANALYTICS-07 finished at 316 files / 8467 passed. This phase adds one file and 38 tests.
Two further observations, both verified rather than assumed:

* the seven pre-existing analytics suites total **231**, exactly as in RD-ANALYTICS-07 — so
  nothing in the analytics area was silently added or removed;
* a run containing **timeouts under-reports its own case count**: a loaded run here reported
  8506 with five 5-second timeouts, while clean runs report 8513 with zero per-file variance
  across repeated runs. All five timeouts were the first test in their file and all passed
  when re-run alone.

After accounting for the new suite, **8 cases remain unattributed** against the
RD-ANALYTICS-07 figure. They are not in any file this phase modified, they are not caused by
the new QA scripts (verified by removing them and re-running: no change), and the per-file
counts are stable run to run. Recorded here rather than papered over.

## 11 · Browser QA results

Real emulator, real production build, Playwright, three viewports, viewport screenshots only.
Fixtures: the RD-ANALYTICS-07 seeds plus a new `checkin_staff` account.

| case | 1440 | 834 | 390 | result |
|---|---|---|---|---|
| owner, 7D / 30D / 90D | yes | yes | yes | 54 / 168 / 360 confirmed in window — three distinct windows |
| owner, partial coverage | yes | yes | yes | gap disclosed at 30D/90D, correctly NOT at 7D; refused baseline explained |
| empty event (uncapped workshop) | yes | yes | yes | measured zeros, "—" where a share has no denominator, per-panel empty notes |
| manager (no `transactions`) | yes | — | — | full module, no rupee symbol, payload has no `revenue`/`Paise`, `financialAllowed:false` |
| checkin_staff | yes | — | — | shell redirects to check-in; direct endpoint probe returns **403** |

Asserted, not merely photographed: both pending populations present with different words and
no bare "Pending"; no delta chip inside the lifetime KPI section; the pass panel states its
lifetime basis; no BIB / timing chip / finish time / race category anywhere; the cancellation
chip is coloured as a negative when it rises. No console errors, no page errors, no
horizontal overflow at any viewport.

## 12 · Known limitations

1. **"Total registrations by day" does not exist and is not shown.** The rollups record net
   confirmed starts and cancellations per day, not creations by status. The trend therefore
   offers confirmed and cancelled — both recorded facts — and the module says so rather than
   deriving a total-by-day it cannot support.
2. **Per-pass figures are lifetime only.** There is no per-pass daily rollup, and building
   one per window would need a per-registration aggregation this architecture refuses. The
   basis travels in the payload (`byPassBasis`) and is printed in the caption.
3. **The dashboard (workspace-wide) adapter reports the new fields as unmeasured.** Its
   payload has no cancellation series and no registration period/baseline of its own; its
   `trendRanges` are a week-over-week model built for a different surface. Synthesising from
   `trendDays` would publish a number the dashboard never computed.
4. **A failed baseline read reports `no_baseline`**, not a distinct "could not read" reason.
   `ComparisonUnavailable` has no member for it and the UI treats both the same way
   (silence), so adding one would widen the type without changing what a reader sees.
5. **The contract endpoint is still named `/analytics/overview/[eventId]`.** It serves the
   whole `AnalyticsResponse` for every module; the path is historical, from RD-ANALYTICS-06.
   Renaming it is part of the route migration, which this phase is explicitly barred from.

## 13 · Deferred work

* Revenue, Operations, Communications, Participants and Reports modules — out of scope here.
* The route migration in `lib/analytics/routes.ts`, including retiring the old
  `/dashboard/analytics` Event Insights page and renaming the contract endpoint.
* A navigation entry for the Registrations module. The module resolver already lists
  `registrations`, but adding a sidebar row belongs with the IA migration, not before it —
  the page is reachable directly and by the event selector today.
* Waitlist depth as its own panel: `ANALYTICS_PANELS` already declares a `waitlist` panel
  under this module, gated on the organizer's switch. This phase uses that gate only to
  decide whether a waitlisted category is real, and builds no queue analytics.
