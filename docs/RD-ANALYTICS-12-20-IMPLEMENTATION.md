# RD-ANALYTICS-12-20 — Revenue Contract Cleanup & Authorization UX

Organizer workspace only. Analytics, Reports, Admin, Finance, permissions and Firestore
untouched. Not committed, not pushed, not deployed.

---

## A. Phase

Two changes, both closing conditions left open by RD-ANALYTICS-12-19:

- **A · Remove the deprecated `estimatedRevenue` alias.** Its one-deploy compatibility window
  has closed.
- **B · Stop presenting an authorization denial as a temporary failure** on the events card.

## B. 12-19 Contract Context

12-19 renamed the Organizer revenue field to `confirmedRevenuePaise` and emitted the old name
beside it for exactly one deploy, because every consumer guards on `=== null` and a stale
bundle reading a renamed payload gets `undefined`, which slips past that guard into a formatter
and renders **"₹NaN"** on a money tile. That was not theory: nine unit tests reproduced it.

**Repository state verified before removal.** The 12-19 implementation was intact and had not
been partially altered: both producers still declared and emitted the pair, the list route still
assigned both from one local, and the detail route still repeated one identical ternary. The
dual-field state was complete and consistent, so removing half of it is a clean subtraction.

## C. Legacy Field Removal

Every occurrence was classified before a single edit — the brief's A/B/C categories:

| Category | Count | Disposition |
|---|---|---|
| Producer type declarations | 2 | **removed** |
| Producer response literals | 2 | **removed** |
| Computed alias local (list route) | 1 | **renamed** to `confirmedRevenuePaise` |
| Non-test fixture (`verify-eventsetup.ts`) | 1 | **removed** |
| Test fixtures carrying only the old name | 4 | **migrated** to the canonical name |
| Test fixtures carrying both | 5 | alias **stripped** |
| Test assertions pinning the old contract | 6 | **inverted** to absence assertions |
| Negative guards naming the old field | 4 | **migrated** — see below |
| QA script payload assertions | 2 | **inverted** to absence assertions |
| Migration documentation (12-15 → 12-19) | 5 docs | **retained** (category C) |
| Route prose that named the field | 4 | reworded |

**The negative guards deserve their own note.** `attendance`, `passes`, `registrationSearch` and
`eventConference` each assert that a component does *not* read a list of event-list fields, and
`estimatedRevenue` was one of the names. Left alone they would still have passed — vacuously,
because the field no longer exists anywhere. A guard that cannot fail is not protection, so all
four now name `confirmedRevenuePaise` and defend the same rule against the field that actually
exists.

**No third name was introduced.** `ticketRevenuePaise` in `EventCommandCenter` remains a
pre-existing local variable, not a contract field.

## D. Canonical Revenue Contract

`confirmedRevenuePaise: number | null` — unchanged in every respect but the disappearance of its
alias. Still integer paise, still Σ `amount` over `status === 'confirmed'`, still refund-stable,
still counter-first with the ledger fallback, still gated on `transactions` before the read, and
still **not** `MaybeMoney`.

Three states, none collapsed:

| State | `confirmedRevenuePaise` | `revenueUnavailable` |
|---|---|---|
| authorized, earned nothing | `0` | `false` |
| authorized, read failed | `0` | `true` |
| **not authorized** | **`null`** | `false` |

## E. EventCard Authorization-State Fix

**The contract already distinguished the states; the presentation layer threw the distinction
away.** `revenueDisplay` returned the identical `{ text: '—', unavailable: true }` for a denial
and for a failed read, so `EventCard` — which captioned on `regs.unavailable || revenue.unavailable`
— could only ever say one thing:

> Some figures couldn't be loaded for this event. They aren't zero — try again shortly.

For a manager or admin that sentence is false in all three of its clauses: nothing failed,
nothing will load on a retry, and there is nothing to come back for. It invites a support ticket
about working software.

**No API change was needed, and none was made.** Stop conditions 8 and 9 did not fire — the
routes already say which case it is (`null` versus `revenueUnavailable`). The fix restores the
distinction the resolver was discarding:

- `MetricDisplay` gains an optional `reason: 'unreadable' | 'restricted'`, meaningful only when
  `unavailable` is true.
- `revenueDisplay` tags the denial `'restricted'` and the failed read `'unreadable'`;
  `registrationsDisplay` tags its only failure mode `'unreadable'`.
- The card shows the retry sentence **only** for `'unreadable'`, and for `'restricted'` shows
  *"Ticket revenue requires finance access."*

**The wording is the platform's own**, already used by the Overview metric
(`eventOverview.ts:130`) and the Reports tab for exactly this state — so this is a reuse, not a
new vocabulary. It names no permission, no role, and no amount.

**Nothing else moved.** Same dash, same `Metric` component, same classes
(`text-fs-2xs leading-relaxed text-muted-foreground`), same slot in the same container, same
layout, spacing, typography, colour and responsive behaviour. The only structural change is a
second `<p>` in a block that already rendered one conditionally.

## F. Role Matrix

Unchanged by this phase — the removal is a field name and the fix is a caption.

| Role | list `confirmedRevenuePaise` | detail | card caption |
|---|---|---|---|
| owner | **value** | **value** | none |
| finance | **value** | **403 at the route** (pre-existing) | none |
| admin | **null** | **null** | *"requires finance access"* |
| manager | **null** | **null** | *"requires finance access"* |
| checkin_lead | 403 | 403 | — |
| checkin_staff | 403 | 403 | — |

## G. API Response Changes

The single contract change, on both producers:

```diff
- confirmedRevenuePaise: number | null
- /** @deprecated … */
- estimatedRevenue: number | null
+ confirmedRevenuePaise: number | null
```

List route emission is now the canonical local by shorthand (`confirmedRevenuePaise,`); the
detail route emits one gated ternary instead of two identical ones. No other field, status code,
header or shape changed.

## H. Consumer Migration

**No runtime consumer needed migration** — 12-19 had already moved all four to the canonical
name, which is what made this removal a subtraction rather than a refactor. The only
runtime-adjacent edits were the two producers, the `verify-eventsetup.ts` fixture, and
`presentation.ts` / `EventCard.tsx` for Change B.

## I. Test Changes

| File | Change |
|---|---|
| `organizerRevenueBoundary.test.ts` | case 3 + 4 → canonical name and shorthand emission; **case 7b inverted** from "both fields carry the identical value" to "the alias is absent from both producers"; **new 17b** (the resolver's reason discriminator) and **new 17c** (the card's caption rule); case 19/21 guards → canonical name; a misplaced JSDoc moved back above the case it describes |
| `organizerDataBoundary.emu.test.ts` | **case 6b inverted** — `not.toHaveProperty('estimatedRevenue')` on real payloads, authorized and denied, list and detail |
| `eventOverview` · `eventsLanding` | the source-contract cases now assert `not.toContain('estimatedRevenue')` |
| `eventHome` | prose + guard on the canonical name |
| 9 fixture files | alias stripped, or migrated where it was the only revenue field |
| `attendance` · `passes` · `registrationSearch` · `eventConference` | negative guards renamed so they still guard something |
| `rd-analytics-12-17-shots.mjs` | payload assertion inverted to absence |
| `rd-analytics-12-20-shots.mjs` · `-roles.mjs` | **new** — browser proof + an admin fixture |

Nothing was weakened to merely ignore the field: every place that pinned its presence now pins
its absence.

## J. Focused Verification

13 files covering both changes and every migrated fixture: **868 passed**.

## K. Full Unit Tests

**345 files — 9,313 passed, 1 skipped, 0 failed.**

Honest note on flakiness: two earlier full runs reported failures — first 1, then 4 *different*
files (`emailProviderRouting`, `analyticsUnavailable`, `analyticsFinancialTruth`,
`whatsappBroadcastConcurrency`), every one an `Error: Test timed out in 5000ms`. All four pass in
isolation (**105 passed**), the failing set changed between runs, and none touches the revenue
contract — the signature of the 5s default timeout under load from a concurrent build, not a
regression. The clean run above used `--testTimeout=20000`. The two Analytics files among them
were re-run deliberately, and pass.

## L. TypeScript

`npx tsc --noEmit` — **PASS**, no output at all. (Not even the stale generated-directory noise
that earlier phases saw.)

## M. ESLint

All 11 touched files: **0 errors, 1 warning** — `@next/next/no-img-element` at
`EventCard.tsx:130`. That is the banner `<img>` in the existing file body; my edit is the caption
block near line 375, and the file is untracked (`??`), so the warning is pre-existing and not
introduced by this phase.

## N. Build

`next build` (into an isolated `.next-a1220`, so a concurrent session's dev server was not
disturbed) — **exit 0**, compiled in 33s, **312 static pages**.

Cleanup: `.next-a1220` deleted and `tsconfig.json` restored byte-for-byte from a pre-build
backup, because the build rewrites the include array and removing my two entries by hand left a
trailing comma. Restored file is valid JSON with **0** `a1220` entries and the concurrent
session's `.next-8c` entries intact.

## O. Emulator

`organizerDataBoundary` + `organizerAnalyticsAuthz` — **27 passed**, real Auth users, real ID
tokens, real `teamMembers` rows, two workspaces. Includes the inverted case 6b proving the alias
is gone from real payloads for both an authorized and a denied caller, on both routes, and the
cross-workspace isolation cases.

## P. Browser

Four roles at 1440 / 834 / 390, screenshots read rather than assumed.

| Check | Result |
|---|---|
| `estimatedRevenue` anywhere on the wire, **any** role | **absent** — every payload carried only `confirmedRevenuePaise` |
| owner card | **"Ticket revenue ₹0"** as real data, **no caption** |
| manager / admin card | **"Ticket revenue —"** + *"Ticket revenue requires finance access."* |
| the misleading retry sentence for a denial | **gone** (`retry:false` for both denied roles) |
| the neutral caption shown to an authorized role | **never** (`neutral:false` for owner and finance) |
| numeric revenue sent to a denied role | **never** |
| literal `NaN` / `undefined` / `null` | **none** |
| raw permission name exposed | **none** |
| horizontal overflow | **0px / 0px / 0px** |

Console entries were identified rather than waved away: the events list produces **zero** failed
requests for any role; the only 404 is `/api/organizer/events/{id}/registrations` on the detail
page (the fixture event has no registrations subcollection) and the only 403 is finance on the
detail route (its `events` boundary, pre-existing from 12-17). Neither involves revenue.

## Q. Analytics Impact

**None.** No Analytics file was modified. `analyticsUnavailable` and `analyticsFinancialTruth`
were run explicitly and pass. Analytics does not reference `estimatedRevenue` at runtime — stop
condition 2 did not fire.

## R. Reports Impact

**None.** Nothing under `lib/reports/` or the report routes was touched, and no report consumer
references the removed field — stop condition 3 did not fire.

## S. Admin Impact

**None.** No Admin file was modified and no Admin reference to the Organizer field exists — stop
condition 4 did not fire. Admin consumes the *Analytics* `confirmedRevenuePaise` (`MaybeMoney`),
a different producer on a different contract.

## T. Firestore Impact

**None.** The removed field was a response-shape name, never a document key. `firestore.rules`
and `firestore.indexes.json` untouched; nothing deployed.

## U. Files Changed

**Producers (2):** `app/api/organizer/events/route.ts` ·
`app/api/organizer/events/[eventId]/route.ts`

**Change B (2):** `app/(dashboard)/dashboard/events/presentation.ts` ·
`app/(dashboard)/dashboard/events/EventCard.tsx`

**Fixture (1):** `scripts/verify-eventsetup.ts`

**Tests (13):** `organizerRevenueBoundary` · `organizerDataBoundary.emu` · `eventsLanding` ·
`eventOverview` · `eventHome` · `eventCommandCenter` · `eventOverviewTab` · `eventSetupCenter` ·
`eventDeletion` · `dashboardArchivedScope` · `attendance` · `passes` · `registrationSearch` ·
`eventConference`

**QA (3):** `rd-analytics-12-17-shots.mjs` (updated) · `rd-analytics-12-20-shots.mjs` (new) ·
`rd-analytics-12-20-roles.mjs` (new)

**Docs (1):** this file.

Unrelated concurrent-session work was neither modified nor reverted.

## V. Remaining `estimatedRevenue` Occurrences

**Runtime code: ZERO.** No producer, no consumer, no type, no fixture, no local variable.

What remains, all deliberate:

| Location | Count | Why |
|---|---|---|
| `organizerRevenueBoundary.test.ts` | 4 | case 7b — the absence assertion and its rationale |
| `organizerDataBoundary.emu.test.ts` | 3 | case 6b — `not.toHaveProperty` on real payloads |
| `eventOverview` · `eventsLanding` · `eventHome` | 3 | `not.toContain` guards |
| `rd-analytics-12-20-shots.mjs` · `-12-17-shots.mjs` | 6 | browser assertions that the key is not on the wire |
| `docs/RD-ANALYTICS-12-15…12-19` | 5 documents | migration history, retained per category C |

Every code occurrence is an assertion that the field is **gone**. Removing them would remove the
protection.

## W. Known Limitations

1. **The Analytics-side reverse JSDoc is still unwritten.** 12-19 left it open because that
   brief forbade touching Analytics; this brief forbids it too, and explicitly says not to add it
   unless required by the removal. It is not. A developer reading
   `EventAnalytics.financial.confirmedRevenuePaise` still gets no pointer to the Organizer field
   of the same name. Unchanged from 12-19, and still needs approval to touch Analytics.
2. **Finance cannot reach the event-detail route** (403 on its `events` boundary), so its
   revenue there is untested by construction. Pre-existing since 12-17 and deliberately out of
   scope for three phases running.
3. **`revenueUnavailable` remains a sibling boolean rather than part of a discriminated union.**
   The `reason` field now derives the distinction correctly at the presentation layer, but the
   API still encodes it across two fields. Working as designed; noted only because a union would
   make the collapse this phase fixed impossible to reintroduce.
4. **The detail surface was already correct** and was not touched — `revenueMetric` has said
   "Requires finance access" since 12-17. Only the card was lying.

## X. Git / Deployment Status

- HEAD `b7e5fdf`, **0 staged**, nothing committed, nothing pushed, nothing deployed.
- No Firestore rules or indexes deployed.
- `tsconfig.json` restored; `.next-a1220` removed; QA dev server stopped.
- Observation, not an action: `.next-8f` include entries that existed early in this session were
  already absent by the time I backed the file up — a concurrent session's doing. I neither
  removed nor restored them.

## Y. Final Verdict

**APPROVED**

Both objectives are complete and independently verified. Runtime `estimatedRevenue` references
are zero, and the places that used to pin its presence now pin its absence — on the types, on the
emitted literals, and on real emulator payloads for both an authorized and a denied caller. The
card no longer tells an unauthorized user that the platform failed; it says, in the platform's
existing words, that the figure requires finance access, while still showing the same dash and
leaking no amount. Revenue semantics, authorization, the role matrix, units and the three-state
contract are unchanged, and Analytics, Reports, Admin, Finance, permissions and Firestore were
not touched. Every gate ran and passed: 9,313 unit tests, 27 emulator tests, clean TypeScript,
ESLint with one pre-existing warning, a successful build, and four-role browser validation at
three viewports with zero overflow.

## Z. Recommended Next Phase

**RD-ANALYTICS-12-21 — the Analytics-side cross-reference** (§W-1): a one-line JSDoc at
`EventAnalytics.financial.confirmedRevenuePaise` pointing to the Organizer field of the same
name, noting that it is the same quantity under the same permission but a different
representation (`MaybeMoney`) and a different source on the common path. It is the last open
condition from the 12-18 audit and needs nothing but permission to edit an Analytics file.

Lower priority, and genuinely optional: fold `revenueUnavailable` into a discriminated union so
the denial/failure distinction cannot be collapsed by a future resolver (§W-3).
