# RD-ANALYTICS-12-24 — Controlled Dashboard Revenue Field Convergence

Exactly one field converged. Backward-compatible, no wire break, no calculation change.
Not committed, not pushed, not deployed.

---

## 1. Executive Summary

`DashboardEvent.revenuePaise` now has a canonical name, `confirmedRevenuePaise`, and the old
name remains beside it as a deprecated alias. **Both are serialized from a single
`RevenueState`**, resolved once per event, so they cannot drift or disagree.

Nothing else named `revenuePaise` was touched. RD-ANALYTICS-12-23 proved that spelling names at
least six different quantities; exactly one of them was approved for convergence, and exactly one
converged.

**One discrepancy between the brief and the implemented contract was found and resolved in favour
of preservation** — see §12. It needs your decision, but it does not block the phase.

| | |
|---|---|
| Files changed | **4** (2 source, 2 test) |
| New files created | **0** — every edit was surgical, into files already carrying uncommitted state |
| Worktree entries | **711 before, 711 after** |
| Wire break | **None** — the alias is still emitted |
| Calculation change | **None** |

## 2. Pre-Implementation Worktree Safety Verification

Performed before any edit, per the RD-12-23.5 warning.

- Baseline captured: **711 entries** (343 untracked, 92 deleted, 275 modified, 0 staged).
- **All four target files already carried uncommitted state** — two `M`, two `??` — so every
  change was made as a surgical edit into existing content. No file was rewritten, reformatted
  or replaced.
- No `reset`, `clean`, `stash`, `checkout` or `restore` was run. No broad regex replacement was
  used; every changed occurrence was classified by hand first.
- The active auth/login workstream was left alone and verified afterwards: `login/page.tsx`
  (11:22), `AuthField.tsx` (11:17), `globals.css` (10 Sep 19:07), `authViewport.spec.ts`
  (10 Sep 23:02) — all retain timestamps predating this phase's first edit.

## 3. Exact Migration Surface

Re-verified against RD-12-23 before implementing. **It matched in every respect.**

| Check | Finding |
|---|---|
| `DashboardEvent.confirmedRevenuePaise` present? | **No** — 0 occurrences in the dashboard route, exactly as audited |
| `DashboardEvent.revenuePaise` | `number \| null`, with `revenueUnavailable?: boolean` |
| Emission | one call to `toLegacyRevenueFields(revenueStateFromCounterMap(...))` |
| `RevenueState` + 4 serializer functions | all present, unchanged |
| `/api/organizer/events`, `/events/[eventId]` | unchanged, already on `confirmedRevenuePaise` |
| **DashboardEvent consumers** | **`reports/page.tsx` only** — the sole importer, with exactly the **two** revenue sites the audit named |
| New consumers since the audit? | **None** — a fresh repository-wide `DashboardEvent` search returns one importer |

## 4. Exact Files Changed by RD-12-24 (LIST B)

| File | Change |
|---|---|
| `app/api/organizer/dashboard/route.ts` | (a) `DashboardEvent` gains canonical `confirmedRevenuePaise: number \| null`; `revenuePaise` re-documented as a `@deprecated` alias; (b) the state is resolved into one local `revenue`; (c) emission spreads **both** serializers from that one value; (d) import extended with `toConfirmedRevenueFields` |
| `app/(dashboard)/dashboard/reports/page.tsx` | the **two** DashboardEvent revenue sites now read `confirmedRevenuePaise` — the `EventRow` render (3 references) and the summary's `revenueKnown` guard + sum |
| `tests/unit/revenueState.test.ts` | **+15 new cases** (A–K); two existing assertions repointed (§14) |
| `tests/unit/registrationReportSources.test.ts` | one existing assertion repointed (§14) |

## 5. Pre-Existing / Unrelated Modified Files (LIST A)

The worktree carried **711 uncommitted entries before this phase and 711 after** — the diff of
`git status --short` before and after is **empty**, which proves RD-12-24 introduced no new file
and removed none.

The active unrelated workstream, untouched:

`app/(auth)/login/page.tsx` · `components/auth/AuthField.tsx` · `AuthSplitLayout.tsx` ·
`PasswordField.tsx` · `PhoneField.tsx` · `SocialLoginRow.tsx` · `app/globals.css` ·
`e2e/authViewport.spec.ts` · `tsconfig.tsbuildinfo`

Plus the ~700 other entries (marketing, discovery, admin, certificates, providers and the rest)
carried through the whole 12-19 → 12-23 sequence. **No unrelated work was overwritten.**

## 6. The Field Migration

```diff
  export interface DashboardEvent {
    …
+   /** RD-ANALYTICS-12-24 · THE CANONICAL NAME for this figure. … */
+   confirmedRevenuePaise: number | null
+   /** @deprecated RD-ANALYTICS-12-24 · renamed to `confirmedRevenuePaise`. … */
    revenuePaise:    number | null
    revenueUnavailable?: boolean
  }
```

Emission, from one state:

```ts
const revenue = revenueStateFromCounterMap(revBySlug, slug, financeAllowed)
…
...toConfirmedRevenueFields(revenue),
...toLegacyRevenueFields(revenue),
```

The canonical field carries **exactly** the semantics the old name had: integer paise, confirmed
ticket revenue, same counter-first/ledger-fallback resolution, same status filter, same
refund and cancellation behaviour, same `statsVersion` backfill gate, same unavailable handling,
same `transactions` authorization. **Only the name is new.**

## 7. The Alias Is Only an Alias

`revenuePaise` remains on the wire, and is **not** a second figure:

- one `RevenueState`, resolved **once** per event (asserted: exactly one
  `revenueStateFromCounterMap(` call in the file);
- both names encoded from that one value by the two **existing** serializers;
- `toConfirmedRevenueFields` still delegates to `toLegacyRevenueFields`, so the legacy pair has
  one author and **no third encoder was introduced**;
- case E2 proves exhaustively, across every state, that `confirmedRevenuePaise === revenuePaise`.

Removal is explicitly **not** part of this phase.

## 8. `registrationCounters.revenuePaise` — NOT Renamed, NOT Migrated

Untouched. It is a **persisted Firestore key**, a different artifact from the wire field that
shares its spelling. The dashboard still reads it under its real name (`d.revenuePaise ?? 0`,
gated on `statsVersion`). No Firestore data migration was performed, and no rules or indexes were
modified — `firestore.rules` (3 Sep) and `firestore.indexes.json` (8 Sep) retain the timestamps
recorded in all six prior phases.

## 9. Unrelated `revenuePaise` Quantities — All Untouched

| Quantity | Where | Status | Guarded by |
|---|---|---|---|
| Persisted counter | `registrationCounters.revenuePaise` | unchanged | case F |
| Day-attributed rollup | `trendDays[].revenuePaise`, `lib/dashboard/dailyStats.ts` | unchanged | case I2 |
| Analytics windowed/period | `normalize.ts` `overview.revenuePaise` | unchanged | case G |
| Analytics confirmed (MaybeMoney) | `EventAnalyticsFinancial.confirmedRevenuePaise` | unchanged | case G |
| Admin Event360 counter-only | `lib/admin/event360Types.ts` | unchanged | case H |
| Platform **licence** income | `organizer360.licenses.revenuePaise` | unchanged | case H2 |

Note on the same file: `reports/page.tsx` contains four other `revenuePaise` references — three
are `trendDays` (daily rollup) and one is a comment about the persisted counter. All four were
deliberately left alone, and case I2 now pins that.

## 10. One State, Proven

Case E asserts the structure — one local, two spreads, exactly one state resolution, no third
encoder. Case E2 asserts the behaviour across all four `RevenueState` shapes plus both
`revenueStateFrom` paths: the two names always hold the identical value.

## 11. Authorization

Unchanged. `transactions` still decides, still resolved **before** the financial read, and the
purely-financial aggregate is still skipped for a denied caller. No permission, role, helper or
route boundary was modified, and the pre-existing Finance event-detail 403 from RD-12-17 was not
touched — the migration did not require going near it.

| Role | `confirmedRevenuePaise` | `revenuePaise` | `revenueUnavailable` |
|---|---|---|---|
| entitled, measured | value | same value | `false` |
| entitled, zero | `0` | `0` | `false` |
| entitled, unreadable | placeholder | same placeholder | **`true`** |
| **not entitled** | **`null`** | **`null`** | `false` |

Case D additionally asserts the withheld amount never appears under either name in the serialized
output, whatever the counter map holds.

## 12. State / Unavailable Behaviour — a discrepancy to flag

**The brief's §3 states that AUTHORIZED + UNAVAILABLE should serialize as
`confirmedRevenuePaise: null`, `revenuePaise: null`, `revenueUnavailable: true`.**

**The implemented contract encodes it as `0` + `revenueUnavailable: true`, not `null`.** That is
what RD-12-21 built and RD-12-22 propagated: the zero is a placeholder the flag disowns, chosen so
that consumers reading only the number are no worse off than before the flag existed.

I preserved the existing encoding rather than following §3's table, for three reasons:

1. **§1 of this same brief requires "same unavailable handling"** and says this is "a FIELD
   CONVERGENCE, not a revenue logic rewrite". The two instructions conflict; the one that
   preserves behaviour wins.
2. **Changing it would leave this phase's scope.** The encoding lives in
   `toLegacyRevenueFields`, which `toConfirmedRevenueFields` delegates to — so switching
   unavailable from `0` to `null` would also change `confirmedRevenuePaise` on
   `/api/organizer/events` and `/events/[eventId]`, contracts this phase must not touch.
3. **It would be a breaking wire change** for the alias, contradicting §2's backward-compatibility
   requirement.

Case C asserts the actual behaviour and documents why. **If you intended the `null` encoding, it
is a deliberate contract change across three routes and belongs in its own phase** — say so and I
will scope it.

## 13. Consumer Migration

`reports/page.tsx` is the only `DashboardEvent` importer, and both of its revenue sites migrated:

- **`EventRow`** — the class predicate, the null/unavailable test and the value now read
  `confirmedRevenuePaise`. Rendering is unchanged: `—` for absent, `₹0` for a measured zero,
  formatted rupees otherwise.
- **The summary total** — `revenueKnown` and the sum now read `confirmedRevenuePaise`. The `?? 0`
  remains, still unreachable-when-unsafe because the guard proves every figure is real first
  (case K).

No label, wording, layout or UI was changed. `lib/analytics/normalize.ts` needed **no** change:
it declares a structural type and, as RD-12-23 established, never reads that field for money —
and the alias is still emitted, so it keeps working either way.

## 14. Test Results

**15 new cases** covering every requirement A–K, plus D2, E2, H2 and I2.

| Gate | Result |
|---|---|
| focused — revenue, dashboard, boundary, report-sources, analytics (23 files) | **950 passed** |
| **full unit suite** | **347 files — 9,403 passed, 1 skipped, 0 failed** |
| emulator — `organizerDataBoundary` + `organizerAnalyticsAuthz` | **27 passed** |

**Three existing assertions were repointed, none weakened** — each pinned a literal expression
this phase reshaped, and each still defends the identical property:

| Case | Was | Now |
|---|---|---|
| `revenueState` 10 | the inline `toLegacyRevenueFields(revenueStateFromCounterMap(...))` literal | the state local **plus** the spread — same property (one state, no `?? 0` at emission), now also proven exhaustively by case E |
| `revenueState` 12 | consumer expressions naming `revenuePaise` | the same expressions naming `confirmedRevenuePaise` |
| `registrationReportSources` | the whole `revenueKnown` line as one string | the predicate itself, `e.confirmedRevenuePaise !== null && !e.revenueUnavailable` (the line now wraps) |

## 15. TypeScript

`npx tsc --noEmit` — **PASS**, no output.

## 16. ESLint

All four touched files — **PASS**, 0 errors, 0 warnings.

## 17. Build

`next build` — **PASS, exit 0**, compiled in 47s. Built into an isolated `.next-a1224`, since
deleted, with `tsconfig.json` restored byte-for-byte from a pre-build backup (valid JSON, 0 stray
entries, the concurrent session's `.next-8c` entries intact).

## 18. Emulator / Browser

**Emulator: 27 passed** — real Auth users, real tokens, two workspaces, both organizer routes
exercised end to end. Those suites do not cover the dashboard route's per-event revenue field, so
they serve here as a regression check that the out-of-scope contracts are unmoved.

**Browser: not run.** No UI, label or layout changed, and the rendering logic is byte-identical
apart from the field name — the behaviour is pinned by cases I and K at the source level. Say the
word if you want a visual pass before the removal phase.

## 19. Revenue Calculation Semantics — Unchanged

No calculation, counter read, ledger aggregate, fallback, status filter, refund rule, rounding or
unit was modified. `revenueStateFromCounterMap` is called with the same three arguments as before;
only its result is now serialized twice.

## 20. The Guarded Counter Decrement — Untouched

The RD-12-23 finding — that `if (amt > 0 && currentRev >= amt)` can silently skip, leaving a
counter above ledger truth — is **out of scope and was not touched**. No increment, decrement,
ledger or refund logic was modified. Data-integrity remediation was deliberately kept out of this
field migration.

## 21. Unexpected Discoveries

1. **The §3 state-table discrepancy** (§12) — the only finding needing your decision.
2. **Three test assertions needed repointing**, one more than expected: the
   `registrationReportSources` hub assertion pinned the entire `revenueKnown` line as a single
   string, so it broke on the line wrap as well as the rename. Narrowed to the predicate itself,
   which is what it was actually defending.
3. **No new consumers appeared** since RD-12-23 despite the busy worktree — `reports/page.tsx`
   remains the only `DashboardEvent` importer.

## 22. Recommended Next Phase

**RD-ANALYTICS-12-25 — DashboardEvent `revenuePaise` alias removal.** Preconditions are already
met except the deploy: no consumer reads the alias (case I asserts the consumer reads neither
`event.revenuePaise` nor `e.revenuePaise`), both fields are proven identical, and the removal
touches one type declaration, one emission line and a handful of assertions. It should run as its
own commit after this change has been deployed once — the same discipline RD-12-19 → RD-12-20
followed.

Settle §12 first if the `null` encoding was intended: that decision changes three routes and
should not be folded into a removal phase.

---

## Final Verdict

## IMPLEMENTED — CONDITIONS REMAIN

The convergence is complete, verified and backward-compatible; all gates pass. One condition
remains: **the §12 unavailable-encoding discrepancy needs your ruling** before the contract can be
called settled. The deprecated alias awaiting its removal phase is the second, expected condition.

### Scope compliance

No Firestore rule, index, schema or data was modified. No unrelated `revenuePaise` was renamed.
No authorization, calculation or UI was changed. No repository-wide operation was run, no
unrelated file was reverted or overwritten, and no new file appeared in the worktree. Nothing was
committed, pushed or deployed.
