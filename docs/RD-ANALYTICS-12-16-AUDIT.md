# RD-ANALYTICS-12-16 — Legacy Data-Boundary Audit

Audit only. No API, permission, UI, test, Firestore or Admin file was changed.

---

## A. Executive Summary

The two issues carried forward from RD-ANALYTICS-12-15 were presented as a matched pair. They
are not. Traced to source, they resolve to very different severities, and one of them is
substantially less serious than the phase that raised it assumed.

**`attendeeName` — not a leak. P3.**
Three pieces of evidence, each checked rather than assumed:

1. **The exposure is deliberate and already reasoned about.** RD-DASH-12 audited this exact
   boundary and removed `attendeeEmail` from the same object, recording why: it was
   `sensitive: true` and reached a `finance` member with no `registrations` grant. It kept the
   name — *"The name stays: it is what the row says."*
2. **The repository's own field-sensitivity SSOT agrees.** `lib/metadata/registry.ts` marks
   `attendee.email` and `attendee.phone` `sensitive: true`, and marks **`attendee.name` as not
   sensitive**. RD-DASH-12 removed exactly the fields the registry flags.
3. **No role receives it without a sanctioned path to attendee names elsewhere.** Owner, admin
   and manager hold `registrations`. Finance does not — but `/api/organizer/payment-issues`
   authorizes with **`transactions`** and returns `attendeeName`, so finance seeing participant
   names is established product behaviour, not an accident of this endpoint.

The residual issue is consistency, not disclosure: the field is ungated *here* while the same
class of data is permission-scoped elsewhere. Worth aligning; not worth an urgent fix.

**`estimatedRevenue` — a genuine boundary violation. P1.**
The name is misleading. The field's own comment says it: *"CANONICAL confirmed revenue
(registrationCounters.revenuePaise / ledger fallback); field name kept for contract stability"*.
It is refund-stable, ledger-backed, authoritative financial data — precisely what `transactions`
protects everywhere else.

**`admin` and `manager` receive it without holding `transactions`**, and unlike the attendee-name
case they have **no** other sanctioned path to per-event revenue: `/api/organizer/finance`
refuses them, and Analytics returns `financialAllowed: false` with the money keys absent.

The inconsistency is internal and demonstrable: `/api/organizer/dashboard` **already gates the
same figure** — `revenuePaise: financeAllowed ? … : null`, pinned by
`dashboardMoneyGate.test.ts` — while `/api/organizer/events` returns it unconditionally. Two
endpoints, one data class, two answers. That is the exact phrasing RD-DASH-12 used when it fixed
`fees`, and the fix here is the same shape.

It reaches **two** routes, not one: the list and the event detail route.

**On RD-12-15:** verified rather than accepted. It did **not** touch the dashboard, so
`attendeeName` exposure is unchanged. It **did** widen the events list from `events` to
`authorizeAnyWorkspace`, which **added `finance`** to the set receiving `estimatedRevenue` —
a role that holds `transactions` and is entitled to it. The violation itself (admin, manager)
is unchanged. My 12-15 note said "not worsened"; that is correct about the violation and
imprecise about the audience, which did grow by one entitled role.

**Verdict: APPROVED WITH CONDITIONS.**

---

## B. Scope and Security Boundary

Organizer workspace only. Six roles: `owner`, `admin`, `manager`, `finance`, `checkin_lead`,
`checkin_staff` — "admin" throughout means the **organizer workspace** admin role.

Both endpoints authorize with `authorizeAnyWorkspace`, which admits any active workspace member
except gate-only roles (`isCheckinOnlyRole`). Gate roles receive **neither** field.

The separate application Admin area was inspected only far enough to prove non-involvement
(§Y). No Admin file was opened for modification.

---

## C. `/api/organizer/dashboard` Architecture

`GET`, one payload, `authorizeAnyWorkspace(req)` at line 733, then
`financeAllowed = authz.permissions.includes('transactions')` at 739 — declared before the
reads it gates, so unauthorized callers do not cost the workspace those queries.

Event scope is `?eventId=`, proven by the path `users/{workspaceUid}/eventDrafts/{eventId}`;
absent ⇒ all-events mode. A bad id refuses rather than falling back.

The activity feed is produced by `lib/dashboard/activityFeed.ts` (`readActivityPage`), shared
with the paging endpoint `/api/organizer/dashboard/activity` so both surfaces apply one scope
rule. It merges two streams — registrations and check-ins — on a watermark cursor.

---

## D. Dashboard Response Field Inventory

| Field group | Gated on | Notes |
|---|---|---|
| `scope`, `organizer`, `license`, `overview` counts | none | workspace aggregates |
| `fees?` | **`transactions`** | absent, not zeroed (RD-DASH-12) |
| `overview.totalRevenuePaise?`, `todayRevenuePaise?` | **`transactions`** | absent |
| `events[].revenuePaise` | **`transactions`** | `financeAllowed ? … : null` — **null, never 0** |
| `reversals`, wallet, settlement | **`transactions`** | absent |
| `trendDays[].revenuePaise` | **`transactions`** | inside the gated block |
| **`activity[]`** | **none** | see §E |
| Check-in / attendance counters | none | aggregates |

The money discipline in this route is thorough and consistent. `activity` is the one
participant-derived array, and it is the only ungated one.

---

## E. Attendee / Activity PII Analysis

`ActivityFeedItem`, and what is actually read — `select(field, 'eventSlug', 'eventName',
'passName', 'attendee.name')` at `activityFeed.ts:146`, so the query is already minimal:

| Field | PII? | Registry classification | Present? |
|---|---|---|---|
| `attendeeName` | personal data (a name) | **not** `sensitive` | **yes** |
| `attendeeEmail` | yes | `sensitive: true` | **REMOVED by RD-DASH-12** |
| phone | yes | `sensitive: true` | never present |
| `sourceId` (registration id) | identifier | — | yes — stable React key + destination |
| `eventSlug`, `eventName`, `passName` | operational | — | yes |
| `timestamp` | operational | — | yes |
| BIB / check-in state / payment status / category | — | — | **not present** |

SOURCE → TRANSFORMATION → RESPONSE → CONSUMER:

```
registrations/{id}.attendee.name
   → select('attendee.name')            (only that subfield is read)
   → ActivityFeedItem.attendeeName      (readActivityPage, merged + sorted)
   → DashboardData.activity[]           (unconditional)
   → RecentActivityCard:164             `${a.attendeeName} registered` / `checked in`
```

The name is **displayed**, not merely passed through — it is the substance of the row.

---

## F. Dashboard Role Exposure

Derived from the real matrix, not from the sidebar:

| Role | Reaches the route | Receives `attendeeName` | Holds `registrations` | Holds `transactions` | Sanctioned path to names elsewhere |
|---|---|---|---|---|---|
| owner | ✅ | yes | ✅ | ✅ | yes |
| finance | ✅ | yes | ❌ | ✅ | **yes** — payment-issues |
| admin | ✅ | yes | ✅ | ❌ | yes |
| manager | ✅ | yes | ✅ | ❌ | yes |
| checkin_lead | ❌ 403 | no | ❌ | ❌ | n/a |
| checkin_staff | ❌ 403 | no | ❌ | ❌ | n/a |

**`registrations` is not required, and no role receives the field without an existing legitimate
route to the same class of data.** Roles with no sanctioned path: **none**.

---

## G. `registrations` Permission Analysis

Held by owner, admin, manager. **Not** by finance or the gate roles.

It protects registration **management and lists** — the registrations API, exports, participant
workspaces, waitlist promotion. Its consistent meaning is *"may work with the registration
records of this workspace"*.

Critically, it is **not** the platform's boundary for attendee names as such:
`/api/organizer/payment-issues` requires **`transactions`** and returns `attendeeName`, because
a payment issue cannot be resolved without knowing whose payment it is. Attendee name is
therefore reachable through at least two different permissions by design.

---

## H. Activity Consumer Map

One consumer.

| Consumer | Fields used | `attendeeName` displayed? | Works without it? |
|---|---|---|---|
| `components/dashboard/RecentActivityCard.tsx` | `type`, `attendeeName`, `eventName`, `passName`, `timestamp`, `sourceId` | **Yes** — line 164 composes the row title | The card would render `undefined registered`; the row loses its subject |

It also pages via `/api/organizer/dashboard/activity`, which shares `readActivityPage` — so any
gating must be applied in the shared reader, not in one route, or the two would disagree.

---

## I. Dashboard API Consumer Map

| Caller | Fields consumed | Sensitivity |
|---|---|---|
| `app/(dashboard)/dashboard/page.tsx` (Overview) | overview counts, `fees?`, license, events[], `activity` | money already gated |
| `app/(dashboard)/dashboard/reports/page.tsx` (legacy Analytics) | `DashboardData` incl. `events[]`, trends | money already gated |
| `components/dashboard/RecentActivityCard.tsx` | `activity` | the only PII consumer |

No Admin consumer (§Y). No field in the payload is unused-but-exposed except `sourceId`, which
has a stated purpose.

---

## J. `/api/organizer/events` Architecture

`GET` only — no mutation exists on this route; every `.set(`/`.add(` in the file is a Map or Set.
`authorizeAnyWorkspace(req)` (since RD-12-15), then `const uid = authz.workspaceUid` and reads
scoped to `users/${uid}/eventDrafts` with cursor pagination. Tenancy is a document path derived
from the session.

It is the workspace's single event list: 12+ consumers including `EventContextProvider` (the one
EventSelector call), events landing, check-in, communications, print assets, registrations, team
settings and the command palette.

---

## K. `estimatedRevenue` Data Lineage

```
registrationCounters/{slug}.revenuePaise        (when the counter is complete/statsVersion current)
   └── fallback: ledger sum aggregate            (revBySlug via sums[])
   → revBySlug: Map<slug, paise>
   → estimatedRevenue = revBySlug.get(slug) ?? 0          (route line 361)
   → revenueUnavailable = revFailed.has(slug)             (line 366 — a failed read is not 0)
   → EventListItem.estimatedRevenue                        (line 399, UNCONDITIONAL)
```

The same figure and the same fallback appear in the event **detail** route
(`events/[eventId]/route.ts`), which authorizes with `authorizeWorkspace(req, 'events')` — so
admin and manager receive it there too.

---

## L. `estimatedRevenue` Financial Classification

**A — financial information**, with **D** as an aggravating factor: the *name* is legacy and
actively misleading.

Evidence, from the field's own declaration:

> `estimatedRevenue: number // paise — CANONICAL confirmed revenue (registrationCounters.revenuePaise / ledger fallback); field name kept for contract stability`

Against the RD-ANALYTICS-02 architecture:

| Property | `estimatedRevenue` |
|---|---|
| Confirmed ledger revenue | **Yes** — it *is* the canonical confirmed figure |
| Refund-stable | Yes — the route comments say refund-stable confirmed `revenuePaise` |
| Includes pending/unpaid | No |
| Derived from registrations or transactions | Counters, with a **ledger** fallback |
| An "estimate" | **No.** The word survives from an older implementation |
| Equivalent gated elsewhere | **Yes** — `DashboardData.events[].revenuePaise`, gated on `transactions` |

Anyone reading the field name would conclude it is a soft operational number. It is not.

---

## M. Event List Role Exposure

| Role | Calls `/api/organizer/events` | Event metadata | Registration counts | **`estimatedRevenue`** | EventSelector | Analytics | Finance |
|---|---|---|---|---|---|---|---|
| owner | ✅ | ✅ | ✅ | ✅ *(entitled)* | ✅ | ✅ | ✅ |
| finance | ✅ | ✅ | ✅ | ✅ *(entitled — holds `transactions`)* | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | ⚠️ **not entitled** | ✅ | ✅ | ❌ |
| manager | ✅ | ✅ | ✅ | ⚠️ **not entitled** | ✅ | ✅ | ❌ |
| checkin_lead | ❌ 403 | — | — | — | ❌ | ❌ | ❌ |
| checkin_staff | ❌ 403 | — | — | — | ❌ | ❌ | ❌ |

**Roles receiving `estimatedRevenue` without `transactions`: `admin`, `manager`.**

---

## N. `estimatedRevenue` Consumer Map

18 files. The ones that matter:

| Consumer | Use | Required? |
|---|---|---|
| `dashboard/events/presentation.ts` | event card revenue figure | displayed |
| `dashboard/events/[eventId]/EventCommandCenter.tsx` | header money tile; donation split (`+ donationTotalPaise`) | displayed |
| `dashboard/events/[eventId]/tabs/ReportsTab.tsx` | "the platform's canonical confirmed-revenue figure" | displayed |
| `lib/events/eventOverview.ts` | overview tile, sub "Confirmed registrations" | displayed |
| `app/api/organizer/events/[eventId]/route.ts` | the **second** exposure route | source |
| `tests/unit/*` (8 files) | fixtures asserting the number renders | test-only |

**Not** used for sorting, filtering or any calculation that would break if absent — it is read
and rendered. `revenueUnavailable` already exists as the "could not resolve" signal, which gives
a fix a ready-made honest state.

---

## O. Event List Data Classification

| Field group | Class | Boundary today |
|---|---|---|
| `draftId`, `slug`, `status`, `lifecycleStatus` | identifiers | workspace |
| `name`, `tagline`, dates, banner, `eventType`, `campaignType` | descriptive | workspace |
| `totalCapacity`, `totalRegistrations`, `passes[].sold` | operational aggregates | workspace |
| **`estimatedRevenue`** | **financial** | **workspace — the finding** |
| `reviewStatus`, `rejectionReason`, `changesComment` | governance | workspace |
| `hasPaidLicense?` | commercial | workspace |
| `statsUnavailable?`, `revenueUnavailable?` | honesty flags | workspace |

No participant PII, no organizer identifiers, no internal metadata.

**Intended purpose:** all four of general discovery, event-management picker, financial selector
and analytics selector — one list serving every surface. That is precisely why an ungated money
field in it is disproportionate: a field needed by one consumer is shipped to twelve.

---

## P. Data Minimization Review

| Field | Required by caller? | Sensitive? | Caller authorized? | Could be omitted? | Verdict |
|---|---|---|---|---|---|
| `activity[].attendeeName` | Yes — it is the row | personal, not registry-`sensitive` | every reader has a path to names | not without emptying the card | **Keep; align the boundary** |
| `activity[].sourceId` | Yes — key + destination | identifier | — | no | Keep |
| `activity[].attendeeEmail` | — | — | — | — | **Already removed** (RD-DASH-12) |
| `events[].estimatedRevenue` | By 4 UI consumers | **financial** | **admin/manager: NO** | **Yes — `null` when denied** | **Gate it** |
| `events[].totalRegistrations` | Yes | aggregate | yes | no | Keep |

---

## Q. Attendee Data Permission Options

| Option | Semantics | Precedent | Role effect | Complexity | Verdict |
|---|---|---|---|---|---|
| **A. workspace membership** (today) | "any organizer may see who is active" | the current behaviour, and RD-DASH-12 kept it deliberately | none | none | **Defensible** |
| B. `events` | wrong — a mutation permission for a read | contradicted by RD-12-14/15 | would keep finance out | low | No |
| **C. `registrations`** | "may work with registration records" | registrations lists/exports | **finance loses the activity feed's names** | low | Semantically tidy, functionally a regression for a role that already sees names elsewhere |
| D. `transactions` | wrong for PII in general | payment-issues does exactly this | admin/manager would lose it | low | No |
| E. dedicated participant permission | — | **forbidden by this brief** | — | — | Excluded |

**Recommendation: C, applied as `registrations || transactions`** — the *union* of the two
permissions that already grant attendee names in this codebase. That is not a new permission; it
is the honest statement of the existing rule, and it changes **nobody's** access today (every
reachable role holds one or the other) while making the boundary explicit and defended by a test
rather than by accident. If any role is ever added that holds neither, it is refused by
construction.

A plain `registrations` gate would be simpler but would remove names from finance's dashboard
while `/dashboard/finance/payment-issues` continues to show them — one product, two answers,
which is the defect class this whole sequence has been closing.

---

## R. Revenue Data Permission Options

| Option | Semantics | Precedent | Role effect | Complexity | Verdict |
|---|---|---|---|---|---|
| A. workspace membership (today) | none — money ungated | contradicted by every other surface | — | — | **The finding** |
| B. `events` | wrong — event authority ≠ financial authority | — | admin/manager keep it | low | No |
| **C. `transactions`** | exact | `/api/organizer/finance`, `/api/organizer/dashboard` (`revenuePaise`), Analytics `financialAllowed`, payment-issues | **admin, manager lose it**; owner + finance keep it | low | **Recommended** |
| D. `wallet` | payout mechanics, not revenue | — | — | — | No |
| E./F. other / new reporting permission | — | forbidden | — | — | Excluded |

**Recommendation: C — `transactions`**, matching `DashboardData.events[].revenuePaise` exactly,
including its shape: `financeAllowed ? value : null`.

---

## S. Server vs Client Boundary

**B — server-side, permission-gated field, `null` when denied.** Not client hiding, and not
plain omission.

- **Client hiding is rejected outright.** The data would still be transmitted, cached in the
  browser, and visible in devtools or a proxy. RD-DASH-12 settled this for `fees`.
- **`null`, not `0`.** The dashboard's own rule: *"₹0 is a lie that looks like a fact; a missing
  field lets the UI say 'not available to your role', which is true."* `EventListItem` already
  carries `revenueUnavailable`, so the UI has a vocabulary for "no number" already.
- **`null`, not absent**, for `estimatedRevenue` specifically: the field is non-optional in
  `EventListItem` and read by four consumers plus eight test fixtures; widening the type to
  `number | null` mirrors `DashboardData.events[].revenuePaise: number | null` exactly and keeps
  the contract shape stable.
- **The gate belongs in the shared reader** for activity (`readActivityPage`), not in one route,
  or the dashboard and its paging endpoint would disagree.
- A separate endpoint (option D) is unjustified — it would fork one list for one field.

---

## T. Legacy Compatibility

**Gating `attendeeName`** could affect: the Recent Activity card (its row titles), the paging
endpoint `/api/organizer/dashboard/activity`, and any test asserting the field. Under the
recommended `registrations || transactions` union, **no role loses it today**, so nothing breaks
— the change is a guard, not a removal. Notifications, search, sorting and mobile do not consume
it.

**Gating `estimatedRevenue`** affects four display consumers and both routes. Admin and manager
would see "—" instead of a figure. Nothing sorts, filters or calculates on it, so no logic
breaks. Eight test fixtures set it as a number and would need `number | null` in their types.
`EventSelector`/`EventContextProvider` do **not** read it — the selector projects a strict subset
— so event selection is unaffected. Analytics and Finance have their own gated sources and are
untouched.

---

## U. Security Threat Analysis

| Threat | Current state | Impact | Required future safeguard |
|---|---|---|---|
| **PII leakage** | `attendeeName` ungated | **Low** — every reachable role has a sanctioned path to names; email and phone already removed; registry does not class the name sensitive | Gate on `registrations \|\| transactions` as a guard against future roles |
| **Financial leakage** | `estimatedRevenue` ungated on two routes | **Real** — admin and manager receive canonical confirmed revenue with no other path to it | Gate on `transactions`, `null` when denied |
| Privilege escalation | none — neither field grants an action | — | — |
| Role confusion | **Present** — the same figure is gated on one endpoint and not another | Maintainers reasonably assume money is gated | One rule, tested across both endpoints |
| Cross-event leakage | none beyond the intended model (§W) | — | — |
| Cross-workspace leakage | none — both scope by session-derived path | — | Keep tenancy from the session |
| **Inference risk** | `estimatedRevenue` is exact, not inferred | direct disclosure, not inference | — |
| Client-side caching | both payloads reach the browser; the dashboard sets no-store, the event list is `cache: 'no-store'` at call sites | money sits in browser memory for unentitled roles | Gate server-side — the only fix that removes it from the wire |
| Unnecessary browser exposure | one money field shipped to 12 consumers, needed by 4 | breadth multiplies exposure | Gate at the source |

---

## V. Cross-Workspace Isolation

Both APIs are correctly isolated, and the mechanism is the same in each: the workspace comes
from the authenticated session (`authz.workspaceUid`), never from the request.

- `/api/organizer/events` — `adminDb.collection(\`users/${uid}/eventDrafts\`)`. No client-supplied
  organizer or workspace id is accepted; `cursor`, `tab`, `search` and `limit` never reach the
  collection path (pinned by `eventsLanding.test.ts`).
- `/api/organizer/dashboard` — `const uid = authz.workspaceUid`, and event scope proven by
  `users/{workspaceUid}/eventDrafts/{eventId}`; a forged id cannot widen the set and refuses
  rather than falling back.

No response field can contain foreign-workspace data. **No finding.**

---

## W. Cross-Event Considerations

Both are **workspace-wide**, deliberately. Per-member event assignment constrains **gate-only
roles and nobody else** — `isEventInScope` returns `true` for every non-gate role, with a stated
rationale: broader roles hold workspace-wide permissions and can reach the same event through the
organizer surfaces anyway.

So a non-gate member seeing every event in their workspace — including its revenue and its recent
registrations — is the intended architecture, not a leak. The finding in §L is about the
**permission class** of the revenue figure, not about which events it covers.

---

## X. RD-12-15 Regression Analysis

Verified against source rather than accepted.

| Question | Answer |
|---|---|
| Did 12-15 touch `/api/organizer/dashboard`? | **No.** Untouched; mtime 27 Aug. `attendeeName` exposure is unchanged and predates it. |
| Did 12-15 change the event list's authorization? | **Yes** — `authorizeWorkspace(req, 'events')` → `authorizeAnyWorkspace(req)`. |
| Did the set of roles receiving `estimatedRevenue` change? | **Yes — `finance` was added.** Owner/admin/manager already held `events`; gate roles remain refused. |
| Is that new exposure a violation? | **No.** Finance holds `transactions`, the permission this data should be gated on. It received data it is entitled to. |
| Did the violation itself change? | **No.** Admin and manager reached this route before 12-15 and after it. |
| Did 12-15 change financial exposure anywhere else? | No. The Analytics money gate is untouched; `financialAllowed` still decides, reads are still not issued. |

**Conclusion: both issues are pre-existing, as reported — with one correction.** 12-15 widened
the *audience* for `estimatedRevenue` by one entitled role. My 12-15 documentation said the issue
was "not worsened", which is accurate about the violation and imprecise about the audience. The
distinction is recorded here rather than left to be rediscovered.

---

## Y. Admin Boundary

**The separate application Admin area does not consume either endpoint.** A repository search for
`api/organizer/dashboard` and `api/organizer/events` across `app/(admin)`, `app/api/admin` and
`lib/admin` returns **nothing**. Admin has its own surfaces (`/api/admin/*`) with their own
boundary (`requireAdmin`), and does not import the organizer workspace authorization helpers at
all.

Therefore a future Organizer-only response change to either field **cannot** affect Admin. No
shared helper is involved: the recommended fixes touch two organizer route files and one shared
organizer reader (`readActivityPage`), none of which Admin references.

One observation, documented and not acted on: `app/(admin)/admin/support/PageClient.tsx` and
`/api/admin/lookup` display `attendeeName`, `attendeeEmail` and `attendeePhone` under the Admin
boundary. That is Admin's own model and is out of scope.

---

## Z. Test Coverage

**Strong — for money on the dashboard:**
`tests/unit/dashboardMoneyGate.test.ts` pins the entire pattern: roles that can open the
dashboard but hold no finance permission genuinely exist (63); `fees` inside the gated block
(72); the tile not rendered (81); per-pass money not aggregated (91); the coupon total gated
(101); **per-event revenue null for a restricted caller, never zero (111)**; and *"no money-shaped
key sits outside the gate in the response literal"* (119). Case 111 is the exact template for the
`estimatedRevenue` fix.

**Strong — for event-list tenancy:** `eventsLanding.test.ts` pins path-scoping and that no
client-supplied parameter reaches the collection path.

**Missing:**
1. **No test asserts who may receive `estimatedRevenue`.** The field is present in eight fixtures
   as a plain number and gated by nothing — which is why the inconsistency with case 111 survived.
2. **No test asserts who may receive `attendeeName`.** RD-DASH-12's removal of `attendeeEmail` is
   not pinned either, so nothing prevents its reintroduction.
3. **No test that the two endpoints agree** about per-event revenue — the specific defect here.
4. **No negative test for the event-detail route's** `estimatedRevenue`.
5. **No response-shape test** for the activity feed's field list.

No tests were added; this is an audit.

---

## AA. Recommended Future Implementation

Two logically separate changes, safe to ship in one phase.

### Change 1 — `estimatedRevenue` (the real fix)

| | |
|---|---|
| **Endpoints** | `GET /api/organizer/events` **and** `GET /api/organizer/events/[eventId]` — both, or the gap simply moves |
| **Field** | `estimatedRevenue: number` → `number \| null` |
| **Boundary** | `transactions` |
| **Server behaviour** | `estimatedRevenue: financeAllowed ? (revBySlug.get(slug) ?? 0) : null`, mirroring `dashboard/route.ts:1414` exactly |
| **Affected roles** | admin, manager lose the figure. Owner, finance unchanged. Gate roles already refused. |
| **Client strategy** | The four display consumers render "—". `revenueUnavailable` already exists but means "could not read" — do **not** overload it; a `null` from the gate is a different fact and the UI should say "not available to your role", as the dashboard does |
| **Tests** | null-not-zero for a restricted caller on both routes; owner/finance receive it; admin/manager do not; no money-shaped key outside the gate; both endpoints agree |

### Change 2 — `attendeeName` (the alignment)

| | |
|---|---|
| **Endpoints** | `GET /api/organizer/dashboard` and `GET /api/organizer/dashboard/activity` — gate inside `readActivityPage`, the shared reader, so they cannot disagree |
| **Field** | `ActivityFeedItem.attendeeName` |
| **Boundary** | `registrations \|\| transactions` — the union already granting names today (§Q) |
| **Server behaviour** | Omit the name and skip `select('attendee.name')` for an unentitled caller; the row keeps event, pass and timestamp |
| **Affected roles** | **None today.** Every reachable role holds one of the two. This is a guard against future roles. |
| **Client strategy** | `RecentActivityCard` needs a fallback title (e.g. "A registration" / "A check-in") for the no-name case, so it never prints `undefined` |
| **Tests** | the union is enforced; a hypothetical role holding neither gets no name; `attendeeEmail`/phone are still absent (pinning RD-DASH-12) |

---

## AB. Implementation Risk

**Change 1 — `estimatedRevenue`: SAFE WITH CONDITIONS.**
Low mechanical risk: one expression per route, mirroring a pattern already shipping in a sibling
endpoint and already covered by a test template. Conditions: (a) **both** routes in the same
change; (b) the type widens to `number | null` and the eight test fixtures follow; (c) the UI
distinguishes "not available to your role" from `revenueUnavailable`; (d) admin and manager
visibly lose a number they see today — a deliberate, reviewable product consequence, not a
silent one.

**Change 2 — `attendeeName`: SAFE.**
No role loses access today, so it cannot regress a workflow. It touches one shared reader and
needs one UI fallback. Its value is defence-in-depth and an explicit, tested boundary.

Neither change requires a Firestore index, rule or schema change. Neither touches Admin.

---

## AC. Findings by Severity

### P0
**None.** No unauthenticated access, no cross-workspace or cross-event leakage, no authorization
bypass. Both endpoints authorize before reading and scope tenancy from the session.

### P1

**P1-1 · `estimatedRevenue` — canonical confirmed revenue returned without `transactions`**
*Location:* `app/api/organizer/events/route.ts:361,399`; `app/api/organizer/events/[eventId]/route.ts`
*Evidence:* The field's own declaration calls it *"CANONICAL confirmed revenue
(registrationCounters.revenuePaise / ledger fallback)"*. The route contains no `transactions`
check for it. The **same figure** is gated in `app/api/organizer/dashboard/route.ts:1414`
(`revenuePaise: financeAllowed ? … : null`) and pinned by `dashboardMoneyGate.test.ts:111`.
*Affected roles:* **`admin`, `manager`** — neither holds `transactions`, and both are refused by
`/api/organizer/finance` and receive `financialAllowed: false` from Analytics, so they have **no
other path** to this figure.
*Impact:* Authoritative per-event revenue disclosed to two organizer roles the platform
otherwise excludes from money. Two endpoints, one data class, two answers.
*Recommendation:* Gate on `transactions`, `null` when denied, on **both** routes (§AA Change 1).
*Phase:* RD-ANALYTICS-12-17.

### P2

**P2-1 · The field name conceals what the field is**
*Location:* `EventListItem.estimatedRevenue`
*Evidence:* Comment: *"field name kept for contract stability"*. It is neither an estimate nor
soft; it is refund-stable ledger-backed confirmed revenue.
*Impact:* A reviewer or a new consumer reasonably treats it as an operational approximation and
does not gate it — which is plausibly how P1-1 arose.
*Recommendation:* Rename to `confirmedRevenuePaise` **only** as part of a separate contract
change with its 18 consumers; until then, keep the clarifying comment adjacent to every use.
*Phase:* later, not with the security fix.

**P2-2 · No test pins who may receive either field**
*Location:* `tests/unit/` — no coverage for `estimatedRevenue` exposure or `attendeeName` exposure
*Evidence:* §Z. `dashboardMoneyGate.test.ts` covers the dashboard thoroughly; the event list has
no equivalent, and RD-DASH-12's `attendeeEmail` removal is unpinned.
*Impact:* The inconsistency in P1-1 survived undetected, and the removed email field could be
reintroduced without failing anything.
*Recommendation:* Add with the fixes (§AA).
*Phase:* RD-ANALYTICS-12-17.

**P2-3 · One money field is shipped to twelve consumers to serve four**
*Location:* `/api/organizer/events`
*Evidence:* §N vs §J — `EventContextProvider`, check-in, communications, print assets, team
settings and the command palette all receive `estimatedRevenue` and none reads it.
*Impact:* Breadth multiplies exposure; the field sits in browser memory on surfaces with no use
for it.
*Recommendation:* The `transactions` gate largely resolves this. A projection parameter would
resolve it fully; not justified on its own.
*Phase:* consider with P2-1.

### P3

**P3-1 · `attendeeName` is ungated while the same class of data is permission-scoped elsewhere**
*Location:* `lib/dashboard/activityFeed.ts:57-66`, surfaced by `/api/organizer/dashboard` and
`/api/organizer/dashboard/activity`
*Evidence:* No `registrations` check on the route (0 occurrences). **But**: RD-DASH-12 audited
this boundary deliberately and kept the name after removing the email; `lib/metadata/registry.ts`
does **not** class `attendee.name` sensitive; and every reachable role has a sanctioned path to
attendee names — owner/admin/manager via `registrations`, finance via `transactions`
(`/api/organizer/payment-issues`).
*Affected roles:* none in practice.
*Impact:* Consistency and defence-in-depth, not disclosure. **RD-12-14 classified this P1; on the
evidence above that was an overstatement.**
*Recommendation:* Gate on `registrations || transactions` in the shared reader (§AA Change 2).
*Phase:* RD-ANALYTICS-12-17, alongside P1-1.

**P3-2 · `sourceId` (a registration id) is returned to every dashboard reader**
*Evidence:* `ActivityFeedItem.sourceId`, justified in source as a stable React key and a real
destination.
*Impact:* Minimal — an opaque id that grants nothing; the routes it addresses authorize
independently.
*Recommendation:* Leave. Documented so it is not rediscovered as a finding.

**Counts: P0 = 0 · P1 = 1 · P2 = 3 · P3 = 2. Total 6.**

---

## AD. Explicit Non-Goals

Not changed: any API, response contract or field; `ROLE_PERMISSIONS`; the `registrations` or
`transactions` permissions; event, workspace, Check-in or Team authorization; Analytics, Reports
or Finance; navigation or UI; any test; Firestore rules, indexes or schemas; anything under
`app/(admin)`, `app/api/admin` or `lib/admin`. No permission was created. No field was removed
or gated. No fix was implemented.

---

## AE. Files Inspected

**Endpoints:** `app/api/organizer/dashboard/route.ts` · `app/api/organizer/events/route.ts` ·
`app/api/organizer/events/[eventId]/route.ts` · `app/api/organizer/payment-issues/route.ts` ·
`app/api/organizer/payment-issues/[orderId]/recover/route.ts`

**Producers & contracts:** `lib/dashboard/activityFeed.ts` · `lib/metadata/registry.ts` ·
`lib/team/types.ts` · `lib/team/workspace.ts` · `lib/events/eventOverview.ts`

**Consumers:** `components/dashboard/RecentActivityCard.tsx` ·
`components/dashboard/EventContextProvider.tsx` · `app/(dashboard)/dashboard/page.tsx` ·
`app/(dashboard)/dashboard/reports/page.tsx` · `app/(dashboard)/dashboard/events/presentation.ts` ·
`.../events/[eventId]/EventCommandCenter.tsx` · `.../events/[eventId]/tabs/ReportsTab.tsx` ·
`.../finance/payment-issues/page.tsx`

**Tests:** `dashboardMoneyGate.test.ts` · `eventsLanding.test.ts` · `eventHome.test.ts` ·
`eventCommandCenter.test.ts` · `attendance.test.ts`

**Admin (non-involvement only):** `app/(admin)/admin/support/PageClient.tsx` ·
`app/api/admin/lookup/route.ts`

---

## AF. Verification Performed

1. `git rev-parse --short HEAD` → `b7e5fdf`; `git status --short` before and after; mtime check
   confirming no target file was touched today.
2. Full read of `activityFeed.ts` including the RD-DASH-12 rationale and the `select()` at line 146.
3. `grep -n "attendee\.\|sensitive" lib/metadata/registry.ts` → `attendee.name` carries **no**
   `sensitive: true`; email and phone do.
4. Repository-wide `attendeeName` search across `app components lib` — located the finance
   payment-issues consumer.
5. `grep authorizeWorkspace app/api/organizer/payment-issues/route.ts` → **`'transactions'`**.
6. `grep -c "includes('registrations')" app/api/organizer/dashboard/route.ts` → **0**.
7. Full `estimatedRevenue` lineage trace in `events/route.ts` (lines 49, 243–295, 358–399).
8. Repository-wide `estimatedRevenue` search — **18 files**, classified by use.
9. Event **detail** route authorization read → `authorizeWorkspace(req, 'events')` (second exposure).
10. `dashboardMoneyGate.test.ts` case 111 and `dashboard/route.ts:1414` — the gated sibling.
11. Admin consumption search across `app/(admin)`, `app/api/admin`, `lib/admin` → **no results**.
12. Tenancy derivation confirmed in both routes (`authz.workspaceUid`, path-scoped).
13. **Executed a temporary script** over the real `ROLE_PERMISSIONS` and `isCheckinOnlyRole`,
    producing §F and §M and computing "roles with no sanctioned path to names" (**NONE**) and
    "roles receiving `estimatedRevenue` without `transactions`" (**admin, manager**).
    **Deleted immediately** (`rm -f ./__audit16.mts`).
14. RD-12-15 regression check by mtime and by reading the diffed authorization lines.

**Not run:** no test suite, no `tsc`, no ESLint, no build, no browser, no emulator. No source
changed, so none was warranted — and none is claimed.

---

## AG. Source Changes

**One file created: `docs/RD-ANALYTICS-12-16-AUDIT.md`.**

No API, permission, UI, test, Firestore or Admin file was created, modified or deleted. One
temporary `.mts` script was written to execute the permission matrix and deleted in the same
command that ran it; `git status` shows no trace of it.

---

## AH. Git / Deployment Status

- **Commit:** not committed. HEAD `b7e5fdf`, nothing staged.
- **Push:** not pushed.
- **Deployment:** none — no Vercel, Firebase, rules or index deployment.
- **Firestore rules / indexes:** unchanged and not deployed. The RD-12-07 and RD-12-11 index
  definitions both remain undeployed.

---

## AI. Final Verdict

**APPROVED WITH CONDITIONS**

Neither boundary is ambiguous. `estimatedRevenue` is financial data by its own declaration and
has an exact, already-shipping precedent to copy. `attendeeName` is a deliberate, documented
decision consistent with the platform's own sensitivity classification, and no role receives it
without a sanctioned path — so it warrants alignment, not urgency.

Conditions on implementation:

1. **Both revenue routes in one change.** Gating only the list moves the gap to the detail route.
2. **`null`, not `0`, and not `revenueUnavailable`.** A gated absence and a failed read are
   different facts; the dashboard already distinguishes them and the UI must too.
3. **The attendee gate is the union `registrations || transactions`**, not `registrations`
   alone — a plain `registrations` gate would take names from finance's dashboard while
   `/dashboard/finance/payment-issues` keeps showing them.
4. **Admin and manager visibly lose a figure.** That is the point of the fix and should be
   reviewed as a product decision, not slipped in.

---

## AJ. Recommended Next Phase

**RD-ANALYTICS-12-17 — Organizer Data-Boundary Fixes (implementation).**

Scope: gate `estimatedRevenue` on `transactions` across both event routes (`null` when denied);
gate `attendeeName` on `registrations || transactions` inside `readActivityPage`; add the missing
exposure tests for both, plus a test that the event routes and the dashboard agree about
per-event revenue.

Why together: they share no files but share one reviewer question — "which permission owns this
class of data?" — and both are small, mechanical and covered by an existing template. Keep them
as two separate commits within the phase so the money change can be reverted independently.

**Not** in scope: renaming `estimatedRevenue` (P2-1), which is a contract change across 18
consumers and deserves its own phase.

---

## AK. Completion Checklist

- [x] `/api/organizer/dashboard` traced end to end
- [x] `/api/organizer/events` traced end to end
- [x] `attendeeName` searched repository-wide and classified
- [x] `activity` consumers mapped
- [x] `estimatedRevenue` lineage traced to source, both routes found
- [x] `estimatedRevenue` consumers mapped (18 files)
- [x] `registrations` permission semantics established from call sites
- [x] `transactions` permission precedent established
- [x] Role exposure matrix computed from the real matrix, not inferred from UI
- [x] Data minimization reviewed for both APIs
- [x] Permission options evaluated for both fields; no new permission proposed
- [x] Server vs client boundary decided; client-only hiding explicitly rejected
- [x] Legacy compatibility assessed
- [x] Security threat analysis completed
- [x] Cross-workspace isolation verified
- [x] Cross-event model verified against the actual architecture
- [x] RD-12-15 regression verified rather than accepted
- [x] Admin non-involvement proven
- [x] Test coverage audited
- [x] Findings classified P0–P3
- [x] Implementation recommendation and risk given for each fix
- [x] No implementation performed
- [x] No permissions, APIs, UI, tests, Firestore or Admin changed
- [x] Temporary script deleted; `git status` verified
- [x] No deployment, commit or push
