# RD-ANALYTICS-12-30 — INSIGHTS ENGINE AUDIT

**Type:** AUDIT ONLY — no source, test, rules, index, schema, data or deployment changes.
**Date:** 2026-09-11
**Baseline:** HEAD `b7e5fdf`, 0 staged, 820 worktree entries (`$TEMP/rd1230-baseline.txt`). `firestore.rules` / `firestore.indexes.json` untouched (pre-existing baseline modifications).
**Concurrent work:** the analytics workstream's own uncommitted files (modules 06–12-29) plus the public-chrome workstream. `app/(dashboard)/dashboard/analytics/page.tsx` (the legacy "Event Insights" landing) carries a concurrent modification — inspected, not touched.

---

## 1. Executive summary

RegisterDesk now has **one payload** — `AnalyticsResponse` from `/api/organizer/analytics/overview/[eventId]?preset=` — that carries every canonical figure the six modules render: lifetime counts (`Count = number|null`), IST-windowed period totals with `ComparedMetric` deltas and explained absences, `MaybeMoney` for every rupee (present only with `transactions`), coverage/limits flags, per-event capabilities, and three "intelligence" blocks (revenue, communications, participants) each carrying a `basis` literal. It is fetched once per module page with `cache: 'no-store'`, computed from aggregates and rollups (no registration scan), and already authorized before any protected read.

The audit's central finding is that **an Insights Engine needs no new read, no new datastore, no new permission decision and no AI**: it is a pure function `insights(response: AnalyticsResponse): Insight[]` — deterministic rules over the payload the page already has — mirroring the platform's existing deterministic engine `lib/dashboard/insights.ts` (`buildAttention`, severities `critical/warning/info`, constants `NEARLY_FULL_PCT = 85`, `CLOSING_SOON_DAYS = 3`, `BEHIND_PACE_PCT = 60`, `PACE_MIN_DAYS = 7`), whose constants and severity vocabulary the new engine must **share, not re-declare**.

| # | Finding | Impact |
|---|---|---|
| F-1 | Every candidate insight is derivable in memory from `AnalyticsResponse`; zero additional Firestore reads. | Architecture |
| F-2 | Permission is already encoded in the payload's *shape* (`revenue?`, `spend?`, `overview.revenuePaise?` absent without `transactions`; gate roles never receive a payload). A rule that reads an absent key produces nothing — authorization precedes computation for free. | Security |
| F-3 | Comparison validity is already encoded: `ComparedMetric.delta === null` with `unavailable ∈ {no_baseline, outside_coverage, not_measured, disabled}`. A rule must never compute its own delta. | Correctness |
| F-4 | `computeDelta` returns `pct: null` for a zero/negative baseline — the platform already refuses "up from nothing" as a percentage. Insights inherit it. | False positives |
| F-5 | The payload carries **no event start/end instant** (only `publishedAt` in the producer, not the contract). Event-day readiness, "starting soon", "closing soon" cannot be built from the payload today; the Dashboard's `buildAttention` has them from `EventSignalInput`. Either add `scope.eventStartsAt` (one field from the event doc the producer already loads) or leave event-day insights to the Dashboard. | Scope |
| F-6 | Historical depth per window is 7–90 daily points with `coverage.since`; robust day-level anomaly detection (median/MAD) is feasible only with ≥14 covered days and a minimum absolute volume; otherwise it manufactures noise. Recommend deferring spike/drop anomalies to Tier 3 and shipping only a bounded "concentration" observation. | Quality |
| F-7 | Two cross-module facts already exist in the payload as canonical derivations (attendance `pct`, AOV); an engine must **read** them, never recompute them from their inputs. | Duplication |
| F-8 | The legacy `/dashboard/analytics` landing (concurrently modified) is where Insights would naturally live; the module nav table lists six modules and `reports`. Insights should be a seventh module page under the same shell, not a redesign. | UX |
| F-9 | No thresholds exist for growth/decline/refund/delivery insights; the ones proposed in §13 are documented business floors, not statistics, and are pinned as named constants. | Thresholds |

**Verdict (§41): APPROVED WITH CONDITIONS.**

---

## 2. Current Analytics inputs

`AnalyticsResponse` (lib/analytics/contract.ts):

- `scope { eventId, eventSlug, eventName, eventType, range{from,to,preset}, comparison }`
- `capabilities { modules[], panels[] }`, `coverage { since, partial, unavailable }`, `limits { registrations, communications, certificates, ledger, passValue, reminders }`, `financialAllowed`
- `overview { registrations: ComparedMetric, checkedIn: ComparedMetric, revenuePaise?: ComparedMetric, fillPct }`
- `registrations { total, confirmed, pending, cancelled, rejected, waitlisted, paid, free, paymentPending, refunded, refundPending, byDay, cancelledByDay, period{confirmed, cancelled}: ComparedMetric, byPass, byPassBasis, capacity, capacityUsedPct, remaining }`
- `revenue? { confirmedRevenue, netRevenue, grossCollected, platformFee, gst, gatewayFee, netSettlement, refunds, refundCount, communicationCost, profitEstimate: MaybeMoney; byDay; byPass; intelligence{ velocity, averageOrderValue, refundRate, refundsInPeriod(ComparedMetric), beforeDiscount } }`
- `operations { checkedIn, attendancePct, byDay, attendance{confirmed, checkedIn, pct, awaited, over}, capacity?{configured, confirmed, usedPct, remaining, over}, identifiers?, timing? }`
- `communications { sent, delivered, failed, remindersScheduled, remindersSent, certificatesIssued, certificatesDownloaded, channels[], totalMessages, spend?, intelligence{ campaigns, composition, email{bounces, complaints}, whatsapp{read, walletSkipped}, window{period, baseline, attempted/delivered/notDelivered: ComparedMetric, velocity}, channelMix } }`
- `participants? { composition{ source, sourceByStatus, passMix, statusMix, identityRules, basis } }`

All of it is produced by one `getEventAnalytics` call from aggregates, counters and rollups; cost is independent of registration count (12-28/12-29 emulator suites at 20k).

---

## 3. Canonical source map

| Insight input | Read from | Never recomputed from |
|---|---|---|
| period registrations + delta | `registrations.period.confirmed` / `overview.registrations` | `byDay` sums |
| period cancellations + delta | `registrations.period.cancelled` | — |
| lifetime status/pass counts | `registrations.*`, `participants.composition.statusMix/passMix` | rows |
| capacity fill | `registrations.capacity/capacityUsedPct/remaining`, `operations.capacity` | `confirmed ÷ capacity` |
| attendance | `operations.attendance{pct, awaited, over}` | `checkedIn ÷ confirmed` |
| period check-ins + delta | `overview.checkedIn` | `operations.byDay` |
| period revenue + delta | `overview.revenuePaise` (absent without `transactions`) | `revenue.byDay` |
| revenue velocity, AOV, refund rate, period refunds + delta, discount | `revenue.intelligence.*` | any arithmetic on `revenue.*` |
| communication window + delta, velocity, mix | `communications.intelligence.window.*`, `channelMix` | channel sums |
| provider signals | `communications.intelligence.email/whatsapp`, `channels[].delivery` | — |
| campaigns | `communications.intelligence.campaigns` | message rows |
| source composition | `participants.composition.source/sourceByStatus` | — |
| coverage / baseline validity | `coverage.*`, each `ComparedMetric.unavailable` | date maths |

Rule of the engine: **an insight may only cite a field of the payload; it may compare two payload fields, and it may not subtract, divide or sum payload fields to manufacture a metric that a module does not itself publish.** (Ratios that exist — `pct`, `sharePct`, `refundRate.pct` — are read.)

---

## 4. Candidate insight catalogue

| ID | Category | Inputs | Window | Permission | Capability | Tier |
|---|---|---|---|---|---|---|
| REG_GROWTH / REG_DECLINE | trend/comparison | `registrations.period.confirmed` | period vs prior | any | — | 1 |
| CANCEL_RISE | comparison | `registrations.period.cancelled` | period vs prior | any | — | 1 |
| CAP_APPROACHING / CAP_REACHED / CAP_OVER | operational | `registrations.capacityUsedPct`, `operations.capacity` | lifetime | any | capacity configured | 1 (shares `NEARLY_FULL_PCT`) |
| ATTEND_LOW / ATTEND_OVER | operational | `operations.attendance` | lifetime | any | `checkin` gate | 1 |
| AWAITING_LARGE | operational | `operations.attendance.awaited` | lifetime | any | `checkin` gate | 1 |
| CHECKIN_ACTIVITY | comparison | `overview.checkedIn` | period vs prior | any | `checkin` | 1 |
| REV_GROWTH / REV_DECLINE | revenue | `overview.revenuePaise` | period vs prior | `transactions` | — | 1 |
| REFUNDS_RISE | revenue | `revenue.intelligence.refundsInPeriod` | period vs prior | `transactions` | — | 1 |
| REFUND_RATE_HIGH | revenue | `revenue.intelligence.refundRate.pct` | lifetime | `transactions` | — | 1 |
| DISCOUNT_HEAVY | revenue | `revenue.intelligence.beforeDiscount` | lifetime | `transactions` + coupons panel | — | 2 |
| COMM_VOLUME | communications | `communications.intelligence.window.attempted` | period vs prior | any | `communications` gate | 1 |
| COMM_DELIVERY_LOW | communications | `channels[].delivery` → `deliveryRate()` from `communicationsModel` | lifetime | any | supported channel | 1 |
| COMM_UNCONFIRMED_HIGH | communications | `unconfirmedShare()` | lifetime | any | supported channel | 1 |
| COMM_BOUNCES | communications | `intelligence.email.bounces/complaints` vs `channels.email.delivery.sent` | lifetime | any | email active | 2 |
| COMM_WALLET_HELD | communications | `intelligence.whatsapp.walletSkipped` | lifetime | any (count, not money) | WhatsApp active | 1 |
| SOURCE_MIX | participants | `participants.composition.source` | lifetime | any | composition measured | 1 (informational) |
| PASS_CONCENTRATION | participants | `participants.composition.passMix` | lifetime | any | ≥2 passes | 1 (informational) |
| STATUS_PENDING_BACKLOG | participants/registrations | `registrations.pending` | lifetime | any | manual approval | 1 |
| REG_CONCENTRATION_DAY | anomaly-lite | `registrations.byDay` | window | any | coverage ≥14 days | 2 |
| REG_SPIKE / REG_DROP (statistical) | anomaly | `byDay` | window | any | — | 3 |
| EVENT_DAY_READINESS, STARTING_SOON, CLOSING_SOON | readiness | needs event start/close instants | — | any | — | 2 (needs `scope.eventStartsAt`) / stays on Dashboard |
| AI narrative | — | deterministic facts | — | — | — | out of scope |

Explicitly NOT in the catalogue: no-show, unique/returning participants, demographics, editions, SMS/Push, cost-per-delivered, windowed unknown, cross-event comparisons, anything from `formResponses` or `attendee.*`.

---

## 5. Trend insights

Only `ComparedMetric` inputs qualify (period value, baseline, delta, reason). A trend insight fires when `delta.pct !== null` **and** the §13 floors hold. Wording is always windowed: "Confirmed registrations rose 18% in the last 30 days vs the 30 days before (54 → 64)". Lifetime totals never appear in a trend sentence. `windowLabel`/`baselineLabel` from `useAnalyticsScope` (or derived from `scope.range`) are the phrases.

---

## 6. Comparison insights

Valid iff `metric.delta !== null`. When `unavailable === 'outside_coverage'` the engine may emit an *informational* "no earlier period on record" only once per page (deduplicated), never as a trend. `not_measured` and `no_baseline` emit nothing. `coverage.partial` on the current window blocks growth/decline insights whose baseline could be truncated (the producer already sets `baselineOutsideCoverage` for the prior window; `coveragePartial` for the current window must also block, because a partially covered current period understates growth).

---

## 7. Anomaly insights

Data: `registrations.byDay`, `cancelledByDay`, `revenue.byDay`, `operations.byDay` — 7/30/90 IST points, filtered to `coverage.since`. Assessment:

- 7-day windows: too shallow for any distributional rule.
- 30/90-day windows with ≥14 covered days and Σ ≥ 50: a robust rule (day > median + 3·MAD, and day ≥ 10 absolute) is deterministic and explainable, but on registration series that are bursty by nature (launch day, price change, broadcast) it will flag every legitimate campaign as an "anomaly".
- Recommendation: **Tier 3** for spike/drop classification; **Tier 2** for a neutral *concentration* observation — "42% of this window's registrations arrived on 3 Sep" — when top-day share ≥ 40%, Σ ≥ 50, ≥14 covered days. Informational severity only.

---

## 8. Operational insights

From `operations.attendance` (lifetime; `pct` unclamped, `awaited` may be negative, `over` flag) and `operations.capacity`:

- ATTEND_LOW: `pct !== null && confirmed ≥ 50 && checkedIn ≥ 1 && pct < 50` — but only meaningful *during/after* the event; without an event instant (F-5) this fires for every upcoming event. **Gate on `checkedIn > 0`** (something has started) as the proxy until `eventStartsAt` exists; wording "so far".
- AWAITING_LARGE: `awaited ≥ 100 && checkedIn > 0` — "N confirmed registrations are still awaiting arrival". Never "no-show".
- ATTEND_OVER: `over === true` — informational, links to Operations' over-attendance note.
- CAP_*: `capacityUsedPct ≥ NEARLY_FULL_PCT (85)` warning; `≥ 100` critical; `remaining < 0` critical with "over configured capacity". Absent when capacity is null.
- CHECKIN_ACTIVITY: `overview.checkedIn` delta, floors as §13.

---

## 9. Revenue insights

All read from `revenue`/`overview.revenuePaise` — keys that **do not exist** without `transactions`. Rules: REV_GROWTH/DECLINE from `overview.revenuePaise` delta; REFUNDS_RISE from `refundsInPeriod.comparison` (Money floors); REFUND_RATE_HIGH from `refundRate.pct ≥ 10` with `confirmedRevenue.ok && paise ≥ ₹10,000`; DISCOUNT_HEAVY when `beforeDiscount.discount.ok` and discount ≥ 20% of before-discount value (Tier 2, needs the coupons panel). Every money sentence uses `inrPaise`. No revenue insight may be generated from registrations × price, from `revenue.byDay` sums, or from any `MaybeMoney` with `ok: false`.

---

## 10. Communications insights

From `communications.intelligence.window` (attempted/delivered/notDelivered ComparedMetric — "not delivered" wording, never "failed"), `channels[].delivery` through the **existing** `deliveryRate/failureRate/unconfirmedShare` functions (denominators carried), `email.bounces/complaints`, `whatsapp.walletSkipped`, `campaigns`. Constraints honoured: unknown ≠ failed; no windowed unknown; SMS/Push (`support: 'not_implemented'`) excluded from every rule; `spend` never cited (money, and its basis is "recorded on sent rows"); cost-per-delivered does not exist. COMM_DELIVERY_LOW: `deliveryRate.pct < 90` with `denominator ≥ 100` — warning; COMM_UNCONFIRMED_HIGH: `unconfirmedShare.pct ≥ 50` with `sent ≥ 100` — informational ("provider callbacks may not be reaching the platform"), the honest reading of a missing webhook. COMM_WALLET_HELD: `walletSkipped ≥ 1` — warning, count only, links to wallet.

---

## 11. Participant insights

Only `participants.composition`: SOURCE_MIX (walk-in share ≥ 25% of ≥ 50 registrations — "a quarter of registrations were created at the gate"), PASS_CONCENTRATION (one pass ≥ 80% with ≥ 2 passes and ≥ 50 confirmed), STATUS_PENDING_BACKLOG (`registrations.pending ≥ 20` — warning, links to Registrations approval). Every sentence says "registrations". No unique/returning/demographic/edition insight can be expressed because no such field exists in the payload.

---

## 12. False-positive controls

An insight requires **all** of: the cited field(s) measured (`!== null` / `ok: true`); a valid comparison when the rule is comparative (`delta !== null`); a minimum absolute volume on the *baseline* and on the *current* value; a minimum absolute change; a minimum percentage change; `coverage.partial === false` for growth/decline; capability/panel present for gated modules; event-type gates where a module is type-exclusive. A rule that cannot state which floor it passed does not fire.

---

## 13. Threshold model

Named constants (to live beside `NEARLY_FULL_PCT` et al., pinned by test):

| Constant | Value | Why |
|---|---|---|
| `TREND_MIN_BASELINE` | 20 (registrations / check-ins / messages) | below this a doubling is noise ("10 → 20") |
| `TREND_MIN_ABS_DELTA` | 10 | a change must be visible in seats, not only in percent |
| `TREND_MIN_PCT` | 15 | rounding and weekly seasonality live under this |
| `TREND_STRONG_PCT` | 40 | promotes info → positive/warning |
| `MONEY_MIN_BASELINE_PAISE` | 1,000,000 (₹10,000) | percent on small money is meaningless |
| `MONEY_MIN_ABS_DELTA_PAISE` | 250,000 (₹2,500) | |
| `REFUND_RATE_WARN_PCT` | 10 | with confirmed revenue ≥ ₹10,000 |
| `REFUNDS_MIN_COUNT` | 3 | a single refund is not a pattern |
| `DELIVERY_RATE_WARN_PCT` | 90 | with known-outcome denominator ≥ 100 |
| `UNCONFIRMED_INFO_PCT` | 50 | with sent ≥ 100 |
| `AWAITING_MIN` | 100 | with checkedIn > 0 |
| `ATTENDANCE_LOW_PCT` | 50 | with confirmed ≥ 50 and checkedIn > 0 |
| `PENDING_BACKLOG_MIN` | 20 | |
| `WALKIN_SHARE_INFO_PCT` | 25 | with ≥ 50 registrations |
| `PASS_CONCENTRATION_PCT` | 80 | with ≥ 2 passes, ≥ 50 confirmed |
| `CONCENTRATION_DAY_PCT` | 40 | with Σ ≥ 50 and ≥ 14 covered days |
| reuse `NEARLY_FULL_PCT` | 85 | already the Dashboard's rule — one definition |

Both the absolute and the percentage floors are required for every trend rule; the baseline floor is required for every comparison. These are business floors, documented as such; they are not statistical significance tests and the copy must not claim they are.

---

## 14. Absence / unavailable contract

Measured zero: eligible only for rules that name zero as meaningful (e.g. "no messages have been sent for this event" — informational, only when `channels` are supported and `totalMessages === 0`; "no check-ins yet" is NOT emitted because the event may not have started). Read failure (`null`/`ok:false`): rule skipped, silently. Unauthorized: key absent → skipped. Unsupported: `not_implemented`/absent panel → skipped. Partial coverage: comparative rules skipped; lifetime rules unaffected. No insight may mention a figure it could not read, and no absence becomes a negative conclusion.

---

## 15. Priority model

Reuse `AttentionSeverity = 'critical' | 'warning' | 'info'` and add `'positive'` as a display variant of `info` (not a fourth severity in the shared type — keep the Dashboard's vocabulary intact; the engine's own type is `InsightSeverity = AttentionSeverity | 'positive'`). Assignment is per rule, not per magnitude, except: capacity ≥100% → critical, ≥85% → warning; trend ≥ `TREND_STRONG_PCT` → positive/warning by direction, else info. "Critical" is reserved for capacity exceeded and configured-capacity overflow; nothing else in v1.

---

## 16. Deduplication

One insight per *evidence field*: a rule group declares the field it cites (`registrations.period.confirmed`), and only the highest-priority rule in the group emits. Velocity is never a separate card from the delta it is derived from; "trend is strong" is the same card with a different severity. Cross-module echoes (registrations ↑ and revenue ↑) are allowed because they cite different fields and carry different permissions. Hard cap per page: 6 surfaced, ranked (§30), with a "n more" affordance if desired.

---

## 17. Provenance contract

```ts
interface Insight {
  id: string                       // `${rule}:${eventSlug}:${range.from}:${range.to}` — stable for a payload
  rule: InsightRuleId              // enum, pinned
  severity: InsightSeverity
  title: string
  summary: string                  // the sentence; windowed wording where windowed
  evidence: {
    field: string                  // JSON path into AnalyticsResponse, e.g. 'registrations.period.confirmed'
    basis?: string                 // the module's own `basis` literal when the field carries one
    value: number | null           // paise for money
    baseline?: number | null
    delta?: Delta | null
    window: 'lifetime' | 'period'
    range: AnalyticsDateRange
    coverage: { partial: boolean; since: string | null }
    thresholds: Record<string, number>   // the constants this rule passed
  }
  module: AnalyticsModuleKey       // where "View analytics" goes
  action?: { label: string; href: string }
  scope: { eventSlug: string; eventId: string | null }   // workspace is implied by the authorized payload
}
```

"Why did RegisterDesk show me this?" is answered by `evidence` alone — field, value, baseline, thresholds, window, coverage.

---

## 18. Actionability

Informational recommendations only, one per rule, phrased as "consider": CAP_APPROACHING → "review capacity or waitlist settings" (link Passes/Waitlist); AWAITING_LARGE → "prepare the check-in team" (link Operations); COMM_DELIVERY_LOW / UNCONFIRMED → "check the campaign and provider status" (link Communications log); REFUNDS_RISE → "review recent refunds" (link Reports → Refunds, `transactions` only); PENDING_BACKLOG → "review pending registrations" (link Registrations). No autonomous action, no mutation, no "auto-fix".

---

## 19. Event-type gating

Rules gate on **capabilities and panels**, not `eventType`: `capabilities.modules` (operations requires `checkin`; communications requires its gate; revenue requires `transactions`), `capabilities.panels` (`coupons` for DISCOUNT_HEAVY, `waitlist` for the waitlist recommendation, `identifiers`/`timing` for any future BIB/timing rule), `operations.identifiers?`/`timing?` presence. No sports/conference branch exists in v1; BIB/timing readiness and session insights are out of scope until the Operations audit conditions (12-27 C-1…C-4) are implemented.

---

## 20. Permission model

| Role | Payload | Insights |
|---|---|---|
| owner, finance | full (`revenue`, `spend`, `overview.revenuePaise`) | all rules |
| admin, manager | no money keys | all non-money rules; money rules find no field and do not run |
| gate roles | 403, no payload | no insights surface |

Filtering happens **before computation** by construction: the engine receives the already-authorized payload and money rules are guarded by `'revenue' in response` / `overview.revenuePaise !== undefined`. The engine must never receive a super-set payload and filter afterwards, and must never be a separate route that re-reads data (a second route would be a second authorization surface).

---

## 21. Cross-metric permission inheritance

A derived insight inherits the **strictest** permission of its inputs. In practice the engine does not derive; where a derived metric exists it is a payload field already placed behind the right key (AOV under `revenue.intelligence`; attendance under `operations`; campaign reach is NOT derivable — "communications + registrations → reach" is not published and must not be invented). Rule: an insight cites fields from at most one permission class, or from classes whose intersection the caller holds — enforced by the fields simply not being present.

---

## 22. Event / workspace isolation

The payload is produced for one `(workspaceUid, eventSlug)` after `authorizeAnyWorkspace` + slug ownership; every insight carries `scope.eventSlug/eventId` and `evidence.range`. There is no global aggregation and no cross-event input. Cross-event insights are not approved (12-26 and 12-28 both left `mode:'event'` unwired).

---

## 23. Date / range semantics

Each rule declares `window: 'lifetime' | 'period'`. Period rules cite `ComparedMetric` fields and use `windowLabel`/`baselineLabel` wording; lifetime rules say "all time" or "so far" and never use "increased/decreased". Mixed sentences are forbidden by the provenance shape (one `window` per insight). Presets 7/30/90/custom ride `scope.range` unchanged; IST is inherited from the producer.

---

## 24. Event-day readiness

Not feasible from the payload (F-5). Inputs that exist: confirmed, checked-in, awaited, capacity, communications sent, identifiers/timing progress. Missing: event start/end instants, staff readiness. Options: (a) add `scope.eventStartsAt` / `registrationClosesAt` to the contract from the event document the producer already loads (no new read) — then STARTING_SOON/CLOSING_SOON can share `STARTING_SOON_DAYS`/`CLOSING_SOON_DAYS` with the Dashboard; (b) leave event-day signals to the Dashboard's Attention Center. No readiness *score* is proposed: its inputs have different semantics (a count, a percentage, a boolean) and any formula would be invented.

---

## 25. Capacity insights

`registrations.capacity` is `ev.totalCapacity` (null when unconfigured); `capacityUsedPct` unclamped; `operations.capacity.over/remaining`. Canonical and complete when configured. CAP_* rules emit only when `capacity !== null && capacity > 0`; wording "confirmed registrations", never participants. Per-pass capacity is not in the payload (and historical per-pass counts pre-2026-08-11 are lost) — no per-pass capacity insight.

---

## 26. Communication constraints

As §10. Additionally: `campaigns.period` comparison may support "N campaigns created in the window vs M" (info) with `TREND_MIN_BASELINE` relaxed to 2 campaigns and absolute delta ≥ 2; provider signals use lifetime counts against lifetime `sent`; F-2 (webhook fallback) means `delivered` can be over-attributed in rare cases — copy stays "confirmed by the provider, as recorded".

---

## 27. Freshness / cache

Per request, from the payload the page already fetched: zero additional latency beyond the pure function (microseconds over one object). No server cache, no TTL, no datastore. If a server-side Insights endpoint is ever wanted (e.g. for the Dashboard), it should call `getEventAnalytics` once and run the same pure function — never cache insights separately from the payload they explain.

---

## 28. Scale architecture

`AnalyticsResponse` cost is already O(1) in registrations (aggregates/rollups; ~60 aggregates + ≤ 90 rollup docs per request). Insights add O(rules × fields) in-memory work — ~20 rules over one object. No rule may call a data source; the engine signature takes the response and returns insights, and a source assertion pins that `lib/analytics/insights*.ts` imports nothing from `@/lib/firebase/*`.

---

## 29. Failure isolation

Each rule reads its own fields; a `null`/`ok:false`/absent input skips that rule only. Revenue unavailable leaves registration/operations/communication rules intact (the payload itself already isolates: `revenue?` absent, `communications` block present). The engine must wrap each rule in a try/catch that drops the rule, so a single malformed field cannot blank the page.

---

## 30. Ranking

Order: (1) critical, (2) warning by operational urgency (capacity, awaiting, pending backlog, delivery), (3) warning by financial impact (refunds, revenue decline), (4) positive (strong growth), (5) info. Within a tier, larger absolute delta first. Surface ≤ 6; remainder collapsible. Ties are stable by rule order.

---

## 31. Lifecycle

Ephemeral and request-generated: `id` stable for a given payload (rule + slug + range), `generatedAt` = response time. No persistence, no read/unread, no dismissal in v1 — nothing in the audit justifies a datastore; an insight is a view of a payload, and the payload is not stored either. Expiration is implicit (new payload → new insights). Revisit only if a cross-session "dismiss" is requested by product.

---

## 32. AI / LLM boundary

Not needed. Deterministic rules produce the facts and the sentence; the sentence templates are code. If narrative generation is ever added: it receives only `Insight[]` (aggregates, no PII, already permission-filtered), may rephrase but not add, subtract or compare, and its output is displayed *beside* the deterministic sentence, never instead of it. No provider, key, or call in RD-12-30/31.

---

## 33. PII

`AnalyticsResponse` carries no names, emails, phones, responses or ids of people (verified across 12-26/12-28/12-29 tests). The engine consumes only that payload, so participant-level insights are impossible by construction; a source assertion pins that the insights module never imports registration, CRM or log readers.

---

## 34. Reports consistency

Insights link to modules and, for money, to the existing Reports kinds (refunds, transactions) under their own permissions. No export, no report kind, no numbers that differ from the module a card links to — the card cites the module's own field.

---

## 35. UX architecture

Seventh module page `/dashboard/analytics/insights` under the same shell (`AnalyticsModuleNav`, `ModuleHeader`, `ModuleStates`), listed first or last in the nav (recommend **first**, as the landing the legacy "Event Insights" page implies — but that page is under concurrent modification, so v1 should add the module and leave the landing untouched). Compact cards: severity chip (text + colour), title, one-sentence summary with the windowed phrase, evidence line ("54 → 64 · last 30 days vs the 30 days before"), "View analytics" link, optional "consider …" action. Empty state: "Nothing needs your attention for this event in the last 30 days" with the list of what was checked. No AI badge, no animation, no alert dashboard.

---

## 36. Accessibility

`<section aria-label="Insights">`, `<h2>` per card group, cards as `<article>` with `<h3>`; severity as text inside the chip plus icon with `aria-hidden`; colour never the only channel; links are `<a>`; keyboard order = ranking; `prefers-reduced-motion` irrelevant (no motion); responsive: single column at 390 px, `[&>*]:min-w-0` on any grid (12-28 lesson).

---

## 37. Test architecture

Pure-function tests over hand-built `AnalyticsResponse` fixtures: trend (strong up, strong down, below pct floor, below abs floor, baseline < floor, zero baseline → `pct null` → no card, `unavailable` reasons × 4, `coverage.partial` blocks); revenue (authorized fires, `revenue` absent → no money rule runs, `ok:false` skips, zero revenue skips); operations (attendance floors, awaited floor, `over`, "no-show" never in any string — source assertion); communications (rates via the existing model functions, unknown untouched, SMS/Push never cited, `spend` never cited); participants (source/pass/pending rules, no unique/returning/demographic strings); permissions (manager payload → no money card; finance payload → money cards); isolation (scope carried; fixture with another event's numbers unaffected — structural); scale (source assertion: no Firebase import; timing of 1,000 runs < 100 ms); failure isolation (each block nulled in turn leaves the others' cards); dedup (one card per evidence field); ranking and cap (≤ 6, order); provenance (every card's `evidence.field` resolves in the fixture to the cited value); accessibility (component renders severity as text). Browser QA: 1440/834/390 for owner, finance, manager, admin, gate.

---

## 38. Exact implementation boundary

**Build (RD-12-31):**
- `lib/analytics/insightsRules.ts` (pure): constants (§13, importing `NEARLY_FULL_PCT`, `AttentionSeverity` from `lib/dashboard/insights`), rule table, `buildInsights(response, labels): Insight[]`, dedup + ranking + cap.
- `lib/analytics/contract.ts`: `Insight`, `InsightSeverity`, `InsightRuleId` types (no change to `AnalyticsResponse`).
- Optional, only if event-day rules are wanted: `scope.eventStartsAt` / `registrationClosesAt` from the event document already loaded (no read) — otherwise omit.
- `components/analytics/insights/InsightsAnalytics.tsx` + page + nav row + breadcrumb leaf.
- Tests per §37; QA per §36/§37.

**Do not build:** any read, route, cache, datastore, persistence, AI, statistical anomaly detection, readiness score, no-show, cross-event, per-pass capacity, demographic/identity insights, Reports changes, changes to any existing module's figures.

---

## 39. Risks / open questions

1. Threshold values are business floors; product should confirm them (they are pinned constants, cheap to change).
2. Attendance rules without an event instant rely on `checkedIn > 0` as "the event has started" — imperfect (a test scan starts it). Adding `scope.eventStartsAt` resolves this cleanly.
3. The legacy `/dashboard/analytics` landing is concurrently modified — placement of Insights as the landing must wait.
4. Webhook F-2 can over-attribute `delivered`; delivery insights inherit that caveat.
5. If the Dashboard's Attention Center and Analytics Insights both exist, the same capacity rule appears in two places — acceptable (different scopes: workspace vs event) as long as the constant is one.

---

## 40. Worktree verification

HEAD `b7e5fdf`; 0 staged; only file created: `docs/RD-ANALYTICS-12-30-INSIGHTS-ENGINE-AUDIT.md`; no source, test, rules, index, config, commit, push, deploy, emulator write or build; concurrent files inspected in place.

---

## 41. Final verdict

**APPROVED WITH CONDITIONS.**

- C-1 The engine is a pure function over `AnalyticsResponse`; no read, route, cache, store or AI.
- C-2 Every rule cites a payload field and passes both an absolute and a percentage floor (§13) with a valid `ComparedMetric` where comparative; `coverage.partial` blocks comparisons.
- C-3 Money rules exist only where the money keys exist; severity vocabulary and `NEARLY_FULL_PCT` are shared with `lib/dashboard/insights.ts`, not re-declared.
- C-4 No no-show, unique/returning/demographic, SMS/Push, spend, windowed-unknown, cross-event or statistical-anomaly insight; concentration observation only under its floors.
- C-5 Event-day rules only after `scope.eventStartsAt` is added from the already-loaded event document; otherwise omitted.
- C-6 ≤ 6 surfaced, one card per evidence field, full provenance on every card.

STOP. Awaiting review before RD-12-31.
