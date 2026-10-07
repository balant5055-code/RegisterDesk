# RD-ANALYTICS-12-15 — Organizer Analytics Authorization Reconciliation

**Scope: Organizer workspace only.** Admin authorization was not touched. No permission was
created, `finance` was not granted `events`, Reports and the legacy dashboard were not changed,
Firestore was not changed. Not committed, not pushed, not deployed.

---

## A. Objective

Stop gating a read with a mutation permission. `authorizeWorkspace(req, 'events')` protected
the Analytics routes; `events` means "may CHANGE an event" and was only standing in for "is an
organizer, not a gate operator". The side effect was that `finance` — a role that holds
`transactions` and whose whole job is money — was refused its own revenue analytics.

## B. RD-12-14 Findings Used

| Finding | Acted on |
|---|---|
| **P1-2** `events` gates a read and performs no scoping (`isEventInScope` returns true for every non-gate role) | Both Analytics routes now use `authorizeAnyWorkspace` |
| **P1-3** Finance cannot list events, so Analytics would be unusable even if granted | The event-list route reconciled in the same phase — the audit's condition 1 |
| **P2-2** The gate-role exclusion mechanism would change silently | Tests updated deliberately to assert `isCheckinOnlyRole`, not the absent permission |
| **P2-3** `requireEventScope` is unreachable defence | **Kept**, and commented as such |
| Audit condition 2 — the nav row must follow the server | `permission: 'events'` removed from the Analytics row in the same change |
| **P1-1** Legacy dashboard ships `attendeeName` ungated | **Not touched** — belongs to RD-ANALYTICS-12-16 |

## C. Organizer Authorization Model

```
authenticate (verifyCaller: token + email-verified)
   ↓
resolve Organizer workspace (resolveWorkspaceUid → role, permissions, eventIds)
   ↓
exclude gate-only roles            ← isCheckinOnlyRole, derived from the matrix
   ↓
event boundary                     ← identity.organizerUid === authz.workspaceUid
   ↓  (+ requireEventScope, kept)
financial permission               ← transactions
   ↓
read only what was authorized      ← includeFinancial travels INTO the producer
   ↓
capability gates                   ← the event's own identifierConfigs
```

Every step uses an existing helper. No duplicate authorization logic, no new permission, no
change to what `events` means.

## D. Analytics Authorization Changes

Two routes, one line each. All five Analytics modules share the first
(`useAnalyticsScope.ts:80`), so there is exactly one canonical boundary.

| Route | Before | After |
|---|---|---|
| `analytics/overview/[eventId]` (all 5 modules) | `authorizeWorkspace(req, 'events')` | `authorizeAnyWorkspace(req)` |
| `analytics/[eventId]` (landing + CSV/XLSX/PDF export) | `authorizeWorkspace(req, 'events')` | `authorizeAnyWorkspace(req)` |

Both routes' stale header prose was corrected in the same change — a header describing the old
model is how the next reader is misled.

**Unchanged in both:** the event boundary, `requireEventScope`, `financeAllowed`, the
`includeFinancial` argument, the capability context, the single non-enumerable `DENIED` message.

## E. Finance Access

Finance now reaches Analytics **without holding `events`** — verified against the real matrix
(`ROLE_PERMISSIONS.finance` is still exactly `['wallet','settlements','transactions']`).

| Module | Finance |
|---|---|
| Overview, Registrations, Operations, Communications | ✅ |
| Revenue / financial | ✅ — because it holds `transactions`, the same permission that has always decided money |
| Timing / Identifiers panels | only where the event's own `identifierConfigs` enable them |
| Anything gate-only | ❌ |

## F. Event Selection / Event Access

**This is the one genuinely debatable change in the phase**, and the audit named it as the
blocking dependency.

`EventContextProvider` makes exactly one call to `GET /api/organizer/events?limit=100`, which
required `events`. Reconciling only the analytics routes would have given finance a working API
and an **empty event selector** — worse than an honest refusal. So that route moved to
`authorizeAnyWorkspace` too.

Each safety claim was checked, not assumed:

| Claim | Evidence |
|---|---|
| Read-only | `GET` is the only exported method; every `.set(`/`.add(` in the file is a Map or Set |
| Tenancy unchanged | reads are `users/{authz.workspaceUid}/eventDrafts` — path-proof, from the session |
| **Admin unaffected** | zero references under `app/(admin)`; no Admin code imports `authorizeWorkspace`/`authorizeAnyWorkspace` at all |
| Delta is one role | owner/admin/manager already held `events`; gate roles still refused; **only finance is added** |
| No new data class for finance | the one money field, `estimatedRevenue`, is what `transactions` protects — and finance holds it |
| Reaching the list ≠ acting | publish, cancel, archive, duplicate and status all still require `events` (test 23) |

The alternative — an Analytics-specific event list — was rejected: it duplicates the one list,
and it would force `EventContextProvider` to choose an endpoint by role, which is client logic
deciding an authorization question.

**Not fixed here, deliberately:** `estimatedRevenue` is returned unconditionally, so admin and
manager receive a per-event money figure while being refused money elsewhere. Pre-existing, not
worsened (both already reached this route), same defect class as the legacy `attendeeName`.
It belongs with RD-ANALYTICS-12-16.

## G. Financial Boundary

**Untouched.** `transactions` still decides money, and the decision still travels *into* the
producer, so financial reads are never issued for a caller who may not see them — absence, not
zeroing.

Proven against real Firestore with real tokens (emulator cases 8–9):

| Role | `financialAllowed` | `revenue` key | Rupee figures |
|---|---|---|---|
| owner | `true` | present | yes |
| finance | `true` | present | yes |
| manager | `false` | **absent** | **none** — no `"revenue"`, no `"spend"`, no `Paise` |

Manager and admin were **not** granted `transactions` (test 13, test 26).

## H. Gate Role Exclusion

`checkin_lead` and `checkin_staff` are refused at the first step, before any read — now by
`isCheckinOnlyRole` rather than by the `events` permission they happened not to hold. The rule
is derived from the matrix, so a future gate role inherits it; the route hard-codes no role name
(test 9).

Covered: refusal with an event assignment (test 7), with **zero** assignment (test 8, guarding
the RD-CHECKIN-11 hardening), and not even the identity document is read (test 19). Confirmed
end to end with real credentials (emulator cases 3 and 12).

## I. Owner Behavior

No regression. Analytics row, landing, all five modules, event selection, financial analytics
and capability-gated panels all as before — owner holds every permission, and nothing owner
touched was narrowed. Emulator cases 1, 6, 8; browser-confirmed sidebar and event selector.

## J. Manager Behavior

Unchanged access, unchanged refusal. Manager keeps Analytics (it holds `events`, and now would
qualify either way), keeps event selection, and still receives **no** money — the reads are not
issued. Manager was not granted `transactions`.

## K. Other Organizer Roles

The catalogue is exactly six: `owner`, `admin`, `manager`, `finance`, `checkin_lead`,
`checkin_staff`. `admin` behaves as `manager` for Analytics purposes (holds `events`, not
`transactions`); it is an ORGANIZER role in `ROLE_PERMISSIONS`, unrelated to the platform-admin
area. No role was added, removed or changed.

## L. Admin Scope

**Out of scope and provably untouched.**

- No file under `app/(admin)`, `app/api/admin` or `lib/admin` was modified by this phase — the
  four that show as changed in `git status` carry mtimes of 1–6 Sept, days before this phase's
  first edit at 18:20.
- Admin does not use the organizer authorization helpers at all: a repository search for
  `authorizeWorkspace`/`authorizeAnyWorkspace` across Admin returns **nothing**. Admin has its
  own boundary (`requireAdmin`), which no change here can reach.
- Test 28 pins that the three reconciled routes import no `@/lib/admin/` and call no
  `requireAdmin`.

One Admin observation, **documented not fixed** per the brief: `app/api/admin/events/[slug]/analytics/route.ts`
exists as a separate Admin analytics surface with its own boundary. It was not inspected beyond
confirming it shares no code path with the organizer routes.

## M. Authorization Order

Unchanged and still correct: nothing sensitive is read before authorization. Test 18 walks four
refusal paths (unauthenticated, gate role, foreign event, absent event) and asserts the
computation ran **zero** times in each; test 19 asserts a gate role costs not even the identity
document.

## N. API Response Security

- **Gate roles** receive no analytics data at all — the refusal body carries no `analytics`,
  `paise`, `revenue` or `registrations` (test 6, emulator case 3).
- **Manager** receives no money field of any kind (test 11, emulator case 9).
- **Finance** receives what `transactions` entitles it to, and nothing that depends on a
  permission it lacks.
- **No participant PII** is in the Analytics contract — `participants?` is absent and
  `hasParticipantData` is `false`. Unchanged by this phase.
- Nothing is solved by client-side hiding: every assertion above is made against the server
  payload.

## O. Cross-Workspace Isolation

Proven twice — with mocks (tests 14–16) and end to end against real Firestore and real Auth
tokens (emulator cases 5–7):

| | Event A (workspace A) | Event B (workspace B) |
|---|---|---|
| owner A | ✅ 200 | ❌ 403 |
| finance A | ✅ 200 | ❌ 403 |
| manager A | ✅ 200 | ❌ 403 |
| owner B | ❌ 403 | ✅ 200 |

A **non-existent** event answers byte-identically to a foreign one, so the response cannot be
used to enumerate other workspaces' events (test 16, emulator case 7).

## P. Cross-Event Isolation

The real Organizer model, unchanged: per-member event assignment constrains **gate-only roles**
and nobody else — `isEventInScope` returns `true` for every non-gate role, deliberately, because
"broader roles already hold workspace-wide permissions and can reach the same event through the
organizer surfaces". Within a workspace, a non-gate member may read any of that workspace's
events, exactly as before this phase.

`requireEventScope` is **kept** although it currently refuses nobody who reaches it: it is free,
it becomes live the moment a non-gate role gains an assignment, and removing a containment
because today's matrix makes it unreachable is how the next role addition becomes a disclosure.

## Q. Tests Added / Updated

**New — `tests/unit/organizerAnalyticsAuthorization.test.ts`, 29 cases** covering A–O of the
brief: the role matrix, gate exclusion (incl. zero-assignment), the money boundary in both
directions, cross-workspace and cross-event isolation, authorization-before-read, the event
list, capability gates, "no new permission", and that the legacy dashboard is untouched.

**New — `tests/emulator/organizerAnalyticsAuthz.emu.test.ts`, 13 cases.** Real Auth users, real
ID tokens, real `teamMembers` documents, real route handlers, two workspaces, two published
events. Nothing about authorization is stubbed.

**Updated deliberately — five existing cases across four files**, each with a comment saying
what it defends and why the assertion moved. None deleted, none weakened:

| File | Case | Why |
|---|---|---|
| `analyticsAuthorization.test.ts` | 2 | Used `finance` as "a member who may not open Analytics". Now asserts finance IS admitted without `events`; **new case 2b** carries the original property with a gate role. |
| `analyticsAuthorization.test.ts` | 6 | Premise guard changed from "lacks `events`" to `isCheckinOnlyRole` — the rule the route now applies. |
| `analyticsAuthorization.test.ts` | 7 | Its "no permission" refusal row used finance; replaced with a gate role so the path is still a refusal. |
| `analyticsOverview.test.ts` | 2, 3 | Same substitution, same reasoning. |
| `navigationSurfacing.test.ts` | 14, 15 | 12-13's matrix had `finance: analytics=false` and pinned `permission: 'events'`; both now follow the reconciled server. |
| `eventsLanding.test.ts` | path-scoping case | Asserted the old call; now asserts the new one, with tenancy-by-path unchanged. |

Two mock modules gained `authorizeAnyWorkspace`, mirroring the real rule over the real matrix —
so gate-role refusal is still decided by `lib/team/types`, not by a test file.

## R. Emulator Validation

`tests/emulator/organizerAnalyticsAuthz.emu.test.ts` — **13 passed**. Every §25 requirement:

| Requirement | Result |
|---|---|
| Owner A / Finance A / Manager A → Event A | **allowed** (case 1) |
| Finance reached it without `events` | **yes** (case 2) |
| Owner A / Finance A / Manager A → Event B | **denied** (case 5) |
| Owner B → Event B allowed, Event A denied | **yes** (case 6) |
| Checkin lead + staff → Analytics | **denied**, no data in the body (case 3) |
| Unauthenticated | **401** (case 4) |
| Owner / Finance → financial | **allowed** (case 8) |
| Manager → financial | **denied, absent not zeroed** (cases 8–9) |
| Event selector returns only workspace A's events | **yes** (cases 10–11) |
| Gate roles cannot list events | **denied** (case 12) |

Regression: with `reportHistoryScale`, `reportHistoricalScope` and `adminFinanceHistoricalScope`
— **4 files, 48 passed**.

## S. Browser Validation

Performed, and **partial** — reported as such rather than overstated.

**Validated:**

| Check | Result |
|---|---|
| finance sidebar now shows Analytics | ✅ `Overview \| CRM \| Analytics \| Reports \| Finance \| Team \| Workspace Settings \| Help & Support` |
| owner and manager sidebars unchanged | ✅ |
| finance event selector populated | ✅ "Profiling Marathon 2026" — the dependency this phase existed to solve |
| analytics/events API responses | `200 /api/organizer/events` for all three roles; **no 401/403** |
| page errors | **none** |
| overflow at 1440 / 834 / 390 | 0px / 0px / 0px |

**NOT validated in the browser: the money boundary.** Every Analytics module rendered its
"Select a single event" state for all three roles, because the emulator fixture's event never
produced module data — the client scope never resolved, and no analytics API call was made at
all. A check that cannot distinguish "money withheld" from "no data" proves nothing, so the QA
script now reports that third outcome as **INCONCLUSIVE** rather than as a pass or a failure.
The first run did report it as a manager failure, which was wrong: nothing had leaked, nothing
had been withheld, there was simply no data.

The money boundary is instead proven by the emulator test (§R), against real Firestore with real
tokens and a real published event, which is the stronger instrument for a server rule.

## T. Performance / Scale

No new query, no new read, no new index. The analytics routes' read pattern is byte-identical —
one identity document, then the existing bounded producer. The event list is the same bounded,
cursor-paginated, workspace-path-scoped query it was; only its authorization line changed. No
Firestore index is required by anything in this phase.

## U. TypeScript

**PASS** — `npx tsc --noEmit`, exit 0.

## V. ESLint

**PASS on every touched file** — 0 errors, 3 warnings, all `'_req' is defined but never used`
in mock signatures that must keep the real parameter shape.

Repository-wide, the pre-existing 88 errors / 103 warnings in admin-finance, communications and
event-tab components are unchanged and were not fixed.

## W. Build

**PASS** — `npm run build`, exit 0, 38.8s, 312 static pages.
Full unit suite: **339 files — 9,199 passed, 1 skipped, 0 failed.**

## X. Firestore Rules / Indexes

**Unchanged.** `firestore.rules` mtime 3 Sept, `firestore.indexes.json` mtime 12:08 — both
predate this phase's first edit at 18:20. No rule, index, collection or schema touched; nothing
deployed. The RD-12-07 and RD-12-11 index definitions remain undeployed.

## Y. Git Status

HEAD `b7e5fdf`, unchanged. Nothing staged. Changed by this phase:

| File | Change |
|---|---|
| `app/api/organizer/analytics/overview/[eventId]/route.ts` | `authorizeAnyWorkspace`; header corrected |
| `app/api/organizer/analytics/[eventId]/route.ts` | `authorizeAnyWorkspace`; header corrected |
| `app/api/organizer/events/route.ts` | `authorizeAnyWorkspace`; safety argument recorded |
| `config/workspaceNav.ts` | Analytics row: `permission` removed, `hideFromGateRoles` added |
| `tests/unit/organizerAnalyticsAuthorization.test.ts` | **new**, 29 cases |
| `tests/emulator/organizerAnalyticsAuthz.emu.test.ts` | **new**, 13 cases |
| `tests/unit/{analyticsAuthorization,analyticsOverview,navigationSurfacing,eventsLanding}.test.ts` | 5 cases updated + 1 added |
| `scripts/qa/rd-analytics-12-15-{shots,fixture}.mjs` | **new**, browser QA |
| `docs/RD-ANALYTICS-12-15-IMPLEMENTATION.md` | this document |

Every other modified file in the tree carries an mtime predating 18:20 and belongs to earlier
phases or a concurrent session; none was touched, reverted or overwritten. `tsconfig.json`
restored (0 `next-a1215` entries) and `.next-a1215` removed.

## Z. Deployment Status

**Not deployed. Not committed. Not pushed.**

## AA. Known Limitations

1. **The browser did not exercise the money boundary** (§S). Proven by the emulator instead. A
   future QA fixture that reliably drives a module to a data state would close this.
2. **`estimatedRevenue` still reaches admin and manager** from the event list — pre-existing,
   not worsened, deliberately left for RD-ANALYTICS-12-16 alongside the legacy `attendeeName`.
3. **`requireEventScope` remains inert** for every role that reaches it. Kept on purpose (§P),
   but it reads as a control and is not one; the comment now says so.
4. **`/dashboard/reports` still uses a different boundary** — `authorizeAnyWorkspace` with its
   own path-proof ownership. The two surfaces now agree on WHO, which was this phase's goal; the
   route migration itself remains future work.
5. **The event list widened to one more role.** The safety argument is in §F and in the route.
   It is the one change here that a reviewer should scrutinise rather than skim.

## AB. Final Verdict

**COMPLETE**, within the phase's stated bounds, with no stop condition triggered:

| Stop condition | Status |
|---|---|
| Finance only reachable by granting `events` | Not hit — `events` not granted |
| Event selection unsafe without broadening | Broadened by exactly one role, argued in §F |
| A change would alter Admin authorization | Not hit — Admin uses none of these helpers |
| Cross-workspace isolation unprovable | Proven, twice |
| Financial data leaks to Manager | Does not — absent, not zeroed |
| Gate roles can access Analytics | Cannot — refused before any read |
| Authorization after sensitive reads | Does not happen |
| A Firestore index/rule change required | None |
| Shared helper unchangeable without Admin impact | No helper was changed at all |
| A new permission appears necessary | None created |

Explicitly, as required: **Organizer-only scope · Admin unchanged · no new permission ·
`finance` not granted `events` · no Reports changes · no legacy PII fix · no Firestore changes ·
no deployment · no commit · no push.**
