# RD-ANALYTICS-10 — Operations Intelligence

**Status:** implemented, gated, browser-validated.
**Date:** 2026-09-06
**Scope:** operational analytics only. No communications, participants, revenue, reports,
route migration, payment, check-in-architecture or schema change.

> **Note on the brief.** The instructions arrived truncated mid-sentence in §18. The missing
> sections were confirmed afterwards to leave the approved direction unchanged, and this
> phase follows the RD-ANALYTICS-08/09 conventions for QA, documentation and the final
> report.

---

## 1 · Audit findings

### 1.1 Check-in / attendance sources

Two exist, and they are for different jobs:

| source | what it is | cost |
|---|---|---|
| `aggregateRegistrationStatusCounts(...).checkedIn` | `count()` over `registrations` ordered by `checkedInAt` — Firestore excludes documents missing the field, so this counts exactly the checked-in | 1 aggregate, **0 documents** |
| `registrationCounters/{slug}.checkedInCount` + `attendanceShards/*` | the sharded write path the gate scanner increments | O(shards) document reads |

The producer already uses the first. That is the right choice for analytics: it is exact,
transfers nothing, and cannot drift from the registration status counts it is published
beside — they come from the same aggregate call. The sharded counter exists because gate
scanning is a mass-burst write path, and it is the operational hot path's concern, not this
module's.

**Canonical for Operations analytics: `aggregateRegistrationStatusCounts`.**

### 1.2 Daily check-in rollups — they exist

`organizerDailyStats` carries `checkedIn` per day (`DailyStatsDoc.checkedIn`, "Check-ins
recorded on this day"), written by the same lifecycle delta path as `confirmed` and
`revenuePaise`. The producer already reads it as `checkInsByDay`, already clips it at the
coverage floor, and already sums it into `period.checkedIn` / `baseline.checkedIn`.

So §5's question is answered: **a reliable daily check-in trend already exists and needs no
new read.** No scan is required and none will be built.

### 1.3 What the contract already publishes

```ts
export interface OperationsAnalytics {
  checkedIn:     Count
  attendancePct: Count      // checked in ÷ confirmed, null when either is unmeasured
  byDay: { date: string; value: number }[] | null
}
```

…plus `overview.checkedIn`, which is already a `ComparedMetric` (period vs preceding
period, with the RD-07 reason codes). The universal half of Operations is therefore mostly
present; what is missing is the operational framing, the capacity module, and the
conditional sections.

### 1.4 Capacity — one explicit source, and two clamps worth naming

`events/{slug}.totalCapacity`, read once by the producer. Explicitly configured; null when
absent. It is NOT a registration-category maximum, a venue capacity or a waitlist threshold,
and nothing in the analytics path treats those as interchangeable.

Two derivations already clamp, and neither says so:

```ts
capacityUsedPct = capacity > 0 ? Math.min(100, Math.round((confirmed / capacity) * 100)) : 0
remaining       = Math.max(0, capacity - confirmed)
```

* **`capacityUsedPct` is capped at 100 in the PRODUCER.** An oversubscribed event cannot
  report 104% anywhere downstream, even though `CapacityMeter` was written to display the
  true figure while clamping only the bar's width. The clamp is in the wrong layer.
* **`remaining` is floored at 0**, so an over-capacity event shows "0 places remaining"
  rather than a data-quality state.

Both are pre-existing. §8 requires that such clamps not be silent, which makes this a
finding rather than a design.

### 1.5 The over-attendance case §8 asks about

`attendancePct = checkedIn ÷ confirmed` is **not** clamped, so 1,050 of 1,000 confirmed
yields 105%. That is arithmetically honest and operationally suspicious: it means people
were admitted who are not counted as confirmed (a cancellation after check-in, a walk-in, a
reconciliation gap). "Remaining expected attendees" — confirmed − checkedIn — would be
negative, which is exactly the display §8 forbids. This needs an explicit data-quality
state rather than a clamp.

### 1.6 BIB / identifier capability — canonical source

`identifierConfigs/{eventSlug}`:

* `.enabled` — whether this event issues identifiers at all;
* `.label` — what this event **calls** them. Configuration, not a constant: "Bib", "Badge",
  "Token", "Volunteer number". It prints verbatim; the word "BIB" is not universal.
* `.tagMapping.enabled` — the timing-chip capability. **Absent ⇒ off**, so every event that
  predates the feature has it off with no migration.
* `.tagMapping.label` — defaults to "Timing Chip", overridable per event.

`fetchIdentifierUsage` reads assignment state entirely through `count()` aggregates bounded
by the CONFIGURATION (pools × states), plus per-pass equality aggregates and a few counter
documents — **zero documents transferred**, and independent of participant volume. It also
yields the exact three-way split (`hasIdentifier` true / false / absent) on the registration
side, so "how many still have no number" is a real figure rather than a lock-minus-roster
subtraction across collections.

Timing chips have the same shape: `identifierTagLocks` carries `eventSlug` and `state`, so
assignment progress is a bounded `count()` per state.

### 1.7 **DEFECT — Analytics infers timing capability from event type**

```ts
{ key: 'timing', label: 'Timing & finishers', module: 'operations',
  gateKey: 'identifiers', eventTypes: ['sports'] },
{ key: 'identifiers', label: 'Identifiers', module: 'operations', gateKey: 'identifiers' },
```

This is precisely what §3 forbids. Two problems:

1. **`eventTypes: ['sports']` is event-type inference.** A sports event with timing switched
   off would still be offered a timing panel; a non-sports event that genuinely uses timing
   chips — the feature is configuration, not a taxonomy — would never be.
2. **The `identifiers` panel gates only on the workspace feature flag and team permission**,
   never on `identifierConfig.enabled`. An event that has never configured identifiers is
   still offered the panel.

`lib/events/eventCapabilities.ts` documents why the event tab bar could not do better —
the config "lives in `identifierConfigs/{slug}`, again a read", and the tab bar must not
make one. **An analytics request is a different situation**: it already reads
`events/{slug}` and issues a dozen aggregates, so one more document is affordable where a
tab-bar render is not.

This is the central correction of the phase.

### 1.8 Waitlist

`eventHasWaitlist(registrationRules)` via `resolveWaitlistSettings` is the one reader, and
`ANALYTICS_PANELS` already gates the waitlist panel on it. `registrations.waitlisted` is a
count aggregate already in the contract. Note the platform-level switch: the waitlist
feature is gated off product-wide, so on most events this resolves to absent.

### 1.9 Staff / check-in operations

`checkinHistory` is append-only and has no aggregate form. Per §11 this is **not**
implemented: producing per-staff throughput would require scanning it, and the result would
be a surveillance dashboard rather than an operations aid.

### 1.10 Existing operational surfaces

`AnalyticsOverview` shows a "Checked in" rail metric with attendance percentage; the
Attendance/Check-in workspace is the operational surface (find + admit) and is out of scope.
`components/analytics/overview/Primitives.tsx`, `TrendPanel`, `useAnalyticsScope` and
`ModuleChrome` are all reusable as-is.

### 1.11 Range, comparison, coverage

Unchanged and reused: 7/30/90 presets, `previousPeriod` + `compareMetric`, and the
`coverageSince` / `coveragePartial` / `baselineOutsideCoverage` model.

### 1.12 Raw scans

None in the analytics path. Every operational figure identified above is a `count()`
aggregate, a rollup `getAll`, or a single configuration document.

### 1.13 Duplicate operational aggregation

None found. Attendance is derived in exactly one place (`normalize.ts`, `pct(checkedIn,
confirmed)`), and the identifier read model is the single owner of assignment state.

---

## 2 · What this audit implies for the build

| § | requirement | answer |
|---|---|---|
| 4 | attendance without a scan | already available; `checkedIn ÷ confirmed`, null-safe |
| 5 | check-in trend | **supported** by `organizerDailyStats.checkedIn`; no new read |
| 7 | previous-period comparison | already computed as `overview.checkedIn` |
| 8 | "remaining" must never be negative | needs a data-quality state, not a clamp (§1.5) |
| 9 | capacity | one explicit source; the producer's clamps must move or be declared (§1.4) |
| 10 | timing / BIB | bounded `count()` readers exist; capability must come from `identifierConfigs`, not event type (§1.7) |
| 11 | staff metrics | **deferred** — would require scanning `checkinHistory` |
| 12 | waitlist | gated on the organizer's switch, already modelled |
| 18 | performance | one extra configuration document; everything else is aggregates already paid for |

---

## 3 · The fixture defect that blocked browser QA

The twelve matrix events were published in Firestore, resolvable by slug, and served
correctly by the API — and completely absent from the event selector, so every page
rendered "Select a single event" and every capability assertion tested a placeholder.

**Cause.** `/api/organizer/events` lists drafts with `orderBy('updatedAt', 'desc')`.
**Firestore excludes documents that do not carry the ordered field** — the same semantic the
codebase already relies on deliberately when it counts check-ins with `orderBy('checkedInAt')`.
The fixture seeds never wrote `updatedAt`, so the list could not see them:

```
total drafts: 14
a10-sports-both-draft          updatedAt=MISSING
…
profiling-draft-event          updatedAt=2026-01-01T00:00:00.000Z
visible to orderBy(updatedAt): 1
```

This is fixture plumbing, not a product bug. The production query is correct and every
real write path stamps `updatedAt`; only the hand-written seeds omitted it. **No production
code was changed to accommodate the fixtures.**

### Two further fixture defects found while fixing it

**`rd-analytics-06-seed.mjs` — `findDraftId() → docs[0]`.** It took the first document of
an unordered five-document page. With only the emulator seed's draft present that was
right, so the defect stayed invisible for four phases. Once RD-ANALYTICS-10 added drafts
beginning `a10-`, `docs[0]` became one of those: the seed published the marathon **on top of
an unrelated fixture event** and left the real draft unpublished, corrupting both. Pinned to
the known id, with a hard failure if it is missing — seeding the wrong event is worse than
not seeding, because the run still looks green.

**A transposed constant, revealed by that pin.** `DRAFT` read `profiling-event-draft`; the
emulator seed writes `profiling-draft-event`. The `docs[0]` fallback had been silently
covering for it. Fixed.

**`rd-analytics-08-staff.mjs` — the same `docs[0]` pattern.** The gate credential was being
scoped to an arbitrary event, which would have let the check-in-staff refusal be attributed
to SCOPE rather than to the missing `events` permission. Pinned the same way.

### Files changed (test/seed infrastructure only)

| file | change |
|---|---|
| `scripts/qa/rd-analytics-10-seed.mjs` | stamps `updatedAt` per event (deterministic order); clones a renderable base draft |
| `scripts/qa/rd-analytics-06-seed.mjs` | stamps `updatedAt`; `findDraftId` pinned by id and fails loudly; `DRAFT` constant corrected |
| `scripts/qa/rd-analytics-08-staff.mjs` | event assignment pinned by id |

After the fix: **`visible to orderBy(updatedAt): 14`**.

## 4 · Implementation

| file | change |
|---|---|
| `lib/analytics/modules.ts` | `timing` panel loses `eventTypes: ['sports']`; `identifiersEnabled` / `timingEnabled` added to the module context and checked independently |
| `lib/analytics/operationsSources.ts` | **NEW.** `resolveOperationalCapabilities` (one config document), `readIdentifierProgress` / `readTimingProgress` (`count()` only) |
| `lib/analytics/eventAnalytics.ts` | capability document resolved in the existing parallel read; conditional progress reads; **capacity clamps removed** |
| `lib/analytics/contract.ts` | `AttendanceAnalytics`, `CapacityAnalytics`, `IdentifierAnalytics`, `TimingAnalytics`; conditional sections ABSENT when unsupported |
| `lib/analytics/normalize.ts` | maps them; attendance unclamped with an explicit `over` |
| `lib/analytics/operationsModel.ts` | **NEW, pure.** `readAttendance` (three states), `readCapacity` (bar clamp only), `readIdentifiers`, `readTiming`, `operationalPanels` |
| `components/analytics/operations/OperationsAnalytics.tsx` | **NEW.** The module |
| `app/(dashboard)/dashboard/analytics/operations/page.tsx` | **NEW** route |
| `app/api/organizer/analytics/overview/[eventId]/route.ts` | forwards the producer's capabilities into module gating |

## 5 · The capacity fix

```ts
// before — the clamp destroyed the measurement at its source
capacityUsedPct = capacity > 0 ? Math.min(100, Math.round((confirmed / capacity) * 100)) : 0
remaining       = Math.max(0, capacity - confirmed)

// after — the figure is the measurement; only a bar's WIDTH may clamp
capacityUsedPct = capacity > 0 ? Math.round((confirmed / capacity) * 100) : 0
remaining       = capacity - confirmed
```

`CapacityMeter` was already written on the correct assumption and said so in its own
comment. The clamp now lives in `readCapacity().barPct`, the one place it belongs.
Capacity is ABSENT entirely when the event configured none.

## 6 · The over-attendance fix

`attendancePct` is unclamped and `awaited` may go negative, with `over` distinguishing the
state. `readAttendance` resolves three cases — `unmeasured`, `normal`, `over` — and the UI
changes what its fourth cell says rather than showing a misleading "0 remaining".

Rendered, for 120 admitted against 100 confirmed:

> **ATTENDANCE 120%** · **ABOVE CONFIRMED 20** — *More admitted than confirmed*
> *20 more checked in than confirmed. Attendance above 100% usually means someone was
> admitted whose registration was later cancelled, or a walk-in was recorded outside the
> confirmed roster.*

## 7 · Browser QA — the mandatory matrix, in the rendered UI

| case | panels rendered | labels | result |
|---|---|---|---|
| **A** Sports + identifiers + timing | both | Bib · Timing Chip | ✓ |
| **B** Sports + identifiers only | identifiers | Bib | timing absent ✓ |
| **C** Sports + neither | none | — | both absent ✓ |
| **D** Conference + identifiers + timing | both | **Badge · Transponder** | no sports assumption ✓ |
| **E** Exhibition + timing only | timing | Wristband | identifiers absent, **capacity absent** (uncapped) ✓ |
| **F** Over-attended | none | — | **120%**, "Above confirmed 20", explained, no clamp ✓ |

Plus workshop (Token), cultural, fundraising, meetup, community, awards — all five reporting
`panels=none`, universal analytics present.

| check | result |
|---|---|
| 1440 / 834 / 390 | no horizontal overflow at any viewport |
| owner | full module |
| manager (`events`, no `transactions`) | module renders; endpoint 200; no `Paise`/`revenue`/`profitEstimate` |
| checkin_staff | endpoint **403** on a direct probe with their own bearer |
| unauthorized | redirected to login; anonymous probe **401** |
| 7D / 30D / 90D | windows report 7 / 30 / 90 days |
| empty event | measured zeros, no capacity module, no credential panels |
| partial coverage | disclosed with a date |
| console errors | none |
| sports vocabulary where capability absent | none — asserted across all eleven events |
| financial data in Operations | none |

Absence is asserted, not just photographed: every event is checked against **all six**
credential nouns any fixture uses, so a panel leaking from one event to another fails.

## 8 · Known limitations

1. **Staff analytics deferred.** Per-staff throughput would require scanning the append-only
   `checkinHistory`, which has no aggregate form — and the result would be a surveillance
   dashboard rather than an operations aid.
2. **Waitlist is platform-gated off**, so its panel resolves absent on essentially every
   event. The gating is implemented and tested; the surface is not exercisable today.
3. **Timing attachment is measured against the confirmed roster**, not against a
   participation list — the platform has no "expected to be timed" population distinct from
   confirmed registrations.
4. **`unrecorded` identifiers** (registrations predating the `hasIdentifier` field) are
   reported as their own state rather than resolved; resolving them needs a backfill.
5. **The conditional reads cost aggregates bounded by configuration** (pools × states), not
   by participants. An event with an unusually large pool count pays proportionally.
6. **The workspace-wide dashboard adapter** publishes the attendance snapshot but no
   capacity or credential sections — it has no per-event capability document.
