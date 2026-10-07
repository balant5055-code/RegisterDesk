# RD-ANALYTICS-12-19 — Revenue Contract Migration

Organizer revenue contract only. Analytics, Reports, Admin, permissions and Firestore
untouched. Not committed, not pushed, not deployed.

---

## A. Objective

Rename the Organizer event revenue field from `estimatedRevenue` — which it is not — to the
canonical `confirmedRevenuePaise`, without changing a single thing about what the number means,
who may see it, or how it is computed.

## B. 12-18 Audit Findings

| Finding | Acted on |
|---|---|
| The value is canonical confirmed revenue, not an estimate | Renamed |
| `confirmedRevenuePaise` **already exists** on the Analytics contract as `MaybeMoney` | §K — collision resolved by documentation, not by a third name |
| No external consumer, no webhook, no SDK, no OpenAPI | Re-verified §L |
| 6 source files + 1 script + 14 test files | Re-verified; the true consumer count was 4 |
| P2-2 "estimated" is factually wrong, developer-facing only | Fixed; no UI copy touched |

## C. Pre-Edit Contract Reconciliation

Performed against source before any edit, and it changed the plan twice.

| Dimension | Organizer `estimatedRevenue` | Analytics `confirmedRevenuePaise` | Same? |
|---|---|---|---|
| Definition | Σ `amount` over confirmed registrations | Σ `amount` over confirmed registrations | ✅ |
| Status filter | confirmed only | `where('status','==','confirmed')` | ✅ |
| Unit | integer paise | integer paise | ✅ |
| Refund behaviour | refund-stable | refund-stable | ✅ |
| Authorization | `transactions` | `transactions` (`financialAllowed`) | ✅ |
| **Source, common path** | `registrationCounters.revenuePaise` when `statsVersion` current | **always** the live ledger aggregate | ❌ |
| Source, fallback | `sumConfirmedRevenueFromLedgerChecked` | same helper | ✅ |
| Unavailable encoding | `0` + sibling `revenueUnavailable` | `{ok:false, reason}` | ❌ |
| Unauthorized encoding | `null` | whole `financial` block absent | ❌ |

**The source difference is real and the 12-18 audit under-stated it.** Analytics issues the
aggregate every time; the Organizer routes prefer the denormalised counter and fall back to that
same aggregate only when `getEventStats().complete` is false.

**Not a stop condition, and here is why.** The counter is a maintained cache of exactly that
aggregate — `buildCounterIncrement` adds `amountPaise` on confirmation and never subtracts on
refund, which is the same refund-stable rule the ledger sum expresses — and `statsVersion` /
`complete` exists precisely to refuse the cache when it cannot be trusted. A cache and its
source-of-truth are the same quantity; the difference is freshness, not meaning. It is
nonetheless the kind of thing a shared name invites someone to misread, so it is documented at
the declaration rather than left to be rediscovered.

Stop conditions 1 and 2 were both evaluated explicitly and neither fired: the semantics are
identical, and `MaybeMoney` does not *conflict* with `number | null` — it is a different
representation at a different layer, which §F treats as a deliberate decision.

## D. Canonical Revenue Definition

Confirmed ticket revenue, integer paise, refund-stable: Σ `amount` over registrations with
`status === 'confirmed'`. Pending and unpaid excluded. Answers "what did this event sell",
never "what did it keep". Unchanged by this phase — no calculation, helper, ledger or refund
rule was touched.

## E. Canonical Field Name

**`confirmedRevenuePaise`.**

`Paise` is not decoration. `EventCommandCenter` computes
`formatINR(ticketRevenuePaise + event.donationTotalPaise)` — a field with no unit in its name,
added to one that has it. That line is correct only because the value happens to be paise; the
suffix is what makes it self-checking.

**No third name was introduced.** `ticketRevenuePaise` in `EventCommandCenter` is a pre-existing
local variable (RD-12-17), not a contract field, and the routes were checked for
`eventRevenuePaise` / `actualRevenuePaise` — absent.

## F. Type / Representation Decision

`number | null` — **unchanged**, and deliberately not `MaybeMoney`.

Widening to `MaybeMoney` would have been a semantics change wearing a rename's clothes: it would
rewrite every consumer's null handling that RD-12-17 had just established, and `MaybeMoney` has
no way to express "you are not entitled" — Analytics says that by omitting the whole `financial`
block, which a per-field response cannot do.

So the same name carries two representations at two layers, which the brief permits when the
distinction is intentional and documented. It is documented at the Organizer declaration,
including why.

## G. Null / Zero / Unavailable Contract

Preserved exactly. Three states, none collapsed:

| State | `confirmedRevenuePaise` | `revenueUnavailable` |
|---|---|---|
| authorized, earned nothing | `0` | `false` |
| authorized, read failed | `0` | `true` |
| **not authorized** | **`null`** | `false` |

Proven end to end (§S cases 2–4, 6b) and by the pure resolvers (§R cases 13–18).

## H. Organizer Event List Migration

`GET /api/organizer/events` — `EventListItem` gains `confirmedRevenuePaise: number | null`
carrying the full reasoning; `estimatedRevenue` remains as a `@deprecated` alias with the
identical type. Both are assigned from **one** computed local, so they cannot drift:

```ts
const estimatedRevenue: number | null = financeAllowed ? (…) : null
…
confirmedRevenuePaise: estimatedRevenue,
estimatedRevenue,                      // @deprecated — identical value
```

The gate expression, the counter/ledger resolution, the skipped financial read and
`revenueUnavailable` are all untouched.

## I. Organizer Event Detail Migration

`GET /api/organizer/events/[eventId]` — the same rename, the same dual field, the same ternary
repeated so both fields carry the identical value including the `null`.

Its route boundary (`authorizeWorkspace(req, 'events')`) is **unchanged**, so finance still
receives 403 here. That was RD-12-17's documented pre-existing behaviour and this phase did not
widen it.

## J. Organizer Consumer Migration

All four read consumers plus the one non-test fixture:

| Consumer | Change |
|---|---|
| `presentation.revenueDisplay` | reads `confirmedRevenuePaise` |
| `eventOverview.revenueMetric` | reads `confirmedRevenuePaise` |
| `EventCommandCenter` | `ticketRevenuePaise` derived from `confirmedRevenuePaise` |
| `ReportsTab` | `revenueRestricted` + the Stat value |
| `scripts/verify-eventsetup.ts` | fixture sets both |

**No UI wording changed.** "Ticket revenue", "Revenue (Confirmed)", "Confirmed registrations",
"Requires finance access" are all as they were, and no "estimated" copy was introduced.

**Zero consumers now read the deprecated alias** — verified by search: every remaining
`estimatedRevenue` occurrence in source is inside the two producers (the declaration, the
emission, one local variable, the QA script's dual assertion and one fixture).

**The prose that the rename invalidated was corrected too.** Four developer-facing comments in
the two routes referred to the field by its old name, and one had become self-contradictory:
*"`estimatedRevenue` is canonical confirmed revenue despite its name"* — a sentence that only
made sense while the name was wrong. A fifth, the 12-15 "WHAT THIS DOES NOT FIX" block, still
asserted the money field was returned unconditionally; RD-12-17 had fixed that two phases ago,
so it is now marked superseded. Comment-only edits, re-verified below.

## K. Analytics Collision Resolution

**No Analytics file was modified.** `lib/analytics/eventAnalytics.ts`, `normalize.ts`, the
analytics page, the analytics export and Admin Event360 all carry mtimes from 6–8 Sept, days
before this phase.

The collision is resolved by **documentation on the Organizer side only**. The
`EventListItem.confirmedRevenuePaise` declaration states that the Analytics field of the same
name is the same quantity under the same definition, permission and unit; that it is a
`MaybeMoney` and absent-not-null when denied; and that the two differ in source on the common
path.

The 12-18 audit's condition 1 asked for cross-referencing JSDoc at **both** declarations. Only
the Organizer half was written, because the brief's CHANGE 5 is explicit — *"If YES: STOP before
changing those areas"* — and a comment is not necessary for correctness. The reverse reference
is recorded as a known limitation (§Y) rather than taken unilaterally.

## L. External Contract Verification

Re-verified in this phase, not inherited: **zero** occurrences of `estimatedRevenue` under
`app/api/public`, `app/api/webhooks` or `public/`; no `app/api/v1`; no `openapi*`, `swagger*` or
`sdk/`. Both producing routes are session-authenticated organizer endpoints reached only by the
dashboard bundle. No compatibility guarantee is owed outside this repository.

## M. Rolling Deployment Strategy

**Dual field for one deploy — and the evidence changed my mind mid-phase.**

The deployment model argued for a hard rename: `vercel.json` is `{}`, one Next app builds API
routes and client bundle as a single unit, `public/sw.js` exists but is **never registered**
(no `serviceWorker.register` anywhere), and there are no external consumers. On that evidence a
hard rename looked safe.

What that reasoning missed is the actual failure mode. Every consumer guards on `=== null`, and
a stale bundle reading a renamed payload gets **`undefined`**, which is not `null`. It slips
past all four guards straight into a formatter:

```ts
if (e.confirmedRevenuePaise === null) return { text: UNAVAILABLE, … }   // undefined passes
return { text: fmtINR(e.confirmedRevenuePaise), … }                     // → "₹NaN"
```

This is not theory: **nine unit tests failed with `₹NaN`** the moment the consumers were
migrated ahead of their fixtures, reproducing exactly the mismatch a rolling deploy would
produce. "₹NaN" on a money tile is materially worse than a dash, so the compatibility field is
justified rather than reflexive.

## N. Old Field Removal Strategy

**Removal is deliberately NOT in this phase**, and its point is fixed:

> Remove `estimatedRevenue` from `EventListItem`, `EventDetailResponse` and both response
> literals **in a single dedicated commit**, once this change has been deployed once.

Preconditions, all already true except the deploy:

- no consumer reads the alias (verified — the producers are the only occurrences)
- both fields carry the identical value, proven on real payloads (§S case 6b)
- the removal touches 2 route files and 6 test fixtures, nothing else

It is a separate commit because rollback after it is no longer a revert (§Z), and because a
"temporary" field that outlives its migration is exactly how `estimatedRevenue` survived this
long.

## O. Authorization Preservation

Untouched. `transactions` still decides, still before the read, and the purely-financial ledger
aggregate is still skipped for an unauthorized caller. No permission, `ROLE_PERMISSIONS`,
authorization helper, workspace or event boundary was modified — verified by mtime
(`lib/team/types.ts` 4 Sept, `lib/team/workspace.ts` 4 Sept).

## P. Role Matrix

| Role | list `confirmedRevenuePaise` | detail | attendee-name path |
|---|---|---|---|
| owner | **value** | **value** | unchanged |
| finance | **value** | **403 at the route** (pre-existing) | unchanged |
| admin | **null** | **null** | unchanged |
| manager | **null** | **null** | unchanged |
| checkin_lead | 403 | 403 | — |
| checkin_staff | 403 | 403 | — |

Identical to RD-12-17's matrix. The rename moved no one.

## Q. Cross-Workspace Verification

Unaffected and re-proved: no workspace-A role sees workspace B's event or its revenue; B's owner
sees only their own with the value intact; tenancy still derives from the session as a document
path (§S case 8).

## R. Test Changes

**Updated, none deleted or weakened** — 9 files:

| File | What moved |
|---|---|
| `organizerRevenueBoundary.test.ts` | fixtures → new field; gate assertions → canonical name; **case 8 rewritten** (12-17's "not renamed" guard is superseded — it now asserts the canonical name on both routes and that no third name appeared); **new case 7b** pins dual-field parity including the denial |
| `eventsLanding.test.ts` | fixtures, the projected-field list, and the name/meaning guard |
| `eventOverview.test.ts` | fixtures + the name/meaning guard (now asserts both fields and the new JSDoc text) |
| `eventCommandCenter.test.ts`, `eventOverviewTab.test.ts` | fixtures |
| `eventHome.test.ts` | fixture, and the occurrence-count rule now counts the canonical field **and asserts the alias is not read by the component at all** |
| `organizerDataBoundary.emu.test.ts` | assertions → canonical name; **new case 6b** proves parity on real payloads |
| `rd-analytics-12-17-shots.mjs` | the wire assertion now checks **both** fields for a denied caller |

## S. Emulator Validation

`organizerDataBoundary.emu.test.ts` + `organizerAnalyticsAuthz.emu.test.ts` — **27 passed**.
Real Auth users, real ID tokens, real `teamMembers` rows, real handlers, two workspaces.

| Proof | Result |
|---|---|
| owner + finance receive `confirmedRevenuePaise` from the list | `4820000` |
| admin + manager receive `null`, amount absent from the payload | ✅ |
| authorized zero is `0` while the denied caller gets `null` for the same event | ✅ |
| denied caller not told the read failed | ✅ |
| detail route: owner value, admin/manager null, finance 403 | ✅ |
| **the deprecated alias carries the identical value, authorized and denied** | ✅ (case 6b) |
| gate roles reach neither route | 403 |
| cross-workspace isolation | ✅ |

## T. Browser Validation

Emulator build served on 3187, three roles, screenshots read.

| Check | Result |
|---|---|
| manager payloads, both routes | **both** `confirmedRevenuePaise: null` **and** `estimatedRevenue: null` |
| a numeric value of either field sent to a denied role | **never** |
| owner events card | **"Ticket revenue ₹0"** — an authorized zero through the renamed field |
| manager events card | **"Ticket revenue —"** |
| literal `null` / `undefined` / `NaN` anywhere | **none** |
| labels unchanged | ✅ |
| overflow at 1440 / 834 / 390 | 0px / 0px / 0px |

Console 404/403 entries were attributed and are pre-existing (fixture has no registrations
subcollection; finance lacks `events` on the detail route).

**One real finding, surfaced only by reading the screenshot** — see §Y-1.

## U. Admin Impact

**None.** No Admin file modified. Admin consumes the **Analytics**
`confirmedRevenuePaise` (`MaybeMoney`) via `app/(admin)/admin/events/[slug]/PageClient.tsx`,
which is a different producer on a different contract and is unaffected.

## V. Reports Impact

**None.** Reports never referenced this field; nothing under `lib/reports/` or
`app/api/organizer/reports/` was touched, and the full suite's Reports tests all pass.

## W. Firestore Impact

**None.** The field is a response-shape name, never a document key. The stored keys
(`registrationCounters.revenuePaise`, the ledger's `amount`) are untouched. `firestore.rules`
(3 Sept) and `firestore.indexes.json` (8 Sept) both predate this phase.

## X. Files Changed

**Producers (2):** `app/api/organizer/events/route.ts` ·
`app/api/organizer/events/[eventId]/route.ts`

**Consumers (4 + 1 fixture):** `app/(dashboard)/dashboard/events/presentation.ts` ·
`lib/events/eventOverview.ts` ·
`app/(dashboard)/dashboard/events/[eventId]/EventCommandCenter.tsx` ·
`app/(dashboard)/dashboard/events/[eventId]/tabs/ReportsTab.tsx` · `scripts/verify-eventsetup.ts`

**Tests (7):** `organizerRevenueBoundary` · `eventsLanding` · `eventOverview` ·
`eventCommandCenter` · `eventOverviewTab` · `eventHome` · `organizerDataBoundary.emu`

**QA + docs (2):** `scripts/qa/rd-analytics-12-17-shots.mjs` · this document

Unrelated concurrent-session work (`components/marketing/*`, `components/discovery/*`,
`tests/unit/screenshotShowcase.test.ts`, and that session's `.next-8c` entries in
`tsconfig.json`) was neither modified nor reverted. Only my `.next-a1219` entries were removed
from `tsconfig.json` and that directory deleted.

## Y. Known Limitations

1. **The events card caption is wrong for a denied caller.** `EventCard.tsx:374-376` renders
   *"Some figures couldn't be loaded for this event. They aren't zero — try again shortly."*
   whenever `revenue.unavailable` is true — which RD-12-17 made true for the **denial** case as
   well. A manager is told the platform failed and to retry, about a figure they will never be
   entitled to see. **Pre-existing (RD-12-17), not caused or worsened by this rename**, and not
   fixed here because it is card copy in a contract-rename phase. Found by reading the
   screenshot, not by any assertion. **Recommended fix:** give `MetricDisplay` a reason so the
   caption can distinguish "unreadable" from "restricted" — the Overview metric already does
   this with its `sub` line.
2. **The Analytics-side cross-reference JSDoc was not written** (§K), because CHANGE 5 forbids
   touching those files. A developer reading `EventAnalytics.financial.confirmedRevenuePaise`
   still gets no pointer to the Organizer field. One-line comment, needs approval to touch
   Analytics.
3. **The deprecated alias is still emitted.** By design, for one deploy (§N). It is dead weight
   the moment that deploy lands.
4. **The source difference (counter vs ledger) is documented, not reconciled.** The two fields
   can in principle differ if a counter drifts, which is what reconciliation exists to correct.
   Out of scope, and arguably correct as-is.

## Z. Rollback Strategy

- **This commit:** plain revert. Both fields are emitted and every consumer works either way, so
  reverting cannot strand a client.
- **Deploy ordering:** irrelevant while both fields exist — that is what the dual field buys.
- **Mixed versions:** safe. An old bundle reads `estimatedRevenue`; a new one reads
  `confirmedRevenuePaise`; both get the same value and the same `null`.
- **After the removal commit (§N):** rollback means re-adding the field, so that commit is
  separate and should be its own deploy.

## AA. Final Verification

| Gate | Result |
|---|---|
| focused — `organizerRevenueBoundary` | **25 passed** |
| **full unit suite** | **344 files — 9,293 passed, 1 skipped, 0 failed** |
| TypeScript | **PASS** — 0 source errors |
| ESLint — every touched file | **PASS** — 0 errors, 0 warnings |
| production build | **PASS** — exit 0, 64s, 312 pages |
| emulator | **27 passed** |
| stale `estimatedRevenue` consumer | **none** — producers only |
| third revenue name introduced | **none** |
| Analytics / Reports / Admin / Firestore / permissions | **unmodified** (verified by mtime) |

TypeScript's only remaining output is `TS6053`/`TS2344` from two stale generated directories
(`.next-verify`, and `.next-8c` created by a concurrent session mid-build) reached through
`tsconfig.json` include globs. Neither is a source file and neither is mine.

## AB. Final Verdict

**APPROVED WITH CONDITIONS**

Every required gate ran and passed, and no regression was found. The rename is
semantics-preserving: same definition, same unit, same permission, same three states, same
calculation, same helper, same role matrix — proven end to end with real credentials and
confirmed on screen. The collision with the Analytics field was resolved deliberately rather
than dodged with a third name, and the one genuine risk — a stale bundle rendering `₹NaN` — was
found by evidence and neutralised with a time-boxed compatibility field.

It is not unconditional, because two things are deliberately left open:

1. **The deprecated `estimatedRevenue` alias must be removed** in a dedicated commit one deploy
   after this one (§N). Until that lands, the contract carries a field whose only purpose is to
   survive a deployment window. Shipping this phase without scheduling that commit leaves the
   repository in exactly the state that produced `estimatedRevenue` in the first place.
2. **The 12-18 audit's condition 1 is only half met** (§K, §Y-2). It asked for cross-referencing
   JSDoc at *both* declarations of `confirmedRevenuePaise`; only the Organizer one was written,
   because CHANGE 5 forbids touching Analytics files. The reverse comment needs explicit
   approval to add.

Neither condition affects correctness, authorization or the values on screen today. Separately,
§Y-1 records a **pre-existing** RD-12-17 caption defect found by browser QA; it is not a
condition on this phase and is not a regression from it.

## AC. Recommended Next Phase

**RD-ANALYTICS-12-20 — `estimatedRevenue` removal** (§N): drop the deprecated alias from both
types and both response literals, update the six fixtures, in one dedicated commit after this
change has been deployed once.

Then, separately and needing approval to touch Analytics: the reverse cross-reference JSDoc
(§Y-2) and the events-card caption fix (§Y-1) — the latter being a real, if small, honesty
defect that browser validation surfaced.
