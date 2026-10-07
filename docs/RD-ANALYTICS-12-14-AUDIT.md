# RD-ANALYTICS-12-14 — Analytics Authorization Reconciliation Audit

Audit only. No authorization, permission, role, route, navigation, rule or index was changed.

---

## A. Executive Summary

The premise handed to this phase was that two Analytics surfaces disagree about authorization
and that the disagreement must be reconciled. It is real — but the audit found the mismatch is
**not** the one the framing implies, and the obvious remedy is the wrong one.

**Three findings decide this audit.**

**1. `events` is not doing event-scoping work in the Analytics routes.** The canonical route
pairs `authorizeWorkspace(req, 'events')` with `requireEventScope`, which reads as
defence-in-depth. It is not: `isEventInScope` returns `true` for **every non-gate role
regardless of assignment** (verified by execution, §J). The only callers it constrains are
gate-only roles — who never reach it, because they hold no `events`. Cross-event and
cross-workspace protection comes entirely from `identity.organizerUid !== authz.workspaceUid`.
So `events` here is a coarse role filter, and the route's own header says so: *"`events` admits
owner, admin and manager… the base permission that correctly excluded gate staff"*. It was
chosen to mean **"is an organizer, not a gate operator"** — a concept that already has a
dedicated primitive: `authorizeAnyWorkspace` + `isCheckinOnlyRole`.

**2. The legacy boundary is the looser one, and it leaks participant PII.**
`/api/organizer/dashboard` authorizes with `authorizeAnyWorkspace` and never checks
`registrations` (0 occurrences). Its `activity` feed carries `attendeeName` unconditionally. So
**`finance` — which holds no `registrations` permission — receives attendee names** from the
endpoint behind `/dashboard/reports`. Any proposal to "relax Analytics to match the legacy
surface" would be adopting a boundary that has a live defect.

**3. Finance cannot select an event anyway.** The EventSelector is fed by one call to
`GET /api/organizer/events?limit=100`, which authorizes with `authorizeWorkspace(req, 'events')`.
Finance is refused. So even if Analytics dropped its `events` requirement tomorrow, a finance
user would reach an event-scoped workspace with an empty selector and nothing to view. **Granting
Analytics to finance is not a one-line permission question; it is a second, independent
dependency nobody has costed.**

The canonical Analytics model is otherwise **architecturally excellent**: authorization strictly
precedes every read, the finance decision travels *into* the computation so financial reads are
never issued for a caller who may not see them, money is absent rather than zeroed, and the
payload is aggregate counts with no participant PII. It is the better of the two models on every
dimension except one — the permission it names.

**Recommended model: Option C** — replace `authorizeWorkspace(req, 'events')` with
`authorizeAnyWorkspace` on the Analytics routes, keeping the existing workspace-ownership event
check and the existing `transactions` money gate untouched. This states the boundary that is
actually intended, changes no role and no permission, and is strictly *narrower* than the legacy
surface it would supersede.

**Verdict: APPROVED WITH CONDITIONS.** The model is clear; two conditions gate implementation
(§AI).

---

## B. Authorization Architecture Inventory

All in `lib/team/` unless noted. Nothing else in the repository defines an organizer boundary.

| Primitive | Purpose | Input | Output | On failure |
|---|---|---|---|---|
| `verifyCaller` (`access.ts`) | Token → uid, with an email-verification gate | `Request` | `{uid}` \| `null` | `null` |
| `resolveWorkspaceUid` | uid → workspace context (role, permissions, eventIds, isOwner) | `callerUid` | `WorkspaceContext` | falls back to self-owned |
| `authorizeWorkspace(req, permission)` | Auth + workspace + **one named permission** | `Request`, `TeamPermission` | `WorkspaceAuthz` | 401 unauth; 403 `Missing required permission: X.` |
| `authorizeAnyWorkspace(req)` | Auth + workspace, **no permission**, but refuses gate-only roles | `Request` | `WorkspaceAuthz` | 401; 403 `This account is limited to event check-in.` |
| `authorizeEvent(req, permission, eventId)` | `authorizeWorkspace` + `requireEventScope` | + `eventId` | `WorkspaceAuthz` | 403 `You are not assigned to this event.` |
| `requireEventScope(ctx, eventId)` | Thin adapter over `isEventInScope` | context, id | `boolean` | — |
| `isEventInScope` (`types.ts`, pure) | The event-assignment rule | subject, id | `boolean` | — |
| `isCheckinOnlyRole` (`types.ts`, pure) | Every held permission ∈ `GATE_PERMISSIONS` | role | `boolean` | — |
| `authorizeWorkspaceDownload` | `authorizeWorkspace` accepting `?token=` | `Request`, permission | `WorkspaceAuthz` | as above |
| `requireResourcePermission` | Cross-workspace resource check | uids, permission | `AccessResult` | — |

`denied()` returns a context carrying **no identity** and `isStaffCredential: true` — so a caller
that reads scope off a denied context sees the most restrictive value, not an unrestricted one.

There is **no** `authorizeAnyEvent`, `authorizeOwner` or `requireOwner` in the organizer
surface; `requireAdmin` exists only for the platform-admin area (`lib/admin/`), out of scope.

---

## C. Current Role / Permission Matrix

`ALL_PERMISSIONS` (10): `events, registrations, broadcasts, certificates, checkin, walkin,
participants, wallet, settlements, transactions`.
`GATE_PERMISSIONS`: `checkin, walkin`.
**No `analytics` permission exists. No `reports` permission exists.** Verified by execution.

| Role | Permissions | Analytics consequence |
|---|---|---|
| owner | all 10 | Full Analytics incl. revenue |
| finance | `wallet, settlements, transactions` | **403** at the Analytics route (no `events`); would also have no event to select |
| admin | `events, registrations, broadcasts, certificates, checkin, walkin, participants` | Analytics allowed; **revenue absent** (no `transactions`) |
| manager | `events, registrations, checkin, walkin, participants` | Analytics allowed; revenue absent |
| checkin_lead | `checkin, walkin` | gate-only → refused everywhere |
| checkin_staff | `checkin` | gate-only → refused everywhere |

Executed outcome table:

```
role           gateOnly  authorizeAnyWorkspace  events  transactions  ANALYTICS  LEGACY    eventsListAPI
owner          false     true                   true    true          ALLOW      ALLOW     ALLOW
finance        false     true                   false   true          DENY 403   ALLOW     DENY 403
admin          false     true                   true    false         ALLOW      ALLOW     ALLOW
manager        false     true                   true    false         ALLOW      ALLOW     ALLOW
checkin_lead   true      false                  false   false         DENY 403   DENY 403  DENY 403
checkin_staff  true      false                  false   false         DENY 403   DENY 403  DENY 403
```

**Finance is the only role the two boundaries disagree about.**

---

## D. `authorizeWorkspace` Analysis

Auth → resolve workspace → `ctx.permissions.includes(permission)`. Fails 403 with the permission
named. Straightforward and correct.

**What `events` means in practice.** 35 call sites. Grouped by what they protect:

| Kind | Count | Examples |
|---|---|---|
| Event **mutation / lifecycle** | 28 | publish, archive, cancel, duplicate, edit, republish, restore, resubmit, save-changes, status, coupons (CRUD), pricing-override, waitlist promote/remove, exhibition, nominations, speaker/sponsor applications, email-branding, drafts |
| Event **read** | 5 | events list, event detail (GET), edit-history (GET), setup-signals (GET) |
| **Analytics** (read-only) | 2 | `analytics/[eventId]`, `analytics/overview/[eventId]` |

So `events` is overwhelmingly **event-management authority** — the right to change an event. The
analytics routes are among the few non-mutating consumers, and they borrowed it for a different
reason, which the source states plainly (§G).

**What `transactions` means.** The money boundary, used identically by `/api/organizer/finance`,
`/api/organizer/dashboard` and both analytics routes. Consistent and well-defined.

---

## E. `authorizeAnyWorkspace` Analysis

From source: auth → resolve workspace → refuse if `!ctx.isOwner && isCheckinOnlyRole(ctx.role)`.

It means **"any active member of the workspace who is not a gate-only operator."** Not "any
authenticated user", not "any role with any permission", not "owner/admin/manager". Its own
comment: *"a permissionless surface is still an organizer surface, and a role whose entire grant
is `checkin` has no business reading workspace aggregates."*

This is precisely the concept the Analytics routes reached for `events` to express.

---

## F. Legacy `/dashboard/reports` Authorization

Page → `GET /api/organizer/dashboard`. `authorizeAnyWorkspace`, then
`financeAllowed = permissions.includes('transactions')`.

Event scoping is by **path-proof ownership**: `users/{workspaceUid}/eventDrafts/{eventId}`. An
event the workspace does not own does not exist at that path, so a forged id cannot widen the
result. A bad id refuses rather than falling back. The page also supports an **"All events"**
mode — it is genuinely mixed-scope, unlike the canonical modules.

### Module classification

| Module | Classification |
|---|---|
| Event counts, active events, registrations, trends | Safe for all workspace members |
| Licence position | Safe for all workspace members |
| `fees?`, revenue, wallet, settlement, reversals | **Requires finance** — correctly gated on `transactions`, absent not zeroed |
| Check-in / attendance counters | Safe for all workspace members |
| **`activity[]` carrying `attendeeName`** | **Requires `registrations` — and is NOT gated. See P1-1.** |

**Why `authorizeAnyWorkspace` was selected** is documented in the route: it is a workspace
aggregate for every organizer role, with money layered on `transactions` (RD-DASH-12, which
fixed admin/manager reading the payout position). The choice is coherent *for aggregates*. It was
never re-examined when a participant-name feed was added beside them.

---

## G. Canonical Analytics Authorization

All five modules call **one** endpoint — `useAnalyticsScope.ts:80` →
`/api/organizer/analytics/overview/[eventId]`. There is exactly one canonical boundary.

Chain, in source order:

1. `authorizeWorkspace(req, 'events')` — 401/403 before anything is read
2. `resolveAnalyticsEventIdentity(eventId)` — **one** document read
3. Deny if `!identity || identity.organizerUid !== authz.workspaceUid || !requireEventScope(...)`
4. `financeAllowed = authz.permissions.includes('transactions')`
5. `normalizeRange(...)` — untrusted input, falls back rather than throwing
6. `getEventAnalytics(eventId, { includeFinancial: financeAllowed, range })`
7. Capability context from the event's own `identifierConfigs`

**Order: authentication → workspace+permission → event → finance → read → capability.** Exactly
the order §7 asks for, with no deviation.

The design detail worth naming: `financeAllowed` is passed **into** the producer, so financial
reads are *never issued* for an unauthorized caller. That is fail-closed by construction rather
than by filtering a computed payload — nothing exists to leak through JSON, an export, or a field
a future client forgets to guard.

The `analytics/[eventId]` route (legacy per-event) applies the same discipline, and its header
records the two defects it fixed: no permission at all (so `checkin_staff` read gross revenue),
and no event scope.

---

## H. Analytics Data Classification

From `lib/analytics/contract.ts`. Every value is a `Count` or `MaybeMoney` — an aggregate, never a
row.

| # | Category | Sensitivity | Required permission | Event scope? | Current gate |
|---|---|---|---|---|---|
| A | Registration counts | Low | none beyond workspace | yes | `events` |
| B | Registration trends (`byDay`, `byPass`) | Low | none beyond workspace | yes | `events` |
| C | Payment **status counts** (paid/pending/free) | Low–medium | none beyond workspace | yes | `events` |
| D | Confirmed revenue | **High** | `transactions` | yes | `transactions` ✅ absent if denied |
| E | Refunds | **High** | `transactions` | yes | `transactions` ✅ |
| F | Profit / fee estimate | **High** | `transactions` | yes | `transactions` ✅ |
| G | Communication counts | Low | none beyond workspace | yes | `events` |
| H | Communication **spend** | **High** | `transactions` | yes | `spend?` absent if denied ✅ |
| I | Check-in / attendance counts | Low | none beyond workspace | yes | `events` |
| J | Timing | Medium | none beyond workspace | yes | `timing?` capability-gated ✅ |
| K | Pass / category counts | Low | none beyond workspace | yes | `events` |
| L | Event health / coverage / limits | Low | none beyond workspace | yes | `events` |
| M | Operational (identifiers, capacity) | Medium | none beyond workspace | yes | `identifiers?` capability-gated ✅ |
| N | Participant information | **High (PII)** | `participants`/`registrations` | yes | **Not present** — `participants?` absent; `hasParticipantData: false` |
| O | Other | — | — | — | None found |

**Architectural assessment:** rows D–F, H, J, M and N are gated by something that genuinely
describes them. Rows A–C, G, I, K–L are gated by `events`, which describes *the right to change
an event* — a poor fit for reading an aggregate count. That mismatch is the audit's subject.

**No participant PII exists in the canonical payload.** `participants?` is absent and
`hasParticipantData` is hard-coded `false` with a stated reason (no form-field → semantic-type
mapping exists; guessing "would manufacture demographics"). The canonical surface is *stricter*
than the legacy one here.

---

## I. Financial Analytics Boundary

Traced through RD-ANALYTICS-02's work.

1. **Which data is financial?** D, E, F, H above, plus every `MaybeMoney` field.
2. **Which permission?** `transactions`, uniformly — the same one `/api/organizer/finance` and
   `/api/organizer/dashboard` use.
3. **Fail-closed?** **Yes, structurally.** `includeFinancial` is an input to the producer, so the
   reads are not issued. Absence, not zeroing: *"₹0 is a lie that looks like a fact; a missing
   field lets the UI say 'not available to your role', which is true."*
4. **Can a non-finance user receive money fields?** No. `revenue?` and `spend?` are optional and
   omitted; the UI renders `NoFinancialAccess` rather than an empty shell.
5. **Indirect inference?** No aggregate in the non-financial set is a money proxy — counts are
   counts, and no fee-per-unit is exposed to multiply by.
6. **Consistency across layers:**

| Layer | Consistent? |
|---|---|
| API (`overview/[eventId]`) | ✅ `financeAllowed` before the read |
| API (`analytics/[eventId]`) | ✅ same |
| Server computation | ✅ `includeFinancial` gates the reads |
| Normalized contract | ✅ `revenue?`, `spend?` optional |
| UI | ✅ `NoFinancialAccess` |
| Comparisons | ✅ an unmeasured side yields no delta (test 18) |
| Exports | ✅ the whole financial section is dropped; day/pass tables keep non-money columns |
| Module navigation | ✅ RD-12-13's strip applies no client gate — the module states its own absence |

**The financial boundary is the strongest part of this architecture and needs no change.**

---

## J. Event Scope Model

`isEventInScope` (executed):

```
role           eventIds=[] → ?    eventIds=[A], asking B → ?
owner          true               true
finance        true               true
admin          true               true
manager        true               true
checkin_lead   true               false
checkin_staff  true               false
```

The rule is `if (!isCheckinOnlyRole(role)) return true` — **event assignment constrains gate-only
roles and nobody else**, which the source states deliberately: broader roles "already hold
workspace-wide permissions and can reach the same event through the organizer surfaces, so
narrowing them here would be a false promise rather than a control." That reasoning is sound.

**Consequence for Analytics:** `requireEventScope` in the canonical route can only ever refuse a
gate-only role, and a gate-only role has already been refused two lines earlier by `events`.
**It is unreachable defence.** Real protection comes from
`identity.organizerUid !== authz.workspaceUid` — workspace ownership of the event.

The zero-assignment rule is nuanced and correct: `[]` means unrestricted for a legacy person row
but **fails closed** for a staff credential (`isStaffCredential`), because such accounts are only
ever created with events, so an empty list is damage rather than history.

**What should an Analytics user need?** Existing primitives already express it: **workspace
membership excluding gate roles** (`authorizeAnyWorkspace`) **plus workspace ownership of the
event** (the uid comparison already in the route). No new access model is required.

---

## K. Finance Role Deep Dive

`finance = ['wallet', 'settlements', 'transactions']` — money only. No `events`, no
`registrations`, no `participants`.

| Surface | Finance today | Boundary |
|---|---|---|
| `/dashboard/finance` | ✅ | `transactions` |
| Reports (`/dashboard/finance/reports`) | ✅ all 8 kinds | per-report permission |
| Report history | ✅ | `authorizeAnyWorkspace` + per-kind |
| Export download | ✅ | `permissionForExportJob` |
| Legacy `/dashboard/reports` | ✅ **incl. attendee names** | `authorizeAnyWorkspace` |
| Canonical Analytics modules | ❌ 403 | `events` |
| `GET /api/organizer/events` (the EventSelector's source) | ❌ 403 | `events` |
| Analytics nav row (since RD-12-13) | hidden | mirrors the above |

**Why finance lacks `events`:** the matrix comment is explicit — finance is a money role,
deliberately excluded from `registrations` and `participants`. Not an oversight.

**Could finance safely access Analytics?**

1. *If Analytics were entirely non-financial* — yes. Rows A–C, G, I, K–M are workspace-level
   operational aggregates with no PII.
2. *If financial modules stayed gated on `transactions`* — yes, and finance **holds**
   `transactions`, so it would legitimately see revenue too.
3. *If event scope were enforced separately* — it already is, by workspace ownership, and finance
   gains nothing it could not already infer from Reports.
4. *If Analytics contained event operational data* — it does (attendance, identifiers, timing).
   These are aggregate counts, not participant records. A finance user seeing "412 checked in" is
   not a disclosure; the legacy surface already gives them the same counter **plus attendee
   names**.

**The blocker is not permission, it is plumbing.** Finance cannot list events, so an event-scoped
Analytics workspace would present an empty selector. Any decision to admit finance must include
that dependency (§T).

---

## L. Admin / Manager Deep Dive

- **admin** = `events, registrations, broadcasts, certificates, checkin, walkin, participants` —
  full operations, **no money**.
- **manager** = `events, registrations, checkin, walkin, participants` — admin minus broadcasts
  and certificates, **no money**.

Both hold `events`, so both reach Analytics today and receive everything except `revenue` and
`spend` — verified by `analyticsAuthorization.test.ts` case 3b, which asserts exactly that.

Both are correctly refused by `/dashboard/finance` and by Finance's nav row (RD-12-13). Reports
shows them a truthful empty state (RD-12-10) because no catalogue kind matches their permissions.

**Their role semantics do imply Analytics access** — they run events and hold `registrations`,
which is strictly *more* than the aggregate counts Analytics exposes. **Event authority and
financial authority are already cleanly separated here, and correctly.**

---

## M. Check-in Role Deep Dive

`checkin_lead = ['checkin','walkin']`, `checkin_staff = ['checkin']`. Both satisfy
`isCheckinOnlyRole` (every held permission ∈ `GATE_PERMISSIONS`).

Refused at every boundary: `authorizeAnyWorkspace` (403 "limited to event check-in"),
`authorizeWorkspace(req, 'events')` (no permission), the events list, and — since RD-12-13 —
the Analytics and Reports nav rows.

`isCheckinOnlyRole` is derived from the matrix, not from role names, so a future gate role
inherits containment automatically. Its header records why the earlier literal rule
(`perms.length === 1 && perms[0] === 'checkin'`) was wrong: adding `walkin` to make
`checkin_lead` would have silently answered `false` and exempted a gate operator from both event
assignment **and** `authorizeAnyWorkspace`.

**Could Analytics leak to gate roles?** Not today. The risk is future: if Analytics moved to
`authorizeAnyWorkspace`, gate exclusion would move from "lacks `events`" to "`isCheckinOnlyRole`"
— still refused, but by a different mechanism, so the negative test must move with it (§Z).

---

## N. Authorization Order Review

| Route | Order | Verdict |
|---|---|---|
| `analytics/overview/[eventId]` | authz → identity(1 doc) → ownership+scope → finance → range → read | ✅ correct |
| `analytics/[eventId]` | authz → ownership → finance → read (header records fixing the reverse) | ✅ correct |
| `organizer/dashboard` | authz → finance → reads | ✅ correct |

**No route computes sensitive data before authorizing.** `analyticsAuthorization.test.ts` case 7
asserts every refusal path invokes the computation zero times, and 7b that the identity read is
one document rather than the analytics scan. No deviation found; no finding raised.

---

## O. Legacy vs Canonical Comparison

| Dimension | Legacy `/dashboard/reports` | Canonical `/dashboard/analytics/*` |
|---|---|---|
| Route | `/dashboard/reports` (compatibility, unlinked since 12-13) | `/dashboard/analytics` + 5 modules |
| Authorization | `authorizeAnyWorkspace` | `authorizeWorkspace(req, 'events')` |
| Scope | **Mixed** — one event or "All events" | **Event only** |
| Financial gating | `transactions`, absent not zeroed | `transactions`, absent **and reads not issued** |
| Event selection | `?eventId=`, ownership by document path | `?eventId=`, ownership by uid comparison |
| Data source | `/api/organizer/dashboard` (rollups + counters) | `getEventAnalytics` (aggregates + rollups) |
| Role access | owner, finance, admin, manager | owner, admin, manager |
| Capability gating | none | `identifierConfigs`-driven (`identifiers?`, `timing?`) |
| Error semantics | 403 on bad id | one message for absent/foreign/unassigned — non-enumerable |
| **Participant PII** | **`attendeeName` in `activity[]`, ungated** | **none** |
| Intended future | redirect to canonical (`ANALYTICS_ROUTE_MIGRATION` step 2) | the canonical workspace |

**Should the legacy model be preserved / replaced / split / tightened / broadened?**
**Tightened, then retired.** It is looser than the canonical model in the one place that matters
(PII), and its mixed scope is the only capability the canonical model lacks. Broadening the
canonical model to match it would import a defect; the correct direction is the reverse.

---

## P. Existing Permission Reuse Analysis

| Candidate | Semantic fit | Security fit | Role fit | Verdict |
|---|---|---|---|---|
| `events` | **Poor** — means "may change an event"; 28 of 35 uses are mutations | Adequate but over-broad as a read gate | Excludes finance for the wrong reason | **Current. Incorrect.** |
| `registrations` | Partial — Analytics is more than registrations | Would newly exclude finance *and* admit nobody new | admin/manager yes, finance no | No |
| `transactions` | Wrong — money only | Would exclude admin/manager from non-financial analytics | Inverts the current problem | No |
| `settlements` / `wallet` | Wrong — payout mechanics | — | — | No |
| `participants` | Wrong — identifier engine | — | — | No |
| `broadcasts` / `certificates` | Wrong — one module each | — | — | No |
| **`authorizeAnyWorkspace` (no permission)** | **Exact** — "an organizer, not a gate operator", which is what the route header says it wanted | Strictly narrower than the legacy surface it supersedes; gate exclusion preserved via `isCheckinOnlyRole`; money and capability gates unchanged | owner, finance, admin, manager | **Best fit** |

The concept Analytics needs is already named in this codebase. It simply is not a `TeamPermission`
— and it does not need to be.

---

## Q. Dedicated Analytics Permission Analysis

Evaluated because §18 requires it, **and rejected.**

An `analytics` permission would need to be added to `ALL_PERMISSIONS`, granted to owner, admin,
manager and (per §T) finance — i.e. **every non-gate role**. A permission that every role holding
any organizer surface possesses is not a permission; it is `authorizeAnyWorkspace` with extra
steps and a migration.

Against it: it duplicates an existing primitive; it requires backfilling every existing
`teamMembers` row or a defaulting rule that is itself a policy decision; it adds an 11th
permission to a deliberately short catalogue; and it invites per-module variants
(`analytics.revenue`, `analytics.operations`) that the `transactions` and capability gates already
handle better.

For it: it would let a workspace *withhold* Analytics from a role that otherwise has organizer
access. **No product requirement for that was found** in any phase, audit or route comment.

**Not justified.** A new permission should be recommended only on strong architectural evidence,
and the evidence points the other way.

---

## R. Future Authorization Options

### Option A — keep `authorizeWorkspace(req, 'events')`
- **Security:** adequate. **Semantics:** wrong — a read gated by a mutation permission.
- **Finance:** permanently excluded from Analytics. **Admin/manager:** unchanged. **Gate:** excluded.
- **Complexity:** zero. **Migration risk:** none. **Compatibility:** total.
- **Cost:** the migration in `lib/analytics/routes.ts` cannot complete without regressing finance,
  and the IA keeps a role that sees Reports and Finance but not Analytics.

### Option B — another existing permission
Rejected in §P. Every candidate is either wrong in meaning or changes the role set arbitrarily.

### Option C — `authorizeAnyWorkspace` + existing event ownership + existing `transactions` ✅
- **Security:** gate roles still refused (`isCheckinOnlyRole`); cross-workspace still refused (the
  uid comparison, unchanged); money still `transactions`; capabilities still server-side. Strictly
  **narrower** than the legacy surface it replaces, because Analytics carries no PII.
- **Semantics:** exact — states the boundary the route header already describes.
- **Finance:** gains non-financial Analytics **and** revenue (it holds `transactions`) — *subject
  to the event-list dependency in §T*.
- **Admin/manager:** unchanged. **Gate:** unchanged (refused).
- **Event scope:** unchanged — `requireEventScope` may stay as inert defence or be removed with a
  comment; either is honest, **keeping it is safer**.
- **Complexity:** one line per route. **Migration risk:** low. **Compatibility:** no role or
  permission changes, so no data migration.

### Option D — dedicated `analytics` permission
Rejected in §Q.

---

## S. Recommended Authorization Model

**Option C.**

```
authorizeAnyWorkspace(req)                     ← replaces authorizeWorkspace(req, 'events')
  → identity.organizerUid === authz.workspaceUid   (unchanged — the real event boundary)
  → requireEventScope(authz, draftId)              (unchanged — inert for non-gate roles, keep)
  → financeAllowed = permissions.includes('transactions')   (unchanged)
  → capability gates from identifierConfigs                 (unchanged)
```

Why this and not the alternatives:

1. **It states what is meant.** The route wanted "an organizer, not a gate operator" and reached
   for the nearest permission. `authorizeAnyWorkspace` *is* that concept, already used by the
   sibling surface.
2. **It grants nothing new to anyone dangerous.** Gate roles remain refused, by the rule derived
   from the matrix rather than from a permission they happen to lack.
3. **It aligns the two Analytics surfaces**, which is this phase's purpose, by moving the
   canonical route to the legacy route's boundary — while the canonical route remains stricter in
   substance (no PII, reads not issued).
4. **It unblocks the route migration** without a permission or role change.
5. **It is one line per route**, with the event and money boundaries untouched.

**This is a recommendation. It was not implemented.**

---

## T. Finance Analytics Decision

**Yes — finance should see Analytics, conditionally.**

- **Which modules?** All five. Finance holds `transactions`, so Revenue and Communications spend
  are legitimately theirs; the other modules are workspace-level aggregates with no PII, and
  finance already receives strictly more from the legacy surface today.
- **Under what authorization?** Option C. No role change, no new permission, no `events` grant.
- **Should financial modules require `transactions`?** Yes, unchanged. Finance passes it; admin
  and manager do not and continue to see `NoFinancialAccess`.
- **Should event-scoped data require event access?** It already does — workspace ownership of the
  event. Per §J, per-member assignment constrains only gate roles by design.
- **Should finance receive the Analytics nav row?** Yes — but **only after** the blocker below,
  and the row's `permission: 'events'` (set in RD-12-13 to mirror the route) must be removed in
  the same change, or the nav will keep hiding what the server now allows.
- **What prevents financial leakage?** Nothing changes: `transactions` gates money, reads are not
  issued, absence not zeroing.

### The blocker

**Finance cannot list events.** `GET /api/organizer/events` requires `events`;
`EventContextProvider` makes exactly one call to it; the Analytics modules are event-scoped. Grant
Analytics without addressing this and finance reaches a working workspace with an empty selector —
a worse experience than today's honest hidden row.

Three candidate resolutions, **none audited, none recommended here**: relax that route's read
boundary the same way; give Analytics a scoped event-list endpoint of its own; or restrict finance
to a workspace-level Analytics view that needs no selector. **This is the subject of the next
phase**, and Option C must not ship without it.

---

## U. Admin / Manager Decision

**Yes to Overview, Registrations, Operations and Communications. No to Revenue — automatically.**

Both hold `events` and `registrations`; Analytics exposes aggregate counts over data they already
administer directly. Under Option C nothing changes for them: they keep access, and `revenue?` /
`spend?` stay absent because they lack `transactions`.

**Event authority and financial authority are already separated correctly here**, and this audit
recommends no change to either. Admin holding `events` is not a reason to give it money, and the
codebase does not.

---

## V. Check-in Decision

**No. No Analytics module for `checkin_lead` or `checkin_staff`.**

They hold only gate permissions; `isCheckinOnlyRole` is true; every organizer aggregate refuses
them by design, and RD-CHECKIN-STAFF-01 deliberately stripped `participants` from
`checkin_staff` to make it a true least-privilege role. Analytics exposes workspace-level
attendance, registration and communications aggregates across an event — beyond what a gate
operator needs to admit an attendee, and their operational surface already provides the live
counters they do need.

Under Option C the *mechanism* of their exclusion changes (from "lacks `events`" to
"`isCheckinOnlyRole`"), so the negative test must move with it — see §Z and P2-2.

---

## W. Route Migration Impact

For a future `/dashboard/reports` → `/dashboard/analytics` migration:

| Dependency | Impact |
|---|---|
| **finance** | **The blocker.** Today finance can open the legacy surface. After migration it would 403 unless Option C ships first — a privilege regression delivered by a route change. |
| admin / manager | None — both reach either surface. |
| gate roles | None — refused by both, before and after. |
| Bookmarked URLs | `/dashboard/reports` must keep resolving or redirect; step 2 of the recorded migration says redirect, not delete. |
| Direct API consumers | `/api/organizer/dashboard` has other consumers (the Overview page) and must not move with the page. |
| Notification links | None point at either analytics route (verified in 12-12). |
| Command palette | Derives from `WORKSPACE_NAV`; already correct since 12-13. |
| Navigation | Already points at the canonical route (12-13). |
| Tests | `analyticsArchitecture.test.ts` 38–42 pin routes and strings; `analyticsAuthorization.test.ts` 2 and 6 pin the current permission. All must be updated deliberately. |
| **Mixed scope** | The canonical modules have **no "All events" mode**. Migrating without it removes a working capability, independent of authorization. |

**Classification: SAFE WITH CONDITIONS** — (1) Option C shipped and finance's event-list
dependency resolved; (2) a redirect, not a deletion; (3) the "All events" gap addressed or
explicitly accepted.

---

## X. Security Threat Analysis

| Threat | Current | Under Option C | Safeguard required |
|---|---|---|---|
| Cross-workspace access | Safe — `organizerUid !== workspaceUid` refuses | Unchanged | Keep the uid comparison first |
| Cross-event access | Safe — ownership by uid/path; assignment binds gate roles only | Unchanged | — |
| Financial leakage | Safe — reads not issued without `transactions` | Unchanged | Never compute then filter |
| **Participant PII** | **RISK — legacy `activity[]` ships `attendeeName` to roles without `registrations`** | Canonical carries none | Gate the legacy feed on `registrations`; keep Analytics PII-free |
| Staff data leakage | None found — no staff identifiers in either payload | Unchanged | — |
| Timing data leakage | Safe — `timing?` from `identifierConfigs`, not event type | Unchanged | Keep capability server-side |
| Authorization bypass | None found — authorization precedes every read | Unchanged | Preserve the order |
| Privilege escalation | None — nav is advisory, server re-checks | Unchanged | Never let a nav row imply access |
| **Role confusion** | **RISK — `events` reads as event authority but is used as "not a gate role"** | Resolved | Use `authorizeAnyWorkspace` |
| Navigation-as-authorization | Safe — RD-12-13 mirrored, never granted | Must stay mirrored | Update the nav row *with* the route, not before |
| Enumeration | Safe — one message for absent/foreign/unassigned | Unchanged | Keep the single `DENIED` string |

---

## Y. Data Minimization

1. **`attendeeName` in the legacy activity feed** — the one real finding. Participant PII shipped
   to every non-gate role, including one with no `registrations` permission. See P1-1.
2. **`sourceId`** in the same feed — a registration id, needed as a stable React key and a
   destination. Justified in source; acceptable.
3. **Canonical Analytics** — aggregate counts only. `participants?` absent,
   `hasParticipantData: false`. **No minimization opportunity found.** The comment declining to
   infer demographics ("guessing would manufacture demographics") is the right call.
4. **No internal identifiers, payment metadata or transaction rows** appear in either analytics
   payload — money arrives pre-aggregated as `MaybeMoney`.

No response contract was changed.

---

## Z. Test Coverage

**Strong:**
- `analyticsAuthorization.test.ts` — unauthenticated refused with nothing computed (1); member
  without the permission refused (2); admin/manager allowed (3b); foreign event refused (4);
  non-existent answers exactly as forbidden (4b); event-scope honoured with nothing computed (5);
  scope asked about the draft id (5b); gate-only member denied (5c); gate staff cannot reach
  financial analytics (6); **every refusal path computes zero times (7)**; identity read is one
  document (7b); exports refused for unauthorized callers (269–287).
- `analyticsRevenue.test.ts`, `analyticsArchitecture.test.ts` (20–22) — revenue absent without
  `transactions`; module absent when its gate refuses.
- `dashboardMoneyGate.test.ts` — the legacy money boundary.
- `navigationSurfacing.test.ts` (13–17, RD-12-13) — nav mirrors the matrix and grants nothing.

**Missing — and material:**
1. **No test asserts finance's outcome at the Analytics boundary.** The one role the two surfaces
   disagree about is the one with no explicit case. Both a positive (finance sees non-financial
   modules) and a negative would be needed under Option C.
2. **No test asserts the legacy dashboard's PII boundary** — nothing pins who may receive
   `attendeeName`, which is why P1-1 went unnoticed.
3. **No test that the two Analytics surfaces agree** about who may read analytics. That is exactly
   this phase's subject and nothing guards it.
4. **No test that `requireEventScope` is inert for non-gate roles**, so its removal or retention
   would pass silently either way.
5. **No route-level test for `GET /api/organizer/events`** asserting finance is refused — the
   dependency in §T.

No tests were added; this is an audit.

---

## AA. Backward Compatibility

Option C changes **no role, no permission, no stored data**:

| Surface | Effect |
|---|---|
| Existing users / roles | None — the matrix is untouched |
| `teamMembers` rows | None — no backfill, no defaulting rule |
| Existing URLs / bookmarks | None — no route moves |
| Direct API calls | Finance's calls begin succeeding where they returned 403; nobody loses access |
| Navigation | The Analytics row's `permission: 'events'` must be removed **in the same change**, or nav will hide what the server allows |
| Notifications | None — no analytics links exist |
| Command palette | Derived from nav; follows automatically |
| Mobile | One shared array; follows automatically |
| Integrations | None found consuming the analytics endpoints externally |

The only widening is finance, and it is the intended outcome. **Every other role's access is
byte-identical.**

---

## AB. Findings by Severity

### P0
**None.** No authorization bypass, no cross-tenant access, and no sensitive data reachable without
a check. Authorization precedes every sensitive read on every route inspected.

### P1

**P1-1 · The legacy dashboard ships participant PII to roles without `registrations`**
*Location:* `app/api/organizer/dashboard/route.ts` — `DashboardActivity.attendeeName` (line ~200),
handler line 733.
*Evidence:* `authorizeAnyWorkspace` requires no permission; the route contains **zero**
occurrences of `includes('registrations')`; `activity` is assigned unconditionally at line 1377.
`finance` holds no `registrations` and reaches this endpoint.
*Impact:* A money-only role receives attendee names for every recent registration and check-in.
Independent of Analytics, and it undercuts any proposal to adopt the legacy boundary wholesale.
*Recommendation:* Gate `activity` (or just `attendeeName`) on `registrations`, absent not blanked,
mirroring the `fees?` pattern already in this file.
*Implementation phase:* Its own — a data-boundary fix, not an IA phase.

**P1-2 · Analytics is gated by a mutation permission that performs no scoping**
*Location:* `app/api/organizer/analytics/overview/[eventId]/route.ts:48`; `analytics/[eventId]/route.ts:160`.
*Evidence:* 28 of 35 `events` uses are mutations. `isEventInScope` returns `true` for every
non-gate role (executed, §J), so the paired `requireEventScope` is unreachable defence. The
route's own header says `events` was chosen because it "correctly excluded gate staff".
*Impact:* Finance is excluded from Analytics for a reason unrelated to Analytics, and the recorded
route migration cannot complete without regressing it.
*Recommendation:* Option C.
*Implementation phase:* Next (RD-ANALYTICS-12-15).

**P1-3 · Granting finance Analytics is blocked by an unaudited second dependency**
*Location:* `app/api/organizer/events/route.ts:116`; `components/dashboard/EventContextProvider.tsx:156`.
*Evidence:* The events list requires `events`; the provider makes exactly one call to it; all five
modules are event-scoped via `useAnalyticsScope.ts:80`.
*Impact:* Option C alone would give finance a working API and an empty event selector.
*Recommendation:* Resolve in the same phase as Option C — relax that read boundary, add a scoped
list endpoint, or give finance a workspace-level Analytics view.
*Implementation phase:* Next, as a precondition.

### P2

**P2-1 · Two Analytics surfaces, two boundaries, no test that they agree**
*Location:* `/api/organizer/dashboard` vs `/api/organizer/analytics/overview/[eventId]`.
*Impact:* The mismatch this phase exists for was found by an IA audit, not by a test.
*Recommendation:* A test pinning the intended role set for "analytics" across both.
*Implementation phase:* With Option C.

**P2-2 · The gate-role exclusion mechanism would change silently under Option C**
*Evidence:* Today gate roles are excluded by lacking `events`; under Option C by
`isCheckinOnlyRole`. `analyticsAuthorization.test.ts` case 2 asserts the former.
*Impact:* A correct refusal for a different reason could mask a regression if the test is updated
carelessly.
*Recommendation:* Update case 2 deliberately and add an explicit `isCheckinOnlyRole` assertion.
*Implementation phase:* With Option C.

**P2-3 · `requireEventScope` in the Analytics route is unreachable defence**
*Evidence:* §J.
*Impact:* Reads as event-assignment enforcement; enforces nothing for any role that reaches it.
*Recommendation:* **Keep it** — it is free and would become live if a future non-gate role ever
gained assignment — but comment it so it is not mistaken for the boundary.
*Implementation phase:* With Option C.

**P2-4 · Missing negative tests for the finance boundary**
*Evidence:* §Z items 1, 2, 5.
*Recommendation:* Add with Option C.

### P3

**P3-1 · `events` is a misleading name for a permission that also gates reads** — renaming is a
wide, risky change for a documentation benefit. Document, do not rename.

**P3-2 · The canonical modules have no "All events" mode** — an IA/product gap, not
authorization, but it blocks the route migration independently (§W).

**P3-3 · `hasParticipantData` is hard-coded `false`** — honest today; when participant analytics
arrives it must be gated on `participants`/`registrations`, not on the Analytics boundary.

**Counts: P0 = 0 · P1 = 3 · P2 = 4 · P3 = 3. Total 10.**

---

## AC. Recommended Implementation Sequence

Not implemented.

**Phase 1 — RD-ANALYTICS-12-15 · Analytics authorization reconciliation.**
Option C on both analytics routes; resolve the event-list dependency (P1-3) in the same phase;
remove `permission: 'events'` from the Analytics nav row in the same change; update
`analyticsAuthorization.test.ts` cases 2 and 6 deliberately; add the finance positive/negative
cases and the cross-surface agreement test. *Closes P1-2, P1-3, P2-1, P2-2, P2-3, P2-4.*

**Phase 2 — Legacy dashboard PII boundary.**
Gate `activity`/`attendeeName` on `registrations`. Independent of Analytics; can run in parallel.
*Closes P1-1.*

**Phase 3 — Route migration** (`ANALYTICS_ROUTE_MIGRATION` steps 1–3), only after Phases 1–2, and
only once the "All events" gap is addressed or accepted. *Closes P3-2.*

**Phase 4 — Documentation.** Record what `events` means for reads (P3-1) and the participant gate
for future participant analytics (P3-3).

---

## AD. Explicit Non-Goals

Not changed: `ROLE_PERMISSIONS`, permission definitions, `permissionForExportJob`,
`authorizeWorkspace`, `authorizeAnyWorkspace`, `authorizeEvent`, `requireEventScope`,
`isEventInScope`, `isCheckinOnlyRole`, any route guard, any API authorization, client permission
logic, navigation, Analytics routes, Reports routes, Finance routes, Firestore rules, Firestore
indexes, schemas, Analytics/Reports/financial calculations, `EventContextProvider`,
`EventSelector`, capability gates, and Check-in / Team / registration / payment / timing
permissions. No permission was created. No role was broadened. No route migrated. No redirect
added. No test added.

---

## AE. Files Inspected

**Authorization:** `lib/team/workspace.ts` · `lib/team/types.ts` · `lib/team/access.ts`

**Analytics APIs:** `app/api/organizer/analytics/overview/[eventId]/route.ts` ·
`app/api/organizer/analytics/[eventId]/route.ts` · `app/api/organizer/dashboard/route.ts` ·
`app/api/organizer/events/route.ts`

**Contracts & producers:** `lib/analytics/contract.ts` · `lib/analytics/routes.ts` ·
`lib/finance/financeAnalytics.ts`

**Clients:** `components/analytics/useAnalyticsScope.ts` ·
`components/dashboard/EventContextProvider.tsx` · `app/(dashboard)/dashboard/reports/page.tsx` ·
`app/(dashboard)/dashboard/analytics/page.tsx` · `config/workspaceNav.ts`

**Tests:** `tests/unit/analyticsAuthorization.test.ts` · `analyticsArchitecture.test.ts` ·
`analyticsRevenue.test.ts` · `navigationSurfacing.test.ts`

**Config:** `firestore.rules` · `firestore.indexes.json` (read only; unchanged)

---

## AF. Verification Performed

1. `git rev-parse --short HEAD` → `b7e5fdf`; `git status --short` before and after.
2. Enumerated every export of `lib/team/workspace.ts`; searched repo-wide for
   `requireOwner`/`requireAdmin`/`authorizeEvent`/`authorizeAnyEvent`.
3. **`grep -rn "authorizeWorkspace(req, 'events')" app/api` → 35 call sites**, classified by
   mutation vs read.
4. Read `authorizeAnyWorkspace`, `authorizeEvent`, `requireEventScope`, `isEventInScope`,
   `isCheckinOnlyRole`, `denied()` in full.
5. Read the canonical analytics route end to end, recording the authorization order.
6. Read the legacy dashboard route's authorization, finance gate and `DashboardActivity`.
7. **`grep -c "includes('registrations')" app/api/organizer/dashboard/route.ts` → 0** (P1-1).
8. Confirmed all five modules call one endpoint (`useAnalyticsScope.ts:80`).
9. Confirmed the EventSelector's single source (`EventContextProvider.tsx:156`) and that route's
   `events` requirement (`events/route.ts:116`).
10. **Executed a temporary script** against the real matrix, printing `ALL_PERMISSIONS`,
    `GATE_PERMISSIONS`, role→permissions, the outcome table at each boundary, and
    `isEventInScope` for every role at `[]` and at a non-matching assignment. Produced §C and §J.
    **Deleted immediately after use** (`rm -f ./__authz14.mts`).
11. Read `AnalyticsResponse`, `CommunicationsAnalytics`, `OperationsAnalytics` for PII and money.
12. Enumerated the analytics authorization test cases.

**Not run:** no test suite, no `tsc`, no ESLint, no build, no browser, no emulator. No source
changed, so none was warranted — and none is claimed.

---

## AG. Source Changes

**One file created: `docs/RD-ANALYTICS-12-14-AUDIT.md`.**

No source file, test, config, rule or index was created, modified or deleted. One temporary
`.mts` script was written to execute the permission resolvers and deleted in the same command
that ran it; `git status` shows no trace of it and no generated artifacts remain.

---

## AH. Git / Deployment Status

- **Commit:** not committed. HEAD `b7e5fdf`, nothing staged.
- **Push:** not pushed.
- **Deployment:** not deployed — no Vercel, Firebase, rules or index deployment.
- **Firestore rules:** unchanged, not deployed.
- **Firestore indexes:** unchanged, not deployed. RD-12-07 and RD-12-11 definitions both remain
  undeployed.

---

## AI. Final Verdict

**APPROVED WITH CONDITIONS**

The authorization semantics are not ambiguous. `events` is used in the Analytics routes as a
proxy for "an organizer, not a gate operator", the codebase already has a primitive that says
exactly that, and adopting it aligns the two surfaces while remaining strictly narrower than the
legacy boundary. Implementation may proceed on **Option C**, subject to:

1. **The event-list dependency (P1-3) must be resolved in the same phase.** Option C alone gives
   finance a working API and an empty event selector — a worse outcome than today's honest
   exclusion.
2. **The Analytics nav row's `permission: 'events'` must be removed in the same change.** RD-12-13
   set it to mirror the route; leaving it would hide from finance what the server now permits, and
   navigation must never disagree with authorization in either direction.
3. **P1-1 must not be bundled in.** The legacy PII leak is a separate data-boundary defect on a
   different endpoint and deserves its own phase; fixing it inside an authorization-reconciliation
   change would mix two boundaries in one diff.

---

## AJ. Recommended Next Phase

**RD-ANALYTICS-12-15 — Analytics Authorization Reconciliation (implementation).**

Scope: Option C on both analytics routes; resolve the finance event-list dependency; remove the
nav row's permission; update the two affected authorization test cases deliberately; add the
missing finance and cross-surface tests.

Why this one: it is the phase every remaining Analytics item is blocked on. The route migration
cannot proceed without it, finance's IA inconsistency cannot be resolved without it, and it is a
one-line-per-route change whose risk lies entirely in the dependency this audit surfaced rather
than in the change itself.

**RD-ANALYTICS-12-16 — Legacy dashboard PII boundary** should run in parallel; it shares no files.

---

## AK. Completion Checklist

- [x] Authorization architecture inventoried
- [x] Role / permission matrix built from source and executed
- [x] `authorizeWorkspace(req, 'events')` traced across all 35 call sites
- [x] `authorizeAnyWorkspace` traced and its meaning established from source
- [x] Legacy `/dashboard/reports` authorization traced and modules classified
- [x] Canonical Analytics authorization traced end to end
- [x] Analytics data classified (A–O)
- [x] Financial boundary verified across all seven layers
- [x] Event scope model analysed and executed
- [x] Finance role deep dive
- [x] Admin / manager deep dive
- [x] Check-in role deep dive
- [x] Authorization order reviewed on every analytics route
- [x] Legacy vs canonical compared
- [x] Existing permission reuse analysed before proposing anything new
- [x] Dedicated permission evaluated and rejected with reasons
- [x] Four future options documented and one recommended
- [x] Finance / admin-manager / check-in decisions stated explicitly
- [x] Route migration impact assessed
- [x] Security threat analysis performed
- [x] Data minimization reviewed
- [x] Test coverage audited
- [x] Backward compatibility assessed
- [x] Findings classified P0–P3
- [x] No authorization implemented or changed
- [x] No permission created; no role broadened
- [x] No routes migrated; no redirects added
- [x] No navigation or UI changed
- [x] No rules or indexes changed
- [x] Temporary scripts deleted and `git status` verified
- [x] No deployment, commit or push
