# RD-ANALYTICS-12-25 — Dashboard Revenue Alias Removal (Implementation)

The deprecated `DashboardEvent.revenuePaise` alias is gone. Three source files changed, all
surgically. Not committed, not pushed, not deployed.

---

## A. Verdict

## IMPLEMENTED — SAFE FOR NEXT ANALYTICS PHASE

The alias is removed, the canonical field is the sole revenue name on the contract, the locked
absence contract is untouched, every unrelated `revenuePaise` survives, and all gates pass.

## B. Exact Changes

**Three files. Net −20/+9 lines in the route, plus four test adjustments.**

| File | Change | Purpose |
|---|---|---|
| `app/api/organizer/dashboard/route.ts` | removed the `revenuePaise` property and its `@deprecated` JSDoc from `DashboardEvent` | the type-level removal |
| ″ | removed `...toLegacyRevenueFields(revenue),` from the event mapping | the only emission |
| ″ | narrowed the import to `{ revenueStateFromCounterMap, toConfirmedRevenueFields }` | the now-unused name |
| ″ | reworded two comments that described "two names" / "the alias" | they described a state that no longer exists |
| `tests/unit/revenueState.test.ts` | **deleted Case J** | its whole purpose was to pin the temporary alias |
| ″ | case 10 and case E repointed to the canonical spread; case E gained two absence assertions | same properties, new shape |
| ″ | `wire()` helper reduced to `toConfirmedRevenueFields`; cases A/B/C/D/E2 dropped their alias comparisons | the helper must mirror what the route emits |
| `tests/unit/dashboardMoneyGate.test.ts` | one assertion repointed from `revenuePaise:` to `confirmedRevenuePaise:` in the type | the invariant is unchanged; the field it names was renamed |

**No other file was touched.** `lib/finance/revenueState.ts` retains its 10 Sep 15:13 timestamp —
the serializer was not modified.

## C. Alias Proof

Verified after the edit, per the audit's §8 checks:

| Check | Result |
|---|---|
| **A** · `DashboardEvent.revenuePaise` type declaration | **0** occurrences |
| **B** · legacy emission in the dashboard route | **0** — `toLegacyRevenueFields` no longer appears in the file at all |
| **C** · runtime reads of `DashboardEvent.revenuePaise` | **0** |
| **D** · dynamic/bracket access | **0** |
| **E** · unrelated `revenuePaise` fields preserved | **all present** |

Three matches remain for the read-pattern search, and **none is a `DashboardEvent`**:

- `admin/organizers/[organizerUid]/PageClient.tsx:370` — an **Organizer360** event row
- `lib/admin/organizer360Service.ts:359` — the same Organizer360 rollup
- `lib/firebase/firestore/registrationCounters.ts:257` — the **persisted Firestore write**

`tsc` passing is independent confirmation: the removed property was *required*, so any surviving
`DashboardEvent` read would have been a compile error.

**Unrelated quantities, occurrence counts unchanged:**

| File | `revenuePaise` count | Concept |
|---|---|---|
| `lib/dashboard/dailyStats.ts` | 15 | day-attributed rollup |
| `lib/analytics/normalize.ts` | 7 | windowed period revenue |
| `lib/firebase/firestore/registrationCounters.ts` | 4 | **persisted Firestore key** |
| `features/media-credits/utils/platformTotals.ts` | 5 | media-credit platform income |
| `lib/admin/organizer360Types.ts` | 2 | platform licence income |
| `lib/admin/event360Types.ts` | 1 | Admin counter-only revenue |

## D. Serializer Proof

**`toLegacyRevenueFields` was NOT deleted, and its implementation was not touched.**

The audit flagged this as the trap: after removal the function has **zero production importers**,
which makes it look dead — but `toConfirmedRevenueFields` still calls it internally:

```ts
export function toConfirmedRevenueFields(s: RevenueState): ConfirmedRevenueFields {
  const { revenuePaise, revenueUnavailable } = toLegacyRevenueFields(s)   // ← still the encoder
  return { confirmedRevenuePaise: revenuePaise, revenueUnavailable }
}
```

Deleting it would have broken `/api/organizer/dashboard`, `/api/organizer/events` and
`/api/organizer/events/[eventId]` simultaneously. Its `export` status was also left alone: the
brief permits changing it only with a concrete verified reason, and there is none — the test suite
imports it directly for cases 1–9, which exercise the encoder itself.

`lib/finance/revenueState.ts` is byte-identical to its pre-phase state.

## E. Contract Proof

**`confirmedRevenuePaise` is canonical and now the only revenue name on `DashboardEvent`:**

```ts
...toConfirmedRevenueFields(revenue),   // { confirmedRevenuePaise, revenueUnavailable }
```

**The locked absence contract is unchanged.** RD-12-24.5's Option A stands exactly as it was —
nothing in `toLegacyRevenueFields` (which still performs the encoding) was modified:

| State | `confirmedRevenuePaise` | `revenueUnavailable` |
|---|---|---|
| authorized, measured | the figure | `false` |
| authorized, zero | `0` | `false` |
| **authorized, unavailable** | **`0`** | **`true`** |
| unauthorized | `null` | `false` |

No `0 + true` was converted to `null`. Test case C asserts this explicitly, and case E2 asserts
exhaustively that every state serializes to exactly `['confirmedRevenuePaise',
'revenueUnavailable']` and carries no `revenuePaise` property.

## F. Authorization Proof

Nothing in the permission path was touched. The gate, its position and its suppression behaviour
are identical:

```ts
const financeAllowed = authz.permissions.includes('transactions')
const revenue = revenueStateFromCounterMap(revBySlug, slug, financeAllowed)
```

| Property | Status |
|---|---|
| `transactions` upstream of financial reads | **unchanged** |
| Unauthorized users gain access | **no** — `revenueWithheld()` still returns first, before any figure is read |
| New financial query for unauthorized users | **none** — no read was added or moved |
| Owner / finance / admin / manager / gate-role behaviour | **unchanged** |

Removing a *duplicate* of an already-gated value cannot widen exposure. The emulator suites
(27 tests, real tokens, two workspaces) confirm the boundary end to end.

## G. Test Results

| Gate | Result |
|---|---|
| `revenueState` (focused) | **33 passed** |
| focused set — revenue, dashboard ×N, reports, boundary, analytics (24 files) | **965 passed** |
| **full unit suite** | **347 files — 9,402 passed, 1 skipped, 0 failed** |
| emulator — `organizerDataBoundary` + `organizerAnalyticsAuthz` | **27 passed** |
| TypeScript `tsc --noEmit` | **PASS** — no output |
| ESLint (3 touched files) | **PASS** — 0 errors, 0 warnings |
| `next build` | **PASS** — exit 0, compiled in 39.3s |

**Four assertions changed, none weakened, all directly caused by the removal:**

| Assertion | Change |
|---|---|
| `revenueState` case 10 | pinned `'...toLegacyRevenueFields(revenue)'` → now pins `'...toConfirmedRevenueFields(revenue)'`. Same property: one state, no `?? 0` at the emission site |
| `revenueState` case E | dropped the second-spread assertion; **gained two absence assertions** (no legacy spread, no alias declaration). Net stronger |
| `revenueState` case E2 | was "the two names never disagree" → now asserts the exact emitted key set and `not.toHaveProperty('revenuePaise')`. Net stronger |
| `dashboardMoneyGate` | the money-gate invariant pinned `revenuePaise: number \| null` in the type → now `confirmedRevenuePaise: number \| null`. Identical rule, renamed field |

**Case J deleted**, not weakened — a comment in its place records why, per the brief. Its absence
is now covered by case E, which is where the emission shape was already defended.

**Protected tests untouched, exactly as instructed:** cases **F** (counter), **G** (Analytics),
**H** (Event360), **H2** (licence), **I2** (trendDays) are unchanged, and the media-credits
occurrences were never in scope.

No `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, optional weakening or unsafe cast was
introduced. No test was skipped.

**Browser validation: not run.** No UI, styling or rendering logic changed — `reports/page.tsx`
was not touched in this phase, because RD-12-24 had already migrated it to the canonical field.
The consumer's behaviour is pinned by cases I and K at source level. Available on request before
deploy.

## H. Worktree Safety

**Baseline 714 entries before, 714 after** — `diff` of `git status --short` across the phase is
**empty**, so RD-12-25 created no file and removed none. Pre-edit copies of both target files were
saved and used to produce the exact diff in §B.

| Class | Detail |
|---|---|
| **Pre-existing changes** | ~710 entries carried since before RD-12-19 — marketing, discovery, admin, certificates, providers. Untouched |
| **RD-12-25 changes** | 3 files: `dashboard/route.ts`, `revenueState.test.ts`, `dashboardMoneyGate.test.ts` |
| **Unrelated active work** | the auth/login UI workstream — `login/page.tsx` (11:22), `AuthField.tsx` (11:17), `globals.css`, `authViewport.spec.ts`. **All retain their pre-phase timestamps** |

Both target files already carried uncommitted state (`M` and `??`), so every edit was made in
place. **No `reset`, `clean`, `stash`, `checkout`, `restore`, broad replacement or reformat was
run.** Nothing was committed, pushed or deployed. No Firestore rule, index, migration, schedule,
deployment or environment file was modified; `registrationCounters.revenuePaise` remains exactly
as it was.

Build hygiene: compiled into an isolated `.next-a1225`, since deleted, with `tsconfig.json`
restored byte-for-byte from a pre-build backup — valid JSON, 0 stray entries, the concurrent
session's `.next-8c` entries intact.

**Git status after implementation:** branch `master`, HEAD `b7e5fdf`, 714 entries, **0 staged**.

## I. Remaining Risks

1. **Deploy ordering.** RD-12-24 (which added the canonical field) and RD-12-25 (which removes the
   alias) are both undeployed. They must ship in that order, or ideally together — if 12-25 were
   somehow deployed without 12-24 the field would vanish with no replacement. Since both sit in
   the same uncommitted working tree, this is a sequencing note rather than a live hazard.
2. **Stale-bundle window.** A browser tab holding a pre-12-24 bundle against a post-12-25 server
   reads `revenuePaise: undefined` → falsy → the muted class and a dash. Degrades gracefully; no
   `₹NaN`. One deploy of 12-24 before 12-25 removes even this.
3. **`toLegacyRevenueFields` now looks dead.** It has zero production importers and is still the
   encoder every organizer revenue contract depends on. A future cleanup pass that trusts an
   unused-export report would break three routes. The function's own JSDoc and §D of this report
   are the guard; making it non-exported would be a cheap additional one, deliberately not done
   here.

No other risk was identified. No semantic, authorization or calculation regression was found.
