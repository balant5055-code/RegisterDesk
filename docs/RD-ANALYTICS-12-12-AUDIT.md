# RD-ANALYTICS-12-12 — Navigation & IA Audit

Audit only. No route, navigation, permission, rule, index or component was changed.

---

## A. Executive Summary

RegisterDesk has **six surfaces competing for two names**, and the navigation resolves to the
wrong one in almost every case.

The single most important finding is not a mislabel. It is that **the entire Analytics
workspace built across RD-ANALYTICS-06 → 11 — Overview, Registrations, Revenue, Operations and
Communications — is unreachable from the product.** A repository-wide search for a navigable
reference (`href=`, `router.push`, `<Link>`, a nav array, a palette entry, a notification link)
to any of those five routes returns **zero**. The only things that navigate to them are my own
QA scripts, which type the URL. Five audited, tested, shipped modules exist solely as URLs
nobody is told about.

Meanwhile the sidebar's one Analytics row points at `/dashboard/reports` — a route whose name
says "reports", whose label says "Analytics", and whose content is an analytics dashboard. And
the actual report generator (`/dashboard/finance/reports`, the subject of RD-12-10 and 12-11) is
**absent from the sidebar and from ⌘K entirely**; it is reachable by exactly one in-product
link, on the Finance page.

Two further defects were confirmed by executing the resolvers rather than reading them:

- `/dashboard/reports` produces the breadcrumb **"Overview / Analytics / Analytics"** — a
  duplicated crumb, caused by the nav item's label and the `LEAF_LABELS` entry both being
  "Analytics".
- All six `/dashboard/analytics*` routes produce the breadcrumb **"Overview"** and nothing else,
  because no nav item owns their path.

And one finding that materially constrains the migration everyone assumes is coming:
`/dashboard/reports` authorizes with `authorizeAnyWorkspace` (no specific permission), while the
canonical Analytics modules authorize with `authorizeWorkspace(req, 'events')`. **`finance` does
not hold `events`.** Moving Analytics to its canonical home as currently built would take
Analytics away from the finance role — a permission regression delivered by an IA change.

The good news is narrow but real: the export-completed notification already links to
`/dashboard/finance/reports`, which after RD-12-11 has a History tab. Workflow G works.

**Verdict: APPROVED WITH CONDITIONS.** The IA is well understood and the migration was written
down in advance (`lib/analytics/routes.ts`), but three conditions must be met before any route
moves — see §AC.

---

## B. Current Route Inventory

| # | Route | Page file | Exists |
|---|---|---|---|
| 1 | `/dashboard/reports` | `app/(dashboard)/dashboard/reports/page.tsx` (710 lines) | yes |
| 2 | `/dashboard/analytics` | `app/(dashboard)/dashboard/analytics/page.tsx` (381 lines) | yes |
| 3 | `/dashboard/analytics/overview` | `…/analytics/overview/page.tsx` (22 lines) | yes |
| 4 | `/dashboard/analytics/registrations` | `…/analytics/registrations/page.tsx` (17) | yes |
| 5 | `/dashboard/analytics/revenue` | `…/analytics/revenue/page.tsx` (18) | yes |
| 6 | `/dashboard/analytics/operations` | `…/analytics/operations/page.tsx` (16) | yes |
| 7 | `/dashboard/analytics/communications` | `…/analytics/communications/page.tsx` (16) | yes |
| 8 | `/dashboard/finance/reports` | `…/finance/reports/page.tsx` | yes |
| 9 | `/reports` | — | **NO — see below** |
| 10 | `/dashboard/events/{id}?tab=reports` | `…/events/[eventId]/tabs/ReportsTab.tsx` | yes (tab) |
| 11 | `/dashboard/check-in/operations` (Reports tab) | `…/check-in/operations/ReportsTab.tsx` | yes (tab) |

### `/reports` does not exist

`app/(dashboard)/reports/` contains exactly one file: `.gitkeep`. There is no `page.tsx`, so
**`/reports` 404s.** It was created in commit `51e7e7d` ("Phase 1 Implementation") and never
filled. It is a placeholder for an intention, not a route.

### Per-route detail

**1 · `/dashboard/reports`** — *the analytics dashboard wearing the reports name*
Apparent purpose: reports. Actual: a workspace analytics dashboard reading
`/api/organizer/dashboard` (rollup/counter-based, uncapped, finance-gated), with event scoping,
date presets and performance insights. Scope: **mixed** — supports both a selected event and
"All events". Authorization: `authorizeAnyWorkspace` (no specific permission);
`financeAllowed = permissions.includes('transactions')` gates money within the payload. In
primary nav: **yes**, as the row labelled "Analytics". Mobile: yes (same array). ⌘K: yes.
Breadcrumb: **"Overview / Analytics / Analytics"** (defect). Notifications: no. Legacy: no —
this is the strongest analytics implementation shipping today. Duplicated: yes, conceptually, by
routes 3–7. **Recommendation: migrate (rename to `/dashboard/analytics/…`) with a redirect.**

**2 · `/dashboard/analytics`** — *the older per-event Event Insights page*
Actual purpose: a per-event deep dive via `/api/organizer/analytics/[eventId]`. Scope: **event**.
Authorization: `authorizeWorkspace(req, 'events')` + `requireEventScope`. Primary nav: **no**.
Mobile: no. ⌘K: no. Breadcrumb: **"Overview"** only (no nav owner; its `LEAF_LABELS` entry
`'Event Insights'` is dead code that can never render). Inbound: **one live link** —
`CouponPanel`'s default `href`, used by the Dashboard Overview. Legacy: **yes — transitional.**
**Recommendation: retire later**, after its content is absorbed per migration step 1.

**3–7 · `/dashboard/analytics/{overview,registrations,revenue,operations,communications}`**
Actual purpose: the new modular Analytics workspace (RD-06/08/09/10/11), each a thin route
mounting a component from `components/analytics/*`. Scope: **event** (via `EventContextProvider`,
`?eventId=`). Authorization: `authorizeWorkspace(req, 'events')`; money keys further gated by
`transactions`; Operations panels gated by the event's own `identifierConfigs`. Primary nav:
**no**. Mobile: **no**. ⌘K: **no**. Breadcrumb: **"Overview"** only. Notifications: no.
Inbound references: **zero navigable, from anywhere in the product.**
**Recommendation: retain and surface — this is the canonical Analytics workspace.**

**8 · `/dashboard/finance/reports`** — *the real report generator*
Actual purpose: the ONE report/export engine — 8 catalogue kinds, sync download, async export
jobs, cancel, expiring signed downloads, and (RD-12-11) History. Scope: **workspace**.
Authorization: per-report permission server-side on every route. Primary nav: **NO**. Mobile:
**no**. ⌘K: **no**. Breadcrumb: "Overview / Finance / Finance Reports" (correct). Notifications:
**yes** — `notifyExportReady` links here. Inbound: **one** in-product link
(`finance/page.tsx:331`). **Recommendation: retain, and promote to primary navigation.**

**10 · Event tab `?tab=reports`** — labelled "Reports", icon `BarChart3`, renders
server-computed event **statistics**. It is analytics, named reports. **Recommendation: rename
(label only).**

**11 · Check-in Operations "Reports" tab** — its own header calls it "Operations Reports &
Analytics"; it contains a button labelled **"Reports Center"** pointing at `/dashboard/reports`,
which is the analytics dashboard, not the reports centre. **Recommendation: investigate; the
label and destination disagree.**

---

## C. Analytics Route Analysis

Three separate analytics implementations ship today:

| Implementation | Route | Data source | Scope | Reachable? |
|---|---|---|---|---|
| Workspace analytics dashboard | `/dashboard/reports` | `/api/organizer/dashboard` | mixed | **yes** (sidebar) |
| Event Insights (older) | `/dashboard/analytics` | `/api/organizer/analytics/[eventId]` | event | only via CouponPanel |
| Modular Analytics workspace | `/dashboard/analytics/*` | `/api/organizer/analytics/overview/[eventId]` | event | **no** |

The newest and most architecturally correct implementation is the least reachable. The oldest
has one accidental inbound link. The one in the sidebar sits at the wrong address.

`lib/analytics/routes.ts` already records this and names the target:
`ANALYTICS_ROUTE_CURRENT = '/dashboard/reports'`,
`ANALYTICS_ROUTE_CANONICAL = '/dashboard/analytics'`,
`REPORTS_ROUTE_CANONICAL = '/dashboard/finance/reports'`, plus a four-step migration with
preconditions. That decision is sound and this audit does not contradict it — but step 1
("absorb Event Insights into the analytics workspace") has **not** happened, and steps 2–4 are
blocked on it.

---

## D. Reports Route Analysis

There is exactly **one** report generator: `ORGANIZER_REPORTS` in `lib/reports/registry.ts`,
derived from `lib/reports/catalog.ts`, surfaced at `/dashboard/finance/reports`. Eight catalogue
kinds, seven generic table reports plus the specialized payout statement; CSV/XLSX/PDF; async
export jobs with cancel and expiring signed downloads; History as of RD-12-11.

It is not in the sidebar, not in ⌘K, and not in mobile navigation. **Total in-product inbound
links: one** — a card on `/dashboard/finance`. A finance user who has not memorised the URL
finds it by opening Finance and scrolling.

Everything else in the product that says "Reports" points somewhere else:

| Says "Reports" | Actually goes to | Is it a report generator? |
|---|---|---|
| Sidebar row (`key: 'reports'`) | `/dashboard/reports` | no — analytics |
| Overview quick link "Reports" | `/dashboard/reports` | no — analytics |
| Event setup "Open reports" | `/dashboard/reports` | no — analytics |
| Check-in "Reports Center" button | `/dashboard/reports` | no — analytics |
| Event tab "Reports" | event statistics | no — analytics |
| Breadcrumb "Finance Reports" | `/dashboard/finance/reports` | **yes** |
| Export-ready notification | `/dashboard/finance/reports` | **yes** |

Five of seven "Reports" affordances lead away from the report generator.

---

## E. Analytics vs Reports Boundary

The **intended** boundary is clean and the codebase supports it:

- **Analytics** — measured, interactive, event-scoped: trends, comparisons, funnels, health.
- **Reports** — generated artifacts, workspace-scoped: formats, export jobs, history, downloads.

The **implemented** boundary is contradicted in four places:

1. The analytics dashboard lives at `/dashboard/reports` (§C).
2. The report generator lives under Finance, so its IA parent is a money module rather than a
   reporting one — defensible today (all 8 catalogue kinds are `category: 'financial'`), but the
   nav rule "one capability, one location" is being satisfied by hiding the capability.
3. The event workspace's "Reports" tab is statistics.
4. Check-in Operations calls `/dashboard/reports` the "Reports Center".

The boundary is not architecturally broken — the *engine* separation is genuinely clean
(`lib/analytics/*` vs `lib/reports/*`, with no cross-imports). What is broken is the **naming
and routing layer above it**.

---

## F. Scope Model

| Surface | Declared scope | Actual behaviour | Correct? |
|---|---|---|---|
| `/dashboard/reports` | `scope: 'event'` (nav) | supports event **and** "All events" | **NO** |
| `/dashboard/analytics` | — | event only | n/a (not in nav) |
| `/dashboard/analytics/*` | — | event only | n/a (not in nav) |
| `/dashboard/finance/reports` | — | workspace | n/a (not in nav) |

**Confirmed defect:** `resolveNavHref` returns `null` for an event-scoped item when no event is
selected, and a `null` href renders the row **disabled**. So with no event selected the Analytics
row is disabled — even though `/dashboard/reports` explicitly handles the unscoped case
(`selectedEventId ? '…?eventId=' : '/api/organizer/dashboard'`) and renders workspace-wide
analytics correctly. A working page is made unreachable by a scope declaration that does not
match it.

The user-facing distinction "Analytics for this event" vs "Reports for my workspace" is **not
currently expressible**, because Reports is not in the navigation at all and Analytics is
mis-scoped.

---

## G. Sidebar / Primary Navigation

`config/workspaceNav.ts` is a genuine, well-documented SSOT consumed by the sidebar (desktop,
collapsed and mobile from one array), ⌘K and breadcrumbs. Its three stated rules are sound. The
findings below are about its **contents**, not its design.

- **One** Analytics section, one row:
  `{ key: 'reports', label: 'Analytics', icon: BarChart3, href: '/dashboard/reports', scope: 'event' }`
- **No `permission`** on that row — it is shown to every role, including gate-only roles.
- **No Reports entry at all.** `/dashboard/finance/reports` is not reachable from primary
  navigation; it is inside Finance.
- **No duplicate Analytics entries** — the one-capability-one-location rule is being honoured.
- **Five Analytics module pages are unreachable** from navigation.
- The row's `key` is `reports` while its `label` is `Analytics` and its `href` is
  `/dashboard/reports` — three names for one row, which is itself a readability hazard for the
  migration.

---

## H. Inbound Reference Map

Counts from repository-wide search across `app components lib config scripts tests`.

| Route | Navigable in-product refs | Comment-only mentions | QA scripts | Tests |
|---|---|---|---|---|
| `/dashboard/reports` | **4** | several | 0 | 9 |
| `/dashboard/analytics` (exact) | **1** | 2 | 0 | 6 |
| `/dashboard/analytics/overview` | **0** | 2 | 4 | 0 |
| `/dashboard/analytics/registrations` | **0** | 1 | 3 | 0 |
| `/dashboard/analytics/revenue` | **0** | 1 | 2 | 1 |
| `/dashboard/analytics/operations` | **0** | 0 | 5 | 0 |
| `/dashboard/analytics/communications` | **0** | 0 | 6 | 0 |
| `/dashboard/finance/reports` | **1** + 1 notification | 2 | 0 | 6 |

### The four navigable references to `/dashboard/reports`

| File:line | Affordance | Label |
|---|---|---|
| `config/workspaceNav.ts:165` | sidebar row (⇒ also ⌘K, breadcrumbs) | "Analytics" |
| `app/(dashboard)/dashboard/page.tsx:91` | Overview quick link | **"Reports"** |
| `lib/eventSetup/items.ts:315` | setup checklist action | **"Open reports"** |
| `app/(dashboard)/dashboard/check-in/operations/ReportsTab.tsx:122` | button | **"Reports Center"** |

Three of the four call it Reports. The sidebar calls it Analytics. They are the same page.

### The single navigable reference to `/dashboard/analytics`

`components/dashboard/CouponPanel.tsx:188` — `href = '/dashboard/analytics'` as a **default
parameter**, rendered at line 250 with `hrefLabel="Analytics"`. `app/(dashboard)/dashboard/page.tsx:954`
mounts `<CouponPanel coupons scopeLabel />` **without `href`**, so the default applies: the
Dashboard Overview's coupon panel links to the orphaned legacy route.

### The two references to `/dashboard/finance/reports`

`app/(dashboard)/dashboard/finance/page.tsx:331` (a card) and
`lib/notifications/inbox/notify.ts:205` (the export-ready notification link).

---

## I. Legacy / Orphan Routes

**`/reports` — does not exist.** `app/(dashboard)/reports/` holds only `.gitkeep`. Not legacy,
not orphaned: never built. It should either be built or the directory removed, but removing it is
cosmetic and out of scope.

**`/dashboard/analytics` — transitional, not yet retirable.** It is the older Event Insights
implementation. It has one live inbound link (CouponPanel default) and six test references, and
`lib/analytics/routes.ts` names it as the *destination* of the migration, so it cannot simply be
deleted — its **path** is wanted even though its **content** is superseded. Known dependencies
before retirement:
`components/dashboard/CouponPanel.tsx:188` · `lib/navigation/breadcrumbs.ts:161` ·
`tests/unit/analyticsArchitecture.test.ts` (tests 38–39 assert the file exists) ·
`tests/unit/couponFilterAndPerformance.test.ts` · `lib/analytics/routes.ts`.

**`/dashboard/analytics/*` (five modules) — orphaned, but current.** Zero inbound references, yet
they are the newest implementation and are covered by tests and QA scripts. This is orphaning by
omission (nobody added the nav rows), not obsolescence. **Do not retire — surface.**

**`LEAF_LABELS['/dashboard/analytics'] = 'Event Insights'` — dead code.** No nav item owns that
path, so `buildBreadcrumbs` returns before the leaf is appended. Verified by execution.

---

## J. Breadcrumb Audit

Executed `buildBreadcrumbs` + `leafLabelFor` + `navItemForPath` directly (see §Z):

| Path | Nav owner | Trail produced |
|---|---|---|
| `/dashboard/reports` | `reports` | **Overview / Analytics / Analytics** ← duplicate |
| `/dashboard/analytics` | **NONE** | Overview |
| `/dashboard/analytics/overview` | **NONE** | Overview |
| `/dashboard/analytics/registrations` | **NONE** | Overview |
| `/dashboard/analytics/revenue` | **NONE** | Overview |
| `/dashboard/analytics/operations` | **NONE** | Overview |
| `/dashboard/analytics/communications` | **NONE** | Overview |
| `/dashboard/finance/reports` | `finance` | Overview / Finance / Finance Reports ✅ |
| `/dashboard/finance` | `finance` | Overview / Finance ✅ |

The duplicate arises because the nav item's `label` is "Analytics" **and**
`LEAF_LABELS['/dashboard/reports']` is "Analytics"; `buildBreadcrumbs` pushes the item label and
then the leaf label unconditionally. The leaf entry was added by RD-ANALYTICS-04 to stop the path
title-casing itself "Reports" — a correct fix whose side effect was never noticed, because the
two labels are identical and the trail reads plausibly.

Finance Reports correctly says "Finance Reports", not "Analytics". No mislabelling there.

---

## K. Command Palette Audit

`lib/commandPalette/registry.ts` derives **all** navigation commands from `WORKSPACE_NAV` — a
good design that makes the palette structurally incapable of drifting from the sidebar. It also
makes it incapable of exceeding it:

- One Analytics command → `/dashboard/reports`, label "Analytics", **no permission gate**.
- **No command for `/dashboard/finance/reports`.** Typing "reports" in ⌘K offers the analytics
  dashboard and the event Reports tab — never the report generator.
- **No commands for the five Analytics modules.**
- No stale or duplicate routes (a consequence of deriving from the SSOT).

Event-tab commands come from `EVENT_TABS`, which includes `{ key: 'reports', label: 'Reports' }`
— so searching "reports" surfaces an event statistics tab alongside an analytics dashboard, and
neither is Reports.

---

## L. Notification / Export Flow

**This flow is correct and needs no change.**

`lib/reports/exportJob.ts:172` calls `notifyExportReady` on job completion →
`lib/notifications/inbox/notify.ts:197-206` writes an `EXPORT_READY` notification titled
"Export ready" with `link: '/dashboard/finance/reports'`.

So Workflow G lands the user on the Reports workspace, which since RD-12-11 has a **History**
tab listing that very job with its download. The one gap: the link opens the **Reports** tab, not
History, so the user must click once more. That is a one-line improvement (`?tab=history` or an
equivalent) — but History's tab state is deliberately local rather than a query parameter (adding
`searchParams` to that page would make it dynamic), so it is a real design decision, not an
oversight. **Do not change in this phase.**

No notification links to `/dashboard/reports` or `/dashboard/analytics*`.

---

## M. Mobile Navigation

`components/dashboard/Sidebar.tsx:296` renders `<NavBody sections={sections} …>` for **both**
desktop and mobile from the same filtered array, with `onNavigate` closing the drawer on mobile.
There is no separate mobile IA.

Consequence: mobile and desktop are perfectly consistent — including in their defects. Mobile
users also cannot reach Reports or any Analytics module, and see the same mislabelled row. No
duplicate entries, no mobile-only routes, no hidden entries.

---

## N. Permission / Role Visibility

Computed against the real `ROLE_PERMISSIONS` matrix (see §Z).

| Role | Gate-only | Sees "Analytics" row | `events` | `transactions` | `settlements` | `wallet` | Nav rows |
|---|---|---|---|---|---|---|---|
| owner | no | yes | ✅ | ✅ | ✅ | ✅ | 18 |
| finance | no | yes | ❌ | ✅ | ✅ | ✅ | 7 |
| admin | no | yes | ✅ | ❌ | ❌ | ❌ | 17 |
| manager | no | yes | ✅ | ❌ | ❌ | ❌ | 15 |
| checkin_lead | **yes** | yes | ❌ | ❌ | ❌ | ❌ | 7 |
| checkin_staff | **yes** | yes | ❌ | ❌ | ❌ | ❌ | 7 |

1. **Which roles see Analytics?** All six — the row carries no `permission`.
2. **Which roles can access it?** `/dashboard/reports` uses `authorizeAnyWorkspace`, which
   excludes gate-only roles. So owner/finance/admin/manager can; `checkin_*` get 403.
3. **Which roles see Reports?** None — it is not in the navigation.
4. **Which roles can access Reports?** Owner and finance see all 8 catalogue reports; admin and
   manager see zero (RD-12-10); gate roles are refused.
5. **Aligned?** Mostly, with two exceptions below.
6. **Can a user see a destination they cannot use?** **Yes** — gate roles see the Analytics row
   and would receive 403. Mitigated by `CheckinStaffGuard`, which redirects them to their own
   console, but that is client-side and async, so the row renders first. Its own comment is
   candid: "a routing hint, not a control".
7. **Can a user access a destination navigation hides?** **Yes, extensively** — all five
   Analytics modules and the entire Reports workspace.
8. **Financial gating correct?** Yes. Money is gated server-side by `transactions` inside the
   payload (`/api/organizer/dashboard:739`, `analytics/[eventId]:179`,
   `analytics/overview/[eventId]:65`), reports by their own catalogue permission. No route relies
   on the client for a money decision.
9. **Gate roles excluded where appropriate?** Yes, at the server. Not in the sidebar.

### The finding that constrains the migration

`/dashboard/reports` → `authorizeAnyWorkspace` (no permission).
`/dashboard/analytics/*` → `authorizeWorkspace(req, 'events')`.

**`finance` holds `transactions`, `settlements`, `wallet` — and not `events`.** Today finance can
open the Analytics row. If Analytics moves to the canonical modules as they are currently
authorized, **finance loses Analytics entirely.** No role but `owner` holds both `events` and
`transactions`, so this is structural, not incidental.

---

## O. User Workflow Analysis

| | Workflow | Entry point | Expected | Actual | Friction |
|---|---|---|---|---|---|
| A | Understand event performance | Sidebar → Analytics | event analytics | `/dashboard/reports` workspace dashboard, event-filtered | Works, but the richest per-event modules are unreachable |
| B | Registration trends | Sidebar → Analytics | Registrations module | never reaches `/dashboard/analytics/registrations` | **Module exists and cannot be found** |
| C | Revenue information | Sidebar → Analytics | Revenue module | `/dashboard/reports` money cards | Revenue module unreachable |
| D | Finance user wants a financial report | ? | Reports | must know Finance → scroll → card | **No nav entry; ⌘K does not offer it** |
| E | Download XLSX/PDF/CSV | Sidebar → "Reports"? | report generator | quick link "Reports" → analytics dashboard | **Actively misleading** |
| F | Find a previously generated export | ? | Reports → History | reachable only via Finance → Reports → History tab | Two hops after an unguessable start |
| G | "Export completed" notification | notification | Reports → History | `/dashboard/finance/reports` (Reports tab) | **Correct**; one extra click to History |
| H | Manager without finance permission uses Analytics | Sidebar → Analytics | analytics without money | works — money keys absent server-side | Correct |
| I | Check-in staff opens the dashboard | `/dashboard` | own console | sees full sidebar incl. Analytics, then `CheckinStaffGuard` redirects | Transient wrong IA |

Workflow **E** is the most damaging: the affordance labelled "Reports" on the Overview page is
the one place a user would look for a report, and it is the one place guaranteed not to have one.

---

## P. Proposed Future IA

The proposal in the brief:

```
Analytics                     Reports
├── Overview                  ├── All Reports
├── Registrations             ├── History
├── Revenue                   └── Scheduled
├── Operations
├── Communications
└── Participants
```

**Fit against the current architecture — direct answers:**

- **Is Analytics appropriately event-scoped?** Yes for the five modules (they require an event
  and read `?eventId=`). No for `/dashboard/reports`, which is genuinely mixed and must keep its
  "All events" state. A migrated Analytics workspace needs **both** — the nav's binary
  `'global' | 'event'` cannot express it today.
- **Is Reports appropriately workspace-scoped?** Yes, unambiguously. Reports have an `event`
  *filter*, not an event *scope*, and History is workspace-wide.
- **Should Reports be top-level navigation?** **Yes.** It is the single worst discoverability
  defect in this audit. The prior objection (`lib/analytics/routes.ts` step 4: "adding a second
  sidebar row would put one capability in two places") **no longer applies** — Reports is not in
  the sidebar at all, so a row creates one location, not two.
- **Should Analytics be top-level navigation?** Yes; it already is.
- **Should Financial Reports be a separate nav item?** **No.** One Reports entry. All 8 catalogue
  kinds are `category: 'financial'`, so a "Financial Reports" row beside "Reports" would be the
  same eight reports twice.
- **Is "All Reports" necessary?** Only as the default tab label beside History. As a *category
  filter* it is scaffolding — RD-12-10 already established that every entry is `financial`, so
  "All" and "Financial" would be identical lists.
- **Is "Financial Reports" redundant?** As a nav item, yes. As the breadcrumb leaf for
  `/dashboard/finance/reports`, it is accurate today and becomes wrong the moment a non-financial
  kind is registered.
- **Should Participants be a module now?** **No.** `config/workspaceNav.ts:107-114` already
  records why: there is no participant capability distinct from Registrations — no route, no API,
  no tab. Adding it would dead-link or duplicate Registrations.
- **Should Operations/Communications be capability-gated?** They **already are**, on the server:
  Operations panels from the event's own `identifierConfigs`, Communications spend from
  `transactions`. The nav must not add a second gate — it would become a permission model.
- **Should Reports remain under Finance?** The **route** should (migrating it costs bookmarks and
  a notification link for no user benefit). The **navigation entry** should not.

**Recommended IA — minimal, and supported by what exists:**

```
Analytics          → /dashboard/analytics            scope: mixed   (no permission)
Reports            → /dashboard/finance/reports      scope: global  (no permission — the page self-filters)
Finance            → /dashboard/finance              scope: global  permission: transactions
```

Analytics keeps its sub-modules as in-page tabs (Overview / Registrations / Revenue / Operations
/ Communications), exactly as Reports now does with Reports / History — one sidebar row per
capability, sub-surfaces inside. That is the pattern RD-12-11 just validated, and it satisfies
the nav file's rule 1 without a nested sidebar.

**Scheduled** is not in the proposal's reach: nothing schedules a report today. Adding the tab
before the capability would be the empty-category defect RD-12-10 explicitly refused.

---

## Q. Route Migration Safety

### Migration 1 — `/dashboard/reports` → `/dashboard/analytics`

| | |
|---|---|
| Inbound refs | 4 navigable + 1 breadcrumb entry + 1 `config/navigation.ts` constant + 9 test refs |
| Named referrers | `config/workspaceNav.ts:165`, `dashboard/page.tsx:91`, `lib/eventSetup/items.ts:315`, `check-in/operations/ReportsTab.tsx:122`, `config/navigation.ts:69`, `lib/navigation/breadcrumbs.ts:160` |
| Bookmark risk | **High** — this is the only Analytics entry point in the product today |
| Notification links | none |
| Blocker | `/dashboard/analytics` is **occupied** by Event Insights; migration step 1 (absorb it) has not been done |
| Test impact | `analyticsArchitecture.test.ts` tests 38/39/41/42 pin the current strings and file locations |

**Classification: REQUIRES DEPENDENCY CLEANUP.** Not safe until Event Insights is absorbed and
the finance/`events` permission asymmetry (§N) is resolved.

### Migration 2 — surface Reports in primary navigation (no route change)

| | |
|---|---|
| Route change | **none** — `/dashboard/finance/reports` stays |
| Inbound refs | unaffected |
| Bookmark risk | **none** |
| Notification links | unaffected (already correct) |
| Test impact | `workspaceNav.test.ts` may assert row counts; `reportsHistoryUi.test.ts` case 5 asserts `config/workspaceNav.ts` contains no `'History'` string — **a new nav row must not be labelled "History"**, and that test would need review if the row's label changed |

**Classification: SAFE.** This is a nav-array addition with no route, permission or API change,
and it fixes the highest-impact finding. It should go first.

### Migration 3 — retire `/dashboard/analytics` (Event Insights content)

**Classification: DO NOT MIGRATE YET.** Its path is the migration target; its content is
superseded but still linked from CouponPanel and asserted by two test files.

### Migration 4 — fix the `/dashboard/reports` breadcrumb duplicate

Delete or rename `LEAF_LABELS['/dashboard/reports']`. One line, no route change.
**Classification: SAFE.**

### Migration 5 — correct the mislabelled affordances

Overview quick link "Reports" → "Analytics"; event setup "Open reports" → "Open analytics";
Check-in "Reports Center" → either relabel, or repoint to `/dashboard/finance/reports` (which is
what its label promises). **Classification: SAFE** for the relabels; **SAFE WITH REDIRECT** is
not needed since no route moves. Repointing the Check-in button is a behaviour change and should
be a product decision.

---

## R. Premium Enterprise IA Assessment

**Clarity — poor.** Six surfaces, two names, and the mapping is inverted in the most visible
places. A new finance hire told "run the settlement report" has no navigational path to it.

**Predictability — poor.** Clicking something labelled "Reports" produces a report exactly zero
times out of five in-product affordances.

**Information hierarchy — good underneath, unexpressed above.** The engine separation
(`lib/analytics/*` vs `lib/reports/*`) is genuinely clean, and both workspaces have adopted the
same "one row, tabs inside" shape. The sidebar simply does not reflect it.

**Discoverability — the critical failure.** Five shipped Analytics modules and one shipped
Reports workspace have, between them, **one** in-product entry point.

**Cognitive load — high, and self-inflicted.** The `key: 'reports'` / `label: 'Analytics'` /
`href: '/dashboard/reports'` triple means even a maintainer reading the nav file must hold three
names for one row.

**Consistent terminology — no.** "Reports", "Reports Center", "Analytics", "Event Insights",
"Analytics & Insights", "Operations reports" all appear, for four distinct things.

**Event vs workspace context — unclear**, and actively wrong in one case (the Analytics row is
disabled with no event selected, though the page works workspace-wide).

**Finance separation — good.** Money is gated server-side everywhere; no client decides it.

**Role-aware navigation — partially.** The sidebar gates on the real matrix, but the Analytics
row carries no permission and is shown to gate-only roles.

**Scalability — the architecture scales; the navigation does not.** Five modules were added
without a single nav change, which is precisely how they became invisible. Nothing structurally
prevents the sixth from doing the same.

---

## S. Test Coverage

**Strong:**
- `tests/unit/analyticsArchitecture.test.ts` — pins the migration contract itself: routes
  distinct (38), every must-resolve route has a page (39), the ordered migration with
  preconditions (40), the sidebar row's exact string (41), breadcrumb agreement (42).
- `tests/unit/workspaceNav.test.ts` — the nav SSOT.
- `tests/unit/navigationRegistry.test.ts` — palette derivation.
- `tests/unit/analyticsAuthorization.test.ts`, `analyticsRevenue.test.ts` — server gating.
- `tests/unit/reportExportAuthorization.test.ts` (40), `reportHistoryReader.test.ts` (45),
  `reportsWorkspacePresentation.test.ts` (34), `reportsHistoryUi.test.ts` (31).

**Missing:**
- **No test asserts that a route is reachable from navigation.** This is the exact gap that let
  five modules ship unreachable. A test comparing the set of `app/(dashboard)/dashboard/**/page.tsx`
  routes against the set of `WORKSPACE_NAV` destinations would have caught it on day one.
- No breadcrumb output test — the duplicated "Analytics / Analytics" trail is untested and was
  found only by executing the resolver.
- No test that nav-declared `scope` matches page behaviour (would have caught the disabled
  Analytics row).
- No mobile-navigation test (low risk — one shared array).
- No test that nav `permission` matches the destination route's server authorization (would have
  caught the gate-role visibility and the finance/`events` asymmetry).

**Tests that encode legacy behaviour — will fail on migration, by design:**
- `analyticsArchitecture.test.ts` test 41 pins `"label: 'Analytics', icon: BarChart3, href: '/dashboard/reports'"` verbatim.
- test 42 pins `'/dashboard/reports': 'Analytics'` in `LEAF_LABELS` — **this is the duplicated
  breadcrumb, currently protected by a test.** Fixing §J means updating this assertion.
- test 39 requires `app/(dashboard)/dashboard/analytics/page.tsx` to exist — retiring Event
  Insights means updating it.
- `reportsHistoryUi.test.ts` test 5 asserts `config/workspaceNav.ts` contains no `'History'`.

These are tripwires, not bugs. They must be updated deliberately as part of a migration, never
deleted to make a build pass.

---

## T. Security / Authorization Considerations

No authorization was changed and none is recommended in this phase. Confirmations for the
proposed IA:

- **Permission bypass — no.** Adding a Reports nav row grants nothing: every report route
  re-authorizes server-side (sync route, export create, poll, process, cancel, download,
  history). The nav `permission` field is advisory and documented as such.
- **Role escalation — no**, provided a new Reports row carries **no** `permission`. Giving it
  `transactions` would *hide* Reports from a role holding only `settlements` or `wallet` while
  the server still serves them — a navigation/authorization disagreement in the safe direction,
  but still a lie. The page already self-filters correctly (RD-12-10).
- **Financial visibility leakage — no.** Money remains gated inside payloads by `transactions`.
- **Cross-event access — no.** Event scope is enforced by `requireEventScope` server-side, not by
  the `?eventId=` the shell appends.
- **Cross-workspace access — no.** Workspace identity comes from the session in every route
  audited.

**Safeguards required of any future implementation:**

1. A nav row must never be the reason a user can or cannot reach data. Adding rows must not
   change a single server check.
2. **The finance/`events` asymmetry (§N) must be resolved before Analytics moves**, and resolved
   deliberately: either the Analytics modules relax to `authorizeAnyWorkspace` with per-section
   gating (matching `/api/organizer/dashboard`), or finance is accepted as losing Analytics. The
   first is a real authorization change and needs its own audited phase. **Do not let a
   navigation phase quietly perform it.**
3. Gate-only roles should be excluded from the Analytics row by the same `isCheckinOnlyRole` rule
   the server uses, rather than relying on `CheckinStaffGuard`'s redirect.

---

## U. Performance / Scale Considerations

- **`/api/organizer/workspace` is fetched twice per dashboard load.**
  `lib/hooks/useWorkspacePermissions.ts` consolidated three callers into one shared hook (its own
  comment records the measurement), but `components/dashboard/CheckinStaffGuard.tsx:60` still
  makes an independent call. One redundant request per load. **P3.**
- **`EventContextProvider` fetches the event list once for the shell**, and the Analytics modules
  read the selection rather than re-fetching — correct. The 403 observed during RD-12-10 QA
  (`[finance] 403 ← /api/organizer/events`) originates here and is correct authorization
  (`finance` lacks `events`), but it means the shell issues a request that always fails for that
  role, on every page load.
- **No duplicated Analytics loads.** Each module fetches its own payload once; no shared parent
  re-fetches.
- **Adding nav rows costs nothing at runtime** — `WORKSPACE_NAV` is a static array and the
  palette caches its derivation (`navCache`).
- Surfacing five Analytics modules as **tabs within one route** (recommended) avoids five
  separate shell initialisations, which five separate sidebar rows would incur on every switch.

None of this blocks the IA work.

---

## V. Findings by Severity

### P0

**P0-1 · The entire Analytics workspace is unreachable from the product**
*Location:* `app/(dashboard)/dashboard/analytics/{overview,registrations,revenue,operations,communications}/page.tsx`; `config/workspaceNav.ts`
*Evidence:* Repository-wide search for `href=`/`push`/`Link`/nav-array/palette/notification references to those five routes returns **0**. The only navigations are `scripts/qa/rd-analytics-0{6,7,8,9},10,11-shots.mjs`, which type URLs. Breadcrumbs for all five resolve to `["Overview"]` (executed, §J).
*Impact:* Five audited, tested, shipped modules (RD-06/08/09/10/11) deliver zero user value. Workflows B and C are impossible through the UI.
*Recommendation:* Surface them — preferably as tabs of one Analytics route, matching the pattern RD-12-11 validated for Reports.
*Implementation required:* **Yes.**

**P0-2 · The Reports workspace is absent from primary navigation and from ⌘K**
*Location:* `config/workspaceNav.ts` (no entry); `lib/commandPalette/registry.ts` (derives from it)
*Evidence:* Exactly one in-product link to `/dashboard/finance/reports` — `app/(dashboard)/dashboard/finance/page.tsx:331`. Zero nav rows, zero palette commands.
*Impact:* The product's only report generator — the subject of RD-12-02 through 12-11 — is undiscoverable. Workflows D, E and F all fail at the entry point.
*Recommendation:* Add one top-level Reports row pointing at `/dashboard/finance/reports`, with **no** `permission` (the page self-filters; see §T-2).
*Implementation required:* **Yes.**

### P1

**P1-1 · Five affordances labelled "Reports" lead to the analytics dashboard**
*Location:* `dashboard/page.tsx:91` ("Reports"); `lib/eventSetup/items.ts:315` ("Open reports"); `check-in/operations/ReportsTab.tsx:122` ("Reports Center"); `lib/events/eventTabs.ts:73` (tab "Reports"); plus the `key: 'reports'` sidebar row labelled "Analytics".
*Evidence:* §H table — all four navigable references resolve to `/dashboard/reports`, an analytics dashboard.
*Impact:* Workflow E is actively misdirected. Terminology teaches users the wrong model.
*Recommendation:* Relabel to "Analytics"; decide separately whether "Reports Center" should repoint to the real one.
*Implementation required:* **Yes** (labels); the repoint is a product decision.

**P1-2 · Moving Analytics to its canonical route would remove it from the finance role**
*Location:* `app/api/organizer/dashboard/route.ts:733` vs `app/api/organizer/analytics/overview/[eventId]/route.ts:48`
*Evidence:* `authorizeAnyWorkspace` (no permission) vs `authorizeWorkspace(req, 'events')`; `ROLE_PERMISSIONS.finance` omits `events` (§N table).
*Impact:* A navigation phase could silently deliver a permission regression to the one role most likely to use analytics daily.
*Recommendation:* Resolve deliberately in its own phase before any Analytics route migration. Do not bundle it into an IA change.
*Implementation required:* **Yes, before migration** — not in a nav phase.

**P1-3 · No test asserts that a route is reachable from navigation**
*Location:* `tests/unit/workspaceNav.test.ts`, `navigationRegistry.test.ts`
*Evidence:* Five unreachable modules passed every gate for six phases.
*Impact:* The defect class that produced P0-1 is undetected and will recur.
*Recommendation:* A test reconciling the dashboard route tree against `WORKSPACE_NAV` destinations, with an explicit allow-list for deliberately unlinked routes.
*Implementation required:* **Yes.**

### P2

**P2-1 · `/dashboard/reports` renders a duplicated breadcrumb**
*Location:* `lib/navigation/breadcrumbs.ts:107,110,160`
*Evidence:* Executed — trail is `Overview / Analytics / Analytics` (§J). Currently *protected* by `analyticsArchitecture.test.ts` test 42.
*Impact:* Visible polish defect on the most-used analytics surface.
*Recommendation:* Remove `LEAF_LABELS['/dashboard/reports']` (the nav item's own label already supplies "Analytics"); update test 42 in the same change.
*Implementation required:* **Yes.**

**P2-2 · The Dashboard Overview links to the orphaned legacy Event Insights route**
*Location:* `components/dashboard/CouponPanel.tsx:188,250`; `app/(dashboard)/dashboard/page.tsx:954`
*Evidence:* `CouponPanel` is mounted without `href`, so the default `'/dashboard/analytics'` applies, rendered with `hrefLabel="Analytics"`.
*Impact:* A live link into a route with no nav owner and no breadcrumb, scheduled for replacement.
*Recommendation:* Point it at the canonical analytics destination once one exists; leave until then.
*Implementation required:* **Yes, during migration.**

**P2-3 · The Analytics row is disabled when no event is selected, though the page works**
*Location:* `config/workspaceNav.ts:165` (`scope: 'event'`); `resolveNavHref` returns `null`; `app/(dashboard)/dashboard/reports/page.tsx:355-369`
*Evidence:* The page branches on `selectedEventId` and fetches the unscoped payload when none is set — an "All events" state the nav's binary scope cannot express.
*Impact:* Workspace-wide analytics is unreachable until an event is chosen.
*Recommendation:* Introduce a third scope (`'mixed'`) or mark the row `'global'`. Needs care: `EVENT_SCOPED_PREFIXES` derives from this field.
*Implementation required:* **Yes.**

**P2-4 · Gate-only roles see an Analytics row they cannot use**
*Location:* `config/workspaceNav.ts:165` (no `permission`); `Sidebar.tsx:209`
*Evidence:* §N — all six roles see the row; `authorizeAnyWorkspace` refuses `checkin_*` with 403. Mitigated only by `CheckinStaffGuard`'s client-side redirect, self-described as "a routing hint, not a control".
*Impact:* Transient — the exact "door that slams" the nav file's rule 3 exists to prevent.
*Recommendation:* Filter gate-only roles in the sidebar using the same `isCheckinOnlyRole` rule the server uses.
*Implementation required:* **Yes** (low effort).

### P3

**P3-1 · `/reports` is an empty directory**
*Location:* `app/(dashboard)/reports/.gitkeep` (commit `51e7e7d`)
*Evidence:* No `page.tsx`; the route 404s.
*Impact:* None to users; misleads maintainers into thinking a route exists.
*Recommendation:* Remove the directory, or build it if `/reports` is the intended canonical Reports URL. **Implementation required:** No.

**P3-2 · `LEAF_LABELS['/dashboard/analytics'] = 'Event Insights'` is dead code**
*Evidence:* No nav item owns that path, so `buildBreadcrumbs` returns before appending the leaf (executed, §J).
*Recommendation:* Remove, or make live by giving the route a nav owner. **Implementation required:** No.

**P3-3 · `/api/organizer/workspace` is fetched twice per dashboard load**
*Location:* `lib/hooks/useWorkspacePermissions.ts:87`; `components/dashboard/CheckinStaffGuard.tsx:60`
*Recommendation:* Have the guard consume the shared hook. **Implementation required:** No.

**P3-4 · The export-ready notification lands on Reports, not on History**
*Location:* `lib/notifications/inbox/notify.ts:205`
*Impact:* One extra click. History's tab state is deliberately local (a query param would make the page dynamic), so this is a design trade-off, not a bug.
*Recommendation:* Consider only if History gains a shareable URL. **Implementation required:** No.

**P3-5 · The nav row uses three different names for one destination**
*Location:* `config/workspaceNav.ts:165` — `key: 'reports'`, `label: 'Analytics'`, `href: '/dashboard/reports'`.
*Recommendation:* Align `key` and `href` with the label during migration. **Implementation required:** No (but do it while migrating).

**Counts: P0 = 2 · P1 = 3 · P2 = 4 · P3 = 5. Total 14.**

---

## W. Recommended Implementation Sequence

Not implemented. Ordered so each phase is independently shippable and reversible.

**Phase 1 — Surface what already exists (no route changes).**
Add a top-level **Reports** row → `/dashboard/finance/reports`, no `permission`. Fix the four
mislabelled affordances (P1-1). Fix the duplicated breadcrumb (P2-1) and update
`analyticsArchitecture.test.ts` test 42. Exclude gate-only roles from the Analytics row (P2-4).
*Closes P0-2, P1-1, P2-1, P2-4. Zero route, permission or API change. Lowest risk, highest value.*

**Phase 2 — Make the Analytics modules reachable.**
Consolidate Overview / Registrations / Revenue / Operations / Communications into one Analytics
route with in-page tabs, following the Reports/History pattern from RD-12-11. Resolve the scope
declaration (P2-3) so the row is not disabled without an event.
*Closes P0-1, P2-3. No route migration yet — mount the tabbed workspace where navigation already
points.*

**Phase 3 — Reconcile Analytics authorization (audited separately).**
Decide and implement whether the Analytics modules relax to `authorizeAnyWorkspace` with
per-section gating, matching `/api/organizer/dashboard`. **This is an authorization change and
must not ride inside an IA phase.**
*Closes P1-2. Blocks Phase 4.*

**Phase 4 — Route migration.**
Absorb Event Insights (migration step 1), move the workspace to `/dashboard/analytics`, redirect
`/dashboard/reports` permanently, sweep the six named referrers including CouponPanel (P2-2),
and update the tripwire tests deliberately.
*Closes P2-2. Requires Phases 2 and 3.*

**Phase 5 — Guardrails.**
Add the reachability test (P1-3), a breadcrumb-output test, and a nav-scope/permission
reconciliation test. Clean up P3-1, P3-2, P3-3, P3-5.
*Closes P1-3 and the P3 set. Prevents recurrence.*

---

## X. Explicit Non-Goals

Intentionally **not** changed in this phase: any route, redirect or route alias; `WORKSPACE_NAV`
or any navigation array; the sidebar, mobile drawer, breadcrumbs or command palette; any
permission, role or authorization check; Firestore rules; Firestore indexes; analytics
calculations; report builders; the report history implementation; export authorization; the
signed-download implementation; notification links; component UI; tests; production data or
configuration. No refactoring of any kind was performed.

---

## Y. Files Inspected

**Navigation & IA:** `config/workspaceNav.ts` · `config/navigation.ts` ·
`components/dashboard/Sidebar.tsx` · `components/dashboard/Breadcrumbs.tsx` ·
`lib/navigation/breadcrumbs.ts` · `lib/commandPalette/registry.ts` ·
`lib/commandPalette/useCommandData.ts` · `lib/events/eventTabs.ts` · `lib/events/eventContext.ts`

**Routes:** `app/(dashboard)/dashboard/reports/page.tsx` ·
`app/(dashboard)/dashboard/analytics/page.tsx` and the five module pages ·
`app/(dashboard)/dashboard/finance/reports/page.tsx` · `app/(dashboard)/dashboard/finance/page.tsx` ·
`app/(dashboard)/dashboard/page.tsx` · `app/(dashboard)/layout.tsx` · `app/(dashboard)/reports/` ·
`app/(dashboard)/dashboard/events/[eventId]/ManageEventClient.tsx` ·
`app/(dashboard)/dashboard/events/[eventId]/tabs/ReportsTab.tsx` ·
`app/(dashboard)/dashboard/check-in/operations/ReportsTab.tsx`

**APIs:** `app/api/organizer/dashboard/route.ts` · `app/api/organizer/analytics/[eventId]/route.ts` ·
`app/api/organizer/analytics/overview/[eventId]/route.ts` · `app/api/organizer/reports/history/route.ts`

**Contracts & support:** `lib/analytics/routes.ts` · `lib/reports/registry.ts` ·
`lib/reports/catalog.ts` · `lib/team/workspace.ts` · `lib/team/types.ts` ·
`lib/hooks/useWorkspacePermissions.ts` · `lib/notifications/inbox/notify.ts` ·
`lib/eventSetup/items.ts` · `components/dashboard/CouponPanel.tsx` ·
`components/dashboard/CheckinStaffGuard.tsx` · `firestore.rules` · `firestore.indexes.json`

**Tests:** `analyticsArchitecture.test.ts` · `workspaceNav.test.ts` · `navigationRegistry.test.ts` ·
`analyticsAuthorization.test.ts` · `analyticsRevenue.test.ts` · `couponFilterAndPerformance.test.ts` ·
`reportsHistoryUi.test.ts` · `reportsWorkspacePresentation.test.ts`

---

## Z. Verification Performed

1. `find app -type f \( -name page.tsx -o -name route.ts \) | grep -iE "analytic|report"` — route inventory.
2. `find "app/(dashboard)/reports" -type f` → only `.gitkeep`; `git log` → commit `51e7e7d`.
3. Per-route inbound counts across `app components lib config scripts tests`.
4. `grep -rn -E "href[=:].*'/dashboard/analytics/|push\('/dashboard/analytics/"` → **0 results**.
5. Non-comment mention filter for the five module routes → **0 results in product code**.
6. Reference-source grouping by file (QA scripts and comments only).
7. **Executed `buildBreadcrumbs` + `leafLabelFor` + `navItemForPath`** over nine paths via
   `npx tsx` on a temporary script — produced the §J table. Script deleted after use.
8. **Executed a role-visibility computation** over `WORKSPACE_NAV_ITEMS`, `ROLE_PERMISSIONS` and
   `isCheckinOnlyRole` via `npx tsx` — produced the §N table. Script deleted after use.
9. Authorization greps across the dashboard and analytics APIs.
10. `grep -n "EVENT_PARAM" lib/events/eventContext.ts` → `'eventId'`, consistent with QA scripts.
11. Sidebar/mobile shared-array confirmation (`Sidebar.tsx:296`).
12. Notification link trace: `exportJob.ts:172` → `notify.ts:197-206`.
13. `CouponPanel` call-site inspection (`dashboard/page.tsx:954` — no `href` passed).
14. Test-file discovery for navigation, analytics, reports, breadcrumbs and palette.

**Not run:** no test suite, no TypeScript check, no ESLint run, no production build, no browser
session, no emulator. This phase changed no source code, so none was warranted — and none is
claimed.

---

## AA. Source Changes

**One file created: `docs/RD-ANALYTICS-12-12-AUDIT.md`.**

No other file in the repository was created, modified or deleted by this phase. Two temporary
`.mts` scripts were written into the working directory to execute the breadcrumb and role
resolvers, and both were deleted in the same command that ran them; `git status` shows neither.

---

## AB. Git / Deployment Status

- **Commit status:** not committed. HEAD unchanged at `b7e5fdf`; nothing staged.
- **Push status:** not pushed.
- **Deployment status:** not deployed.
- **Firestore rules:** unchanged. `firestore.rules` not modified by this phase.
- **Firestore indexes:** unchanged. No index added, altered or deployed. The RD-12-07
  `settlementRequests` and RD-12-11 `reportExportJobs` definitions both remain **undeployed**.

---

## AC. Final Verdict

**APPROVED WITH CONDITIONS**

The IA problem is fully characterised, the evidence is reproducible, and the migration intent was
written down in advance (`lib/analytics/routes.ts`) and is still sound. Implementation may
proceed, subject to three conditions:

1. **Phase 1 must not move any route.** Surfacing Reports and correcting labels closes both P0s
   and all four P2s with zero migration risk. Do that first and ship it.
2. **P1-2 must be resolved in its own audited phase before any Analytics route migration.** The
   `finance` / `events` asymmetry means an IA change could silently revoke Analytics from the
   finance role. A navigation phase must never perform an authorization change.
3. **The tripwire tests in `analyticsArchitecture.test.ts` (38, 39, 41, 42) must be updated
   deliberately, never deleted to make a build pass.** They encode the current state on purpose.

---

## AD. Recommended Next Phase

**RD-ANALYTICS-12-13 — Reports & Analytics Navigation Surfacing (implementation, no route
changes).**

Scope: Phase 1 of §W — add the Reports nav row, correct the four mislabelled affordances, fix the
duplicated breadcrumb, exclude gate-only roles from the Analytics row, and add the navigation
reachability test (P1-3) so the defect class cannot recur.

Why this one: it closes the two P0 findings and three P2s while changing no route, no permission,
no API and no Firestore artifact — so it is independently shippable and trivially reversible. It
also delivers the largest user-visible improvement in the whole sequence: the report generator
built across nine phases becomes findable.

---

## AE. Completion Checklist

- [x] Route inventory complete
- [x] Analytics boundary audited
- [x] Reports boundary audited
- [x] Scope audited
- [x] Navigation audited
- [x] Inbound references searched
- [x] Legacy/orphan routes investigated
- [x] Permissions audited
- [x] Breadcrumbs audited
- [x] Command palette audited
- [x] Notifications audited
- [x] Mobile navigation audited
- [x] User workflows audited
- [x] Future IA evaluated
- [x] Migration safety evaluated
- [x] Tests audited
- [x] Security implications reviewed
- [x] Performance implications reviewed
- [x] No implementation performed
- [x] No rules/indexes changed
- [x] No deployment performed
- [x] No commit/push performed
