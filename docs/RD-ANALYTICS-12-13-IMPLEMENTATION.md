# RD-ANALYTICS-12-13 — Navigation Surfacing Implementation

**Status:** complete. Navigation and terminology only. **No route moved, no redirect was added,
no authorization changed.** Not committed, not pushed, not deployed.

---

## A. Objective

Make two already-built workspaces findable, and stop five affordances lying about where they
lead. Nothing was built; things were connected.

## B. Audit Findings Used

From RD-ANALYTICS-12-12 (APPROVED WITH CONDITIONS):

| Finding | What this phase did |
|---|---|
| **P0-1** Five Analytics modules had **zero** navigable references product-wide | Sidebar Analytics now points at the canonical workspace; a module strip links all five |
| **P0-2** Reports absent from sidebar and ⌘K; one in-product link | Reports is now a first-class nav row and a palette command |
| **P1-1** Five affordances labelled "Reports" opened the analytics dashboard | Three repointed, one documented as correct-as-is |
| **P1-3** No test asserts a route is reachable from navigation | Added — with a negative control |
| **P2-1** `/dashboard/reports` rendered "Overview / Analytics / Analytics" | Fixed; now "Overview / Analytics" |
| **P2-4** Gate roles saw an Analytics row the API refuses | Fixed via a gate-role flag mirroring the server's own rule |

The audit's **condition 2** — the `finance` / `events` authorization asymmetry (P1-2) — was
**not** touched. See §T.

## C. Changes Implemented

1. **`config/workspaceNav.ts`** — Analytics repointed to `/dashboard/analytics` with
   `permission: 'events'`; a new **Reports** section and row → `/dashboard/finance/reports`;
   a new optional `hideFromGateRoles` field on `WorkspaceNavItem`.
2. **`components/dashboard/Sidebar.tsx`** — one added filter honouring that flag.
3. **`lib/analytics/routes.ts`** — `ANALYTICS_MODULES`, the module catalogue (SSOT).
4. **`components/analytics/AnalyticsModuleNav.tsx`** *(new)* — the module strip.
5. **Six pages** — the strip rendered on the Analytics landing and each of the five modules.
6. **`lib/navigation/breadcrumbs.ts`** — duplicate removed, module leaves added, the
   no-owner branch now honours a known leaf.
7. **Three affordances** repointed to the report generator.

## D. Navigation Before / After

| | Before | After |
|---|---|---|
| Sidebar "Analytics" | → `/dashboard/reports` (the *older* dashboard) | → `/dashboard/analytics` |
| Sidebar "Reports" | **did not exist** | → `/dashboard/finance/reports` |
| Sidebar "Finance" | → `/dashboard/finance` | unchanged |
| ⌘K "Reports" | **did not exist** | → `/dashboard/finance/reports` |
| Analytics modules | **0 links product-wide** | 5, from a strip on all six analytics surfaces |
| Overview quick action "Reports" | → analytics dashboard | → report generator |
| Event-setup "Open reports" | → analytics dashboard | → report generator |
| Check-in "Reports Center" | → analytics dashboard | → report generator |

The command palette needed **no code change**: `buildNavigationCommands` derives entirely from
`WORKSPACE_NAV`, so correcting the array corrected ⌘K. That is the existing architecture paying
off, and test 30 pins it.

### The Reports row's declarations, and why

- **`scope: 'global'`** — reports are workspace-wide. The event field on the page is a slug
  *filter* the user types, not an `eventId` scope, and History spans the workspace. An
  event-scoped row would render **disabled** until an event was selected, for a page that never
  needed one.
- **no `permission`** — no single permission describes it. The catalogue spans `transactions`,
  `settlements` and `wallet`; naming any one would hide Reports from a role holding only the
  other two while the server kept serving them. The page already self-filters (RD-12-10),
  showing a truthful empty state when the caller holds nothing.
- **`hideFromGateRoles: true`** — the server's exclusion is not a permission either
  (`authorizeAnyWorkspace` → `isCheckinOnlyRole`), so there was nothing to mirror through the
  `permission` field. Without the flag, a row carrying no permission is offered to accounts
  every organizer API answers with 403.

### The Analytics row gains `permission: 'events'`

Its destination changed, so its mirror changed. `/api/organizer/analytics/overview/[eventId]`
authorizes with `authorizeWorkspace(req, 'events')`; the previous destination used
`authorizeAnyWorkspace` and correctly carried no permission. Test 15 asserts the nav declaration
and the route's actual call agree.

## E. Permission Behavior

Derived from the real `ROLE_PERMISSIONS` matrix and confirmed in a browser:

| Role | Analytics | Reports | Finance |
|---|---|---|---|
| owner | ✅ | ✅ | ✅ |
| finance | **hidden** | ✅ | ✅ |
| admin | ✅ | ✅ | hidden |
| manager | ✅ | ✅ | hidden |
| checkin_lead | hidden | hidden | hidden |
| checkin_staff | hidden | hidden | hidden |

**`finance` loses the Analytics row — deliberately, and it is a real consequence.** Finance holds
`transactions`/`settlements`/`wallet` and not `events`, so the Analytics modules genuinely answer
it with 403. Previously the row pointed at a route needing no permission, so it worked; the row
now points at the canonical workspace, which does not. Showing it anyway would be precisely the
"door that slams" the nav file's rule 3 exists to prevent. Widening `finance` to keep a row
visible would have been navigation granting access.

`/dashboard/reports` still resolves, so nothing finance could reach yesterday is gone — only the
sidebar shortcut to it. Reconciling the two authorization models is the audit's deferred P1 and
its own phase.

**Navigation grants nothing.** No server check, permission, role or matrix was modified; test 17
pins `ROLE_PERMISSIONS.finance` still lacking `events`, and the report routes still authorizing
for themselves.

## F. Route Compatibility

- `/dashboard/reports` — **exists, unchanged, still resolves.** Browser-confirmed. No redirect.
- `/dashboard/analytics` and its five modules — unchanged apart from the strip.
- `/dashboard/finance/reports` — unchanged; still the notification target.
- No route directory renamed, no `route.ts` redirect added anywhere (test 33).
- `lib/analytics/routes.ts` still names the same three routes and the same four migration steps
  (test 34). Step 1 remains undone; this phase did not perform any of it.

## G. Breadcrumb Changes

Executed the resolver rather than reading it — before and after:

| Path | Before | After |
|---|---|---|
| `/dashboard/reports` | **Overview / Analytics / Analytics** | Overview / Analytics |
| `/dashboard/analytics` | Overview | Overview / Analytics |
| `…/analytics/overview` | Overview | Overview / Analytics / Overview |
| `…/analytics/registrations` | Overview | Overview / Analytics / Registrations |
| `…/analytics/revenue` | Overview | Overview / Analytics / Revenue |
| `…/analytics/operations` | Overview | Overview / Analytics / Operations |
| `…/analytics/communications` | Overview | Overview / Analytics / Communications |
| `/dashboard/finance/reports` | Overview / Finance / Finance Reports | **Overview / Reports** |
| `/dashboard/crm` | Overview / People / CRM | unchanged |

Three edits produced this:

1. **Removed `LEAF_LABELS['/dashboard/reports'] = 'Analytics'`… then restored it.** The duplicate
   came from the nav row's label *and* the leaf both being "Analytics". Once the row moved away,
   nothing owned the path — so the leaf became the only thing that could name it.
2. **Removed `LEAF_LABELS['/dashboard/finance/reports'] = 'Finance Reports'`.** Reports is now its
   own row whose href *is* that path, so a leaf could only append "Reports / Finance Reports". It
   is also the label the approved IA deliberately avoids: all eight catalogue kinds are financial
   today, so "Financial Reports" distinguishes nothing and becomes wrong the moment a
   non-financial kind is registered.
3. **The no-owner branch now honours a known leaf.** It previously returned before reaching the
   leaf, so `LEAF_LABELS` entries for un-owned paths were unreachable code that looked like
   working configuration — `/dashboard/analytics` carried `'Event Insights'` for two phases and
   never once rendered it. This is what lets the compatibility route keep naming itself.

## H. Command Palette Changes

**None to the code.** `lib/commandPalette/registry.ts` derives navigation commands from
`WORKSPACE_NAV`, so it inherited all three destinations automatically. Verified by execution:

```
"Analytics" → /dashboard/analytics          permission=events
"Reports"   → /dashboard/finance/reports    permission=none
"Finance"   → /dashboard/finance            permission=transactions
Reports entries: 1
```

No duplicates, no stale entry pointing at `/dashboard/reports` (tests 28–30).

## I. Mobile Navigation

**None needed.** `Sidebar.tsx` runs one resolution pass over `WORKSPACE_NAV` and feeds desktop,
collapsed and mobile from it — `<NavBody sections={sections}>` appears once. Mobile inherited
every change, including the gate-role filter. Test 31 pins the single array and single
`NavBody`; the browser confirmed the drawer at 390px carries Analytics, Reports and Finance.

## J. Reports Affordance Fixes

Each call site traced, not string-replaced:

| Call site | Was | Now | Why |
|---|---|---|---|
| `dashboard/page.tsx` quick action | "Reports" · hint "View analytics and insights" · → `/dashboard/reports` | "Reports" · hint "Generate and download reports" · → `/dashboard/finance/reports` | Every other tile names its own destination. This was the one place on the Overview a person would look for a report, and the one guaranteed not to have one. |
| `lib/eventSetup/items.ts` | "Reports & exports" · "Open reports" · → `/dashboard/reports` (scoped) | → `/dashboard/finance/reports` (**unscoped**) | The row already said "Reports & exports". Unscoped because Reports is workspace-scoped: `ctx.scoped()` appends an `eventId` the page ignores. |
| `check-in/operations/ReportsTab.tsx` | "Reports Center" → `/dashboard/reports` | → `/dashboard/finance/reports` | It sits beside a CSV download and Print Operations — a row of export affordances whose "Reports" button produced none. |

### Deliberately NOT changed — the documented exception

**The event workspace tab `?tab=reports`, labelled "Reports"** (`lib/events/eventTabs.ts`).
Its content is server-computed event **statistics** — aggregates, pass breakdowns, revenue — not
generated artifacts. Per §5's own exception clause this is "Reports" meaning reporting metrics,
so repointing it would send a reader looking at their event's numbers to a workspace-wide export
tool. Relabelling it is a terminology change to the event workspace, whose `key` appears in
`?tab=` URLs and feeds the palette and active-row resolution — outside this phase's file scope.
Recorded as remaining work.

## K. Analytics Module Reachability

No tab mechanism existed. `components/analytics/ModuleChrome.tsx` is a shared *header* (event
selector, range, refresh, states) used by four of the five modules; `AnalyticsOverview` predates
it and carries its own header; the landing page is a separate implementation again. So the
minimum wiring was a strip, added in one new component and rendered from the six thin page files
— **no module component was modified**, so five audited surfaces stay exactly as audited.

- Driven by `ANALYTICS_MODULES` in `lib/analytics/routes.ts`, one array, consumed by the strip
  and the tests. Adding a sixth module without registering it now fails a test — the guard the
  audit's P1-3 asked for.
- **Links, not tabs.** Each module is a real route with its own page, so these are anchors that
  survive middle-click, bookmarking and Back. `role="tablist"` would claim a widget contract
  (roving focus, one shared panel) that five documents cannot honour; `aria-current="page"` is
  the correct signal.
- Carries `?eventId=` across a switch, or the reader silently moves to a different event's
  numbers.
- Scrolls horizontally rather than wrapping — five labels do not fit at 390px, and a wrapped
  second row pushes the module's own header below the fold.

**Capability gating is untouched.** Which Operations panels exist still comes from the event's own
`identifierConfigs`, money keys still require `transactions`, and the payload still requires
`events` — all server-side. The strip deliberately applies **no** client-side capability filter:
doing so would create a second gate beside the real one.

## L. Tests Added / Updated

**New — `tests/unit/navigationSurfacing.test.ts`, 34 cases.** Destinations, scope and permission
declarations; reachability; the affordances; breadcrumb output; palette; mobile; and that nothing
migrated. Two cases carry their weight in particular:

- **Case 11 — every dashboard route is owned by a nav row, has a known leaf label, or is a named
  exception with a reason.** This is the guard for the defect class: six phases shipped
  unreachable routes because nothing checked. It found five *pre-existing* unlinked routes
  (`/dashboard/wallet`, `/assets`, `/campaigns`, `/notifications`, `/settings/staff`) — recorded
  as documented exceptions rather than fixed, since repointing unrelated navigation is outside
  this phase.
- **Case 12 — a negative control.** Each module route resolves to the Analytics row *now*, and
  `/dashboard/reports` resolves to none — so the guard demonstrably fires rather than passing
  vacuously.

**Updated deliberately — four existing cases, none weakened:**

| File | Case | Why |
|---|---|---|
| `analyticsArchitecture.test.ts` | 41 | Pinned the old row string verbatim. Now asserts the row points at the canonical workspace, that nothing in nav points at the old route, and that the old route's page still exists. |
| `analyticsArchitecture.test.ts` | 42 | Unchanged assertion, new comment: the leaf now renders via the no-owner branch. |
| `dashboardTopSection.test.ts` | quick-action destinations | Expected `/dashboard/reports`; now `/dashboard/finance/reports`. |
| `eventSetupCenter.test.ts` | event-scope carrying | Added `/dashboard/finance/reports` to the existing exception list beside `/settings/integrations`, because Reports is workspace-scoped. |
| `reportsHistoryUi.test.ts` | 5 | Asserted the Analytics row still pointed at `/dashboard/reports` — 12-11's way of saying "no route migrated". Now asserts Reports has one canonical URL and History did not become a second. |

None deleted; each carries a comment saying what it defends and why the assertion moved.

## M. Browser Validation — performed

Emulator + seeded owner/finance/manager + a production build served on 3187 + Playwright, with
screenshots **read**.

| Check | Result |
|---|---|
| Sidebar Analytics / Reports / Finance destinations | `/dashboard/analytics?eventId=…` · `/dashboard/finance/reports` · `/dashboard/finance` |
| Duplicate rows | none — exactly one each |
| Any sidebar link to `/dashboard/reports` | **none** |
| Clicking Analytics | lands on `/dashboard/analytics` |
| Module strip present on the landing | ✅ Overview \| Registrations \| Revenue \| Operations \| Communications |
| **Clicking** each of the five modules | all five reached, none blank, strip survives on every one |
| Module breadcrumb | "Overview Analytics Communications" — no duplicate |
| Reports breadcrumb | "Overview Reports" |
| `/dashboard/reports` still resolves | ✅, breadcrumb "Overview Analytics" |
| Overview "Reports" links | both → `/dashboard/finance/reports` |
| finance sidebar | Reports ✅, Finance ✅, **Analytics correctly absent** |
| manager sidebar | Analytics ✅, Reports ✅, **Finance correctly absent** |
| ⌘K | opens, lists Analytics / Reports / Finance |
| Mobile drawer (390px) | carries Analytics, Reports, Finance — same IA |
| Page overflow at 1440 / 834 / 390 | 0px / 0px / 0px |
| Clipped module labels | 0 at every width |
| Console errors / page errors | **none** |

Screenshots in `e2e/.shots/rd-analytics-12-13/`, read and inspected — the desktop Analytics
landing and the 390px Registrations module in particular, confirming the active-tab underline,
the horizontal scroll rather than clipping, and the preserved module chrome.

## N. TypeScript

**PASS** — `npx tsc --noEmit`, exit 0.

## O. ESLint

**PASS on every file this phase touched** — 0 problems across all fifteen.

Stated precisely, as the brief asks: a repository-wide run reports **88 errors and 103 warnings,
all pre-existing** in admin-finance, communications and event-tab components belonging to other
work. That count is unchanged by this phase and none of it was fixed.

## P. Build

**PASS** — `npm run build`, exit 0, 54s compile, 312 static pages. All six analytics routes and
`/dashboard/finance/reports` present in the manifest.

Full unit suite: **335 files — 9,129 passed, 1 skipped, 0 failed.**

One note on the suite: an intermediate run showed five unrelated files failing at 7–9s
(`identifierFinalAudit`, `emailProviderRouting`, `analyticsFinancialTruth`, `analyticsUnavailable`,
`printJobCreation`). All five passed in isolation — load-induced cold-start timeouts under
concurrent builds, not regressions. The final full run is clean.

## Q. Firestore Rules / Indexes

**Unchanged.** `firestore.rules` mtime 3 Sept and `firestore.indexes.json` mtime 12:08 today
(RD-12-11's index) both predate this phase's first edit at 15:53. No rule, index, collection or
schema was touched, added or deployed. The RD-12-07 and RD-12-11 index definitions both remain
**undeployed**.

## R. Git Status

HEAD `b7e5fdf`, unchanged. Nothing staged. Files changed by this phase:

| File | Change |
|---|---|
| `config/workspaceNav.ts` | Analytics repointed; Reports section added; `hideFromGateRoles` field |
| `components/dashboard/Sidebar.tsx` | one filter for the gate-role flag |
| `lib/analytics/routes.ts` | `ANALYTICS_MODULES` catalogue |
| `components/analytics/AnalyticsModuleNav.tsx` | **new** |
| `app/(dashboard)/dashboard/analytics/page.tsx` | strip rendered (one import, one element) |
| `…/analytics/{overview,registrations,revenue,operations,communications}/page.tsx` | strip rendered |
| `lib/navigation/breadcrumbs.ts` | leaves + the no-owner branch |
| `app/(dashboard)/dashboard/page.tsx` | quick action repointed |
| `lib/eventSetup/items.ts` | checklist action repointed |
| `app/(dashboard)/dashboard/check-in/operations/ReportsTab.tsx` | button repointed |
| `tests/unit/navigationSurfacing.test.ts` | **new**, 34 cases |
| `tests/unit/{analyticsArchitecture,dashboardTopSection,eventSetupCenter,reportsHistoryUi}.test.ts` | 5 cases updated |
| `scripts/qa/rd-analytics-12-13-shots.mjs` | **new**, browser QA |
| `docs/RD-ANALYTICS-12-13-IMPLEMENTATION.md` | this document |

The working tree carries many other modified files from earlier phases and a concurrent session;
every one has an mtime predating 15:53 and none was touched, reverted or overwritten.
`tsconfig.json` was restored after the emulator build (0 `next-a1213` entries) and `.next-a1213`
removed.

## S. Deployment Status

**Not deployed. Not committed. Not pushed.**

## T. Known Limitations

1. **`finance` no longer sees an Analytics row.** Documented in §E — honest, since the modules
   refuse it. This is the visible face of the audit's deferred **P1-2**, and reconciling
   `authorizeAnyWorkspace` with `authorizeWorkspace(req, 'events')` is an authorization change
   that must have its own audited phase. Deliberately not solved here.
2. **`/dashboard/reports` is now unlinked but still live.** Intended — bookmarks keep working —
   but it is a route with no navigational owner until the migration lands.
3. **The event tab "Reports" still says Reports** while showing statistics (§J). A real
   terminology defect, deliberately out of scope.
4. **Five pre-existing routes are unreachable from navigation** — surfaced by the new guard and
   recorded as exceptions: `/dashboard/wallet`, `/dashboard/assets`, `/dashboard/campaigns`,
   `/dashboard/notifications`, `/dashboard/settings/staff`. Findings for a later IA phase.
5. **The Analytics landing is still the older Event Insights page.** The strip makes the modules
   reachable from it, but migration step 1 (absorb it) is untouched, so the workspace has a
   landing whose content is superseded by its own Overview module.
6. **The module strip applies no capability filter**, by design (§K) — so a module with nothing
   to show for an event renders its own empty state rather than being hidden.

## U. Final Verdict

**COMPLETE**, within the phase's stated bounds.

Both P0 findings are closed: the Analytics workspace is reachable by clicking, and the report
generator built across nine phases is a first-class destination. Three P2s are closed. The
guard that would have caught all of it is in place, with a negative control proving it fires.

Explicitly, and as required:

- **no route migration occurred** — `/dashboard/reports`, `/dashboard/analytics` and
  `/dashboard/finance/reports` all resolve exactly as before
- **no redirect was added**
- **no authorization model was changed** — no server check, guard or matrix touched
- **no permission was added** — `hideFromGateRoles` is an advisory UI flag mirroring
  `isCheckinOnlyRole`, not a permission
- **no Firestore rules changed**
- **no Firestore indexes changed**
- **no deployment occurred**
- **no commit occurred**
- **no push occurred**
