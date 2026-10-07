# RD-ANALYTICS-12-27 — OPERATIONS & ATTENDANCE AUDIT

**Type:** AUDIT ONLY — no source, test, rules or index changes.
**Date:** 2026-09-11
**Baseline:** HEAD `b7e5fdf`, 0 staged. `firestore.rules` / `firestore.indexes.json` untouched. The only file this phase adds is this document.
**Predecessors:** RD-ANALYTICS-10 (Operations module contract), RD-DASH-11A/B (Check-in card counter fold), RD-CHECKIN-2.0 (indexed lookup, append-only history, one readiness resolver), RD-ANALYTICS-12-26 (`checkedIn` aggregate for period comparison).

---

## 1. Executive summary

The Operations & Attendance surface is **already a mature, honest analytics module**, not a green-field. RD-ANALYTICS-10 shipped `OperationsAnalytics` (attendance, capacity, conditional identifier and timing panels, waitlist, per-day arrivals) with the same `Count = number | null` discipline the revenue work adopted, and RD-CHECKIN-2.0 gave it a sound write side: transactional admission, idempotent undo, sharded attendance counters, IST daily rollups written in the same transaction, and an append-only `checkinHistory` timeline.

No P0 or P1 defect was found. The findings are **semantic clarifications and forward-looking constraints** for the implementation phase:

| # | Finding | Severity |
|---|---|---|
| F-1 | Attendance `checkedIn` counts every registration with `checkedInAt` regardless of `status`; the denominator counts `status == 'confirmed'`. A cancel-after-admission therefore inflates the rate and is the only real-world source of the `over` state. The contract documents this; the UI labels it "over". Nothing is wrong, but any "no-show"/"attendance rate" narrative built on top must state this population mismatch. | P3 |
| F-2 | `undo_checkin` is attributed to TODAY in the daily rollups, while the original `checkin` was attributed to its own day. Undoing a day-D admission on day D+1 leaves `byDay[D] = +1, byDay[D+1] = −1`. Totals stay correct; a single day can read negative. | P3 |
| F-3 | `checkinHistory` is written **best-effort** (`appendCheckinHistorySafe` catches and logs). It is complete in practice but not transactionally guaranteed. Any history-derived metric must be labelled reconstructive, and must not be used as the source of the check-in count. | P3 (constraint) |
| F-4 | The collection-group index `checkinHistory (eventSlug ASC, occurredAt DESC)` is declared but not verifiably deployed; a history-based hourly arrival curve would additionally need `(eventSlug, action, occurredAt)`, which is **not declared**. Arrival-by-hour must therefore be built on `registrations.checkedInAt` range aggregates (index already deployed and used by the dashboard). | P2 (design constraint, not a defect) |
| F-5 | The Dashboard Check-in card (shard fold of `registrationCounters`) and Analytics (`count()` on `checkedInAt`) measure check-ins by **two different mechanisms**. Both are written in the same transaction and both ignore `status`, so they agree by construction, but they are not the same read and can drift under the same class of counter failure RD-DASH-11 fixed. Acceptable; documented. | P3 |
| F-6 | No-show is **correctly not defined**. There is no event-end cutoff in the data model; `awaited` (`confirmed − checkedIn`) is the honest stand-in and the UI never calls it "no-show". Implementation must keep it that way unless an explicit event-end instant is introduced. | Note |
| F-7 | Staff/operator performance metrics do not exist and **must not be added as a ranking**: `checkedInBy` is present on registrations and `operatorUid` on history, but exposing per-operator throughput to organizers is a people-metric with no product requirement and a real misuse risk. | Note |

**Verdict (§26): APPROVED WITH CONDITIONS.**

---

## 2. Scope and method

Read-only audit of:

- Contract: `lib/analytics/contract.ts` (`OperationsAnalytics`, `AttendanceAnalytics`, `CapacityAnalytics`, `IdentifierAnalytics`, `TimingAnalytics`).
- Engine: `lib/analytics/eventAnalytics.ts`, `lib/analytics/operationsSources.ts`, `lib/analytics/operationsModel.ts`, `lib/analytics/normalize.ts`.
- Write side: `lib/firebase/firestore/registrations.ts` (check-in / undo transactions), `lib/firebase/firestore/registrationCounters.ts` (`writeCheckinDelta`, `foldAttendanceShards`), `lib/dashboard/dailyStats.ts` + `dailyStatsAdmin.ts`, `lib/checkin/history.ts`.
- Adjacent consumers: `app/api/organizer/dashboard/route.ts` (`todayCheckins`, Check-in card via `lib/dashboard/checkInStatusAdmin.ts`), Event360 (`lib/admin/event360Types.ts`), `components/analytics/operations/OperationsAnalytics.tsx`.
- Readiness: `lib/checkin/readiness.ts`, `lib/identifiers/timingTags.ts` (`resolveCredentialReadiness`), `lib/eventSetup/readiness.ts`.
- Auth: `app/api/organizer/analytics/[eventId]/route.ts`, `lib/team/types.ts`.
- Indexes: `firestore.indexes.json` (read only).
- Tests: `tests/unit/analyticsOperations.test.ts` (38 cases), `attendance.test.ts`, `checkinCounterSource.test.ts`, `checkinHistoryRead.test.ts`, `dashboardCheckInStatus.test.ts`, `operationsReadiness.test.ts`.

Method: source reading + grep, no emulator runs (nothing to exercise in an audit-only phase). Worktree entry count rose from 727 to 793 during the audit; the additions are the concurrent auth/login workstream (untracked, not mine) and were not inspected.

---

## 3. Current Operations contract (as shipped by RD-ANALYTICS-10)

```ts
interface AttendanceAnalytics { confirmed: Count; checkedIn: Count; pct: Count /* unclamped */; awaited: Count; over: boolean }
interface CapacityAnalytics   { configured: Count; confirmed: Count; usedPct: Count /* unclamped */; remaining: Count; over: boolean }
interface IdentifierAnalytics { … }   // absent unless identifierConfigs/{slug}.enabled
interface TimingAnalytics     { … }   // absent unless tagMapping.enabled
interface OperationsAnalytics { attendance; capacity?; identifiers?; timing?; waitlist?; byDay: { day; checkedIn }[] }
```

Normalisation (`normalize.ts:192-199`):

- `pct = pct(checkedIn, confirmed)` — null when either side is null or `confirmed === 0`.
- `awaited = confirmed − checkedIn` (negative when over).
- `over = checkedIn > confirmed`.

Presentation model (`operationsModel.ts:41-57`): `state: 'unmeasured' | 'normal' | 'over'`; in the `over` state `awaited` is nulled and `excess = checkedIn − confirmed` is exposed instead. The UI (`OperationsAnalytics.tsx:88-104`) renders an `OverAttendanceNote` rather than a >100 % bar.

Period comparison (`normalize.ts:287`): `checkedIn: compareMetric(period.checkedIn, baseline.checkedIn, baselineReason)` — the 12-26 groundwork already routes check-ins through the same `ComparisonUnavailable` model as revenue.

**Assessment:** contract is correct and complete for lifetime attendance. Nothing here needs to change for the implementation phase.

---

## 4. Definition of "checked in"

Source of truth: `registrations/{id}.checkedInAt` (Timestamp, present ⇒ admitted). Set in `checkInRegistration` (`registrations.ts:~700-760`) inside `adminDb.runTransaction`, guarded by `checkInBlockReason` (`lib/registrations/checkinEligibility.ts`) which is the ONE canonical check-in validator (Registrations GA close).

In the same transaction:

1. `writeCheckinDelta(txn, eventSlug, registrationId, passId, +1)` → attendance shard.
2. `stageDailyStatsIncrement(txn, organizerUid, eventSlug, Date.now(), { action: 'checkin' })` → IST daily rollup, `checkedIn: +1`.

After the transaction (awaited, best-effort): `appendCheckinHistorySafe({ action: 'CHECK_IN', … })`.

**Analytics reads it as** `base.orderBy('checkedInAt','desc').count()` (`aggregateRegistrationStatusCounts`) — a zero-document aggregate on the deployed `(organizerUid, eventSlug, checkedInAt DESC)` index. `status` is not a filter.

**Consequence (F-1):** a registration cancelled *after* admission keeps its `checkedInAt` (cancellation does not touch it — verified `registrations.ts` cancel path writes `status`, counters, refunds only) and remains in the numerator, while it leaves the `confirmed` denominator. This is the only realistic producer of `over`. The contract JSDoc already says "unclamped"; the model already names the state. F-1 is a documentation condition, not a code change.

---

## 5. Undo / correction semantics

`unCheckInRegistration` (`registrations.ts:~800-845`):

- Transactional; captures the outcome INSIDE the transaction from the pre-state.
- Idempotent: a registration with no `checkedInAt` returns a no-op outcome and writes nothing.
- `checkedInAt`, `checkedInBy`, `checkedInSource` → `FieldValue.delete()`.
- `writeCheckinDelta(…, −1)` on the **same shard** as the admission.
- `stageDailyStatsIncrement(…, Date.now(), { action: 'undo_checkin' })` → `checkedIn: −1` on **today's** key (`dailyStats.ts:199-200`).
- History: `UNDO_CHECK_IN` appended best-effort.

**F-2:** cross-day undo produces a −1 on the undo day. `byDay` sums remain exact; individual days can be negative. The Arrivals chart (`OperationsAnalytics.tsx` section 2) draws `byDay.checkedIn` directly. The implementation phase should either (a) floor the rendered per-day value at 0 with a footnote, or (b) accept and document. Recommend (b) with a single JSDoc line on `OperationsAnalytics.byDay` — changing rollup attribution retroactively is not possible and a floor hides a true correction.

---

## 6. Counter architecture (attendance shards)

- `registrationCounters/{slug}` holds `totalCount` (confirmed), `passCounts`, `revenuePaise`, `checkedInCount`, `passCheckedInCounts`.
- Check-in deltas go to `registrationCounters/{slug}/attendanceShards/{n}` (GA-5 S3) and are folded by `foldAttendanceShards`. The base doc's own `checkedInCount` is **never authoritative alone** — RD-DASH-11 found 0 vs 288 real check-ins because a caller read around the fold.
- Dashboard: `resolveCheckInFromCounters` (`checkInStatusAdmin.ts:69-105`) folds once per slug, and `shards === null` ⇒ `state: 'unavailable'`, never 0.

**F-5:** Analytics does not use the shard fold; it uses the `checkedInAt` aggregate. The two are written atomically together, so they agree unless a shard write is lost while the document write lands (impossible inside one transaction) or a reconciliation rewrites one side. `lib/reconciliation/events.ts` reconciles registration counters from the ledger; whether it recomputes `checkedInCount` from `checkedInAt` was not verified and is listed as an open check in §24. Not a blocker: Analytics reads the document truth directly.

---

## 7. Daily rollups and time zone

- `organizerDailyStats` keyed `{uid}__{slug}__{dayKey}`; `dayKey` uses `REPORTING_TZ_OFFSET_MINUTES = 330` (IST). Written in the check-in transaction.
- Analytics `byDay` = `readDailyStats(organizerUid, eventId, trendKeys)` with coverage via `readCoverage` / `resolveCoverage` (`eventAnalytics.ts:568-572`) — partial history is disclosed, not drawn as zero.
- `checkedInAt` is a UTC instant. Any hour-of-day or "arrivals today" derived from it must bucket in IST using `istRangeBounds` (12-26) / `dayKey`, **not** `lib/reports/format.rangeBounds` (UTC). The dashboard `todayCheckins` already does this correctly (`dashboard/route.ts:978-990`, `checkedInAt >= todayStart` with IST `todayStart`).

Event-timezone vs reporting-timezone: registrations trend mode buckets by **event** timezone; rollups bucket by **reporting** (IST). For an India-first product these coincide in practice; the contract should say which one arrival-by-hour uses (recommend IST to match `byDay`).

---

## 8. Capacity

`capacity = typeof ev.totalCapacity === 'number' ? ev.totalCapacity : null` (`eventAnalytics.ts:532`); panel absent when unconfigured. `usedPct` unclamped; `remaining = configured − confirmed`, negative when oversubscribed; `over` flag → warning colour and "N over the configured capacity" copy (`OperationsAnalytics.tsx:147-168`).

Per-pass capacity: `passCounts` are now nested maps (counter dotted-key fix, 2026-08-11); historical per-pass counts before that date are lost. A per-pass capacity panel in the implementation phase must treat pre-fix events as unmeasured for per-pass figures, not zero.

Capacity `confirmed` deliberately excludes `pending` and `waitlisted` (contract §"venue capacity and a waitlist threshold are different things", `contract.ts:249`). Correct.

---

## 9. Waitlist interaction

`waitlisted` comes from status counts (`eventAnalytics.ts:672`); the waitlist panel (section 4 of the UI) renders only when `registrationForm.registrationRules.waitlistEnabled` (canonical setting) and rules were readable ("one whose rules cannot be read shows no waitlist", `eventAnalytics.ts:256`). Platform-wide `WAITLIST_ENABLED=false` means no queue is joinable today, so the panel is inert in production. No finding.

---

## 10. Identifier and timing panels (conditional capabilities)

`operationsSources.ts` — `OperationalCapabilities { identifiersEnabled, identifierLabel, timingEnabled, timingLabel }`, gated on `identifierConfigs/{slug}.enabled` and `tagMapping.enabled` (configuration, not `eventType`). A failed capability read yields `NO_OPERATIONAL_CAPABILITIES` → panels **absent**, never zero — matches the identifier read-model rule ("a failed read is NEVER 0").

Identifier progress: `count()` on `hasIdentifier == true/false`; `unassignedEligible` remains UNKNOWN by design. Labels print verbatim (never lower-cased). Timing readiness via `resolveCredentialReadiness({eligible, identified, mapped})` (`timingTags.ts:515`) → ready / needsTag / needsIdentifier. The BIB → Timing Chip invariant is untouched and out of scope.

No finding.

---

## 11. Check-in readiness (pre-event)

`lib/checkin/readiness.ts`: `CheckinBlockedReason = 'not_found' | 'not_published' | 'no_slug' | 'not_accepting'`; `resolveCheckinReadiness` is the ONE resolver; `isEventOpenForCheckin` derives from it. `CHECK_IN_LIFECYCLES` in `checkInStatusAdmin.ts` mirrors `lib/eventSetup/registry` and is pinned by test.

Implementation opportunity (not a defect): an Operations "readiness strip" (published? credentials assigned? staff invited? capacity set?) can be composed from `resolveCheckinReadiness`, `resolveCredentialReadiness`, and `publishRequirements` (remember: `.filter(r => !r.passed)` — the evaluator returns all 12). No new read paths are needed.

---

## 12. Arrival timeline (hour-of-day) — feasibility

Two candidate sources:

| Source | Index | Cost | Completeness |
|---|---|---|---|
| `registrations.checkedInAt` range `count()` per hour | `(organizerUid, eventSlug, checkedInAt DESC)` — **deployed**, used by dashboard | 24 aggregates per day, 0 documents | Authoritative (undo deletes the field ⇒ excluded) |
| `checkinHistory` collection-group, `action == 'CHECK_IN'` by `occurredAt` | needs `(eventSlug, action, occurredAt)` — **not declared**; `(eventSlug, occurredAt DESC)` declared but deployment unverifiable | 24 aggregates per day | Best-effort (F-3); includes undone admissions unless paired |

**Constraint F-4:** build on `checkedInAt`. This phase may not touch `firestore.indexes.json`, and the history route would also need index deployment, which this workstream cannot perform. Window the aggregates to the event day(s) only — for a multi-day event, `days × 24` aggregates is acceptable; for a lifetime range it is not, so the timeline must be scoped to the selected window, not the event lifetime.

---

## 13. Staff and operator data

`lib/team/types.ts`: `TeamRole = owner | admin | manager | checkin_staff | checkin_lead | finance`; permissions matrix is the SSOT; `isCheckinOnlyRole` is derived from the matrix. `teamMembers` rows carry role, status, `eventIds` (non-empty for staff); no credentials are stored or readable. Registrations carry `checkedInBy`, `checkedInSource`; history carries `operatorUid`, `method`.

**F-7:** a per-operator leaderboard is technically derivable and should not be built. Acceptable aggregates: check-ins by **method** (`qr` / `search` / `walkin` / `bulk`) — an operational signal about the gate, not about people. No permission changes (brief constraint honoured).

---

## 14. Authorization

`app/api/organizer/analytics/[eventId]/route.ts`: `authorizeAnyWorkspace` (gate roles → 403 via `isCheckinOnlyRole`), `resolveAnalyticsEventIdentity`, denied when `identity.organizerUid !== authz.workspaceUid || !requireEventScope(...)`. Operations data carries no money, so it is **not** behind `transactions`; `financeAllowed` gates only the financial block. Pinned by `analyticsAuthorization.test.ts` and `organizerAnalyticsAuthorization.test.ts`.

No PII enters the contract: attendance, capacity, identifier and timing panels are counts and labels only. Any new operations field must keep that property (no names, no emails, no bib lists).

---

## 15. Failure handling

Every read in the operations path is `.catch(() => null)` → `Count = null` → UI renders "unmeasured", never 0. Capabilities failure → panels absent. Rollup failure → `byDay` unavailable with coverage disclosure. Dashboard shard failure → `state: 'unavailable'`. This is the same discipline the revenue work converged on, already in force here.

The one asymmetry (F-3): history append failure is logged and swallowed. Correct for the admission path (an operator must not be blocked by a timeline write) and precisely why history cannot be a counting source.

---

## 16. Absent vs zero vs unavailable — operations encoding

| Situation | Encoding | Surface |
|---|---|---|
| Panel not configured (no capacity, identifiers off, timing off, waitlist off) | key **absent** | panel not rendered |
| Configured, measured zero | `0` | rendered as 0 |
| Configured, read failed | `null` | "unmeasured" |
| Capability read failed | all conditional keys absent | panels not rendered (honest: we don't know they're configured) |

This differs from the Dashboard revenue lock (`0 + revenueUnavailable: true`) and that is fine: Operations has no entitlement dimension, so `null` alone is unambiguous. Do not import the `revenueUnavailable` flag pattern here.

---

## 17. Consistency across surfaces

| Surface | Check-in source | Denominator | Agreement |
|---|---|---|---|
| Analytics Operations | `count()` on `checkedInAt` | `status == confirmed` count | canonical |
| Dashboard Check-in card | shard fold `checkedInCount` | counter `totalCount` (confirmed) | equal by construction (same txn) |
| Dashboard `todayCheckins` | `count()` on `checkedInAt >= IST todayStart` | `totalRegistrations` (share) | different denominator **by design** (share of all registrations, documented `dashboard/route.ts:574-580`) |
| Reports page | no check-in metric | — | n/a |
| Event360 (admin) | `checkedInCount` via counter | — | admin-only; same fold expected (§24 open check) |
| Registrations tab `stats` | shard-folded counter | — | same fold |

No contradiction. `todayCheckinShare` ≠ attendance `pct` and the two are labelled differently; implementation must not present them side-by-side as the same "rate".

---

## 18. Scale

- Analytics: fixed number of aggregates regardless of registration count; no document scans. Adding hour buckets adds ≤ 24 × days aggregates (§12).
- Check-in screens: recent window is 20 docs; lookup is indexed (Check-in 2.0). Unaffected.
- History read: `MAX_HISTORY_ENTRIES = 50` per registration, single-field order, no composite index.
- Daily rollups: one doc per event-day.

No scale finding.

---

## 19. Tests in force

`analyticsOperations.test.ts` (38), `attendance.test.ts`, `checkinCounterSource.test.ts`, `checkinHistoryRead.test.ts`, `checkinUndoPermission.test.ts`, `checkinStaffLeastPrivilege.test.ts`, `dashboardCheckInStatus.test.ts`, `operationsReadiness.test.ts`, `analyticsUnavailable.test.ts`. Pins observed: unclamped pct, negative `awaited`, `over` state, absent-not-zero panels, gate-role 403, shard-fold-only counter reads, idempotent undo, history ordering.

Implementation must add pins for: IST hour bucketing of `checkedInAt`, window-scoped (not lifetime) arrival aggregates, cross-day undo `byDay` documentation (F-2), and "no per-operator ranking" contract discipline (F-7) — source-assertion style, matching `revenueIntelligence.test.ts` contract-discipline cases.

---

## 20. Comparisons

`period.checkedIn` vs baseline already flows through `compareMetric` with `coveragePartial` / `baselineOutsideCoverage`. Event-to-event comparison remains unwired (`mode: 'event'` declared, engine takes boolean) — same deferral as 12-26; do not open it in the operations phase.

---

## 21. No-show

Not defined (F-6). Prerequisite for a true no-show metric is an event-end instant (`ev.endAt` or last session end for conferences) after which `awaited` freezes. That is an event-model decision, not an analytics one. Until then: keep "Awaiting arrival" wording; never "no-show".

---

## 22. Risk register for the implementation phase

| Risk | Mitigation |
|---|---|
| Building arrivals on `checkinHistory` | Forbidden by F-3/F-4; use `checkedInAt` |
| UTC bucketing of `checkedInAt` | `istRangeBounds` / `dayKey` only |
| Lifetime hourly aggregates on long-running events | Window-scoped only |
| Presenting `todayCheckinShare` as attendance rate | Distinct labels; no shared component |
| Per-operator metrics | Method-level only |
| Reading base counter `checkedInCount` without the fold | Use `foldAttendanceShards` / existing route data |
| Zeroing a failed read | `null` → "unmeasured" |
| Touching `firestore.indexes.json` | Out of scope; design within deployed indexes |

---

## 23. What the implementation phase (RD-12-28) may build

Within existing reads and indexes:

1. **Arrival curve** — hour-of-day check-ins for the selected window via `checkedInAt` range `count()`s, IST-bucketed, with an "unmeasured" bucket on failure.
2. **Check-ins by method** — from `checkedInSource` (`count()` per method value; index need must be checked — `(organizerUid, eventSlug, checkedInSource)` is not confirmed deployed, so this may have to come from the attendance shards if they carry it, otherwise defer).
3. **Readiness strip** — composed from the three existing resolvers (§11).
4. **Attendance intelligence rows** — arrival rate per hour (velocity analogue), peak hour, time-to-50 %: all pure functions over (1), following `revenueIntelligence.ts` (pure module + `basis` literal per row).
5. **JSDoc conditions** — F-1 population note on `AttendanceAnalytics.pct`; F-2 note on `byDay`.

Not to build: no-show, per-operator ranking, event-to-event comparison, any history-derived count, any index or rules change, any Check-in screen change.

---

## 24. Open checks (non-blocking)

1. Whether `lib/reconciliation/events.ts` recomputes `checkedInCount` from `checkedInAt` (affects Dashboard card only; Analytics unaffected).
2. Whether Event360 reads the shard fold or the base doc (admin surface; outside organizer analytics).
3. Whether an index exists to aggregate by `checkedInSource` (needed only for §23 item 2).

---

## 25. Compliance

- Only file created: `docs/RD-ANALYTICS-12-27-OPERATIONS-ATTENDANCE-AUDIT.md`.
- No source, test, rules, index, workflow, or config edits. No commit, push, deploy, emulator seeding, or build.
- No Check-in rebuild, no R2 scanning, BIB → Timing Chip invariant unchanged, staff permissions unchanged.
- Concurrent auth/login workstream untouched.
- Dashboard revenue contract (`confirmedRevenuePaise = 0`, `revenueUnavailable = true`) unchanged.

---

## 26. Final verdict

**APPROVED WITH CONDITIONS.**

Conditions carried into RD-12-28:

- C-1 Arrival analytics derive from `registrations.checkedInAt` aggregates only, IST-bucketed, window-scoped (F-3, F-4).
- C-2 Document the numerator/denominator population mismatch on `AttendanceAnalytics.pct` and the cross-day undo attribution on `byDay` (F-1, F-2) — JSDoc only.
- C-3 No no-show metric, no per-operator metric, no history-derived counts (F-6, F-7).
- C-4 Every new operations figure is `Count` with `null` on failure, panels absent when unconfigured; source-assertion tests pin C-1 and C-3.

STOP. Awaiting the audit completion report before any implementation.
