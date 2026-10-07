# RD-ANALYTICS-12-18 — Revenue Contract Migration Audit

Audit only. No field renamed, no type changed, no API, UI, test, Analytics, Reports, Finance,
Admin, permission or Firestore change.

---

## A. Executive Summary

The migration is straightforward — the surface is far smaller than the "18 consumers" figure
carried forward suggested — and the audit found one thing that changes the recommendation.

**The proposed name is already taken, for the same concept, with a different type.**

`confirmedRevenuePaise` exists today in the Analytics financial contract:
`EventAnalytics.financial.confirmedRevenuePaise: MaybeMoney` (`lib/analytics/eventAnalytics.ts:170`),
consumed by the organizer Analytics page, the analytics export and the Admin Event360 page. It
is the **same underlying value** — both it and `EventListItem.estimatedRevenue` resolve through
the same helper, `sumConfirmedRevenueFromLedgerChecked`, and both are refund-stable confirmed
ticket revenue in integer paise.

What differs is how each encodes the three states:

| State | `EventListItem.estimatedRevenue` | `financial.confirmedRevenuePaise` |
|---|---|---|
| authorized value | `number` | `{ ok: true, paise }` |
| read failed | `0` + sibling `revenueUnavailable: true` | `{ ok: false, reason: 'query_failed' }` |
| unauthorized | **`null`** | the whole `financial` block is **absent** |

Renaming the list field to `confirmedRevenuePaise` without unifying the type would put two
fields of the same name and the same meaning into one codebase with **different shapes and
different unavailability semantics**. A developer moving between them would reasonably assume
they are interchangeable, and would be wrong in the one direction that matters — money.
That is a worse defect than the misleading name being fixed.

**Recommended name: `confirmedRevenuePaise`** — it is the accurate one, and the collision is an
argument for *deliberate* naming, not against it. **Recommended strategy: internal-first, then a
dual-field deprecation window**, with the type left as `number | null` and the difference from
the Analytics wrapper documented at both declarations.

The rest is clean. **Zero** references in Analytics, Reports, Finance or Admin source. No public
route, webhook, SDK or OpenAPI artifact exposes the field. Every formatter takes paise and
divides by 100. No consumer sorts, filters or calculates on it, and none coerces `null` to `0`.
`EventContextProvider` and `EventSelector` do not read it — re-verified, zero occurrences.

**Verdict: APPROVED WITH CONDITIONS.**

---

## B. Scope

The Organizer revenue contract only: `EventListItem.estimatedRevenue` and
`EventDetailResponse.estimatedRevenue`, and the question of renaming them to
`confirmedRevenuePaise`. No implementation. Admin was inspected only far enough to prove
non-involvement.

---

## C. Current Revenue Semantics

| Property | Value |
|---|---|
| **Source** | `registrationCounters/{slug}.revenuePaise` when the counter is complete (`statsVersion >= EVENT_STATS_VERSION`), else `sumConfirmedRevenueFromLedgerChecked(slug)` |
| **Meaning** | Σ `amount` over **confirmed** registrations |
| **Unit** | integer **paise** |
| **Currency** | INR |
| **Pending / unpaid** | excluded |
| **Refunds** | **not** deducted — refund-stable by design: a refund keeps `status: 'confirmed'` and does not change `amount` |
| **Zero** | a measured fact — the event earned nothing |
| **Unavailable** | `0` with the sibling flag `revenueUnavailable: true` |
| **Unauthorized** | `null` (RD-ANALYTICS-12-17), `revenueUnavailable: false` |
| **Authorization** | `transactions` |

**It is not an estimate.** Both route declarations already say so:
*"CANONICAL confirmed revenue (registrationCounters.revenuePaise / ledger fallback); field name
kept for contract stability"*. The word survives from a superseded implementation that computed
Σ(pass.price × pass.sold).

---

## D. Producer Map

Two producers, both Organizer API routes. No library, adapter or service produces the field.

### 1 · `app/api/organizer/events/route.ts` (list)

| | |
|---|---|
| Function | `GET`, per-event mapping at line 402 |
| Input | `revBySlug: Map<slug, paise>` — from `getEventStats` (complete counter) or the ledger aggregate |
| Calculation | `financeAllowed ? (slug ? (revBySlug.get(slug) ?? 0) : 0) : null` |
| Output | `estimatedRevenue: number \| null` (line 450) |
| Unit | paise |
| Authorization | `authorizeAnyWorkspace` (route) + `transactions` (field) |
| Consumers | `presentation.ts`, and every caller of the list |

### 2 · `app/api/organizer/events/[eventId]/route.ts` (detail)

| | |
|---|---|
| Function | `GET`, response literal at line 577 |
| Input | `loadStats()` → `revenuePaise`, same counter/ledger resolution |
| Calculation | `financeAllowed ? revenuePaise : null` |
| Output | `estimatedRevenue: number \| null` (line 159) |
| Unit | paise |
| Authorization | `authorizeWorkspace(req, 'events')` (route) + `transactions` (field) |
| Consumers | `eventOverview.ts`, `EventCommandCenter.tsx`, `ReportsTab.tsx` |

Both skip the purely-financial ledger read entirely for an unauthorized caller. Neither
transforms, copies or re-maps the field anywhere else — there is no adapter layer to migrate.

---

## E. API Contract Inventory

| Route | Method | Response type | Route permission | Field permission | Consumed by |
|---|---|---|---|---|---|
| `/api/organizer/events` | GET | `EventListItem[]` | `authorizeAnyWorkspace` | `transactions` | browser only |
| `/api/organizer/events/[eventId]` | GET | `EventDetailResponse` | `authorizeWorkspace(req,'events')` | `transactions` | browser only |

**No additional Organizer endpoint returns the field** — a repository-wide search found it in
exactly these two routes. Both are private, session-authenticated, and reached only by the
dashboard app.

---

## F. Type System Inventory

| Declaration | File | Type |
|---|---|---|
| `EventListItem.estimatedRevenue` | `app/api/organizer/events/route.ts:64` | `number \| null` |
| `EventDetailResponse.estimatedRevenue` | `app/api/organizer/events/[eventId]/route.ts:159` | `number \| null` |
| `EventListItem.revenueUnavailable?` | list route:85 | `boolean` (optional) |
| `EventDetailResponse.revenueUnavailable?` | detail route:171 | `boolean` (optional) |

No Zod schema, no DTO layer, no serialized-state type, no hook or context type declares it. 36
files import `EventListItem`/`EventDetailResponse`, overwhelmingly for other fields.

**A renamed field should keep exactly `number | null`.** Widening it to `MaybeMoney` to match
Analytics would be a semantics change, not a rename, and would touch every consumer's null
handling that RD-12-17 just established — see §S.

---

## G. Unit Analysis

Integer **paise** at every stage, with no conversion until presentation:

| Stage | Unit |
|---|---|
| `registrationCounters.revenuePaise` | paise |
| `sumConfirmedRevenueFromLedgerChecked` | paise |
| `revBySlug` / `loadStats().revenuePaise` | paise |
| API response | paise |
| `fmtINR(paise)` — `presentation.ts:32` | `paise / 100` → `Intl.NumberFormat` INR |
| `formatINR(paise)` — `eventOverview.ts:90` | `Math.round(paise / 100)` |

Both formatters name their parameter `paise`. **No arithmetic, no comparison, no total and no
decimal conversion happens on the field outside those two formatters** — except one, noted below.

**The one place the name invites a unit error:** `EventCommandCenter.tsx` computes
`formatINR(ticketRevenuePaise + event.donationTotalPaise)`. Both sides are paise and the sum is
correct — but the field's name carries no unit while its sibling's (`donationTotalPaise`) does.
A field called `estimatedRevenue` added to one called `donationTotalPaise` is exactly the shape
of a unit bug, and the only thing preventing it is that the value happens to be paise. This is
the strongest single argument for the `Paise` suffix (§S).

---

## H. Complete Consumer Inventory

Fresh repository-wide trace: **137 occurrences across 25 files** (excluding build output).
Property access, destructuring, spreading, object literals, types, fixtures and tests were all
searched.

**Source (6 files, 21 occurrences)**

| File | Occurrences | Role |
|---|---|---|
| `app/api/organizer/events/route.ts` | 8 (3 code, 5 prose) | producer |
| `app/api/organizer/events/[eventId]/route.ts` | 4 (2 code, 2 prose) | producer |
| `app/(dashboard)/dashboard/events/presentation.ts` | 2 | consumer |
| `lib/events/eventOverview.ts` | 2 | consumer |
| `app/(dashboard)/dashboard/events/[eventId]/tabs/ReportsTab.tsx` | 4 (3 code, 1 prose) | consumer |
| `app/(dashboard)/dashboard/events/[eventId]/EventCommandCenter.tsx` | 1 | consumer |
| `scripts/verify-eventsetup.ts` | 1 | fixture |

**Tests (14 files, 52 occurrences)** — `organizerRevenueBoundary` (22), `eventsLanding` (8),
`eventOverview` (6), `eventHome` (4), `eventCommandCenter` (3), `eventOverviewTab` (2), and one
each in `attendance`, `dashboardArchivedScope`, `eventConference`, `eventDeletion`,
`eventSetupCenter`, `passes`, `registrationSearch`, plus `organizerDataBoundary.emu` (6).

**QA + docs (5 files, 64 occurrences)** — `rd-analytics-12-17-shots.mjs` (4) and the three
prior audit/implementation documents (53), which are historical records and must not be
rewritten.

**The "18 consumers" figure was loose.** The true migration surface is **6 source files + 1
script + 14 test files**. Six of the source occurrences are explanatory prose, not code.

---

## I. Consumer Classification

| Consumer | Class | Cares about unit | null | zero | unavailable | authz | exact name |
|---|---|---|---|---|---|---|---|
| `presentation.revenueDisplay` | **A** display | ✅ paise | ✅ | ✅ | ✅ | indirectly | ✅ |
| `eventOverview.revenueMetric` | **A** display | ✅ paise | ✅ | ✅ | ✅ | indirectly | ✅ |
| `ReportsTab` Stat | **A** display + **E** conditional | ✅ | ✅ | ✅ | ✅ | indirectly | ✅ |
| `EventCommandCenter` | **A** display + **B** calculation (`+ donationTotalPaise`) | ✅ **critically** | ✅ | ✅ | ✅ | indirectly | ✅ |
| `scripts/verify-eventsetup.ts` | **I** fixture | ✖ | ✖ | ✖ | ✖ | ✖ | ✅ |
| 14 test files | **H/I** | mixed | some | some | some | some | ✅ |

**No consumer is C (sorting), D (filtering) or F (API pass-through).** The value is read,
formatted and rendered; the single calculation is the donation sum. That is the smallest
possible migration profile for a field with this many references.

---

## J. UI Consumer Analysis

| Surface | Formatter | null handled | zero handled | `revenueUnavailable` present | Says "estimated"? |
|---|---|---|---|---|---|
| Events list card | `fmtINR` | ✅ `—`, muted | ✅ renders `₹0` | ✅ separate branch | **No** — label is "Ticket revenue" |
| Event Overview metric | `formatINR` | ✅ `—` + "Requires finance access" | ✅ | ✅ | **No** — sub reads "Confirmed registrations" |
| Event Command Center | `formatINR` | ✅ via `ticketRevenuePaise` | ✅ | ✅ folded into the same guard | **No** — "Ticket revenue" |
| Reports tab Stat | `fmtINR` | ✅ via `revenueRestricted` | ✅ | ✅ | **No** — "Revenue (Confirmed)" |

**No UI string anywhere says "estimated".** The user-facing terminology is already correct and
has been for some time — "Ticket revenue", "Revenue (Confirmed)", "Confirmed registrations". The
misleading name is a **developer-facing** problem only, which is why this is P2 and not P1, and
why no copy change is needed.

---

## K. Event List Analysis

- **Displayed:** yes, via `revenueDisplay` on each card.
- **Recalculated:** no.
- **Passed into another component:** yes — as part of the whole `EventListItem`, never extracted.
- **Sorting / filtering:** **no.** Repository search for any sort or filter on the field returns
  nothing; the list orders by `updatedAt desc` and filters by tab and search text server-side.
- **`EventSelector` / `EventContextProvider`:** **re-verified — zero occurrences** in
  `EventContextProvider.tsx`, `EventSelector.tsx` and `lib/events/eventContext.ts`. The context
  projects a strict subset that does not include revenue. The RD-12-16 finding holds.

---

## L. Event Detail Analysis

Chain: detail route → `ManageEventClient` → `EventCommandCenter` (header + donation split),
`ReportsTab` (one Stat), and `lib/events/eventOverview.revenueMetric`.

The detail route's authorization boundary **differs from the list's**: it requires
`authorizeWorkspace(req, 'events')`, so **`finance` is refused at the route** and never reaches
the field. RD-12-17 documented and asserted this; it is out of scope here.

**Does it affect the migration? Only mildly, and worth stating:** a rename must be applied to
both routes together regardless of who can reach them, because the two types are consumed by
overlapping code (`eventOverview.ts` is imported by list and detail surfaces alike). Migrating
one and not the other would produce two names for one concept — the exact defect being fixed.

---

## M. Analytics Dependency

**Analytics does not consume `estimatedRevenue`. Zero occurrences** in `lib/analytics/` and
`components/analytics/`.

It has its own field for the same value: `EventAnalytics.financial.confirmedRevenuePaise`
(`lib/analytics/eventAnalytics.ts:170`), typed `MaybeMoney`, derived at line 949 from
`sumConfirmedRevenueFromLedgerChecked` (line 697) — **the same helper the events routes use**.
`lib/analytics/normalize.ts:309` maps it to `confirmedRevenue` on the normalized contract.

So the two are independent producers of one figure, and the proposed name already belongs to
one of them. This is the audit's central finding — §S and P1-1.

---

## N. Reports Dependency

**None. Zero occurrences** in `lib/reports/` and `app/api/organizer/reports/`. The report
builders read the transaction and settlement ledgers directly; they neither consume nor export
this field.

---

## O. Finance Dependency

**None. Zero occurrences** in `app/api/organizer/finance/` and
`app/(dashboard)/dashboard/finance/`. Finance resolves revenue from the ledger independently,
through the same canonical helpers — which is why the figures reconcile without either surface
importing the other's field.

---

## P. Public / External Contract Analysis

**No external consumer exists.** Evidence:

- `app/api/public/` — 0 occurrences.
- `app/api/webhooks/` — 0 occurrences.
- No `app/api/v1/`, no `openapi*`, no `swagger*`, no `sdk/` directory in the repository.
- `public/` — 0 occurrences.
- Both producing routes are session-authenticated organizer endpoints reached only by the
  dashboard bundle.

The field name is therefore **internal**, and no compatibility guarantee is owed to anyone
outside this repository.

---

## Q. Null / Zero / Unavailable Contract

The three states finalized by RD-12-17, and every consumer's behaviour:

| Consumer | authorized `0` | read-failed (`0` + flag) | unauthorized `null` |
|---|---|---|---|
| `revenueDisplay` | `₹0` | `—` unavailable | `—` unavailable (checked **first**) |
| `revenueMetric` | `₹0` | `—`, no sub | `—` + "Requires finance access" |
| `ReportsTab` | figure | `—` "could not be loaded" | `—` "requires finance access" |
| `EventCommandCenter` | figure | `—` | `—` (both fold into `ticketRevenuePaise === null`) |

**No consumer assumes `null === 0`.** A repository search for `estimatedRevenue ?? 0`,
`|| 0` and `Number(...)` coercion returns nothing.

**One nuance worth recording for the migration:** `EventCommandCenter` deliberately collapses
"read failed" and "unauthorized" into a single `ticketRevenuePaise === null`, because that dense
header has no room to explain either. That is correct today and must survive a rename unchanged
— a migration that "tidies" it into two branches would be a behaviour change smuggled into a
naming change.

---

## R. Canonical Financial Source

| | `EventListItem.estimatedRevenue` | `financial.confirmedRevenuePaise` |
|---|---|---|
| Counter source | `registrationCounters.revenuePaise` | — |
| Ledger source | `sumConfirmedRevenueFromLedgerChecked` | `sumConfirmedRevenueFromLedgerChecked` |
| Refund treatment | refund-stable | refund-stable |
| Unit | paise | paise |
| Permission | `transactions` | `transactions` (`financialAllowed`) |
| Unavailability | sibling boolean | in-band `{ok:false, reason}` |
| Denial | `null` | whole block absent |

**Same value, same definition, same permission.** `confirmedRevenuePaise` therefore describes
`estimatedRevenue` accurately — which is precisely why the collision matters.

---

## S. Naming Options

| Option | Semantic accuracy | Unit clarity | Convention fit | Developer safety | Migration cost |
|---|---|---|---|---|---|
| **A. `confirmedRevenuePaise`** | **exact** | **explicit** | matches `donationTotalPaise`, `revenuePaise`, `platformFeeBasePaise`, and the Analytics field | high — kills the unit hazard in §G | 6 source + 14 test files |
| B. `confirmedRevenue` | exact | **none** — the sibling it is added to is `donationTotalPaise` | weaker; `normalize.ts` uses this name for a `MaybeMoney` | **lower** — reintroduces the unit ambiguity | same |
| C. `revenuePaise` | partial — omits "confirmed", and the platform has several revenues | explicit | collides with `registrationCounters.revenuePaise`, a different layer | medium | same |
| D. keep `estimatedRevenue` | **wrong** — it is not an estimate | none | none | low — the defect stands | zero |

**Recommended: A — `confirmedRevenuePaise`.**

The `Paise` suffix is not decoration. §G shows the one arithmetic site adds this field to
`donationTotalPaise`; a name that carries its unit is what makes that line self-checking. And
the repository convention is unambiguous — money fields carry the unit.

**The collision is a condition, not a veto.** Two fields would then share a name and a meaning
while differing in type (`number | null` vs `MaybeMoney`) and in how they express denial. That
must be handled deliberately (P1-1): cross-referencing JSDoc at both declarations, and a test
asserting the two resolve to the same figure for the same event. Choosing a *different* name to
dodge the collision would leave the codebase with three names for one number, which is worse.

---

## T. Migration Strategy Options

| Strategy | Compatibility | Risk | Complexity | Stale-field risk | Rollback |
|---|---|---|---|---|---|
| **A. Hard rename** | none needed (no external consumers, §P) | **medium** — one deploy where a cached bundle could read the old name | low — 6 source files | none | revert the commit |
| **B. Dual field** (both emitted) | total | **low** | medium — two fields to keep in sync | **high** — a "temporary" field that outlives the migration is how `estimatedRevenue` survived this long | drop the new one |
| **C. Internal rename only** | total | **lowest** | low | none | trivial |
| D. Versioned API | total | high | high — a version axis for one field | high | complex |
| E. Alias / deprecation period | total | low | medium | high, as B | drop the alias |

**Recommended: C, then B, then removal — a three-step sequence, not one of the five.**

1. **C first.** Rename every *internal* identifier — local variables, the display resolvers'
   parameters, JSDoc — while the wire field keeps its name. Zero contract risk, and it moves
   most of the diff out of the risky step.
2. **B briefly.** Emit both fields from both routes for one deploy, with the old one marked
   `@deprecated`, so a browser holding a cached bundle across a rolling deploy cannot render a
   dash where a figure belongs (§W).
3. **Remove** the old field once no consumer references it, verified by a repository search that
   is itself the acceptance criterion.

Hard rename (A) is *defensible* here — there are no external consumers and the field is
display-only — and it is the right call if the deploy can be treated as atomic. The dual-field
step exists only to make the rolling-deploy window safe; it must be time-boxed to one phase, and
step 3 must be part of the same approved plan, or it becomes the very stale field it is meant to
avoid.

---

## U. Recommended Migration Strategy

**Internal-first (C) → one dual-field deploy (B) → removal**, with:

- the type unchanged at `number | null`;
- `revenueUnavailable` **not** renamed and **not** merged into the value;
- the three-state contract from RD-12-17 preserved exactly;
- cross-referencing JSDoc added at both `confirmedRevenuePaise` declarations (list/detail and
  Analytics) stating that they are the same figure in different encodings.

---

## V. Recommended Migration Order

Derived from this codebase's actual dependency direction (types are declared in the routes and
imported by consumers, so the type must move first or nothing compiles):

1. **Analytics cross-reference JSDoc** — document the two encodings *before* creating the second
   `confirmedRevenuePaise`, so the collision is explained the moment it exists.
2. **Producers' type declarations** — `EventListItem` and `EventDetailResponse`, both routes,
   emitting **both** fields (dual-field step).
3. **Producers' assignments** — the two gated expressions.
4. **Consumers** — `presentation.ts`, `eventOverview.ts`, `ReportsTab.tsx`,
   `EventCommandCenter.tsx` (the donation sum last, and reviewed on its own).
5. **Fixture** — `scripts/verify-eventsetup.ts`.
6. **Tests** — 14 files (§X), source-contract assertions last because they pin exact strings.
7. **Verify** — full unit suite, `tsc`, build, and the emulator boundary test unchanged and
   passing.
8. **Remove the old field** from both routes and both types.
9. **Final repository search** — `estimatedRevenue` must return only historical documents.

There is **no adapter or normalization layer** between producer and consumer for this field, so
step 4 is a direct rename with no intermediate mapping to keep in sync.

---

## W. Rollback Strategy

- **API compatibility required?** Not for external consumers (§P). It *is* required across a
  **rolling deploy**: Vercel serves old and new bundles concurrently, so for a window a cached
  client could request the new API and read the old field name — rendering `—` on a surface that
  should show a figure. Not a security failure; a visible, confusing one.
- **Dual fields necessary?** For that window only. That is their entire justification.
- **Deploy ordering:** server before client. With dual fields emitted, order stops mattering,
  which is the point.
- **Mixed versions:** safe during the dual-field window; unsafe with a hard rename mid-rollout.
- **Rollback:** during steps 1–7, revert the commit — the old field is still emitted and every
  consumer still works. After step 8, rollback means re-adding the field, so **step 8 should be
  its own commit** and ideally its own deploy.

---

## X. Test Migration Requirements

**14 test files**, by kind:

| Kind | Files | Must change |
|---|---|---|
| **Boundary / authorization** | `organizerRevenueBoundary` (22 refs), `organizerDataBoundary.emu` (6) | **Yes** — these pin the gate expressions and the null tail by exact string |
| **API / source-contract** | `eventsLanding` (8), `eventOverview` (6) | **Yes** — pin the type and the response literal |
| **UI** | `eventCommandCenter` (3), `eventHome` (4), `eventOverviewTab` (2) | **Yes** — `eventHome` counts occurrences of the identifier |
| **Fixtures only** | `attendance`, `dashboardArchivedScope`, `eventConference`, `eventDeletion`, `eventSetupCenter`, `passes`, `registrationSearch` (1 each) | **Yes**, mechanically — a field name in an object literal |

No snapshots reference the field. The emulator test asserts payload keys and must move with the
contract; it is also the best proof the migration is semantics-preserving, so it should be run
**unchanged first** (to confirm the dual-field step is transparent) and only then updated.

---

## Y. Browser Contract

The field name **is** observable in the browser: it appears in the JSON of both routes'
responses and, through `EventListItem`/`EventDetailResponse`, in React props and component
state. It is not persisted in `localStorage` or any client cache the repository manages.

RD-12-17's browser validation already read these payloads directly — it asserted
`"estimatedRevenue": null` on the wire for a manager — so the contract is confirmed observable.
No visual change is proposed or needed here.

---

## Z. Security Review

The rename is **semantics-preserving** and touches no control:

| Property | Effect |
|---|---|
| `transactions` authorization | unchanged — the gate expression moves with the field, the permission does not |
| Financial exposure | unchanged — same value to the same roles |
| Null semantics | **must be preserved exactly**; the risk is a migration that "tidies" `null` into `0` or into `revenueUnavailable`, which would undo RD-12-17 |
| Workspace isolation | untouched — tenancy is the route's path scoping |
| Event authorization | untouched |
| Financial gates | untouched |

**The one security-relevant risk is regression, not exposure**, and it is why §V puts the
boundary tests last and requires the emulator test to pass unchanged at the dual-field step.

---

## AA. Admin Boundary

**Admin does not consume the Organizer field.** Zero occurrences of `estimatedRevenue` in
`app/(admin)`, `app/api/admin` and `lib/admin` — re-verified, confirming RD-12-16.

Admin **does** consume `confirmedRevenuePaise` — but the Analytics one:
`app/(admin)/admin/events/[slug]/PageClient.tsx:258,477` reads
`a.financial?.confirmedRevenuePaise` through `MaybeMoney`. That is a different producer on a
different contract and is unaffected by an Organizer rename.

It does, however, sharpen P1-1: after the migration, `confirmedRevenuePaise` would name a
`MaybeMoney` in Admin and a `number | null` in the Organizer event list. **No Admin change is
proposed or permitted.**

---

## AB. Firestore Impact

**None.** The field is a response-shape name only; it is never a document key. The stored keys
are `registrationCounters.revenuePaise` and the ledger's `amount`, neither of which the rename
touches. No rule, index, schema or data migration is required — and none was made.

---

## AC. Findings by Severity

### P0
**None.** No security or correctness defect. RD-12-17 closed the data-boundary issue; what
remains is naming.

### P1

**P1-1 · The proposed name is already in use for the same concept with a different type**
*Severity:* P1 — a naming collision on a money field.
*Evidence:* `lib/analytics/eventAnalytics.ts:170` declares
`confirmedRevenuePaise: MaybeMoney` on `EventAnalytics.financial`; line 949 derives it from
`sumConfirmedRevenueFromLedgerChecked` — the same helper the events routes use (line 697 there,
the ledger fallback here). `lib/analytics/normalize.ts:309` maps it onward as
`confirmedRevenue`.
*Affected files:* `lib/analytics/eventAnalytics.ts`, `lib/analytics/normalize.ts`,
`app/(dashboard)/dashboard/analytics/page.tsx`, `app/api/organizer/analytics/[eventId]/route.ts`,
`app/(admin)/admin/events/[slug]/PageClient.tsx` — **none of which may be modified**.
*Affected consumers:* every future reader of either field.
*Impact:* Two fields, one name, one meaning, two shapes — `number | null` versus `MaybeMoney` —
and two different ways of saying "no value". A developer would reasonably treat them as
interchangeable and be wrong about money.
*Recommendation:* Proceed with the name, and **make the difference explicit**: cross-referencing
JSDoc at both declarations, plus a test asserting both resolve to the same figure for the same
event. Do not dodge the collision with a third name.
*Future phase:* RD-ANALYTICS-12-19, step 1.

### P2

**P2-1 · The field name omits its unit at the one site where it is added to a `Paise` sibling**
*Evidence:* `EventCommandCenter.tsx` — `formatINR(ticketRevenuePaise + event.donationTotalPaise)`.
Correct today; the name is what makes it unverifiable at a glance.
*Impact:* The shape of a unit bug, prevented only by the value happening to be paise.
*Recommendation:* The `Paise` suffix. This is the strongest single argument for option A.
*Future phase:* 12-19.

**P2-2 · "Estimated" is factually wrong and survives only for contract stability**
*Evidence:* Both route declarations say so in their own comments.
*Impact:* Developer-facing only — **no UI string says "estimated"** (§J), so no user is
misled today.
*Recommendation:* The rename. Confirms the P2 grading from RD-12-16.
*Future phase:* 12-19.

**P2-3 · The three-state contract is pinned by exact-string assertions in two boundary tests**
*Evidence:* `organizerRevenueBoundary.test.ts` matches `estimatedRevenue: number | null = financeAllowed…: null`
and `estimatedRevenue: financeAllowed ? revenuePaise : null` verbatim.
*Impact:* The rename necessarily rewrites the tests that protect the security property, in the
same change — the classic window for a silent regression.
*Recommendation:* Run the **emulator** boundary test unchanged at the dual-field step; it
asserts payload values rather than source strings and is therefore independent of the rename.
*Future phase:* 12-19, and it should be the acceptance gate.

### P3

**P3-1 · `revenueUnavailable` does not carry its unit or its subject** — a sibling flag named
for the field it describes. Renaming it too would widen the diff for no correctness gain.
*Recommendation:* Leave it; document the pairing.

**P3-2 · One fixture outside `tests/`** — `scripts/verify-eventsetup.ts:34` sets
`estimatedRevenue: 0`. Easy to miss because it is not a test file.
*Recommendation:* Include it in the migration checklist explicitly.

**Counts: P0 = 0 · P1 = 1 · P2 = 3 · P3 = 2. Total 6.**

---

## AD. Future Implementation Specification

| | |
|---|---|
| **Rename** | `estimatedRevenue` → `confirmedRevenuePaise` |
| **Type** | `number \| null` — **unchanged**, not `MaybeMoney` |
| **Routes** | `/api/organizer/events` and `/api/organizer/events/[eventId]` — **both, together** |
| **Permission** | `transactions` — unchanged |
| **Three states** | `0` / `0`+`revenueUnavailable` / `null` — **preserved exactly** |
| **`revenueUnavailable`** | not renamed, not merged into the value |
| **Strategy** | internal rename → one dual-field deploy → removal (§U) |
| **Order** | the nine steps in §V |
| **Source files** | 6 + 1 script |
| **Test files** | 14 |
| **Not touched** | Analytics, Reports, Finance, Admin, permissions, Firestore, UI copy |
| **Acceptance** | `organizerDataBoundary.emu.test.ts` passes **unchanged** at the dual-field step; a repository search for `estimatedRevenue` returns only historical documents after step 8 |

---

## AE. Explicit Non-Goals

Not changed: `estimatedRevenue` (not renamed), `confirmedRevenuePaise` (not added), any type,
API route, response contract, component, UI copy, test, fixture, Analytics, Reports, Finance,
Admin, permission, `ROLE_PERMISSIONS`, authorization helper, revenue calculation, ledger or
refund logic, `firestore.rules`, `firestore.indexes.json`. No compatibility alias was created,
no field added, no field removed.

---

## AF. Files Inspected

**Producers:** `app/api/organizer/events/route.ts` · `app/api/organizer/events/[eventId]/route.ts`

**Consumers:** `app/(dashboard)/dashboard/events/presentation.ts` · `lib/events/eventOverview.ts` ·
`app/(dashboard)/dashboard/events/[eventId]/EventCommandCenter.tsx` ·
`app/(dashboard)/dashboard/events/[eventId]/tabs/ReportsTab.tsx` · `scripts/verify-eventsetup.ts`

**Collision surface:** `lib/analytics/eventAnalytics.ts` · `lib/analytics/normalize.ts` ·
`app/(dashboard)/dashboard/analytics/page.tsx` · `app/api/organizer/analytics/[eventId]/route.ts` ·
`app/(admin)/admin/events/[slug]/PageClient.tsx` *(read only, to prove non-involvement)*

**Canonical source:** `lib/firebase/firestore/registrationCounters.ts` · `lib/finance/gatewayFee.ts`
(`MaybeMoney`) · `lib/registrations/types.ts`

**Scope checks:** `components/dashboard/EventContextProvider.tsx` ·
`components/dashboard/EventSelector.tsx` · `lib/events/eventContext.ts`

**Tests:** the 14 files listed in §X.

---

## AG. Verification Performed

1. `git rev-parse --short HEAD` → `b7e5fdf`; `git status --short` before and after.
2. **Repository-wide `estimatedRevenue` search** (ripgrep, build output excluded) → **137
   occurrences across 25 files**, grouped by file and classified.
3. Related-term searches: `confirmedRevenuePaise` (**14 files — the collision**),
   `confirmedRevenue` (18), `revenuePaise` (61), `revenueUnavailable` (16),
   `registrationCounters.revenuePaise` (5).
4. **Module-boundary searches** — `estimatedRevenue` in `components/analytics`, `lib/analytics`,
   `lib/reports`, `app/api/organizer/reports`, `app/api/organizer/finance`,
   `app/(dashboard)/dashboard/finance`, `app/api/admin`, `app/(admin)`, `lib/admin` → **0 in
   every one**.
5. **External-contract searches** — `app/api/public`, `app/api/webhooks`, `public/` → 0; no
   `app/api/v1`, no `openapi*`/`swagger*`/`sdk/`.
6. Producer trace: both routes read end to end, including the gate expressions and the
   counter/ledger resolution.
7. Unit trace: `fmtINR` (`presentation.ts:32`) and `formatINR` (`eventOverview.ts:90`) — both
   divide by 100 and name the parameter `paise`.
8. **Null-coercion search** — `estimatedRevenue ?? 0`, `|| 0`, `Number(...)` → **none**.
9. **Sort/filter search** — no sort or filter on the field anywhere.
10. **`EventContextProvider` / `EventSelector` / `eventContext.ts` re-verified → 0 occurrences.**
11. Analytics derivation read (`eventAnalytics.ts:696-949`) confirming both fields resolve
    through `sumConfirmedRevenueFromLedgerChecked`.
12. `MaybeMoney` shape read (`lib/finance/gatewayFee.ts:14-24`).
13. Type inventory across both route files; import-count for the two response types (36 files).

**Not run:** no test suite, no `tsc`, no ESLint, no build, no browser, no emulator. No source
changed, so none was warranted — and none is claimed.

---

## AH. Source Changes

**One file created: `docs/RD-ANALYTICS-12-18-AUDIT.md`.**

No source, type, test, fixture, script, config, Firestore or Admin file was created, modified or
deleted. No temporary scripts were written in this phase.

Unrelated concurrent work exists in the tree (`components/marketing/*`,
`tests/unit/screenshotShowcase.test.ts`, and `.next-8c` entries in `tsconfig.json` from another
session's build). It was neither modified nor reverted, and is distinct from this phase's single
document.

---

## AI. Git / Deployment Status

- **Commit:** not committed. HEAD `b7e5fdf`, nothing staged.
- **Push:** not pushed.
- **Deployment:** none.
- **Firestore rules / indexes:** unchanged, not deployed. The RD-12-07 and RD-12-11 index
  definitions both remain undeployed.

---

## AJ. Final Verdict

**APPROVED WITH CONDITIONS**

The value is consistently canonical confirmed revenue (§C, §R), `confirmedRevenuePaise`
describes it accurately, there are no external consumers, no database change is implied, and the
migration surface is small and shallow — display-only, with one arithmetic site and no adapter
layer.

Conditions:

1. **Resolve the name collision deliberately (P1-1).** `confirmedRevenuePaise` already exists on
   the Analytics contract as `MaybeMoney`. Ship cross-referencing JSDoc at both declarations and
   a test asserting the two agree for the same event — in the same phase, ideally first.
2. **Both routes in one change.** Migrating the list without the detail leaves two names for one
   concept.
3. **The type stays `number | null`,** and the three-state contract from RD-12-17 is preserved
   exactly. Do not merge `null` into `revenueUnavailable`, and do not widen to `MaybeMoney` —
   either would be a semantics change wearing a rename's clothes.
4. **The emulator boundary test must pass unchanged** at the dual-field step. It asserts payload
   values rather than source strings and is the only check independent of the rename itself.
5. **Field removal is its own commit** (§W), because rollback after it is no longer a revert.

No stop condition was triggered: the value is consistent, the name is accurate, no external
consumer exists, no database, permission, Analytics or Reports authorization change is required,
and Admin has no dependency on the Organizer contract.

---

## AK. Recommended Next Phase

**RD-ANALYTICS-12-19 — Revenue Contract Migration (implementation).**

Scope: the specification in §AD, in the order in §V, under the five conditions in §AJ. Step 1
(the Analytics cross-reference) and step 8 (old-field removal) should be separate commits within
the phase so the risky ends are independently revertable.

This is the last item on the RD-ANALYTICS-12-1x sequence: with it, the misleading name is gone,
the money boundary is enforced, and the Organizer revenue contract says what it means.

---

## AL. Completion Checklist

- [x] Fresh repository-wide trace performed — not inherited from the prior report
- [x] Semantics established from source (units, refunds, zero, unavailable, authorization)
- [x] Producer map complete (2 producers)
- [x] API contract inventory complete (2 routes)
- [x] Type system inventory complete
- [x] Unit analysis complete, including the one arithmetic site
- [x] Complete consumer inventory (25 files, 137 occurrences)
- [x] Every consumer classified
- [x] UI consumers analysed; no copy change proposed
- [x] Event list re-verified, incl. EventContextProvider (0 occurrences)
- [x] Event detail chain traced
- [x] Analytics dependency established (**0** — but the name collides)
- [x] Reports dependency established (**0**)
- [x] Finance dependency established (**0**)
- [x] Public / external contract established (**none**)
- [x] Semantic-neighbour searches performed
- [x] Null / zero / unavailable contract audited per consumer
- [x] Canonical financial source compared
- [x] Four naming options evaluated, one recommended
- [x] Five migration strategies evaluated, one recommended
- [x] Migration order derived from the actual dependency direction
- [x] Rollback strategy defined, incl. rolling-deploy risk
- [x] Test migration scope enumerated (14 files)
- [x] Browser contract confirmed
- [x] Security review — semantics-preserving
- [x] Admin boundary re-verified; no Admin change
- [x] Firestore impact — none
- [x] Findings classified P0–P3
- [x] No implementation performed
- [x] No rename, no alias, no new field, no removed field
- [x] No permissions, Analytics, Reports, Finance, Admin or Firestore changes
- [x] No temporary scripts created
- [x] No deployment, commit or push
