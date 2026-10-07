# RD-ANALYTICS-12-22 — Organizer Revenue Serializer Consolidation

Internal consolidation. No wire change, no rename, no new public field.
Not committed, not pushed, not deployed.

---

## 1. Inventory of the Two Affected Event Routes

### `GET /api/organizer/events` (list)

| | |
|---|---|
| **Revenue calculated** | `revBySlug: Map<string, number>` — counter `revenuePaise` when `getEventStats().complete`, else the ledger aggregate `sumConfirmedRevenueFromLedgerChecked` |
| **Failure signal** | `revFailed: Set<string>` — a **separate Set**, not a null in the map |
| **Authorization** | `financeAllowed = authz.permissions.includes('transactions')`, resolved before any read |
| **Financial read gating** | `if (financeAllowed && incompleteSlugs.length > 0)` — the purely-financial aggregate is not issued for a denied caller |
| **Pair constructed (before)** | two hand-built expressions: a ternary for the figure, a separate one for the flag |
| **Consumers** | `presentation.revenueDisplay` → `EventCard`; `EventsClient`; `EventContextProvider` |

### `GET /api/organizer/events/[eventId]` (detail)

| | |
|---|---|
| **Revenue calculated** | internal `StatsResult { revenuePaise, revenueUnavailable, … }` from the same counter/ledger pair |
| **Failure signal** | `StatsResult.revenueUnavailable: boolean` |
| **Authorization** | same permission; `if (!financeAllowed) return { ...none, counter: view }` skips the money aggregate |
| **Pair constructed (before)** | `confirmedRevenuePaise: financeAllowed ? revenuePaise : null` plus, ~7 lines later, `revenueUnavailable: financeAllowed ? revenueUnavailable : false` |
| **Consumers** | `eventOverview.revenueMetric`, `EventCommandCenter`, `ReportsTab` |

**The finding that shaped the implementation:** neither route matches the dashboard's input
shape. The dashboard carries its failure signal *inside* the map (`null` = unmeasured), which
`revenueStateFromCounterMap` reads. These two carry the same three facts as **(number, separate
failed-flag, permission)**. So the existing resolver could not be reused as-is — see §3.

## 2. Previous Serialization Behaviour

Both routes assembled the legacy pair by hand, from two independent expressions:

```ts
// list
const confirmedRevenuePaise = financeAllowed ? (slug ? (revBySlug.get(slug) ?? 0) : 0) : null
const revenueUnavailable    = financeAllowed && slug ? revFailed.has(slug) : false

// detail — and these sat seven lines apart in the response literal
confirmedRevenuePaise: financeAllowed ? revenuePaise : null,
revenueUnavailable:    financeAllowed ? revenueUnavailable : false,
```

Correct as written, and correct only because two separate expressions happened to agree. That is
precisely the shape that produced F1 on the dashboard, where one of the two was edited and the
other was not.

## 3. New Serialization Flow

```
counter / ledger measurement + failure signal + `transactions`
        ↓
revenueStateFrom({ financeAllowed, unavailable, paise })   →  RevenueState
        ↓
toConfirmedRevenueFields(state)   →  delegates to toLegacyRevenueFields
        ↓
{ confirmedRevenuePaise, revenueUnavailable }  spread into the response
```

**Two minimal additions to `lib/finance/revenueState.ts`**, both permitted by Phase 3's "minimal
correction" clause and neither a competing abstraction:

- **`revenueStateFrom({ financeAllowed, unavailable, paise })`** — the constructor for the
  (number + separate flag) shape these two routes have, so both input layouts converge on one
  state type instead of one of them keeping a bespoke ternary. **Entitlement outranks failure**,
  matching what both routes already did: a caller who may not see the figure is `withheld`,
  never `unavailable`, because being refused is not the platform breaking.
- **`toConfirmedRevenueFields(state)`** — the same pair under these routes' field name. It
  **delegates** to `toLegacyRevenueFields` and renames the key only, so the legacy pair still has
  exactly one author. This exists because the two contracts spell the figure differently
  (`confirmedRevenuePaise` here, `revenuePaise` on the dashboard) and Phase 9 forbids unifying
  those names in this phase.

No `serializeRevenue()`, `serializeEventRevenue()` or `formatRevenueState()` was introduced.

**One removal that mattered:** the detail route re-asserted `revenueUnavailable:` *after* the
spread. A later key wins in an object literal, so leaving it would have silently overridden the
serializer and reopened the exact drift this phase closes. It is gone, with a comment saying why.

### Behavioural equivalence, checked case by case before editing

| Input | Before | After |
|---|---|---|
| authorized, measured | `{n, false}` | `{n, false}` |
| authorized, no slug | `{0, false}` | `{0, false}` |
| authorized, read failed | `{0, true}` (map unset → `?? 0`) | `{0, true}` |
| unauthorized | `{null, false}` | `{null, false}` |

For the detail route this required confirming that `revenuePaise` is **always 0 whenever
`revenueUnavailable` is true** — verified at both failure branches (`StatsResult` lines 331 and
360, each spreading `none`, whose `revenuePaise` is 0). Equivalence therefore holds exactly.

## 4. Security Preservation

Unchanged in every respect:

- `transactions` still decides, still resolved **before** the reads.
- The purely-financial aggregate is still skipped for a denied caller on both routes — the gates
  (`if (financeAllowed && incompleteSlugs.length > 0)` and
  `if (!financeAllowed) return { ...none, counter: view }`) were not touched.
- **No unauthorized `RevenueState` is built by reading financial data.** `revenueStateFrom`
  returns `withheld` on its first line, before it looks at either the flag or the figure — so a
  denied caller's state cannot encode the amount, the measurement status, or the read outcome.
  Test D asserts this with a non-zero amount and `unavailable: true` supplied: the output is
  `{null, false}` and the amount does not appear in the serialized result.
- Workspace authorization, event membership, and the existing 403 behaviours are untouched.

## 5. API Compatibility Assessment

**No breaking wire change.** Same field names, same types, same values in all four states — only
the key *order* within the JSON object shifts, which no consumer can depend on. `revenuePaise`
and `revenueUnavailable` remain available to every existing consumer; `RevenueState` itself was
**not** put on the wire, and no new public field was added.

## 6. Consumer Audit

Because the emitted values are byte-equivalent (§3), no consumer required a change. Verified
against each anyway:

| Consumer | positive | zero | unavailable | unauthorized |
|---|---|---|---|---|
| `presentation.revenueDisplay` → `EventCard` | figure | `₹0` | `—` + "try again shortly" | `—` + "requires finance access" |
| `eventOverview.revenueMetric` | figure | `₹0` | `—`, no sub | `—` + "Requires finance access" |
| `EventCommandCenter` | figure | `₹0` | `—` | `—` |
| `ReportsTab` | figure | `₹0` | `—` | `—` + "requires finance access" |

No consumer interprets unavailable as zero; the existing optional `revenueUnavailable` handling
is unchanged. No UI redesign and no wording change.

## 7. Remaining Hand-Built Revenue-Pair Search

Repository-wide search for `revenueUnavailable [:=]` and revenue-adjacent `?? 0` / `|| 0`,
outside the serializer:

| Occurrence | Class | Verdict |
|---|---|---|
| `dashboard/route.ts:1194` — `revenueUnavailable = scopedSlugs.some(… === null)` | **2 · safe calculation** | The KPI **total**'s own unavailable rule, not the per-event pair. Correct and deliberately preserved. |
| `events/route.ts:71` | **5 · unrelated** | A line of JSDoc prose. |
| `[eventId]/route.ts:317,322,331,360,400` — `StatsResult` | **6 · migration candidate** | An **internal accumulator** carrying the counter read's outcome. It is the *input* to `revenueStateFrom`, not a response pair. Could itself become a `RevenueState` later; out of scope here. |
| `events/route.ts:318` — `c?.revenuePaise ?? 0` | **2 · safe** | Only reached when `st.complete`; an absent counter field is a real zero. |
| `events/route.ts:426` — `revBySlug.get(slug) ?? 0` | **2 · safe** | That map holds **numbers only** — its failure signal is the separate `revFailed` Set, which is now read into the state. Unlike the dashboard's map, no `null` can arrive here. |
| `[eventId]/route.ts:343` — `cd?.revenuePaise ?? 0` | **2 · safe** | Same rule, gated on `complete`. |

**No unexplained hand-built Organizer revenue pair remains.** No unrelated safe usage was
changed.

## 8. Tests

**New — `revenueState.test.ts`, cases A–G** (the suite is now 21 cases total):

A authorized positive · B measured zero, still distinguishable from unavailable · C authorized
unavailable, never a silent measured zero · D unauthorized: withheld, never flagged, amount
absent from the serialized output · E the serializer is the only constructor of the pair
(asserts the adapter **delegates** rather than re-encoding, and that exactly one place decides
the encoding) · F **exhaustive** — all 12 input combinations, no contradictory pair ·
G neither route hand-builds the pair any more.

**G · the F1 dashboard regression remains protected** — cases 1-12 of the 12-21 suite are
untouched and still pass, including case 5's literal reproduction.

**Five pre-existing assertions re-pointed, none weakened.** Each pinned a literal expression that
the consolidation moved; each now asserts the same property at its new home:

| Case | Was | Now |
|---|---|---|
| `organizerRevenueBoundary` 3 | the denied ternary's tail per route | entitlement-first + null-denial **in the serializer**, proven once for every caller |
| `organizerRevenueBoundary` 5 | the flag's per-route expression | the encoding rule, **plus** a behavioural assertion, **plus** a new guard that neither route may re-assert the flag after the spread |
| `organizerRevenueBoundary` 7b | one gated literal per route | exactly **one** `toConfirmedRevenueFields(` call per route and no hand-built field beside it |
| `eventsLanding` flags-reach-payload | `'revenueUnavailable,'` as a standalone key | the spread that now emits it alongside the figure it qualifies |
| `eventsLanding` no-slug-never-flagged | the whole flag expression | both halves of the rule: the `slug ? … : false` tail, and entitlement decided first |

Case 5 and 7b are now *stronger* than before: they added guards against re-assertion and against
duplicate emission, which are the two ways this consolidation could be undone by accident.

## 9. TypeScript

`npx tsc --noEmit` — **PASS**, no output.

## 10. Lint

All 6 touched files — **PASS**, 0 errors, 0 warnings.

## 11. Build

`next build` — **PASS, exit 0**, compiled in 71s. Built into an isolated `.next-a1222`, since
deleted, with `tsconfig.json` restored byte-for-byte from a pre-build backup (valid JSON, 0 stray
entries, the concurrent session's `.next-8c` entries intact).

## 12. Emulator

`organizerDataBoundary` + `organizerAnalyticsAuthz` — **27 passed**, real Auth users, real
tokens, real `teamMembers` rows, two workspaces. No setup issue this time (the Auth emulator
restarted in RD-12-21 was still up; both ports answered before the run).

This is the strongest evidence available for a refactor of this kind: that suite invokes both
event route handlers end to end and asserts **actual payload values** — `4820000` for an
entitled caller, `null` for a denied one, `0` for an authorized zero — so byte-equivalence of the
new serialization path is demonstrated, not merely argued.

## 13. `confirmedRevenuePaise` — NOT CHANGED

The field name, type (`number | null`), meaning, unit, permission and null semantics are
**unchanged** on both routes. It was not renamed, not aliased, and not unified with the
dashboard's `revenuePaise`. The larger revenue-name convergence was not started.

## 14. Analytics / Reports / Finance — NOT CHANGED

No file under `lib/analytics/`, `lib/reports/`, the report routes, Admin, or the finance
permission model was modified. `lib/analytics/eventAnalytics.ts` carries its 9 Sept mtime,
predating this work. `MaybeMoney` itself is untouched — `RevenueState` sits beside it and copies
its shape without altering it. Analytics authorization and its financial contract are as they
were.

## 15. Indexes / Rules / Deployment — NOT CHANGED

- `firestore.rules` — untouched (mtime 3 Sept).
- `firestore.indexes.json` — untouched (mtime 8 Sept).
- No index deployment, no rules deployment, no Vercel or Firebase deployment.
- Not committed, not pushed. Concurrent-session work neither modified nor reverted.

## 16. Remaining Work — Revenue-Name Convergence

1. **Unify the two names.** `revenuePaise` (dashboard) and `confirmedRevenuePaise` (events) are
   one quantity from one counter. This is rename-class work and should run like RD-12-19 did:
   dual-emit, migrate consumers, then a dedicated removal commit. Completing it lets
   `toConfirmedRevenueFields` be deleted and `toLegacyRevenueFields` serve every contract.
2. **Fold the detail route's `StatsResult` into `RevenueState`** (§7, class 6) so the internal
   accumulator stops carrying its own number-plus-flag pair.
3. **Decide whether `RevenueState` reaches the wire.** It is an internal source of truth today.
   Publishing the union is the audit's end state and *is* a breaking change — it should be
   planned as one.
4. **Then retire the flag**, once no consumer reads the legacy pair.
