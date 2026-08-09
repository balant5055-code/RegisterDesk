# RD-RACEOPS-01 — Race Operations Module · Phase 0 Architecture Audit

> **Sprint 1 shipped.** Foundation complete and verified — see
> [§14 Sprint 1 delivery record](#14-sprint-1-delivery-record) at the end of this
> document, and [`features/race-operations/README.md`](../features/race-operations/README.md).
> Sprint 2 has **not** started and needs approval.

**Status:** Audit complete · Sprint 1 delivered
**Scope of this document:** deliverables 1–10 only. No business logic implemented.

**Baseline measured before the audit (not assumed):**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** — clean |
| `npm test` (vitest) | **60 files / 436 tests passed** |
| `npm run lint` | ⚠️ **204 problems — 93 errors, 111 warnings, all pre-existing** |

The lint baseline is **not** zero. Top rules: `@typescript-eslint/no-unused-vars` (73),
React Compiler `setState`-in-effect (34), `@next/next/no-img-element` (28), refs-during-render
(18), `react/no-unescaped-entities` (15), components-during-render (13).

Your brief says *"Zero warnings. Zero errors."* That target is **not achievable as an
absolute** without a repo-wide cleanup sprint that would edit dozens of production files —
which your brief also forbids. So I am interpreting the gate as: **Race Operations
contributes zero new errors and zero new warnings; the 204 pre-existing findings stay
untouched and are re-counted every sprint to prove no drift.** Say the word if you want a
separate lint-cleanup sprint instead.

Everything below is grounded in files that exist today. Every path in this document
was read, not assumed.

---

## 0. Executive summary + the four decisions I need from you

The codebase is in excellent shape for this: there is a generic job kernel, a
generic identifier engine, a canonical RBAC matrix, a single sidebar SSOT, and —
critically — **the certificate module already has a results-shaped hole waiting to
be filled**. Race Operations can be built almost entirely additively.

Four things in your brief collide with the repo as it actually is. I need your call
on each before Sprint 1.

| # | Issue | My recommendation |
|---|---|---|
| **D1** | **There is no `src/` directory.** The project is root-level (`app/`, `components/`, `lib/`) with `@/*` → repo root (`tsconfig.json:38-42`). Creating `src/features/race-operations/` would introduce a second, contradictory root convention. | Use **`features/race-operations/`** at repo root — same isolation, same folder tree, zero convention conflict. Imports become `@/features/race-operations/...`. |
| **D2** | **"Select Distance" has no data model.** Distance is not a field. In RegisterDesk a race distance **is a Pass** (`events/{slug}.pricing.passes[]`), each pass optionally carrying `raceDetails: { category, customCategory, minAge, maxAge }` (`components/wizard/AddPassEditor.tsx:52-56, 100`). | Treat **Distance = Pass**. "Select Distance" is a pass picker reading the event's existing passes. No schema change, no new builder field. |
| **D3** | **"Existing Certificate Module becomes available" is already true.** Certificate issuance is gated only on registration status (`lib/certificates/firestore.ts:70-80`) — not on results. The `'results'` trigger exists as a *type* (`lib/certificates/types.ts:37`) but nothing implements it; `manual` is the only live trigger. So publishing results unlocks nothing today. Separately, `distance`/`finishTime`/`position` are **hardcoded to `''`** at both issue sites (`app/api/organizer/events/[eventId]/certificates/issue/route.ts:145-147` and `lib/certificates/jobs.ts:176-178`), so `{{finishTime}}` and `{{position}}` render blank on every certificate ever issued. | **Sprint 6, needs your explicit approval:** a 2-file, ~6-line additive change that reads published results and passes them into the existing `GenerateCertificateInput`. Nothing else in the certificate module is touched; with no results the values stay `''` (byte-identical behaviour). Without this, Race Operations and Certificates remain visually linked but functionally disconnected. |
| **D4** | **Gender and age are not queryable.** They live only as free-text answers inside `registrations.attendee.formResponses` under the labels `'Gender'` and `'Date of Birth'`, both **optional**, and only on sports/team-sport form templates (`components/wizard/registrationFormConfig.ts:201, 286, 307`). | Ranking engine v1 ranks by **Overall** and **Pass (distance)** only — both fully reliable. Gender/age-group ranking ships in Sprint 5 as **best-effort from the uploaded file's own columns**, never inferred from `formResponses`. Honest and deterministic. |

---

## 1. Architecture Audit Report

### 1.1 Framework & conventions

| Fact | Value |
|---|---|
| Next.js | **16.2.7**, App Router (`package.json:38`) · React 19.2.4 |
| Repo root | `registerdesk/` — **no `src/`** |
| Path alias | `@/*` → `./*` (repo root) |
| TS | `strict: true`, `noEmit`, `isolatedModules` |
| Tests | Vitest, `tests/unit/*.test.ts` (60 suites); `tests/` is **excluded** from tsconfig |
| Lint | flat config, `eslint-config-next` core-web-vitals + typescript, no custom rules |
| Styling | Tailwind v4 via `@tailwindcss/postcss`, CSS-variable token layer (`--primary`, `--primary-rgb`, `--primary-gradient`) |
| Middleware | `middleware.ts` only rewrites `/admin` → `/admin/dashboard`. **Not an auth gate** and `matcher` is scoped to `/admin` only — Race Ops needs nothing here. |

> `AGENTS.md` warns this Next.js version diverges from training data. Sprint 1 will read
> `node_modules/next/dist/docs/` for the current route-handler + `params` contract before
> writing the first route. Note the already-current signature in existing routes:
> `context: { params: Promise<{ eventId: string }> }` — **params is a Promise**.

### 1.2 Route groups

```
app/(auth)/        public auth pages
app/(dashboard)/   ← ORGANIZER WORKSPACE — Race Operations belongs here
app/(admin)/       platform admin (separate shell, separate nav SSOT)
app/(admin-auth)/  admin login
app/api/           route handlers (organizer / admin / public / cron / webhooks)
app/<public>/      marketing, /events, /attendee, /verify …
```

### 1.3 The organizer shell (`app/(dashboard)/layout.tsx`, 471 lines)

A single client-component layout that wraps every organizer page:

```
ToastProvider → ConfirmProvider → BusinessConfigProvider
  └── div.h-dvh
       ├── <Sidebar/>                       (components/dashboard/Sidebar.tsx)
       ├── <DashboardHeader/>               breadcrumbs · ⌘K · bell · theme · profile
       ├── <main id="main-content">{children}</main>
       ├── #wizard-footer-portal
       ├── <SessionGuard/>
       └── <CommandPalette/>
```

**Client-side auth guard** (`layout.tsx:401-423`): `useAuth()` → `resolveAuthGuard(user)`
→ redirect to login / verify-email; renders `<AuthLoadingScreen/>` until `authorized`.
This is UX only — **every API route re-authorizes server-side**.

**Breadcrumbs are automatic** from the pathname (`layout.tsx:72-90`), driven by
`SEG_LABELS`. Race Ops path segments (`race-operations`, `publish-results`, `photos`,
`history`) will auto-titleize to "Race Operations", "Publish Results", "Photos",
"History" via the `seg.replace(/-/g,' ')` fallback — **no edit to `SEG_LABELS` needed**.
One caveat: `race-operations` is a **container segment with no index page** in my plan,
so it must be added to `NON_INDEX_SEGMENTS` (`layout.tsx:60`) or the crumb becomes a
dead link. That, or give it an index page. See §7.

### 1.4 Sidebar architecture — the extension point

`config/workspaceNav.ts` is the **single source of truth**. `Sidebar.tsx:54` reads it
verbatim (`const NAV_SECTIONS: NavSection[] = WORKSPACE_NAV`) — the sidebar contains
no hardcoded destinations.

Shape: `WorkspaceNavSection { sectionLabel, groups: WorkspaceNavGroup[] }`, where a
group is `{ key, label, icon, href, children: { label, href, matchParams?, newTab? }[] }`.

Behaviour worth knowing:
- **Expanded mode** renders group → collapsible children. **Collapsed (72px) mode**
  renders only the group icon, linking to `group.href`. So `group.href` **must be a
  real page** or the collapsed sidebar produces a 404.
- Active state: `isGroupActive` = `pathname.startsWith(group.href)`; `isChildActive` =
  exact path match + optional `matchParams`.
- **Feature-flag filter** `navHrefEnabled` (`Sidebar.tsx:59-65`) — note
  `if (href.includes('/certificates')) return flags.certificates`. A Race Ops child
  linking to the certificates route is therefore **automatically flag-gated**, which is
  correct and free.

`config/navigation.ts` holds `ROUTES` — the route-constant SSOT. Its own comment:
*"never hardcode strings in components."* Race Ops routes go here.

### 1.5 Permission system

Two files, and they are the whole story.

**`lib/team/types.ts`** — the role→permission matrix, explicitly *"the single source of
truth… Routes must never hard-code role checks"*:

```
TeamRole       = owner | admin | manager | checkin_staff | finance
TeamPermission = events | registrations | broadcasts | certificates | checkin
               | participants | wallet | settlements | transactions
owner   → all
admin   → events, registrations, broadcasts, certificates, checkin, participants
manager → events, registrations, checkin, participants
```

**`lib/team/access.ts` + `lib/team/workspace.ts`** — enforcement.
`verifyCaller` does `adminAuth.verifyIdToken(token, /* checkRevoked */ true)` **and
rejects `email_verified !== true`**. `resolveWorkspaceUid` maps caller → the workspace
they act in (owner → self; active team member → owner's uid). Route-level one-liners:

```ts
authorizeWorkspace(req, permission)   // token + workspace + permission
requireAdmin(callerUid, organizerUid) // owner or admin ONLY  ← Race Ops
authorizeWorkspaceDownload(req, perm) // same, token may be ?token= (for <a download>)
```

> **"Only Event Owner / Event Admin" maps exactly to `requireAdmin`.** No new permission
> is required, no matrix edit, no new role. `requireAdmin` returns `ok:false` for
> `manager`, `checkin_staff`, and `finance`. This is the cleanest possible fit and I
> recommend it over adding a `raceOperations` permission (which would mean editing
> `ALL_PERMISSIONS`, `ROLE_PERMISSIONS`, and the Team settings UI — i.e. touching
> production authorization code, which your brief forbids).

**Ownership is proven by path**, not by a field: `users/{uid}/eventDrafts/{eventId}`.
An event the caller doesn't own simply doesn't exist at that path → 404. See §3.2.

### 1.6 Backend / API conventions

Observed uniformly across ~200 organizer routes:

1. `authorizeWorkspace(req, perm)` (or `requireAdmin`) first — **before** parsing input.
2. `const { eventId } = await context.params` — params is a Promise.
3. Hand-rolled validation. **There is no Zod / schema library** — `lib/validators/` is an
   empty directory. Validation is explicit predicate functions (e.g.
   `lib/registrations/importValidation.ts`, `lib/certificates/validation.ts`).
4. `NextResponse.json(body, { status })`; read-sensitive routes add
   `{ headers: { 'Cache-Control': 'no-store' } }`.
5. Firestore only via `adminDb` from `@/lib/firebase/admin` (server-only modules are
   marked `// Server-only` at the top of the file).
6. Long work → the **generic job kernel**, never an inline loop. `lib/jobs/kernel.ts`
   (lease / cursor / counts / status) + `lib/jobs/runner.ts` (`JobStrategy`, chunked).
   Driven either by a client "drive-loop" POSTing `.../process`, or by `app/api/cron/*`.
7. Errors: `console.error('[scope]', err)` + a generic client message. Sentry via
   `captureError(err, { scope, area })`.

---

## 2. Existing UI Audit — what to reuse, verbatim

**`components/ui/` (barrel: `components/ui/index.ts`)**

| Need | Reuse | Notes |
|---|---|---|
| Card | `Card` | `variant?: CardVariant` |
| Buttons | `Button` (`variant`,`size`), `IconButton`, `TextLink` | |
| Page title | `PageHeader` (supports `PageHeaderStatus` w/ tone), `SectionHeader`, `SectionHeading` | |
| Modal | `Dialog` (`open,onClose,title,children,footer,size`) | |
| Confirm / prompt | `useConfirm()` from `ConfirmProvider` | already mounted in layout |
| Toasts | `useToast()` from `ToastProvider` | already mounted in layout |
| Empty / error | `EmptyState`, `ErrorState` | |
| Status pill | `StatusChip` (`tone`) | |
| Loading | `Spinner`, `Skeleton` | |
| Progress | `ProgressBar` (`value,max,tone,label`) | for import progress |
| Inline notice | `Banner` (`tone,title,action,onDismiss`) | |
| Badge | `Badge` | |

**`components/admin/` (barrel: `components/admin/index.ts`)** — *"One design language for
every admin content page… Import from here — never re-hand-roll these in a page."*
`TableFrame / THead / Th / TBody / Tr / Td / TableStateRow`, `AdminToolbar`, `SearchInput`,
`FilterTabs`, `LoadMoreButton`, `StatusPill`, `ErrorBanner`.

> ⚠️ These are **named** admin primitives but are pure presentation with no admin coupling.
> The results-preview and results-table screens need exactly this table + toolbar + filter-tab
> + pagination set. **Decision D5 (low risk):** reuse `components/admin/*` from Race Ops
> (import-only, zero modification), rather than hand-rolling a duplicate table — duplication
> is explicitly forbidden by your brief. I recommend reuse and a one-line comment at each
> import site explaining why an organizer page imports from `components/admin`.

**Other confirmed reuse points**

| Need | Reuse |
|---|---|
| Excel/CSV parse | `read-excel-file` (already a dependency), pattern in `app/(dashboard)/dashboard/events/[eventId]/registrations/ImportParticipantsDrawer.tsx` (782 lines) — incl. `describeWorkbookError` / `logParserException` diagnostics |
| CSV export escaping | `csvCell` / `csvRow` — `lib/utils/csv.ts` (**the** SSOT; formula/DDE-injection hardened) |
| Job progress UI | `useJobProgress` — `lib/hooks/useJobProgress.ts` (drive-loop + toast) |
| Drawer a11y | `useFocusTrap` — `lib/hooks/useFocusTrap.ts` |
| Class merge | `cn` — `lib/utils/cn.ts` |
| Status colours | `lib/ui/statusColors.ts` (`registrationStatusCls`, `eventLifecycleMeta`) |
| Typography / container scales | `lib/ds/` (`fs`, `typography`, `container`) |
| Event picker | `EventSwitcher` — `components/dashboard/EventSwitcher.tsx` (presentation-only, no fetching) |
| Metric tiles | `MetricCard`, `StatCard` — `components/dashboard/` |
| Inbox notification | `notifyImportComplete` / `notifyBulkComplete` — `lib/notifications/inbox/notify.ts` |

**Closest structural precedent for the whole feature:**
`app/(dashboard)/dashboard/check-in/page.tsx` — a *global* workspace hub that lists the
organizer's events from `GET /api/organizer/events` and deep-links per event. Publish
Results should be built as its twin.

**No upload component exists to reuse.** File input + drag-drop is hand-rolled per site
(`ImportParticipantsDrawer.tsx`, `BrandingMediaSection.tsx`, `TemplatesPanel.tsx`). Race
Ops will build **one** `ResultsFileDropzone` inside the module and use it everywhere in
the module.

---

## 3. Firestore Audit Report

### 3.1 Collections that exist (from `firestore.rules` + `firestore.indexes.json` + `lib/firebase/firestore/`)

**Core:** `events/{slug}`, `users/{uid}` + `users/{uid}/eventDrafts/{draftId}` +
`users/{uid}/campaignDrafts` + `users/{uid}/notifications`, `registrations/{regId}`
(+ `auditLog` subcollection), `registrationCounters/{eventSlug}`, `registrationClaims`,
`ticketCodeClaims`, `teamMembers`, `waitlists`, `eventSessions`.

**Identity engine:** `identifierLocks`, `identifierCounters`, `identifierHistory`,
`identifierConfigs`, legacy `bibLocks`, `bibCounters`.

**Certificates:** `certificateTemplates/{eventId}`, `certificateRecords`, `certificates`,
`certificateJobs`.

**Jobs:** `certificateJobs`, `registrationImportJobs` (+ `rows` subcollection),
`printTemplates`, print/report/broadcast job collections.

**Finance / comms / governance / licensing:** `platformTransactions`,
`organizerRevenueWallets`, `walletTransactions`, `settlementRequests`, `emailLogs`,
`broadcastCampaigns`, `crmContacts`, `crmActivities`, `adminAuditLogs`, `eventLicenses`,
`licenseOrders`, `publishBaselines`, `platformSettings`, `businessConfig`, …

**There is no results / race-operations collection of any kind.** Confirmed by grep:
`raceResults|raceOperations|race-operations` → 0 hits repo-wide.

### 3.2 Relationships — the part that matters most

```
users/{uid}                                     organizer profile
  └── eventDrafts/{eventId}      ← "eventId" IN EVERY ORGANIZER ROUTE.
                                    Ownership is proven BY THIS PATH.
                                    .eventDetails.seo.urlSlug ──┐
                                                                 │
events/{slug}   ←────────────────────────────────────────────────┘
   .uid          = organizer uid        .draftId = eventId (back-pointer)
   .eventType    = 'sports' | 'conference' | 'workshop' | 'exhibition'
                 | 'cultural' | 'awards' | 'community'
   .pricing.passes[]  ← ***THE DISTANCE MODEL***
        { id, name, price, quantity, raceDetails: { category,
          customCategory, minAge, maxAge }, advancedSettings:{ badgeCategory }, … }

registrations/{registrationId}                  keyed by eventSLUG, not eventId
   .eventSlug     .organizerUid  (denormalized → enables organizer queries)
   .passId  .passName            ← the participant's DISTANCE
   .bibNumber  .bibCategory      ← nullable; set by the identifier engine
   .status  .paymentStatus  .checkedIn  .ticketCode
   .attendee.{ name, email, phone, formResponses }
                                 ← 'Gender' / 'Date of Birth' hide in here

certificateTemplates/{eventId}                  keyed by eventId
certificateRecords/{certificateId}              keyed by (eventId, registrationId, type)
```

**Two ID spaces.** Organizer surfaces are keyed by **`eventId` (= draftId)**; participant
and public data are keyed by **`eventSlug`**. The canonical bridge is
`lib/registrations/importContext.ts:38-45`:

```ts
const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
if (!draftSnap.exists) return { ok:false, status:404, error:'Event not found' }  // = ownership
const slug = draftSnap.data().eventDetails?.seo?.urlSlug
if (!slug)  return { ok:false, status:400, error:'Event is not published' }
const event = await getEventBySlug(slug)
```

Race Ops repositories will reuse this exact resolution shape. **Results documents will
carry BOTH `eventId` and `eventSlug`** so they join to organizer surfaces and to
registrations without a second lookup.

### 3.3 The four fields your brief names

| Field | Reality | Consequence |
|---|---|---|
| **Bib number** | `registrations.bibNumber` (string, nullable) + `bibCategory`. Authoritative allocation is the **generic identifier engine** (`lib/identifiers/engine.ts`); `lib/sports/bibNumbers.ts` is a documented legacy adapter with *"NO bib-specific allocation logic anymore"*. `identifierLocks` is the uniqueness authority. | Race Ops **matches on** bib; it must **never allocate or mutate** one. Read-only. |
| **Distance** | **Not a field.** It is a Pass (`pricing.passes[].name`) with optional `raceDetails.category`. `registrations.passId/passName` records which one. Grep: `raceCategory` → 0 hits. | → **D2**. Distance = Pass. |
| **Category** | Three unrelated meanings: `passes[].raceDetails.category` (builder), `registrations.bibCategory` (identifier label at assignment time), `identifierConfigs.pools[].by: 'pass'|'category'|…`. | Race Ops must define **one** unambiguous `categoryLabel` on its own result doc and not overload any existing field. |
| **Gender** | Only `formResponses['Gender']`, radio `['Male','Female','Other / Prefer not to say']`, **optional**, sports templates only. Not indexed, not a column, absent on non-sports events and on any participant who skipped it. | → **D4**. Gender ranking from the uploaded file's own column only. |

### 3.4 Existing indexes

`firestore.indexes.json`, 774 lines, 32 collection groups. `registrations` carries the
composite indexes used by the organizer list/filter/export paths (RD-ORGANIZER-01 added 4).
`identifierHistory` and `certificateRecords` are indexed.

**No existing index needs to change.** Race Ops needs new composite indexes on its **own**
new collections only (§8) — an additive append to `firestore.indexes.json`, which is the
normal deploy path (`npm run deploy:firebase`).

### 3.5 Security-rules doctrine

`firestore.rules` is emphatic: every server-only collection gets an **explicit**
`allow read, write: if false;`, described in-file as *"a tripwire against a future client
query being added without a security review."* Rules do **not** cascade to subcollections —
each subcollection needs its own deny (see the `registrations/{id}/auditLog` comment at
`firestore.rules:11-17`).

**Every Race Ops collection is server-only and gets an explicit deny, subcollections
included.** This is an append to `firestore.rules` — the one unavoidable edit to a shared
file, and it is purely additive (new `match` blocks, no existing block altered).

**Storage:** `storage.rules` covers `event-assets/{uid}/…`, `organizer-assets/{uid}/…`,
`certificates/templates/{uid}/{eventId}/**`, then a wildcard deny. **No R2, no S3 —
everything is Firebase Storage today.** Photos (Cloudflare R2) would need a new SDK
dependency + new env vars; correctly deferred to placeholder-only.

---

## 4. Certificate Flow Audit

### 4.1 How it works today

```
certificateTemplates/{eventId}          organizer-configured design + settings
        │
        ├── manual   → POST /api/organizer/events/[eventId]/certificates/issue
        └── bulk     → certificateJobs + /jobs/[jobId]/process  (lib/certificates/jobs.ts)
                       both call ↓
generateCertificate({ input, certificateType, source, template })   lib/certificates/generate.ts
  1. assertRegistrationEligibleForCertificate(registrationId)
       → throws unless status ∉ {cancelled, rejected} and paymentStatus ≠ refunded
  2. findCertificate(eventId, registrationId, type)      → idempotent early return
  3. reserveCertificateId(...)                            → deterministic claim
  4. buildContext(input) → PlaceholderContext             → replaceVariables()
  5. renderCertificatePdf(...) → Storage → certificateRecords
  6. optional emailCertificate()
```

Placeholders (`lib/certificates/placeholders.ts`) — the registry is *"a single source of
truth… no hardcoded token lists elsewhere"*. Sports tokens already declared:
`{{bibNumber}} {{distance}} {{finishTime}} {{position}} {{category}}`.

### 4.2 The two findings

**F-1 — Nothing gates certificates on results.** Eligibility is
`lib/certificates/firestore.ts:70-80`: registration status + payment status. That's all.
`CertificateTrigger` includes `'results'` (`types.ts:37`, commented *"after results /
positions are published (sports)"*) but grep for `'results'` returns **only that type
declaration** — no implementation anywhere. `types.ts:27` confirms *"`manual` is the only
trigger"*.

→ **Publishing results does not need to unlock certificates, because certificates are
already unlocked.** "Certificate module becomes available" is satisfied by navigation:
the Race Ops sidebar links to the existing certificates route, and the post-publish
screen deep-links to it. **Zero certificate-module changes. Guaranteed non-regression.**

**F-2 — Three sports placeholders are permanently hardcoded empty.** Both issue paths pass:

```ts
bibNumber: reg.bibNumber ?? '',
distance:  '',        // ← app/api/.../certificates/issue/route.ts:145
finishTime:'',        // ← :146          and lib/certificates/jobs.ts:176-178
position:  '',        // ← :147
category:  reg.bibCategory ?? '',
```

So a marathon certificate using `{{finishTime}}` renders a blank today. Race Operations
is the feature that produces those three values.

→ **D3.** The minimal honest fix, deferred to Sprint 6 behind your approval: one
read-only reader in the Race Ops module, called at those two sites, with `''` as the
fallback. ~6 lines across 2 existing files, additive, no signature change, and
byte-identical output when no results exist. **I will not touch these files without your
explicit go-ahead.** If you decline, Sprint 6 is dropped and the module still delivers
import → validate → rank → publish → history; certificates simply keep rendering blanks
as they do now.

---

## 5. Extension Points — the complete list of files outside the module

Exactly **five** shared files are touched, and every touch is an append.

| # | File | Change | Risk |
|---|---|---|---|
| E1 | `config/navigation.ts` | append 4 `ROUTES` constants | none (additive const) |
| E2 | `config/workspaceNav.ts` | append 1 `WorkspaceNavGroup` to the existing `Operations` section + import the `Flag` icon | none (data-only; sidebar reads it) |
| E3 | `app/(dashboard)/layout.tsx` | add `'race-operations'` to `NON_INDEX_SEGMENTS` (line 60) — **only if** we ship no index page | 1 line, breadcrumb-only |
| E4 | `firestore.rules` | append explicit-deny `match` blocks for new collections + subcollections | additive; strictly tightens |
| E5 | `firestore.indexes.json` | append composite indexes for new collections | additive |
| **E6** | `app/api/organizer/events/[eventId]/certificates/issue/route.ts` **+** `lib/certificates/jobs.ts` | **D3 only, Sprint 6, on approval** — populate 3 placeholder values | 2 files, ~6 lines, `''` fallback |

Nothing else. No existing route, page, component, lib module, type, collection, index, or
rule is modified. `lib/team/types.ts` is **not** edited (we use `requireAdmin`).
No feature flag is added to `FeatureFlagsConfig` (Print Assets and Asset Library are
precedent for an unflagged nav group).

---

## 6. Folder Structure

`features/race-operations/` at repo root (**D1**). Your requested tree, unchanged in
shape:

```
features/race-operations/
├── index.ts                     public surface of the module (routes import only from here)
│
├── publish-results/             feature slice — upload → validate → preview → import → rank → publish
│   ├── components/
│   ├── hooks/
│   └── index.ts
├── photos/                      Sprint 7 — placeholder only
│   └── index.ts
├── history/                     Sprint 8 — page shell + read-only timeline
│   └── index.ts
│
├── components/                  module-shared UI (composed FROM components/ui + components/admin)
├── services/                    orchestration: use-cases, transaction boundaries
├── repositories/                the ONLY place adminDb is touched (server-only)
├── validators/                  pure row/file/schema validation — no SDK, unit-testable
├── ranking/                     pure ranking engine — no SDK, no I/O, unit-testable
├── import/                      parse (xlsx/csv) + column mapping + job strategy
├── hooks/                       client hooks (module-shared)
├── types/                       domain types — SDK-free, client+server safe
└── utils/                       time parsing/formatting, sorting comparators
```

Discipline, enforced by review:

- `types/`, `validators/`, `ranking/`, `utils/` are **pure** — no `firebase-admin`, no
  `next/*`. This is what makes the ranking engine unit-testable in `tests/unit/`.
- `repositories/` are the **only** files importing `adminDb`, each headed `// Server-only`.
- Route handlers under `app/api/organizer/race-operations/**` are thin: authorize →
  parse → call a service → respond. No business logic in routes.
- The module imports **from** the design system and shared libs; nothing shared imports
  **from** the module (sole exception: E6, if approved).

---

## 7. Routes

### 7.1 Pages (`app/(dashboard)/dashboard/race-operations/`)

| Path | Purpose |
|---|---|
| `/dashboard/race-operations` | **Module hub.** Event picker (`GET /api/organizer/events`), per-event results status. Mirrors `/dashboard/check-in`. |
| `/dashboard/race-operations/publish-results` | Event selection → the publish wizard entry |
| `/dashboard/race-operations/publish-results/[eventId]` | The flow: Distance (pass) → Upload → Validate → Preview → Import → Rank → Publish |
| `/dashboard/race-operations/photos` | Placeholder ("Coming soon", R2) |
| `/dashboard/race-operations/history` | Sprint 8 — import history / publish log / rollback info |

> **Why a hub page exists:** the collapsed sidebar links to `group.href` directly
> (`Sidebar.tsx:394`). A group whose `href` has no page 404s in collapsed mode. Shipping
> `/dashboard/race-operations` as a real hub is the correct fix and makes **E3
> unnecessary** — the breadcrumb becomes a live link. **Recommended.**

Certificates is **not** a new page — the sidebar child points at the existing
`/dashboard/communications/certificates`.

### 7.2 API (`app/api/organizer/race-operations/`)

All guarded by `requireAdmin` after `verifyCaller` (owner or admin only).

| Method + path | Purpose |
|---|---|
| `GET  /events/[eventId]/context` | Event + passes ("distances") + counts. Resolves eventId→slug, proves ownership. |
| `GET  /events/[eventId]/template` | Download the results upload template (per selected pass) |
| `POST /events/[eventId]/validate` | **Read-only.** Parse+validate rows against registrations. Writes nothing. |
| `POST /events/[eventId]/import` | Create an import job (kernel) + rows subcollection |
| `POST /events/[eventId]/import/[jobId]/process` | Advance one leased chunk (drive-loop) |
| `GET  /events/[eventId]/import/[jobId]` | Job status + counts |
| `POST /events/[eventId]/import/[jobId]/cancel` | Cancel |
| `GET  /events/[eventId]/import/[jobId]/failed-rows` | Rejected-row export (`csvCell`) |
| `POST /events/[eventId]/rank` | Run the ranking engine over imported results |
| `GET  /events/[eventId]/results` | Paginated results (filter by pass/category) |
| `POST /events/[eventId]/publish` | Draft → published (transactional, audited) |
| `POST /events/[eventId]/unpublish` | Rollback (audited) |
| `GET  /events/[eventId]/history` | Import + publish timeline |

Mirrors the registration-import route family 1:1, which is the proven shape.

---

## 8. Data Model (new collections only)

All server-only, all explicitly denied in `firestore.rules`, all carrying **both**
`eventId` and `eventSlug`.

| Collection | Doc id | Purpose |
|---|---|---|
| `raceResultSets/{setId}` | `{eventId}__{passId}` | One per event × distance(pass). Holds `status: draft|ranked|published`, `passId`, `passName`, `categoryLabel`, counts, `rankedAt`, `publishedAt/By`, `version`. **The publish state authority.** |
| `raceResultSets/{setId}/entries/{entryId}` | `registrationId` when matched, else row hash | One participant result: `bibNumber`, `participantName`, `registrationId`, raw + normalized `finishTime` (ms), `overallRank`, `passRank`, `categoryRank`, `genderRank?`, `status: finished|dnf|dns|dq`, `sourceRow`. |
| `raceResultImportJobs/{jobId}` (+ `rows/`) | auto | `extends Job` from `lib/jobs/types` — the kernel drives it, exactly like `registrationImportJobs`. |
| `raceOperationsHistory/{autoId}` | auto | Immutable audit: `imported | ranked | published | unpublished | rollback`, actor, counts, `setId`. Modeled on `identifierHistory`. |

New composite indexes (append to `firestore.indexes.json`):
`raceResultSets(eventId, status)`, `raceResultSets(organizerUid, publishedAt desc)`,
`entries(setId, overallRank)`, `entries(setId, passId, passRank)`,
`raceOperationsHistory(eventId, createdAt desc)`.

**Zero writes to `registrations`, `events`, `eventDrafts`, `identifierLocks`,
`registrationCounters`, or any certificate collection.** Race Ops reads them; it never
writes them.

---

## 9. Sidebar Integration Plan

Append **one group** to the existing `Operations` section of `WORKSPACE_NAV`
(`config/workspaceNav.ts:143-169`), placed after `checkin`:

```ts
{
  key: 'race-operations',
  label: 'Race Operations',
  icon: Flag,                                   // lucide-react, add to the existing import
  href: '/dashboard/race-operations',           // real hub page — safe in collapsed mode
  children: [
    { label: 'Publish Results', href: '/dashboard/race-operations/publish-results' },
    { label: 'Photos',          href: '/dashboard/race-operations/photos'          },
    { label: 'Certificates',    href: '/dashboard/communications/certificates'     }, // EXISTING
    { label: 'History',         href: '/dashboard/race-operations/history'         },
  ],
},
```

Notes:
- **🏁 as a lucide icon:** the codebase uses lucide `LucideIcon` exclusively — the type is
  `icon: LucideIcon`, so a literal emoji is not assignable. `Flag` is the semantic match.
  (A checkered-flag glyph would require an emoji-in-label hack that breaks the pattern.)
- **Certificates child needs no special handling** — `navHrefEnabled` already returns
  `flags.certificates` for any href containing `/certificates` (`Sidebar.tsx:62`), so the
  child auto-hides when the platform flag is off. Correct behaviour, free.
- **Active state:** `isGroupActive` uses `startsWith('/dashboard/race-operations')`.
  The Certificates child lives outside that prefix, so it highlights under the
  Certificates group instead — that is the pre-existing, correct behaviour for a
  cross-link and is how `Reports → Finance Reports` already behaves.
- `ROUTES` additions in `config/navigation.ts`: `RACE_OPS`, `RACE_OPS_PUBLISH_RESULTS`,
  `RACE_OPS_PHOTOS`, `RACE_OPS_HISTORY`. The nav entry references them (no literals).
- Placement rationale: "Operations" already contains Check-in, Print Assets, Asset
  Library — on-the-ground event execution. Race Operations belongs there, not in a new
  top-level section.

---

## 10. File Creation Plan

**New files: 47. Modified existing files: 5** (`config/navigation.ts`,
`config/workspaceNav.ts`, `firestore.rules`, `firestore.indexes.json`, and — Sprint 6,
approval-gated — the 2 certificate issue sites; `app/(dashboard)/layout.tsx` drops out if
we ship the hub page, which is the recommendation).

<details open>
<summary><b>Pages (6)</b></summary>

```
app/(dashboard)/dashboard/race-operations/page.tsx                            hub
app/(dashboard)/dashboard/race-operations/RaceOpsHubClient.tsx
app/(dashboard)/dashboard/race-operations/publish-results/page.tsx
app/(dashboard)/dashboard/race-operations/publish-results/[eventId]/page.tsx
app/(dashboard)/dashboard/race-operations/photos/page.tsx                     placeholder
app/(dashboard)/dashboard/race-operations/history/page.tsx
```
</details>

<details open>
<summary><b>API routes (13)</b> — under <code>app/api/organizer/race-operations/events/[eventId]/</code></summary>

```
context/route.ts   template/route.ts   validate/route.ts
import/route.ts    import/[jobId]/route.ts   import/[jobId]/process/route.ts
import/[jobId]/cancel/route.ts   import/[jobId]/failed-rows/route.ts
rank/route.ts   results/route.ts   publish/route.ts   unpublish/route.ts
history/route.ts
```
</details>

<details open>
<summary><b>Module: <code>features/race-operations/</code> (28)</b></summary>

```
index.ts

types/index.ts                    ResultSet, ResultEntry, ResultStatus, RankScope, HistoryAction
types/api.ts                      request/response contracts

utils/time.ts                     hh:mm:ss[.ms] parse ⇄ format, ms normalization
utils/sort.ts                     stable comparators (time asc, DNF/DNS/DQ last)
utils/columns.ts                  header aliasing / column detection

validators/fileSchema.ts          headers, sheet, row/byte caps
validators/rowValidation.ts       per-row rules → READY | WARNING | DUPLICATE | ERROR
validators/matchRegistration.ts   bib / ticketCode / email match strategy + ambiguity
validators/index.ts

ranking/engine.ts                 PURE: entries → overall/pass/category/gender ranks
ranking/ties.ts                   tie policy (shared rank, next-rank skip)
ranking/scopes.ts                 rank-scope resolution
ranking/index.ts

import/parseWorkbook.ts           read-excel-file + CSV, hardened error messages
import/template.ts                template generation (per selected pass)
import/jobStrategy.ts             JobStrategy for lib/jobs/runner
import/index.ts

repositories/resultSetRepo.ts     server-only
repositories/entryRepo.ts         server-only
repositories/historyRepo.ts       server-only
repositories/eventReadRepo.ts     server-only — eventId→slug + ownership + passes
repositories/registrationReadRepo.ts  server-only — READ-ONLY registration lookup

services/validateResults.ts       read-only validate use-case
services/importResults.ts         job creation + chunk execution
services/rankResults.ts           ranking orchestration
services/publishResults.ts        transactional publish / unpublish + audit
services/certificateResults.ts    reader consumed by E6 (Sprint 6, D3)

components/ResultsFileDropzone.tsx    the module's ONE upload control
components/ResultsPreviewTable.tsx    composed from components/admin/DataTable
components/ValidationSummary.tsx
components/DistanceSelector.tsx       = pass picker (D2)
components/PublishConfirmDialog.tsx    uses ui/Dialog + useConfirm
components/ResultsEmptyState.tsx       uses ui/EmptyState

hooks/useResultsImport.ts         wraps lib/hooks/useJobProgress
hooks/useRaceOpsContext.ts

publish-results/index.ts   photos/index.ts   history/index.ts
```
</details>

<details open>
<summary><b>Tests (6)</b> — <code>tests/unit/</code>, matching the existing convention</summary>

```
raceOpsTimeParse.test.ts       raceOpsRanking.test.ts      raceOpsTies.test.ts
raceOpsRowValidation.test.ts   raceOpsMatching.test.ts     raceOpsColumns.test.ts
```
</details>

---

## 11. Risk Assessment

| ID | Risk | Sev | Mitigation |
|---|---|---|---|
| **R1** | `src/` vs root convention split → broken imports, two competing layouts | **High** | **D1** — resolve before any file is created. Recommendation: `features/` at root. |
| **R2** | "Distance" invented as a new field → schema drift + a second truth vs passes | **High** | **D2** — Distance = Pass, read-only from `pricing.passes[]`. |
| **R3** | Ranking silently wrong for gender/age because `formResponses` is optional & unindexed | **High** | **D4** — v1 ranks Overall + Pass only. Gender/age from the uploaded file's columns, and the UI states the scope explicitly. Never infer. |
| **R4** | Certificate module regression from E6 | **High** | Approval-gated (**D3**), 2 files, `''` fallback → byte-identical with no results. Sprint 6 lands alone with a dedicated verification pass. |
| **R5** | Bib collision: Race Ops mutating identifiers | **High** | Repositories for `registrations`/`identifierLocks` are **read-only by construction** — no write method exists to call. Enforced at code-review. |
| **R6** | Publish partially applied → half-published results | Med | Publish flips `raceResultSets.status` in a **transaction** + writes `raceOperationsHistory`; entries are written before publish, never during. Unpublish is the inverse. |
| **R7** | Import double-runs → duplicate entries | Med | Reuse the proven pattern: content-derived row `fingerprint` as idempotency key (`lib/registrations/importJob.ts:66-71`) + `entries/{registrationId}` doc-id determinism. Never row number. |
| **R8** | Large file blows the request/memory budget | Med | Row + byte caps mirroring `IMPORT_MAX_ROWS`/`IMPORT_MAX_FILE_BYTES`; execution via the job kernel in leased chunks with an explicit budget, not one request. |
| **R9** | Unmatched rows (bad bib, unregistered runner) silently dropped | Med | Every row lands in a validation bucket; rejected rows are downloadable (`csvCell`); counts are surfaced. Never a silent drop. |
| **R10** | 404 in collapsed sidebar (group.href has no page) | Med | Ship the hub page at `/dashboard/race-operations`. |
| **R11** | Client-SDK read of a new collection | Med | Explicit `allow read, write: if false;` per collection **and** per subcollection (rules don't cascade). |
| **R12** | Firestore composite-index error at first query in prod | Med | Indexes appended + deployed in the **same** sprint as the query. |
| **R13** | Missed Next 16 API change (params Promise, route contract) | Low | Read `node_modules/next/dist/docs/` per `AGENTS.md` before Sprint 1 code; mirror the signature in existing routes. |
| **R14** | Duplicating the design system | Low | Reuse `components/ui` + `components/admin` barrels; the module's `components/` only *composes*. |
| **R15** | Reusing `components/admin` from an organizer page reads as a layering smell | Low | **D5** — reuse with a one-line justification comment at the import site. Duplication is the worse outcome. |
| **R16** | Emoji sidebar icon breaks the `LucideIcon` type contract | Low | Use lucide `Flag`. |
| **R17** | Public results page expected but not specified | Low | Out of scope for Phase 0. Results are organizer-only until you ask for a public surface. Flagged, not built. |

---

## 12. Sprint Plan

Every sprint ends on: `npx tsc --noEmit` **0** · `npm test` **all pass** ·
`npm run build` **0** · `npm run lint` **no new findings vs the 93/111 baseline** (see the
baseline table at the top — the absolute-zero lint target is not reachable without a
separate repo-wide cleanup sprint).

| Sprint | Deliverable | Files | Ships behind |
|---|---|---|---|
| **0** | *This audit.* | 1 doc | — |
| **1** | **Skeleton + wiring.** `features/race-operations/` tree, `types/`, `index.ts` barrels, 4 `ROUTES`, 1 `WORKSPACE_NAV` group, hub page + 3 real pages (empty states only), `GET .../context` route with `requireAdmin`. Firestore rules + indexes appended. **Navigable end to end, zero business logic.** | ~16 new, 4 mod | nothing to hide — pages are honest empty states |
| **2** | **Pure engines + tests.** `utils/time`, `utils/columns`, `utils/sort`, `validators/*`, `ranking/*`. 6 unit-test files. **No I/O, no UI** — the highest-risk logic proven in isolation first. | ~13 new, 6 tests | — |
| **3** | **Upload + validate (read-only).** `ResultsFileDropzone`, `parseWorkbook`, template download, `POST .../validate`, `ValidationSummary`, `ResultsPreviewTable`, `DistanceSelector`. **Writes nothing to Firestore.** | ~10 new | — |
| **4** | **Import execution.** `raceResultImportJobs` via the job kernel, `jobStrategy`, rows subcollection, drive-loop + `useJobProgress`, failed-rows export, cancel. | ~8 new | — |
| **5** | **Ranking + publish.** `POST .../rank`, `POST .../publish`/`unpublish` (transactional + audited), results list route + UI, gender/age scopes from file columns (**D4**). Post-publish deep-link to the existing certificates page. | ~8 new | — |
| **6** | **Certificate placeholder wiring — D3, approval-gated.** `services/certificateResults.ts` + the 2-file, ~6-line change so `{{distance}}/{{finishTime}}/{{position}}` finally render. Dedicated regression pass on both issue paths. | 1 new, 2 mod | drop entirely if D3 is declined |
| **7** | **Photos placeholder hardening.** Honest "coming soon" surface documenting the R2 plan. No R2 SDK, no env vars, no upload. | 1 mod | — |
| **8** | **History.** Read-only timeline over `raceOperationsHistory` (imports, ranks, publishes, rollbacks) + rollback affordance wired to Sprint 5's `unpublish`. | ~3 new | — |

Sprint 1 is deliberately a walking skeleton: it proves the extension points work
against real Next 16 + the real sidebar before any logic is written, so if any of
D1–D5 turns out wrong, the cost of correction is near zero.

---

## 13. Approval checklist

- [ ] **D1** — `features/race-operations/` at repo root (not `src/`)
- [ ] **D2** — Distance = Pass; no new distance field
- [ ] **D3** — Sprint 6 certificate placeholder wiring: **approve / decline**
- [ ] **D4** — Ranking v1 = Overall + Pass; gender/age from file columns only
- [ ] **D5** — Race Ops may import `components/admin/*` presentation primitives
- [ ] Permissions via `requireAdmin` (owner + admin), **no** matrix change
- [ ] Ship the hub page at `/dashboard/race-operations` (avoids the collapsed-sidebar 404)
- [ ] Sidebar icon = lucide `Flag`; group lives in the existing **Operations** section
- [ ] The 5 shared-file appends in §5 are acceptable
- [ ] Lint gate = "no new findings vs the 93 error / 111 warning baseline" (not absolute zero)
- [ ] Sprint sequencing approved

---

## 14. Sprint 1 delivery record

**Objective:** the Race Operations foundation only — navigable, isolated, no result
processing, no changes to existing business logic.

### 14.1 Deviations from the Phase 0 sprint plan (all reductions)

The Sprint 1 brief tightened the constraints to *"No API changes · No Firestore
schema changes · No business logic."* Three items the Phase 0 plan had placed in
Sprint 1 were therefore **dropped**, each shrinking the blast radius:

| Phase 0 planned for Sprint 1 | Actual | Why |
|---|---|---|
| `GET /api/organizer/race-operations/events/[eventId]/context` | **not created** | The existing `GET /api/organizer/events` already returns `passes: EventPassSummary[]` per event, and is already workspace-scoped server-side. A new route would have duplicated it. |
| `firestore.rules` explicit denies | **not touched** | Sprint 1 writes nothing and owns no collection. Denies land in the sprint that first creates a collection (Sprint 4). |
| `firestore.indexes.json` composite indexes | **not touched** | Same — no query exists to index yet. |
| `app/(dashboard)/layout.tsx` → `NON_INDEX_SEGMENTS` | **not needed** | Shipping the real hub page at `/dashboard/race-operations` makes the breadcrumb a live link, as §7 anticipated. |

Net effect: **shared files modified dropped from 5 to 2.**

### 14.2 Verification

| Gate | Baseline (pre-Sprint) | After Sprint 1 |
|---|---|---|
| `npx tsc --noEmit` | 0 | **0** (re-run with `tsconfig.tsbuildinfo` deleted, so not a cached pass) |
| `npm test` | 60 files / 436 tests | **62 files / 460 tests, all passing** (+2 suites, +24 cases) |
| `npm run lint` | 204 problems (93 err / 111 warn) | **204 problems (93 err / 111 warn)** — identical; **0 findings in any Race Operations file** |
| `npm run build` | — | **exit 0**; all 4 routes prerendered static (`○`) |

Lint on the new + modified files in isolation (`npx eslint features
"app/(dashboard)/dashboard/race-operations" config tests/unit/raceOps*.test.ts`)
returns **exit 0 with no output**.

> **Note on the build gate.** The first `next build` failed on
> `components/event-templates/shared/media/GalleryShowcase.tsx:211`
> (`Cannot find name 'slotFor'`). This is **not** Race Operations code. The working
> tree contains a large pre-existing uncommitted `event-templates` refactor (63
> modified/deleted files at `git status`), and that file was mid-edit when the build
> worker read it — the reported line no longer matches the file's current content. A
> clean re-run passes. Race Operations touches none of those files. Worth knowing:
> `tsconfig.tsbuildinfo` caching can make `tsc --noEmit` report 0 while `next build`
> still type-errors, so the tsc figure above was taken after deleting it.

### 14.3 Certificates

Untouched, as required. Race Operations reaches the existing module purely by
`href` (`ROUTES.DASHBOARD_CERTIFICATES` → `/dashboard/communications/certificates`)
from two places: the sidebar child and the post-selection card in the flow. No
certificate file is imported, wrapped, or read. **Decision D3 (populating the empty
`{{distance}}` / `{{finishTime}}` / `{{position}}` placeholders) remains unapproved
and unimplemented.**

### 14.4 Still open

- **D3** — certificate placeholder wiring: approve or decline (Sprint 6).
- Sprint 2 (pure engines) awaits approval.
- Sprint 1 was verified by build, type-check and unit tests. It has **not** been
  visually QA'd in a browser, and the access gate has not been exercised against a
  real `manager` / `checkin_staff` / `finance` team member — only unit-tested.
