# RD-ANALYTICS-12-21 — Revenue State Contract Design & F1 Fix

> **Filename note.** The brief asked for `docs/RD-ANALYTICS-12-21-IMPLEMENTATION.md`, but that
> file already exists and records the completed Analytics contract-alignment phase. Overwriting a
> delivered record would destroy history, so this work is written alongside it. The audit this
> phase implements is likewise in `RD-ANALYTICS-12-20-REVENUE-STATE-AUDIT.md`, beside the
> alias-removal record it shares a number with.

---

## F1 · Root Cause

`app/api/organizer/dashboard/route.ts`, in the `DashboardEvent` mapping:

```ts
revenuePaise: financeAllowed ? (slug ? (revBySlug.get(slug) ?? 0) : 0) : null,
```

`revBySlug` is `Map<string, number | null>`, and **`null` there means UNMEASURED** — written
that way deliberately by the self-healing aggregate's `.catch(() => null)`, whose own comment
records that the previous `.catch(() => 0)` *was* the bug. But `null ?? 0` evaluates to `0`.

So a failed read was republished as a measured-looking **₹0**, and `DashboardEvent` had no flag
to say otherwise. The same response got it right one field over: `totalRevPaise` checks
`.some(v => v === null)` and correctly returns `null`. **One payload, two answers** — the KPI
said "unavailable" while the event row beneath it said "₹0".

The deeper cause is shape, not typo: a number plus an *optional* boolean cannot force a reader to
ask whether the number is real, so `?? 0` compiles cleanly and is wrong exactly in the failure
case.

## F1 · Fix

```ts
...toLegacyRevenueFields(revenueStateFromCounterMap(revBySlug, slug, financeAllowed)),
```

Both wire fields are now **derived from one `RevenueState`**, so they cannot contradict each
other. `DashboardEvent` gained `revenueUnavailable?: boolean` — the same additive flag
`/api/organizer/events` has carried since RD-EVENT-02 — and the one consumer was updated to
honour it (without that, the restored signal would have been discarded at the boundary).

Preserved exactly: the `transactions` gate, `totalRevPaise`'s existing correct behaviour,
workspace membership, event visibility, activity behaviour, and every other KPI.

## Current Revenue-State Contract

| State | `revenuePaise` | `revenueUnavailable` |
|---|---|---|
| measured value | the number | `false` |
| measured zero | `0` | `false` |
| **read failure** | `0` | **`true`** ← was `0`/`false` |
| unauthorized | `null` | `false` |

This is the platform's existing events-route encoding, so the dashboard became *consistent*
rather than novel.

## MaybeMoney Compatibility Analysis

Inspected at `lib/finance/gatewayFee.ts:21`, and answered against source rather than assumed:

| Question | `MaybeMoney` |
|---|---|
| 1 · measured positive revenue? | **Yes** — `{ok:true, paise}` |
| 2 · measured zero? | **Yes** — `{ok:true, paise:0}`, distinct from absence |
| 3 · unavailable / read failure? | **Yes** — `{ok:false, reason:'query_failed'}` |
| 4 · unauthorized / withheld? | **No** |

(4) is decisive. Analytics expresses denial by omitting its whole `financial` block — a
*block-level* answer. The Organizer contracts deny per **field**, inside a payload the caller is
otherwise entitled to receive, so the denial has to live in the value itself.

## Selected Canonical Model

**Option C — two explicit models, for the reason the brief allows it.**

```ts
export type RevenueState =
  | { ok: true;  paise: number }
  | { ok: false; reason: 'unavailable' | 'unauthorized' }
```

`lib/finance/revenueState.ts`, with `revenueMeasured` / `revenueUnmeasured` / `revenueWithheld`
constructors, the pure `revenueStateFromCounterMap` resolver, and `toLegacyRevenueFields` as the
single serializer.

### Why this and not the alternatives

- **Option A (reuse `MaybeMoney` unchanged)** — rejected: it cannot express authorization denial,
  which is one of the four states the whole exercise exists to keep separate.
- **Option B (extend `Unavailable` with an `unauthorized` member)** — rejected on scope and
  blast radius. `Unavailable` is consumed across Finance and Analytics; widening a shared union
  to serve one caller pushes a breaking change through modules this phase is explicitly forbidden
  to modify. It would also blur a type documented as "why a figure is missing" with "you may not
  ask", which is not a missing figure but a refused question.
- **Option C** — taken. Field-level denial and block-level denial are genuinely different
  architectures, exactly the condition the brief names.

**This is not a third overlapping type.** It replaces the Organizer's informal
`number + optional flag` convention with a real type; the count of models stays at two, and the
new one deliberately copies `MaybeMoney`'s `{ok, …}` shape so there is one narrowing idiom in the
codebase rather than two competing styles.

## Unauthorized vs Unavailable Semantics

Unchanged, and now structurally enforced:

- **unauthorized** — `null`, flag `false`. `null` already carries the denial; the flag stays
  false so it keeps meaning only "the platform failed", which it did not. The withheld amount
  never enters the response regardless of what the map holds (test 4 asserts the serialized
  output contains no trace of it).
- **unavailable** — `0` with the flag `true`. The zero is a placeholder the flag disowns.

The two never collapse into each other: test 6 asserts the states and their wire encodings are
distinct.

## Type Safety

`paise` exists only on the `ok: true` arm, so it is unreachable without narrowing — the compiler
now asks the question the convention merely hoped a reader would. The defect class
`unavailable → ?? 0 → measured zero` is unrepresentable in the new model, because there is no
way to produce a `0` that means "unmeasured".

`tsconfig` excludes `tests/` from `tsc`, so a `@ts-expect-error` in a test would prove nothing.
Test 7 therefore asserts the union's shape on the declaration itself — where the enforcement
actually lives — plus a runtime demonstration that the `ok:false` arm carries no `paise`.

## Migration Status

**Phase 1 complete. The broader migration is deliberately NOT done here.**

- `RevenueState` is the source of truth **inside the dashboard route**; the wire keeps its
  existing shape, derived.
- `/api/organizer/events` and `/events/[eventId]` still assemble the legacy pair by hand. They
  are correct today (their gate and flag were fixed in RD-12-17) but should adopt
  `toLegacyRevenueFields` so no contract hand-assembles the pair.
- The Dashboard's `revenuePaise` and the events routes' `confirmedRevenuePaise` remain two names
  for one quantity. Unifying them is a rename-class migration and belongs in its own phase.

## Backward-Compatibility Assessment

**No breaking wire change. No dual emit.**

`revenueUnavailable` is *additive and optional*, exactly as RD-EVENT-02 introduced it on the
events routes. A consumer that ignores it behaves precisely as before; one that reads it is
correct. There is no second representation of the same fact and therefore nothing that can
contradict — the forbidden combination (`canonical = unavailable` with `revenuePaise: 0` and
`revenueUnavailable: false`) is unconstructible, since both fields come from one state. Test 8
asserts that exhaustively across all four states.

The only *behavioural* change visible to a user: an unreadable event now shows "—" instead of a
false "₹0", and a total containing one refuses to present itself as exact. That is the fix.

## Changed Files

| File | Change |
|---|---|
| `lib/finance/revenueState.ts` | **new** — the canonical union, constructors, resolver, serializer |
| `app/api/organizer/dashboard/route.ts` | F1 fix at the emission site; `revenueUnavailable?` added to `DashboardEvent`; one import |
| `app/(dashboard)/dashboard/reports/page.tsx` | the sole consumer honours the restored signal — row renders "—", total refuses to sum a placeholder |
| `tests/unit/revenueState.test.ts` | **new** — 12 cases |
| `tests/unit/dashboardMoneyGate.test.ts` | the money-gate invariant re-pointed to the gate's new home |
| `tests/unit/registrationReportSources.test.ts` | predicate assertion updated to the stricter rule |

## Tests

12 new cases in `revenueState.test.ts`, covering every item the brief required:

1. authorized + positive → positive paise · 2. authorized zero → exactly `0`, explicitly measured ·
3. authorized + unavailable → **never coerced to 0** · 4. unauthorized → withheld, amount absent
from the serialized output · **5. the literal F1 reproduction** — `map(null)` may never produce
`{revenuePaise: 0, revenueUnavailable: false}`, asserted alongside the old expression to show what
it used to yield · 6. the two absences stay distinct · 7. narrowing required to reach `paise` ·
8. the derived fields cannot contradict, exhaustively · 9. unpublished/never-looked-up zeros stay
real · 10-12. the defect is gone from the route and honoured by its consumer.

**Two pre-existing tests were updated, neither weakened:**

- `dashboardMoneyGate` pinned the old inline ternary. The security property — per-event revenue
  is `null` for a restricted caller, never zero — is unchanged; the assertion now proves it at the
  gate's new home, in one pure function rather than inferred from the tail of a ternary.
- `registrationReportSources` pinned the exact `revenueKnown` string. The predicate became
  **stricter**, not looser: it withheld only permission-denied figures before and now also
  withholds unreadable ones.

## Verification Results

| Gate | Result |
|---|---|
| focused — `revenueState` | **12 passed** |
| dashboard + reports + revenue + analytics suites (24 files) | **1,037 passed** |
| **full unit suite** | **347 files — 9,372 passed, 1 skipped, 0 failed** |
| TypeScript | **PASS** — no output |
| ESLint — all 6 touched files | **PASS** — 0 errors, 0 warnings |
| production build | **PASS** — exit 0, compiled in 57s |
| emulator — `organizerDataBoundary` + `organizerAnalyticsAuthz` | **27 passed** |

The emulator run is meaningful here rather than incidental: `organizerDataBoundary.emu.test.ts`
imports and invokes the real dashboard `GET` with real tokens and seeded counters, so the changed
handler was exercised end to end.

**Emulator footnote, reported rather than glossed:** the first attempt failed at setup with
`ECONNREFUSED 127.0.0.1:9099` — 27 tests *skipped*, not failed. The local Auth emulator had died
while Firestore stayed up, and a full restart was refused because port 8080 was held by that
half-dead instance and killing it could have disrupted a concurrent session. Starting **only**
the Auth emulator restored the pair without touching the running Firestore, and the suites then
passed.

## Explicit Confirmations

- **No deployment performed** — nothing deployed to Vercel or Firebase.
- **No Firestore index changes** — `firestore.indexes.json` untouched.
- **No Firestore rules changes** — `firestore.rules` untouched.
- Not committed, not pushed. `git status --short` carries only this work plus pre-existing
  concurrent-session changes, none reverted.
- Untouched per scope: Admin, Reports architecture, Finance permissions, Analytics authorization,
  `MaybeMoney` itself, deployment/Vercel config, Check-in, Team/Staff, Print, WhatsApp/SMS,
  public event pages. No UI redesign; no unrelated field renamed.
- The build used an isolated `.next-a1221b`, since removed, with `tsconfig.json` restored
  byte-for-byte from a pre-build backup (valid JSON, 0 stray entries, the concurrent session's
  `.next-8c` entries intact).

## Remaining Migration Work

1. **Adopt `toLegacyRevenueFields` in the two events routes**, so no contract assembles the
   `revenuePaise`/`revenueUnavailable` pair by hand. Mechanical; they are already correct.
2. **Unify the two names** — Dashboard `revenuePaise` and events `confirmedRevenuePaise` are one
   quantity. Rename-class migration, own phase, dual-emit like RD-12-19.
3. **Decide whether `RevenueState` reaches the wire.** Today it is an internal source of truth
   serialized to the legacy pair. Publishing the union directly is the end state the audit
   pointed at, and it *is* a breaking change — it should be planned as one, not slipped in.
4. **Then retire the flag**, once no consumer reads the pair.
