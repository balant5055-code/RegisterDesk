# RD-ANALYTICS-12-17 — Organizer Data-Boundary Fixes

**Organizer workspace only.** Admin untouched. No permission created, no `ROLE_PERMISSIONS`
change, no field renamed, no Firestore change. Not committed, not pushed, not deployed.

---

## 1 · Phase

Implement the two data-boundary corrections approved by RD-ANALYTICS-12-16, kept as two
logically separate changes so the financial one can be reverted on its own.

## 2 · Original 12-16 findings

| Finding | Severity | Boundary |
|---|---|---|
| **P1-1** `estimatedRevenue` — canonical confirmed revenue returned to every workspace member, on **two** routes | P1 | `transactions` |
| **P3-1** `attendeeName` — returned by the shared activity reader with no permission check | P3 | `registrations` **OR** `transactions` |

## 3 · Change A — `estimatedRevenue`

The field's name says estimate. Its own declaration says otherwise: *"CANONICAL confirmed
revenue (registrationCounters.revenuePaise / ledger fallback); field name kept for contract
stability"*. Refund-stable, ledger-backed money — and `admin` and `manager`, who hold no
`transactions`, received it while `/api/organizer/finance` refuses them and Analytics answers
`financialAllowed: false`.

The same figure has been gated on `/api/organizer/dashboard` since RD-DASH-12
(`revenuePaise: financeAllowed ? … : null`). Two endpoints, one data class, two answers. Both
now agree.

**Authorized** → the existing canonical value, unchanged. **Unauthorized** → `null`.

## 4 · Change B — `attendeeName`

Not a leak being closed. The audit graded it P3 because RD-DASH-12 audited this exact row,
removed `attendeeEmail` and **deliberately kept the name**; `lib/metadata/registry.ts` classes
email and phone `sensitive: true` and the name not; and every role that reaches the reader
already has a sanctioned path to attendee names — owner/admin/manager via `registrations`,
finance via `transactions` (`/api/organizer/payment-issues` returns names under exactly that
permission).

So this replaces an implicit boundary with an explicit, tested one. **No role loses access
today.** Its value is that the next role added cannot inherit participant names by default.

## 5 · Exact routes changed

| Route | Change |
|---|---|
| `GET /api/organizer/events` | A — `financeAllowed` gate; `estimatedRevenue: number \| null`; ledger fallback skipped when denied |
| `GET /api/organizer/events/[eventId]` | A — same gate, same null tail, ledger fallback skipped |
| `GET /api/organizer/dashboard` | B — passes `canReadAttendeeName`; `DashboardActivity.attendeeName: string \| null` |
| `GET /api/organizer/dashboard/activity` | B — passes `canReadAttendeeName` |

`/api/organizer/dashboard`'s own **route-level** boundary is untouched — still
`authorizeAnyWorkspace`. Change B gates a field, not the route.

## 6 · Exact shared readers / helpers changed

| File | Change |
|---|---|
| `lib/dashboard/activityFeed.ts` | B — `ActivityScope.canReadAttendeeName: boolean` (**required**); conditional `select`; `attendeeName: string \| null` |
| `app/(dashboard)/dashboard/events/presentation.ts` | A — `revenueDisplay` null branch |
| `lib/events/eventOverview.ts` | A — `revenueMetric` null branch with a reason |
| `components/dashboard/RecentActivityCard.tsx` | B — `ActivityRow.attendeeName: string \| null`; subject-less title fallback |
| `…/events/[eventId]/EventCommandCenter.tsx` | A — `ticketRevenuePaise` guard; Combined never sums a missing figure |
| `…/events/[eventId]/tabs/ReportsTab.tsx` | A — `revenueRestricted` folded into the existing `revenueKnown` |

No parallel authorization logic, no duplicated calculation, no new Firestore query.

**`canReadAttendeeName` is required, not optional-defaulting-false.** A default in either
direction lets a future entry point inherit a decision silently; the compiler now forces every
caller to state it — and it did, immediately, by failing on both existing callers.

## 7 · Permission boundaries

| Data | Permission | Denied response |
|---|---|---|
| `estimatedRevenue` | `transactions` | `null` |
| `attendeeName` | `registrations` **OR** `transactions` | `null` |

The union is not a convenience. Gating on `registrations` alone would blank names on finance's
dashboard while `/dashboard/finance/payment-issues` three clicks away kept showing them.

## 8 · Role matrix — measured, not assumed

| Role | `transactions` | `registrations` | events list revenue | detail revenue | attendee name |
|---|---|---|---|---|---|
| owner | ✅ | ✅ | **value** | **value** | ✅ |
| finance | ✅ | ❌ | **value** | **403 at the route** | ✅ (via `transactions`) |
| admin | ❌ | ✅ | **null** | **null** | ✅ |
| manager | ❌ | ✅ | **null** | **null** | ✅ |
| checkin_lead | ❌ | ❌ | 403 | 403 | never reaches the reader |
| checkin_staff | ❌ | ❌ | 403 | 403 | never reaches the reader |

**Finance is refused the event DETAIL route entirely** — it authorizes with
`authorizeWorkspace(req, 'events')`, which RD-12-15 reconciled for the analytics routes and the
events *list* only. Pre-existing, unchanged here, and asserted rather than assumed: the first
emulator run expected finance to reach it, which would have been a false claim that 12-15
widened that route.

**No role lost attendee-name access.** Every role that reaches the reader holds one of the two
permissions.

## 9 · Response behaviour

```
AUTHORIZED   estimatedRevenue: <canonical value>      attendeeName: "<name>"
UNAUTHORIZED estimatedRevenue: null                   attendeeName: null
```

Three states, kept distinct:

| State | `estimatedRevenue` | `revenueUnavailable` |
|---|---|---|
| authorized, event earned nothing | `0` | `false` |
| authorized, read failed | `0` | `true` |
| **not authorized** | **`null`** | **`false`** |

`revenueUnavailable` is **not** overloaded as the denial signal. A denied caller told "could
not be read" would be told the platform has a problem, which is false.

**Authorization precedes the read where the read is purely financial.** `getEventStats` still
runs for everyone — it carries the registration counts, which are not financial — but the
ledger aggregate (`sumConfirmedRevenueFromLedgerChecked`) is money only and is not issued for
an unauthorized caller. Likewise `attendee.name` is dropped from the `select()`, so the name is
never read, never serialised and never hidden client-side.

## 10 · UI fallback behaviour

| Surface | Withheld revenue | Withheld name |
|---|---|---|
| Events list card | `—`, muted (one dense row, no space to explain) | — |
| Event Overview metric | `—` + **"Requires finance access"** | — |
| Event Command Center header | `—` + screen-reader "Unavailable"; **Combined never sums a missing figure** | — |
| Event Reports tab | `—` + "requires finance access" | — |
| Recent Activity card | — | **"A registration" / "A check-in"** |

The activity fallback names no one — not an email, not a phone, not the registration id, not an
invented name. The row still says what happened and where; only who is missing.

No layout, styling or component was redesigned.

## 11 · Tests added / changed

**New, and deliberately separate:**

| File | Cases | Covers |
|---|---|---|
| `tests/unit/organizerRevenueBoundary.test.ts` | **24** | Change A: the gate on both routes, the null tail, `revenueUnavailable` not overloaded, the skipped financial read, the calculation unchanged, the role matrix, and all three display states driven through the real pure resolvers |
| `tests/unit/organizerActivityNameBoundary.test.ts` | **19** | Change B: the union, the required scope field, the conditional `select`, no substituted PII, the card fallback, and that no role loses access |
| `tests/emulator/organizerDataBoundary.emu.test.ts` | **13** | Both changes end to end — real Auth users, real tokens, real `teamMembers` rows, real handlers, two workspaces |

**Updated deliberately — 9 existing cases across 7 files**, each with a comment saying what it
defends and why the assertion moved. None deleted, none weakened:

| File | What moved |
|---|---|
| `eventsLanding.test.ts` | `revenueUnavailable` gained `financeAllowed &&`; the no-slug rule it defends is unchanged |
| `dashboardRecentActivity.test.ts` ×2, `dashboardEventScope.test.ts` | the `select(...)` is now conditional; still asserts a fixed field list, never a whole document |
| `dashboardActivityPaging.test.ts` | tripped by the word "placeholder" in my own comment — comment reworded, test untouched |
| `eventHome.test.ts` ×2 | counts the *rendered* value now that the raw field is read once to derive it |
| `eventOverview.test.ts` | type widened; the meaning note moved into a JSDoc, so it is asserted against the raw file |
| `eventOverviewTab.test.ts` | the Combined guard is now `ticketRevenuePaise === null`, which covers both causes |
| `organizerAnalyticsAuthorization.test.ts` (mine, 12-15) | asserted the dashboard had *no* `registrations` check — 12-17 is the phase that adds one |

## 12 · Focused test results

`organizerRevenueBoundary` **24 passed** · `organizerActivityNameBoundary` **19 passed** ·
with `dashboardMoneyGate` + `eventsLanding`: **169 passed**.

## 13 · Full unit result

**342 files — 9,260 passed, 1 skipped, 0 failed.**

## 14 · TypeScript

**PASS** — `npx tsc --noEmit`, 0 source errors.

Two stale generated directories (`.next-verify`, and `.next-8c` created by a concurrent
session mid-build) emit `TS6053`/`TS2344` from `tsconfig.json` include globs. Neither is a
source file, neither is mine, and both predate or belong to that session. Source is clean.

## 15 · ESLint

**PASS on every file this phase touched** — 0 errors, 0 warnings across all 13.

The repository-wide pre-existing failures in admin-finance, communications and event-tab
components are unchanged and were not fixed.

## 16 · Build

**PASS** — `npm run build`, exit 0, 72s, 312 static pages.

## 17 · Emulator result

`organizerDataBoundary.emu.test.ts` — **13 passed**; with `organizerAnalyticsAuthz`,
**26 passed**. Real tokens, real membership documents, real handlers.

| Proof | Result |
|---|---|
| owner + finance receive the revenue from the list | `4820000` |
| **admin + manager receive `null`**, and the amount appears nowhere in the payload | ✅ |
| **an authorized zero is still `0`** while the denied caller gets `null` for the same event | ✅ |
| a denied caller is not told the read failed (`revenueUnavailable` falsy) | ✅ |
| non-financial fields unaffected (`totalRegistrations: 10`) | ✅ |
| the **detail** route: owner value, admin/manager null, finance 403 at the route | ✅ |
| gate roles reach neither route | 403 |
| every role that reaches the dashboard still gets names | ✅ |
| no `attendeeEmail` / `attendeePhone` in the dashboard payload | ✅ |
| the dashboard's own money gate untouched (`finance.allowed` true/false) | ✅ |

Two fixture bugs were found and fixed along the way, both mine, neither a code defect: the
counter fixture omitted `eventSlug`/`updatedAt`, and the draft fixture put the slug at the top
level when both routes read `eventDetails.seo.urlSlug`. Each made every authorized figure
return 0, which *looked* like a gating bug.

## 18 · Browser result

Emulator build served on 3187, three roles, screenshots read.

| Check | Result |
|---|---|
| **manager payloads on the wire** | `estimatedRevenue: null` from **both** `/api/organizer/events` and `/events/[id]` |
| a numeric `estimatedRevenue` sent to a denied role | **never** |
| rupee figure rendered for manager (list / detail) | **none** |
| manager event header | reads **"— revenue"** — a dash, not `null`, not `₹0` |
| literal `null` / `undefined` / `NaN` anywhere | **none** |
| recent activity rendered for all three roles | ✅ |
| overflow at 1440 / 834 / 390 | 0px / 0px / 0px |

Console 404/403 entries were observed and attributed: `/registrations` 404 because the fixture
event has no registrations subcollection, and 403 for finance on the event detail — the
pre-existing `events` boundary (§8), which emulator case 5 asserts. **Neither is caused by this
phase.**

## 19 · Cross-workspace result

Unaffected and re-proved. No workspace-A role sees workspace B's event or its revenue; B's
owner sees only their own, with the value intact. Tenancy still derives from the session and is
expressed as a document path in both routes.

## 20 · Analytics regression result

**None.** `financialAllowed` still decides money, the reads are still not issued, and
`authorizeAnyWorkspace` is still the analytics boundary — asserted by
`organizerRevenueBoundary` case 22 and by the 26 passing analytics/authorization emulator
cases. Manager denial, owner access and finance access are all unchanged.

## 21 · Reports regression result

**None.** No Reports route, builder, registry, catalogue, export or history was touched. The
full unit suite includes every Reports test (`reportExportAuthorization`, `reportHistoryReader`,
`reportsWorkspacePresentation`, `reportsHistoryUi`, `reportRegistryMetadata`) and all pass.

## 22 · Admin impact

**None, provably.** No file under `app/(admin)`, `app/api/admin` or `lib/admin` was modified —
a `find` for anything changed in this phase's window returns nothing. The 12-16 audit
established Admin consumes neither endpoint, and Admin uses none of the organizer authorization
helpers.

## 23 · Firestore status

**Unchanged.** `firestore.rules` mtime 3 Sept, `firestore.indexes.json` 8 Sept — both predate
this phase's first edit at 14:22. No rule, index, collection or schema touched; nothing
deployed. No index became necessary: both changes gate existing reads and add none.

## 24 · Files changed

**Change A (revertable on its own):** `app/api/organizer/events/route.ts` ·
`app/api/organizer/events/[eventId]/route.ts` ·
`app/(dashboard)/dashboard/events/presentation.ts` · `lib/events/eventOverview.ts` ·
`app/(dashboard)/dashboard/events/[eventId]/EventCommandCenter.tsx` ·
`app/(dashboard)/dashboard/events/[eventId]/tabs/ReportsTab.tsx` ·
`tests/unit/organizerRevenueBoundary.test.ts` *(new)*

**Change B:** `lib/dashboard/activityFeed.ts` · `app/api/organizer/dashboard/route.ts` ·
`app/api/organizer/dashboard/activity/route.ts` ·
`components/dashboard/RecentActivityCard.tsx` ·
`tests/unit/organizerActivityNameBoundary.test.ts` *(new)*

**Both:** `tests/emulator/organizerDataBoundary.emu.test.ts` *(new)* ·
`scripts/qa/rd-analytics-12-17-shots.mjs` *(new)* · this document ·
9 updated cases in 7 existing test files.

Every other modified file in the tree carries an mtime predating 14:22 or belongs to a
concurrent session (`components/marketing/*`, `tests/unit/screenshotShowcase.test.ts`, and that
session's `.next-8c` entries in `tsconfig.json`). None was touched, reverted or overwritten;
`tsconfig.json` had only my `.next-a1217` entries removed, and `.next-a1217` was deleted.

## 25 · Known limitations

1. **`estimatedRevenue` is still misnamed.** RD-12-16 graded this P2; renaming is a contract
   change across 18 consumers and was explicitly out of scope. The JSDoc on both routes now
   says plainly that the value is not an estimate.
2. **Finance cannot open the event detail route at all**, so the field gate never applies to it
   there. Pre-existing (`authorizeWorkspace(req, 'events')`), out of scope, now documented and
   asserted.
3. **The list card shows only a dash** when revenue is withheld, with no explanation — the row
   has no space for one. The Overview metric and the Reports tab, which do, say why.
4. **The browser could not distinguish the two "no figure" causes visually.** Both render `—`
   on the compact surfaces by design; the payload-level assertions and the emulator test are
   what separate them.
5. **`sourceId` (a registration id) is still returned** to every dashboard reader. RD-12-16
   graded it P3-2 and recommended leaving it: it is a stable React key with a real destination,
   and the routes it addresses authorize independently.

## 26 · Recommended next phase

**RD-ANALYTICS-12-18 — `estimatedRevenue` contract migration** (P2-1): rename to
`confirmedRevenuePaise` across its 18 consumers, now that the value is correctly typed
`number | null` and gated. Purely a naming/contract change with no security content, which is
why it should not have ridden along with this one.

Lower priority, from RD-12-16: **P2-3**, the event list ships one money field to twelve
consumers to serve four — largely resolved by this phase's gate, fully resolved only by a
response projection.

---

**Explicitly:** Organizer-only · Admin unchanged · no new permission · no `ROLE_PERMISSIONS`
change · `estimatedRevenue` not renamed · Reports and Finance untouched · no Firestore change ·
no deployment · no commit · no push.
