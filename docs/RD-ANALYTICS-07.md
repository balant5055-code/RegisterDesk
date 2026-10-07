# RD-ANALYTICS-07 — Analytics Overview Intelligence + Comparison Foundation

**Status:** implemented, gated, browser-validated.
**Date:** 2026-09-05
**Scope:** the per-event Analytics producer, the contract adapter, the Overview endpoint and
the Overview UI. No route migration, no schema change, no Firestore rules or index change,
no historical backfill.

---

## 1 · What this phase was asked to close

Three things, all of which RD-ANALYTICS-06 left open or introduced:

1. **A real previous-period comparison.** The contract has carried `ComparedMetric` since
   RD-ANALYTICS-04, but no producer ever resolved a baseline, so every delta on the Overview
   was structurally `null`. The page had the vocabulary for comparison and nothing to say.
2. **`coverage.since` on the event path.** The dashboard path knew where the rollup record
   began; the event path hard-coded `since: null`, so the Overview could not tell a quiet
   week from a week that predates the analytics record.
3. **The "Pending" terminology collision.** Two different populations — registrations
   pending *approval* and registrations whose *payment* has not completed — sat on one
   screen, one labelled "Pending" and the other "Awaiting payment".

## 2 · The defect RD-06 shipped, found while auditing for this phase

`TREND_DAYS = 30` was hard-coded in the producer. The 7D / 30D / 90D control changed the
header text and the request, and nothing else: every preset returned the same thirty rollup
days. It was confirmed visually before the fix (header "Last 7 days · 08-30 to 09-05" above
thirty bars spanning 7 Aug → 5 Sept, total 846) and is closed by §3.

## 3 · The producer is now range-aware

`getEventAnalytics(eventId, { includeFinancial, range, comparison })`:

```ts
const activeRange = range ?? DEFAULT_RANGE()
const trendKeys   = rangeDayKeys(activeRange)
const priorRange  = comparison ? previousPeriod(activeRange) : null
const priorKeys   = priorRange ? rangeDayKeys(priorRange) : []
```

`previousPeriod` was already written and tested in RD-ANALYTICS-04; this phase is the first
caller. The baseline window is the immediately preceding window **of identical length**,
derived from the range itself rather than from its preset, so a custom range compares
against an equally-custom baseline and a percentage is never a comparison of window sizes.

## 4 · The read cost of adding a comparison

One additional `getAll` of deterministic document ids, plus one document for the coverage
marker:

| source   | mechanism                     | documents transferred |
|----------|-------------------------------|-----------------------|
| status   | 7 × `count()`                 | 0 |
| split    | 1 + N × `count()`             | 0 |
| counter  | `registrationCounters/{slug}` | 1 + attendance shards |
| daily    | `getAll` over the window      | one per DAY (≤ 90) |
| baseline | `getAll` over the prior window| one per DAY (≤ 90) |
| coverage | `{uid}__meta`                 | 1 |

The bound is the **window**, not the event. A 100,000-registration event costs what a
100-registration one costs — the property RD-ANALYTICS-03 established and this phase had to
not break. Proven at 20,000 registrations against the real emulator (§14).

## 5 · Period totals, and why money is dropped at the boundary

```ts
const totalsOf = (rows: DailyStatsPoint[] | null): PeriodTotals | null => {
  if (rows === null) return null
  const t: PeriodTotals = {
    confirmed: rows.reduce((n, p) => n + p.confirmed, 0),
    checkedIn: rows.reduce((n, p) => n + p.checkedIn, 0),
  }
  if (includeFinancial) t.revenuePaise = rows.reduce((n, p) => n + p.revenuePaise, 0)
  return t
}
```

A rollup row carries registrations and revenue in one document, so there is no financial
*query* to suppress for an unauthorized caller. The field is therefore never copied out —
`revenuePaise` is **absent**, not null, exactly as RD-ANALYTICS-02 requires of every money
field on this path.

A failed rollup read yields `null` rows and therefore `null` totals, never zeros.

## 6 · Coverage: the days the platform can actually speak for

`readCoverage(organizerUid)` returns the day the rollup record begins (falling back to
`ROLLUP_EPOCH`, a real date, never an invented one). `buildSeries` fills every requested day,
so a day before coverage comes back as a zero that is indistinguishable from a quiet day.
Clipping is what stops that:

```ts
const covered = (rows) =>
  rows === null ? null : coverageSince ? rows.filter(p => p.date >= coverageSince) : rows
```

The trend series, the period totals and the chart all read the clipped rows. `coveragePartial`
declares the gap rather than absorbing it.

## 7 · When a baseline is refused

```ts
const baselineOutsideCoverage = Boolean(
  priorRange && coverageSince && priorRange.from < coverageSince)
const baseline = baselineOutsideCoverage ? null : totalsOf(priorDaily)
```

A partial baseline compared against a complete current period manufactures growth out of
missing history — the most convincing wrong number this page could produce. It is refused
outright rather than summed.

## 8 · `coveragePartial` and `baselineOutsideCoverage` are different facts

This was a real defect found in browser validation, not in review. The adapter originally
inferred the *reason* for a missing baseline from `coveragePartial`, which describes the
**current** window. The two disagree in the common case: a 7-day window can sit entirely
inside recorded history while the 7 days before it lie entirely outside it. The page then
told the reader "no earlier period on record to compare" — which reads as *this event has
never run before* — about an event whose earlier months simply predate the rollups.

The producer now reports `baselineOutsideCoverage` directly, and the adapter uses it:

```ts
const baselineReason: ComparisonUnavailable =
  a.baselineOutsideCoverage ? 'outside_coverage' : 'no_baseline'
```

Guarded by unit tests `25c2` (adapter) and `14d` (producer, against a fake Firestore).

## 9 · The comparison model gained a reason, not new arithmetic

`computeDelta` is untouched — it already refuses to divide by an empty baseline and returns
`pct: null` rather than "up from nothing". What is new is that a metric says *why* it has no
delta:

```ts
export type ComparisonUnavailable =
  | 'no_baseline'       // the previous window could not be read
  | 'outside_coverage'  // the previous window predates the analytics record
  | 'not_measured'      // the CURRENT value is itself unmeasured
  | 'disabled'          // comparison was not requested
```

`not_measured` outranks any caller-supplied reason: if the figure itself could not be read,
no statement about the comparison applies.

## 10 · The endpoint

Order is unchanged in principle and extended in one place:

```
authorizeWorkspace(req, 'events')
  → resolveAnalyticsEventIdentity   (one document)
  → ownership + requireEventScope
  → financeAllowed = permissions.includes('transactions')
  → normalizeRange(untrusted query)
  → getEventAnalytics(eventId, { includeFinancial, range })
  → normalizeEventAnalytics({ range: result.analytics.range, comparison: … })
```

Two properties worth stating explicitly:

* the **window travels into the computation** alongside the entitlement, so the producer
  never guesses which days it is being asked about;
* the response echoes `result.analytics.range` — the window the producer *used* — not the
  request. If the two ever disagree the page narrates what it is showing.

## 11 · The headline / movement separation

The single largest UI decision in this phase, and it is a refusal:

> **A delta may not hang off a lifetime figure.**

"480 ↑12%" invites the reading that the event grew 12%, when the 12% describes the last 30
days against the 30 before them and the 480 describes all time. Two different quantities in
one visual unit.

So the hero keeps the lifetime figure and takes **no** `delta` prop, and a `PeriodMovement`
line below it carries the windowed count, its chip, and the window's own name:

```
CONFIRMED REGISTRATIONS
480
640 total across every status
158 confirmed in the last 30 days   ↑63%  vs the 30 days before
```

The same rule applies at rail scale: "Confirmed revenue" and "Checked in" show lifetime
figures, so their chips moved into a `RailMovement` beside the period figure they were
computed from. Guarded by tests `28b` and `28b2`, which read the component source and fail if
a `delta=` prop ever reappears on a `HeroMetric` or `RailMetric`.

## 12 · Terminology

| surface | before | after | population |
|---|---|---|---|
| status composition legend | "Pending" | **"Registration pending"** | `status === 'pending'` — awaiting approval |
| stat rail | "Awaiting payment" | "Awaiting payment" + sub "Payment not yet completed" | `paymentStatus === 'pending'` |

Neither is called bare "Pending" any more. Test `28f` fails if `label: 'Pending'` returns.

## 13 · Everything the page says about its window comes from the server

`windowLabel` and the header both derive from `data.scope.range.preset`, never from the
pressed button. An unrecognised preset falls back server-side (test 9); a header narrating
the request while the figures came from the fallback would be wrong in exactly the way this
architecture exists to prevent. Test `28c` fails if `PRESET_DAYS[preset]` — the local state —
is used for display again.

The trend caption names the days actually **drawn** (`r.byDay[0].date → …`), not the days
requested, because the coverage floor makes the two differ. Test `28f2`.

## 14 · Gates

| gate | result |
|---|---|
| `vitest run tests/unit` | **316 files, 8,467 passed, 1 skipped, 0 failed** |
| the seven analytics suites alone | 231 passed |
| `tsc --noEmit` | 0 errors |
| `eslint` (touched paths: `lib/analytics`, `components/analytics`, `app/api/organizer/analytics`, the five analytics suites, the three QA scripts) | 0 problems |
| `next build` (production, `NEXT_DIST_DIR=.next-verify2`) | success |
| `tests/emulator/analyticsScale.emu.test.ts` (20,000 registrations, real Firestore) | 16/16 passed |
| `npm run test:emu` (whole emulator suite, clean emulator) | **40 files, 793 passed, 1 failed** — the pre-existing `capturedRecovery` test 15 only |
| browser validation | §16 |

The one emulator failure is `capturedRecovery.emu.test.ts > 15 · a duplicate-email refusal
creates NO registration and refunds in full`. It predates this phase, is unrelated to
analytics, and payments recovery code was explicitly out of scope.

An earlier attempt at this suite stalled after its first file. The cause was emulator state,
not a regression: `analyticsScale.emu.test.ts` had been run separately beforehand, leaving
20,000 registrations resident for every subsequent scan-based test. Run against a clean
emulator the whole suite finishes in 650s.

Three environment notes, stated because they cost real time and will recur:

* `next build` fails with `OS can't spawn worker thread` / a worker fail-fast when the
  Firebase emulator (JVM) and a second build are resident. Build alone. The final gate above
  was run with nothing else on the machine.
* `npm run emu:build` **requires the emulator to be running** — it prerenders `/`, which
  queries Firestore. Killing the emulator first produces an `ECONNREFUSED 127.0.0.1:8080`
  prerender error that looks like a code fault and is not one.
* A build into a non-default dist dir rewrites `tsconfig.json` to add that directory's
  `types/**` to `include`. The `.next-verify2` entries this phase's build added were removed
  afterwards; `tsc` re-verified clean.

Repo-wide ESLint reports 88 pre-existing errors (React-Compiler `set-state-in-effect` in
`WizardFooter`, `useTheme`, and others) and 97 warnings. None are in analytics files — the
word "analytics" does not appear in the lint output at all.

## 15 · Test changes

Nothing was weakened. Three assertions were **re-anchored** because the behaviour they
described genuinely changed, and each carries a comment saying what changed and why:

| test | was | is |
|---|---|---|
| `analyticsNormalize` 25 | "a producer with no baseline reports NO delta" | "a producer WITH a baseline reports a real delta over PERIOD totals" — the sharper rule, that the delta compares period against period |
| `analyticsArchitecture` 18 | `compareMetric(null, 10)` equals `{value, baseline, delta}` | …plus `unavailable: 'not_measured'`; the refusal is unchanged, the metric now says which side was missing |
| `analyticsOverview` 6/7 | `getEventAnalytics` called with `{ includeFinancial }` | `{ includeFinancial, range }` — strengthened, the window must travel in too |

New guards:

* `analyticsNormalize` 25b / 25c / 25c2 / 25d — no fabricated baseline; `outside_coverage`
  reported as such; the reason describes the *baseline* window; revenue comparison is
  period-over-period and needs the permission (`expect(JSON.stringify(denied)).not.toMatch(/Paise/)`).
* `analyticsArchitecture` 18b — the caller names the reason; `not_measured` outranks it.
* `analyticsFinancialTruth` 14c / 14d — days before the coverage floor are withheld, not
  zeroed; a covered window with an uncovered baseline is reported as exactly that.
* `analyticsOverview` 28b / 28b2 / 28c / 28d / 28e / 28f / 28f2 / 28g — the eight UI rules
  above, asserted against component source with comments stripped so prose about a rule
  cannot satisfy its guard.

The `analyticsOverview` producer stub now **echoes the range it is given**, because a stub
answering with one fixed window cannot tell a route that forwards the request's range from
one that ignores it — which is precisely the RD-06 defect.

## 16 · Browser validation

Real emulator, real production build, Playwright, three viewports (1440 / 834 / 390),
viewport screenshots only. Two fixture modes, because coverage is per-organizer:

**`full`** — coverage predates all history:

| preset | lifetime | in window | registrations | revenue | checked in |
|---|---|---|---|---|---|
| 7D  | 480 | 54  | ↑35% | ↑35% | ↑13% |
| 30D | 480 | 168 | ↑63% | ↑63% | ↑100% |
| 90D | 480 | 360 | ↑49% | ↑49% | ↑19% |

Three distinct windows from one control — the RD-06 defect is closed, visibly. The trend
chart draws 7 / 30 / 90 bars respectively, and its caption tracks them.

**`partial`** — coverage begins 12 days back:

* 30D / 90D: the chart starts at the floor (24 Aug), the coverage notice reads *"daily
  analytics begin 24 Aug 2026, so earlier days in this range are not shown"*, and the
  movement line reads *"89 confirmed in the last 90 days · no earlier period on record to
  compare"* with **no chip**.
* 7D: the window is entirely inside recorded history, so **no** gap is claimed — but its
  baseline is not, so the explanation still appears. This is the §8 defect, caught here.

The capture script asserts, not merely photographs: the headline and window figures must
differ; no `[aria-label*="percent"]` element may sit inside the hero block; bare "Pending"
may not appear beside "Awaiting payment"; a comparison may not be claimed when history is
missing; and a fully covered window may not claim a gap. No console errors, no page errors,
no horizontal overflow at any viewport.

**The empty event** (uncapped workshop, no registrations) reads *"0 confirmed in the last 30
days"* and stops there. It previously printed *"…vs the 30 days before"* with no percentage
in front of it, because `computeDelta(0, 0)` returns `pct: null` — a delta *object* exists,
but there is no showable comparison. Fixed and guarded by test `28e2` and by an assertion in
the capture script.

**Financial isolation** was verified separately as a `manager` (holds `events`, not
`transactions`): no `₹`, no revenue module in the rendered page, and the intercepted API
payload carries no `revenue` key, no `*Paise` field, and `financialAllowed: false`.

### Defects this validation found

Three, none of which a code reading or a green test suite would have surfaced:

1. the baseline's *reason* described the current window rather than the baseline window (§8);
2. the trend caption named the days requested while the chart drew the days covered;
3. the empty-event movement line printed a comparison phrase with no percentage.

Each is now guarded — `25c2` / `14d`, `28f2`, and `28e2` respectively.

## 17 · The velocity insight now has a baseline — at one window only

`buildPerformanceInsights` emits *"N% more registrations in the last 7 days vs the prior
week"* verbatim. Feeding it a 30- or 90-day comparison would print a true number beneath a
false window, so it is offered only when the served preset is `7d` and the delta actually
resolved:

```ts
const velocity = useMemo(() => {
  const reg = data?.overview.registrations
  if (!data || !reg || reg.value === null || !reg.delta) return null
  return data.scope.range.preset === '7d' ? { total: reg.value, delta: reg.delta } : null
}, [data])
```

Verified in the browser: the insight appears at 7D and is absent at 30D.

## 18 · Files changed

**Source**

| file | change |
|---|---|
| `lib/analytics/comparison.ts` | `ComparisonUnavailable`, `ComparedMetric.unavailable`, `compareMetric(value, baseline, reason)` |
| `lib/analytics/eventAnalytics.ts` | `range` + `comparison` params; `PeriodTotals`; `readCoverage`; `period` / `baseline` / `coverageSince` / `coveragePartial` / `baselineOutsideCoverage`; series clipped at the floor |
| `lib/analytics/normalize.ts` | coverage from the producer; overview compares period vs period; revenue comparison behind the permission |
| `app/api/organizer/analytics/overview/[eventId]/route.ts` | forwards the resolved range; echoes the producer's range |
| `components/analytics/overview/Primitives.tsx` | `PeriodMovement`, `RailMovement` |
| `components/analytics/overview/AnalyticsOverview.tsx` | movement lines, terminology, coverage sentence, served-window narration, drawn-range caption, velocity gating |

**Tests** — `analyticsArchitecture`, `analyticsFinancialTruth`, `analyticsNormalize`,
`analyticsOverview`, `analyticsUnavailable`.

**QA tooling** — `scripts/qa/rd-analytics-07-seed.mjs`, `rd-analytics-07-manager.mjs`,
`rd-analytics-07-shots.mjs`. All three refuse to run outside the emulator and outside a
`demo-` project.

## 19 · Constraints honoured

No deploy, no push, no commit. No Firestore rules or index changes. No new collections, no
schema or data migration, no historical rollup rebuild. No route migration;
`/dashboard/analytics` still exists, `/dashboard/reports` is not redesigned,
`/dashboard/finance/reports` is not renamed. Timezone semantics unchanged — the reporting
offset and `dayKey` are untouched, and every date the page prints is formatted at a fixed
zone so a label cannot drift by a day. `capturedRecovery.emu.test.ts` test 15 was not
touched.

## 20 · What is NOT done, stated rather than implied

* **The dashboard adapter's overview revenue** still reports `baseline: null` alongside a
  delta taken from the dashboard's own week-over-week computation. It is not wrong — the
  delta comes from a trusted source — but it is the one `ComparedMetric` in the codebase
  whose baseline value is not surfaced. The event path does not have this shape.
* **A failed baseline read** reports `no_baseline` rather than a distinct "could not read"
  reason. `ComparisonUnavailable` has no member for it and the UI treats it the same way
  (silence), so adding one would widen the type without changing what a reader sees.
* **Comparison mode `event`** (this event vs another) remains groundwork: `resolveComparison`
  understands it, no service resolves a baseline event, and this phase adds none.
* **One emulator test still fails** — `capturedRecovery.emu.test.ts` test 15. It is
  pre-existing, unrelated to analytics, and payments recovery code was out of scope for this
  phase, so it was left alone. Everything else in the emulator suite passes (§14).
