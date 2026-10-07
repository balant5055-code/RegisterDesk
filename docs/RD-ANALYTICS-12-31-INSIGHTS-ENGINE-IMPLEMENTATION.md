# RD-ANALYTICS-12-31 — INSIGHTS ENGINE IMPLEMENTATION

**Date:** 2026-09-11
**Baseline:** HEAD `b7e5fdf`, 0 staged before and after. `firestore.rules` (3 Sep) / `firestore.indexes.json` (8 Sep) untouched.
**Audit:** `docs/RD-ANALYTICS-12-30-INSIGHTS-ENGINE-AUDIT.md` — APPROVED WITH CONDITIONS (C-1…C-6), implemented to its §38 boundary and nothing beyond.

---

## 1. Executive summary

The Insights Engine is one pure function, `buildInsights(response)`, over the `AnalyticsResponse` every Analytics page already fetches. It reads no data, computes no canonical metric, decides no permission, and calls nothing: nineteen deterministic rules each cite one payload field, clear documented business floors (absolute **and** percentage, plus a baseline minimum for every comparison), and produce a card with full provenance — the field path, value, baseline, the payload's own delta, window, range, coverage and the named thresholds it passed. One card per evidence field, ranked by severity → rule priority → magnitude → id, capped at six. A money rule finds the `revenue`/`overview.revenuePaise` key or finds nothing — that is the whole of its permission logic. The severity vocabulary and `NEARLY_FULL_PCT` are imported from `lib/dashboard/insights.ts`, not re-declared.

A seventh module page, `/dashboard/analytics/insights`, renders the cards under the existing shell: severity chip (text, not colour alone), window badge, title, sentence, evidence line, "View analytics" and an informational action; an honest empty state ("No significant changes detected … not a statement that everything is fine"); no field paths, no AI styling, no mention of what a viewer cannot see.

Verified: 42 new unit tests, full suite **356 files / 9,909 passed**, analytics emulator suites 31/31, `tsc` clean, ESLint clean on touched files, production build clean, and browser QA in which the **same engine was run in Node over the observed payload and the screen was required to show exactly those cards** — owner (1440/834/390), finance, admin, manager, gate-staff — across three fixture events including a money card visible only to `transactions` roles.

**Verdict (§27): IMPLEMENTED — SAFE FOR NEXT ANALYTICS PHASE.**

---

## 2. Audit constraints followed

| Condition | Status |
|---|---|
| C-1 Pure function; no read/route/cache/store/AI | Met — `insightsRules.ts` imports only pure modules; test 39 pins no `firebase`, `fetch`, `Date`, `Math.random`, `process.env` |
| C-2 Every rule cites a field and passes absolute + percentage floors with a valid `ComparedMetric`; `coverage.partial` blocks comparisons | Met — `movement()`; tests 2–8 |
| C-3 Money rules only where the money keys exist; severity words and `NEARLY_FULL_PCT` shared with the Dashboard | Met — tests 10, 20 |
| C-4 No no-show, unique/returning/demographic, SMS/Push, spend, windowed-unknown, cross-event or statistical anomaly | Met — tests 17, 26, 32; day-concentration only under its floors (33) |
| C-5 Event-day rules only after `scope.eventStartsAt` exists | Met — none built; attendance rules gate on `checkedIn > 0` instead (§24) |
| C-6 ≤ 6 surfaced, one card per evidence field, full provenance | Met — tests 34–36 |

---

## 3. Architecture

```
AnalyticsResponse  (authorized, aggregate/rollup-produced, fetched once by the page)
        ↓
buildInsights(response, labels?)   lib/analytics/insightsRules.ts — pure
        ↓
{ insights: Insight[] (≤ 6), evaluated, candidates }
        ↓
InsightsAnalytics.tsx  (renders; computes nothing; no fetch of its own)
```

No rule touches a data source. The QA script proves the same: it bundles the engine with esbuild and the bundle contains zero references to Firebase.

---

## 4. Insight contract

Added to `lib/analytics/contract.ts` (types only): `InsightSeverity = AttentionSeverity | 'positive'`, `InsightRuleId` (26 literals), `InsightEvidence { field, basis?, unit, window, range, value, baseline?, delta?, coverage, thresholds }`, `Insight { id, rule, severity, title, summary, evidence, module, action?, scope }`. `AnalyticsResponse` itself is unchanged.

---

## 5. Provenance

`evidence.field` is a JSON path into the payload (`registrations.period.confirmed`, `overview.revenuePaise`, `communications.channels[email].delivery`, …); test 36 resolves every emitted path against the fixture and requires a real value. `delta` is the payload's `ComparedMetric.delta` copied verbatim (test 2 asserts equality with `computeDelta`); `thresholds` lists the named floors the rule passed; `window` says `period` or `lifetime`; `range`/`coverage` are echoed from the payload; `basis` carries the module's own basis literal where the field has one. `id = rule:eventSlug:from:to` — stable for a payload.

---

## 6. Implemented rules

| Rule | Field | Window | Severity | Floors |
|---|---|---|---|---|
| registrations_growth / _decline | `registrations.period.confirmed` | period | positive (strong ↑) / warning (strong ↓) / info | count floors |
| cancellations_rise | `registrations.period.cancelled` | period | warning (strong) / info; rise only | count floors |
| checkins_growth / _decline | `overview.checkedIn` | period | positive (strong ↑) / info | count floors |
| capacity_approaching / _reached / _exceeded | `registrations.capacityUsedPct` (+`operations.capacity.over`) | lifetime | warning / critical / critical | `NEARLY_FULL_PCT`, 100, remaining < 0; capacity > 0 |
| attendance_low | `operations.attendance.pct` | lifetime | info | pct < 50, confirmed ≥ 50, checkedIn > 0 |
| attendance_over | `operations.attendance.pct` | lifetime | info | `over` |
| awaiting_large | `operations.attendance.awaited` | lifetime | warning | awaited ≥ 100, checkedIn > 0 |
| revenue_growth / _decline | `overview.revenuePaise` | period | positive (strong ↑) / info / warning (↓) | money floors |
| refunds_rise | `revenue.intelligence.refundsInPeriod.comparison` | period | warning | money floors + count ≥ 3; rise only |
| refund_rate_high | `revenue.intelligence.refundRate.pct` | lifetime | warning | ≥ 10 % with confirmed revenue ≥ ₹10,000 |
| discount_heavy | `revenue.intelligence.beforeDiscount.discount` | lifetime | info | ≥ 20 % of before-discount; `coupons` panel |
| comm_volume_growth / _decline | `communications.intelligence.window.attempted` | period | info | count floors |
| comm_delivery_low | `communications.channels[k].delivery` via `deliveryRate()` | lifetime | warning | < 90 % over ≥ 100 known outcomes; supported channels only |
| comm_unconfirmed_high | same via `unconfirmedShare()` | lifetime | info | ≥ 50 % over ≥ 100 sent |
| comm_bounces | `communications.intelligence.email.bounces` | lifetime | warning | ≥ 2 % of ≥ 100 email sent |
| comm_wallet_held | `communications.intelligence.whatsapp.walletSkipped` | lifetime | warning | ≥ 1 |
| source_walkin_share | `participants.composition.source.walkin` | lifetime | info | ≥ 25 % of ≥ 50 |
| pass_concentration | `participants.composition.passMix` | lifetime | info | ≥ 80 %, ≥ 2 passes, ≥ 50 confirmed; never the "Other passes" row |
| pending_backlog | `registrations.pending` | lifetime | warning | ≥ 20 |
| day_concentration | `registrations.byDay` | period | info | ≥ 14 covered days, Σ ≥ 50, top day ≥ 40 %, coverage complete |

`RULE_COUNT = 19` (rule functions; some emit one of two ids).

---

## 7. Thresholds

Named exports pinned by test: `TREND_MIN_BASELINE 20`, `TREND_MIN_ABS_DELTA 10`, `TREND_MIN_PCT 15`, `TREND_STRONG_PCT 40`, `MONEY_MIN_BASELINE 1,000,000 paise`, `MONEY_MIN_ABS_DELTA 250,000`, `REFUND_RATE_WARN_PCT 10`, `REFUNDS_MIN_COUNT 3`, `DISCOUNT_HEAVY_PCT 20`, `DELIVERY_RATE_WARN_PCT 90`, `DELIVERY_MIN_KNOWN 100`, `UNCONFIRMED_INFO_PCT 50`, `COMM_MIN_SENT 100`, `BOUNCE_WARN_PCT 2`, `AWAITING_MIN 100`, `ATTENDANCE_LOW_PCT 50`, `ATTENDANCE_MIN_CONFIRMED 50`, `PENDING_BACKLOG_MIN 20`, `WALKIN_SHARE_INFO_PCT 25`, `COMPOSITION_MIN 50`, `PASS_CONCENTRATION_PCT 80`, `CONCENTRATION_DAY_PCT 40`, `CONCENTRATION_MIN_DAYS 14`, `CONCENTRATION_MIN_SUM 50`, `MAX_SURFACED 6`; `NEARLY_FULL_PCT` imported. The UI's footer states they are business floors, not statistical tests (test 42 pins that no copy claims significance).

---

## 8. Deduplication

`byField: Map<evidence.field, Insight>` keeps, per field, the card that ranks first (most severe, then highest rule priority). The three capacity states therefore collapse to one (test 35); velocity is never a separate card from the delta it derives from (no velocity rule exists — the Revenue/Communications modules show it).

---

## 9. Ranking

`compare(a, b)`: severity rank (`critical 0, warning 1, positive 2, info 3`) → `RULE_PRIORITY` (capacity → awaiting → pending → delivery/wallet/bounces → refunds/rate/revenue decline → count declines → growth → observations) → absolute movement (larger first; lifetime cards use the cited value) → `id`. Never by text. Test 34 pins an exact order over a busy fixture.

---

## 10. Six-insight cap

`insights = ranked.slice(0, MAX_SURFACED)`; `candidates` and `evaluated` are returned so the page can say "3 of 19 checks cleared their floors (2 overlapping or beyond the top 6 are not shown)". Deterministic: two runs over the same payload yield identical ids (test 34).

---

## 11. Permission behaviour

Payload shape is the boundary: without `transactions` the route omits `revenue` and `overview.revenuePaise`, so revenue/refund/discount rules return null (test 20: no rule emits, no `paise`/₹ in the output, `evaluated` still 19). Browser QA: `a29-mix` shows `revenue_growth` to owner and finance and not to admin or manager, from the same engine over each role's own payload; gate staff never reach the API. The UI never names a missing protected figure (test 42).

---

## 12. Event / workspace isolation

The engine receives one authorized `(workspace, event)` payload and stamps `scope { eventSlug, eventId }` and `evidence.range` on every card; there is no cross-event input and no aggregation. Browser QA: three events produced three different card sets for every role.

---

## 13. Failure isolation

Each rule reads its own fields and is wrapped in try/catch; test 37 removes revenue and participants and nulls communications and still gets capacity/awaiting/pending cards; test 38 sets `communications = null` (malformed) and the other rules survive.

---

## 14. Date/range behaviour

Windowed cards cite `ComparedMetric` fields and phrase both windows with `rangeLabels(range)` — the same wording `useAnalyticsScope` derives ("last 30 days" / "the 30 days before"; the page passes its own labels so header and cards agree). Lifetime cards say "all time"/"so far". Test 41 pins that no card mixes the two. `coverage.partial` blocks every comparative rule and the day-concentration rule.

---

## 15. UI

`components/analytics/insights/InsightsAnalytics.tsx` + `app/(dashboard)/dashboard/analytics/insights/page.tsx`; `lib/analytics/routes.ts` gains the module (first in the strip); `lib/navigation/breadcrumbs.ts` gains the leaf. Cards: `<ol>` of `<li><article aria-labelledby>` with severity chip text (`Critical / Needs attention / Positive / Observation`), window badge, `<h3>` title, summary, evidence line (`₹30,000 from ₹15,000 ↑100%`, `DeltaChip` inverted for declines/rises that are bad), "View analytics" and the action link, both carrying `?eventId=`. Empty state distinguishes "nothing cleared a floor" from "analytics could not be read". No animation, no gradient, no AI badge.

---

## 16. Responsive QA

1440 / 834 / 390 for owner: cards single-column at phone width, `main` overflow 0 at every width (probe covers `documentElement` and `main`), no clipped text, no mid-word wraps.

---

## 17. Tests

`tests/unit/insightsEngine.test.ts` — **42**: registration trends incl. weak/small/absolute/zero-baseline/unavailable/partial (1–9); capacity incl. shared constant (10–13); operations incl. no-show-never and no operator data (14–17); revenue incl. unauthorized/unavailable/zero/refunds/rate/discount (18–23); communications incl. unknown-not-failed and unsupported channels (24–28); participants incl. forbidden vocabulary (29–33); dedup, ranking, cap, provenance resolution, failure isolation, malformed-field survival, purity + timing, labels, window wording, copy discipline (34–42). No existing test changed; `navigationSurfacing` and `analyticsArchitecture` pass unmodified with the seventh module because they iterate the route table.

---

## 18. Emulator validation

No new Firestore behaviour to prove (the engine reads nothing). `organizerAnalyticsAuthz.emu` + `analyticsScale.emu` re-run: 31/31.

---

## 19. Scale validation

O(rules): 1,000 runs over the busiest fixture in < 500 ms (test 39, typically tens of ms). The payload it consumes is the 20k-proven one from 12-26/12-28/12-29; the engine adds no read.

---

## 20. TypeScript / lint / build

`tsc --noEmit` clean · ESLint 0 errors/0 warnings on all new and touched files · unit **356 / 9,909** · `NEXT_DIST_DIR=.next-a1231 next build` clean, dist removed, `tsconfig.json` restored · `emu:build` clean.

---

## 21. Files changed

**New:** `lib/analytics/insightsRules.ts`, `components/analytics/insights/InsightsAnalytics.tsx`, `app/(dashboard)/dashboard/analytics/insights/page.tsx`, `tests/unit/insightsEngine.test.ts`, `scripts/qa/rd-analytics-12-31-fixture.mjs`, `scripts/qa/rd-analytics-12-31-shots.mjs`, this report.
**Edited (surgical):** `lib/analytics/contract.ts` (+59/−1: `Delta`/`AttentionSeverity` type imports, Insight types), `lib/analytics/routes.ts` (+2), `lib/navigation/breadcrumbs.ts` (+1, CRLF preserved).

---

## 22. Concurrent work preserved

`app/(dashboard)/dashboard/analytics/page.tsx` (legacy landing, concurrently modified) not opened; `lib/analytics/modules.ts` untouched (`AnalyticsModuleKey` unchanged — cards link to existing modules); no other module file, Reports, CRM, registration or communication source touched. The public-chrome workstream's files not opened.

---

## 23. Deferred rules

Event-day readiness, starting/closing-soon (need `scope.eventStartsAt`); statistical spike/drop anomalies; campaign-count movement; per-pass capacity; any cross-event or edition comparison; natural-language generation.

---

## 24. Known limitations

Attendance rules use `checkedIn > 0` as the "event has started" proxy until an event instant exists in the payload. Windowed `delivered` in a communication card still carries the F-2 webhook caveat of 12-28. Thresholds are product floors and are cheap to change but were not product-reviewed in this phase.

---

## 25. Firestore verification

`firestore.rules` / `firestore.indexes.json` unmodified (pre-existing baseline modifications, mtimes 3 Sep / 8 Sep). No collection, index, cache or job added; nothing deployed.

---

## 26. Git / worktree verification

HEAD `b7e5fdf`; 0 staged; no commit/push/deploy; no reset/clean/stash/checkout/restore/revert; worktree diff against the captured baseline is exactly the new files listed in §21 plus the three surgical edits; CRLF preserved; QA server stopped; isolated build dir and the esbuild bundle removed.

---

## 27. Final verdict

**IMPLEMENTED — SAFE FOR NEXT ANALYTICS PHASE.**

STOP. Awaiting review before RD-12-32.
