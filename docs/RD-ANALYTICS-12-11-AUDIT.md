# RD-ANALYTICS-12-11 — Reports History Audit

**Type:** AUDIT ONLY. No application source, test, Firestore rule, Firestore index, package
file, route, navigation or UI was modified. Nothing committed, pushed or deployed. The only
file created is this one.

---

## A · Executive summary

**History needs no new collection, no new DTO, and no new permission — but it does need three
things that do not exist: a paged read endpoint, one composite index, and a truthful answer for
rows whose artifact is gone.**

`reportExportJobs` already stores everything a History list needs, and `toExportJobView()`
already projects it safely — omitting the storage path and every internal field. The download
route already re-authorizes and mints a fresh short-lived signed URL per request (12-04), which
is exactly the behaviour a History download action requires. So History is largely an exercise
in *reading* what is already written.

**The defining constraint is a lifecycle mismatch:** job documents are **never deleted**, while
their artifacts are reclaimed after **7 days** and the application declares the download expired
after **24 hours**. A History list will therefore be dominated by rows whose file no longer
exists. That is not a defect to fix in 12-11 — it is a state the UI must express honestly.

**No P0. No P1.**

### One correction to the brief's premise

The brief states that the Reports page already has *"permission-filtered report visibility"*
from RD-ANALYTICS-12-10. **It does not. RD-ANALYTICS-12-10 was never implemented.**
`app/(dashboard)/dashboard/finance/reports/page.tsx` contains no `useWorkspacePermissions`, no
`.filter(...)`, and no permission logic; it renders all eight catalogue entries and surfaces a
403 only after the user clicks. Catalogue-driven *discovery* is real and came from 12-08.

This matters here: History cannot inherit a filter that does not exist, so §F/§G below specify
the filtering History must do for itself.

## B · Repository snapshot

- **HEAD:** `b7e5fdf feat(finance): add finance control center and analytics`
- **Branch:** `master`, level with `origin/master`, **nothing staged**
- **Working tree:** 588 uncommitted entries — long-lived, pre-existing
- **Concurrent work:** none touching Reports during this audit. The most recent Reports writes
  are my own 12-08 changes (18:43–18:52). Another session has been active in
  `components/marketing/**` and `content/marketing/**`; untouched here.
- **Docs present:** 12-02, 12-03, 12-04 ×2, 12-07, 12-08. **Absent:** 12-01 implementation
  (a known outstanding closure item), and 12-05/12-06/12-09, which were terminal-only audits by
  instruction.

## C · Export-job architecture

```
POST /api/organizer/reports/exports          authorizeWorkspace(req, meta.permission)
  → createReportExportJob({ kind, format, filenameBase, heading, filters,
                            organizerUid, createdBy })
  → kernelCreateJob(REPORT_EXPORT_JOBS='reportExportJobs', 'rex_'+randomUUID)
  → first chunk inline, then /api/cron/report-exports (CRON_SECRET, fail-closed)
      processItem: meta.build → serializeTables → uploadServerFile
                 → output { path, filename, contentType, rowCount, truncated, expiresAt }
      → notifyExportReady (workspace inbox; link is the page, no id, no URL)

GET  .../exports/[jobId]          poll     authorizeAnyWorkspace + ownership + permission
POST .../exports/[jobId]/process  drive    same
POST .../exports/[jobId]/cancel   cancel   same
GET  .../exports/[jobId]/download          same + status/expiry → signedReadUrl → 302
```

The job rides `lib/jobs/kernel` — the generic runner shared with broadcasts, certificates,
identifiers and AI. Nothing about it is report-specific except the payload.

## D · `reportExportJobs` exact schema

`ReportExportJob extends Job`. Every field below was read from source; none is invented.

| Field | Type | Writer | Purpose | Safe for History UI |
|---|---|---|---|---|
| `jobId` | `string` (`rex_<uuidv4>`) | `createReportExportJob` | identity | ✅ already exposed |
| `organizerUid` | `string` | creation (server-resolved) | **workspace ownership** | ❌ never render |
| `createdBy` | `string` | creation (`authz.callerUid`) | requester | ⚠️ as a resolved name, not a uid |
| `status` | `'pending'\|'processing'\|'completed'\|'failed'\|'cancelled'` | kernel | state | ✅ |
| `counts` | `{total, processed, succeeded, failed, skipped}` | kernel | progress | ✅ |
| `cursor` | `string \| null` | kernel | resume checkpoint | ❌ internal |
| `error` | `string \| null` | kernel (`err.message`) | failure reason | ⚠️ see §W-P3 |
| `lockedUntil` | Timestamp \| null | kernel | lease | ❌ internal |
| `createdAt` | Timestamp | kernel | ordering key | ✅ |
| `startedAt` | Timestamp \| null | kernel | — | optional |
| `updatedAt` | Timestamp | kernel | — | optional |
| `completedAt` | Timestamp \| null | kernel | finish time | ✅ **stored, not yet projected** |
| `kind` | `string` | creation | → catalogue metadata | ✅ (resolve to label) |
| `format` | `'csv'\|'xlsx'\|'pdf'` | creation | file type | ✅ |
| `filenameBase` | `string` | creation | naming | ❌ internal |
| `heading` | `string` | creation | PDF heading | ❌ internal |
| `filters` | `ReportFilters` | creation | from/to/event/campaign/status | ✅ date range useful |
| `output.path` | `string` | on completion | **storage path** | ❌ **never expose** |
| `output.filename` | `string` | on completion | display + download name | ✅ |
| `output.contentType` | `string` | on completion | signing | ❌ internal |
| `output.rowCount` | `number` | on completion | size | ✅ |
| `output.truncated` | `boolean` | on completion | completeness | ✅ **important** |
| `output.expiresAt` | Timestamp | on completion | app-layer expiry | ✅ |

**There is no `output.url`.** RD-ANALYTICS-12-04 removed it; the field is gone from the type and
no longer written. **There is no `eventId`** — reports are workspace-scoped, consistently.
`dedupeId` is **not** on the job; it exists only on the notification document
(`export-<jobId>`), and `firestore.rules:434-436` restricts that subtree to the owner's own uid.

## E · Lifecycle / state machine

```
pending ──► processing ──► completed        (output written, expiresAt = +24h)
   │            │
   │            └────────► failed           (error set, no output)
   └──► cancelled ◄────────┘
```

`cancelJob` (`lib/jobs/kernel.ts:196-210`) is transactional and **refuses to cancel a job that
is already `completed` or `cancelled`** — it returns the existing status unchanged. So a
cancelled job is one that never finished, and in practice carries **no `output`**. The download
route's `status === 'cancelled' → 410` check is therefore belt-and-braces rather than the
primary guard; it is correct and should stay.

**`expired` is not a status.** Expiry is derived at read time from `output.expiresAt`. History
must derive it the same way rather than inventing a stored state.

## F · Authorization and tenancy

Every path resolves the workspace **server-side** and never trusts the client:

| Path | Gate |
|---|---|
| create | `authorizeWorkspace(req, meta.permission)` |
| poll / process / cancel | `authorizeAnyWorkspace` + `job.organizerUid === authz.workspaceUid` + `permissionForExportJob` |
| download | same, plus status/expiry, then a fresh signed URL |

- Workspace comes from `resolveWorkspaceUid(caller.uid)`; `organizerUid` is never read from the
  request.
- **Gate-only roles** (`checkin_staff`, `checkin_lead`) are refused by `authorizeAnyWorkspace`
  before the job is read.
- **Revoked/suspended** members drop out of `activeMemberships`, resolve to their own uid, and
  fail the ownership comparison.
- **Cross-workspace and cross-owner access are impossible** — asserted by 40 tests in
  `reportExportAuthorization.test.ts`.
- `jobId` is `crypto.randomUUID()` — not enumerable — and since 12-03 a job id alone is **not**
  sufficient: the report's permission is re-checked.
- **Client SDK access to `reportExportJobs` is denied.** The collection has no match block in
  `firestore.rules`, and Firestore denies by default; there is no permissive catch-all. All
  reads go through the Admin SDK behind these routes.

**The existing model is sufficient. History needs no new authorization concept** — it needs the
*same* checks applied per row.

## G · Permission matrix

| Role | Permissions | Create | Poll | Download | **Should see in History** |
|---|---|---|---|---|---|
| owner | all | ✅ | ✅ | ✅ | ✅ all rows |
| finance | wallet, settlements, transactions | ✅ | ✅ | ✅ | ✅ all rows (covers every current report) |
| admin | events, registrations, broadcasts, certificates, checkin, walkin, participants | ❌ | ❌ | ❌ | **none today** |
| manager | events, registrations, checkin, walkin, participants | ❌ | ❌ | ❌ | **none today** |
| checkin_lead | checkin, walkin | ❌ 403 | ❌ 403 | ❌ 403 | ❌ — refused before any read |
| checkin_staff | checkin | ❌ 403 | ❌ 403 | ❌ 403 | ❌ |
| suspended / removed | — | ❌ | ❌ | ❌ | ❌ |

Because every registered report is financial, only `owner` and `finance` can see anything at
all. `admin` and `manager` would get an **empty** History, not an error — which is correct, and
worth stating in the UI as "no reports you can access" rather than a bare empty state.

**Recommendation: (B) — workspace-wide, filtered per row by
`permissionForExportJob(job) ∈ authz.permissions`.** It reuses the exact predicate the other
four routes use, so History cannot drift from them. Option (A) would show rows a caller cannot
download; a catalogue-visibility filter would silently hide retired kinds.

## H · Creator vs workspace visibility

**Workspace-wide, permission-filtered — not creator-specific.**

Evidence: the job stores `organizerUid` as the tenancy key and `createdBy` only as attribution;
every existing route authorizes on `organizerUid`, never on `createdBy`; and
`notifyExportReady` writes to the **workspace** inbox, so the product already treats a finished
export as a workspace event rather than a personal one.

Filtering by creator would also defeat the main purpose of History: recovering an export
started by a colleague, or by yourself in another session.

`createdBy` should still be *displayed* (resolved to a name), because on a shared finance
workspace "who ran this" is the second question after "what is it".

## I · Retention

| Thing | Retention | Source |
|---|---|---|
| Job documents | **none — never deleted** | no delete path exists anywhere |
| Storage artifacts | **7 days** | `RETENTION_MS`, `app/api/cron/storage-cleanup/route.ts:26` |
| App-layer download expiry | **24 hours** | `EXPIRY_MS`, `lib/reports/exportJob.ts:39` |
| Signed URL | ≤ 300 s, and ≤ remaining expiry | 12-04 |

Cleanup is bounded at `MAX_PER_PREFIX = 500` per tick, single unpaginated page. `eventDeletion`
does not touch `reportExportJobs` — correctly, since reports are workspace-scoped.

**No job retention policy exists. That is a statement of fact, not a recommendation to add one
in 12-11.**

## J · Artifact vs History lifecycle — independent, and that is the point

They already diverge, by three different clocks:

```
job document   ├─────────────────────────────────────────────►  forever
artifact       ├──────────── 7 days ────────────┤
downloadable   ├── 24 h ──┤
```

So the architecture **already supports** "row remains, download unavailable" — the row is a
Firestore document with no dependency on the object. History must render three distinct
download states:

1. **available** — completed, `expiresAt` in the future
2. **expired** — completed, `expiresAt` passed (the API answers 410); regenerate to get it back
3. **never produced** — failed or cancelled

**A History implementation must not store signed URLs, must not extend their lifetime, and must
not persist `output.url`** (which no longer exists). Nothing in the recommended design does.

## K · Firestore query and index

Required query:

```ts
adminDb.collection('reportExportJobs')
  .where('organizerUid', '==', authz.workspaceUid)
  .orderBy('createdAt', 'desc')
  .startAfter(cursorSnapshot)      // keyset, never offset
  .limit(PAGE_SIZE)
```

**`reportExportJobs` currently has ZERO indexes** in `firestore.indexes.json` — verified. An
equality on `organizerUid` plus `orderBy` on a *different* field (`createdAt`) requires a
composite index:

```
collectionGroup: reportExportJobs
queryScope:      COLLECTION
fields:          organizerUid: ASCENDING, createdAt: DESCENDING
```

**Not created, not modified, not deployed.** Note the deployment dependency: this index and the
12-07 `settlementRequests` index would both need deploying before their features work in
production. The Firestore emulator does not enforce indexes, so a passing emulator test proves
nothing about production readiness here.

Status/format/kind filters would each need their own composite index — an argument for keeping
the first version to server-side ordering plus client-side refinement of the loaded page.

## L · Scale

Reads are bounded by the page, not the collection, so the query is safe at every size:

| Jobs in workspace | Behaviour |
|---|---|
| 1,000 | one or two pages |
| 10,000 | unchanged — cursor pages |
| 100,000 | unchanged; the *list* becomes unusable long before the query does |
| 1,000,000 | unchanged read cost; job documents accumulate forever (§I) |

Recommended: **page size 25**, keyset cursor, newest-first, no offset, no client-side filtering
of the whole collection. The scale risk is storage growth from never-deleted documents, not read
cost.

## M · Recommended filters

**Must have (v1):** none beyond ordering. Newest-first with "load more" is genuinely sufficient
and needs exactly one index.

**Useful later:** status (`completed` / `failed`), report kind, date range — each needs its own
composite index, so each should be justified by use rather than added speculatively.

**Should not be included:** an event selector. Reports are workspace-scoped and jobs carry no
`eventId`; adding one would imply a scope that does not exist.

## N · Recommended History row

`toExportJobView()` **already is** the safe projection — it deliberately omits `output.path`,
`contentType`, `organizerUid`, `cursor`, `lockedUntil`, `filenameBase` and `heading`. Reuse it
rather than writing a second DTO.

Row: **report label** (from the catalogue via `kind`) · **date range** (`filters.from`–`to`) ·
**format** · **created** (`createdAt`) · **created by** (resolved name) · **status** ·
**rows** (`output.rowCount`, with a truncation marker when `output.truncated`) · **download
state** (§J).

Two small, safe additions to the view: `completedAt` and `createdBy` — both already stored, and
`createdBy` must be resolved to a display name rather than emitting a raw uid.

Never render: storage path, contentType, cursor, lockedUntil, organizerUid, or any URL.

## O · Catalogue integration

`job.kind` is sufficient. History resolves `REPORT_CATALOG[job.kind]` for the label, and must
import from **`lib/reports/catalog`** — never `lib/reports/registry`, which value-imports the
builders and would pull `firebase-admin` into a client bundle (the trap 12-08 documented).

**Retired or unknown kinds must degrade gracefully.** Job documents are never deleted, so a
report removed from the catalogue leaves permanent rows whose `kind` resolves to nothing. The
row should render the raw `kind` as its label and **disable download** — because
`permissionForExportJob` returns `null` for an unregistered kind and the download route already
refuses it with 404. History must not crash on, or silently hide, its own history.

## P · payout-statement

It is in the catalogue, deliberately outside `ORGANIZER_REPORTS` dispatch, and **cannot produce
export jobs at all**: `exports/route.ts` validates `ORGANIZER_REPORTS[kind]` and rejects it with
400.

**Therefore no `payout-statement` row can exist in `reportExportJobs`** — not by exclusion, but
because the async path is closed to it. History needs no special case today. If a future phase
gives it async export, it becomes an ordinary row whose label comes from the same catalogue.

Its route, builder, PDF rendering and dispatch model are untouched by anything recommended here.

## Q · Status handling

| Status | Show in History | Download |
|---|---|---|
| `pending` / `processing` | Yes — reconciles with the active panel (§R) | no |
| `completed`, unexpired | Yes | **yes** — fresh signed URL |
| `completed`, expired | **Yes** — the row is the record | no; offer regenerate |
| `failed` | **Yes** — a failed export is information | no |
| `cancelled` | **Yes** | no |

Nothing should be hidden. A History that omitted failures would be a list of successes, which is
not a history.

## R · Download behaviour

Already correct, and unchanged: History row → authenticated request to the **existing**
`GET .../exports/[jobId]/download` → `authorizeAnyWorkspace` → ownership → `permissionForExportJob`
→ status → expiry → `signedReadUrl(path, ttl ≤ min(300s, remaining))` → 302 + `Cache-Control:
no-store`.

This is exactly the flow RD-ANALYTICS-12-04 built. **History needs no download code of its
own** — it reuses the route, and the UI reuses the fetch-with-header + blob pattern already in
the page. No signed URL is stored, reused or extended.

## S · Active export panel relationship

They should share one source and split by state: `pending`/`processing` belong to the active
panel; terminal states belong to History. Both read `reportExportJobs`; only the panel drives
`process`.

The honest simplification: once History exists, the active panel is *the same row* with polling
attached. 12-11 should not attempt that merge — but it should not build a second job model that
would make the merge harder.

## T · Refresh / navigation behaviour — the problem History solves

Traced in `finance/reports/page.tsx`: `exportJob` is `useState` only. There is **no**
persistence, and **no list endpoint** — `REPORT_EXPORT_JOBS` is enumerated only by the cron.

So today:

- **refresh** → the job vanishes from the UI
- **navigate away** → same
- **return later** → no way to find it
- **finishes after you leave** → the cron completes it; the artifact exists; the notification
  says "Export ready" and links to the page — **which cannot show it**

The document survives in Firestore the whole time. **This is the discoverability gap History
closes**, and it is the strongest argument for 12-11.

## U · Orphans and inconsistency

History must tolerate all of these, because all are reachable:

1. **Completed job, artifact reclaimed** — the normal steady state after 7 days. Common, not
   exceptional.
2. **Completed job, expired but artifact alive** — the 24h/7d window; the API refuses, correctly.
3. **Failed/cancelled job with no output** — expected.
4. **Job whose `kind` left the catalogue** — permanent, since documents are never deleted.
5. **Artifact with no job** — not reachable through this path; the path embeds `jobId`.
6. **Partially written output** — not reachable; `output` is written in one `update`.

None is a defect to repair in 12-11. All are display states.

## V · Existing test coverage

**Strong:** `reportExportAuthorization.test.ts` — 40 cases over the real handlers covering
ownership, permission, gate roles, revocation, cross-workspace/owner, expiry, cancellation,
not-ready, TTL bounds, no-persisted-URL, and that signing happens only after authorization.
Also `reportRegistryMetadata.test.ts` (24), `financeReportDefinitions.test.ts`,
`reportHistoricalScope.emu.test.ts` (13), `adminFinanceHistoricalScope.emu.test.ts` (13).

**Absent:** any test of a History reader (none exists), of `toExportJobView`'s field
projection, of job-document retention, or of the Reports page's runtime behaviour.

## W · Required future tests

A workspace isolation · B per-row permission filtering · C gate-role rejection ·
D revoked/suspended rejection · E workspace-wide (not creator-only) visibility ·
F keyset pagination with no duplicates or gaps · G newest-first ordering ·
H no unbounded read (page size respected) · I unknown/retired kind renders and disables
download · J payout-statement produces no rows · K expired artifact still lists, refuses
download · L download mints a **fresh** signed URL · M no signed URL persisted or returned by
the list · N status rendering for all five states · O `toExportJobView` never leaks
`output.path`, `contentType`, `organizerUid`, `cursor` or `lockedUntil`.

## X · Security findings

**P0: none. P1: none.**

**P2-1** No History reader exists, so a completed export is undiscoverable after a refresh
(§T) — the functional gap, not a vulnerability.
**P2-2** `reportExportJobs` has **zero** indexes; the required composite is undeployed, and so is
12-07's settlement index.
**P2-3** Job documents are never deleted while artifacts expire at 7 days — unbounded growth and
a History that will be mostly dead links.
**P2-4** The Reports page still shows all reports regardless of permission (12-10 not
implemented); History must not repeat that pattern.

**P3-1** `error` is stored as the raw `err.message` and projected verbatim by
`toExportJobView`. A Firestore failure message can carry an index-creation URL or internal
detail. Low impact — only workspace members with the report's permission can read it — but
History would make it far more visible than a transient panel does.
**P3-2** `createdBy` is a raw uid and needs resolving to a name before display.
**P3-3** Storage cleanup is a single bounded page (500/tick) and can lag.

## Y · Recommended Reports IA

```
Reports  (/dashboard/finance/reports — canonical, unchanged)
  ├── All Reports   ← existing discovery + execution
  └── History       ← new tab, same page, same job source
```

A tab on the existing page. No new route, no navigation change, no second Reports system.
Everything History needs — catalogue, download route, auth — is already on that page.

## Z · 12-11 implementation boundary

**In scope — narrow, and appropriate as the brief proposed:**

1. `GET /api/organizer/reports/exports` (list) — `authorizeAnyWorkspace`, `organizerUid`
   equality, `orderBy('createdAt','desc')`, keyset cursor, page 25, per-row
   `permissionForExportJob` filter, projected through the existing `toExportJobView` (+
   `completedAt`, `createdBy`).
2. One index **definition** for `(organizerUid ASC, createdAt DESC)` — **not deployed**.
3. A History tab on the existing page: list, statuses, the three download states, retired-kind
   fallback, "load more".
4. Download reuses the existing route unchanged.
5. Focused tests covering §W A-O.

**One judgement call to make deliberately:** extending `toExportJobView` changes a shape the
active-export panel already consumes. Additive fields are safe, but the change should be made
knowingly rather than incidentally.

## AA · Deferred

Scheduled reports · job retention policy · new/operational/participant report types ·
navigation changes · route migration · UTC→IST timezone decision · analytics changes · admin
report redesign · print exports · export-engine changes · merging the active panel into History
· status/kind/date filters and their indexes · error-message sanitisation (P3-1) · deploying
either index.

## AB · Files inspected

`lib/reports/exportJob.ts` · `lib/reports/registry.ts` · `lib/reports/catalog.ts` ·
`lib/reports/types.ts` · `lib/jobs/types.ts` · `lib/jobs/kernel.ts` ·
`app/api/organizer/reports/exports/route.ts` · `.../exports/[jobId]/route.ts` ·
`.../[jobId]/process/route.ts` · `.../[jobId]/cancel/route.ts` · `.../[jobId]/download/route.ts` ·
`app/(dashboard)/dashboard/finance/reports/page.tsx` · `app/api/cron/report-exports/route.ts` ·
`app/api/cron/storage-cleanup/route.ts` · `lib/firebase/storage/admin.ts` ·
`lib/notifications/inbox/notify.ts` · `firestore.rules` · `firestore.indexes.json` ·
`lib/team/workspace.ts` · `tests/unit/reportExportAuthorization.test.ts` ·
`tests/unit/reportRegistryMetadata.test.ts`

## AC · Confirmation

No implementation occurred. No application source, test, Firestore rule, Firestore index,
package file, route, navigation or UI was modified. No index was created or deployed. No
commit, no push, no deployment. The only file created is
`docs/RD-ANALYTICS-12-11-AUDIT.md`.
