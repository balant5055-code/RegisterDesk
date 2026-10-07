# RD-ANALYTICS-12 — Reports Workspace Architecture Audit

**Type:** AUDIT ONLY. No application code, component, API, test, route, rule, index or
dependency was modified. Nothing committed, pushed or deployed. The only file created is this
one.

**Method:** every claim below was traced to source. Filenames were never treated as evidence
of behaviour. Where a comment and the code disagree, the code is reported.

---

## 1 · Executive Summary

RegisterDesk has **two unrelated things both called "reports"**, and the one the sidebar
calls Reports is not the reports system.

The real reports subsystem — `lib/reports/` behind `/dashboard/finance/reports` — is
well-built in its *semantics* and structurally unsound in its *data access*. Its money
definitions are careful and genuinely well tested (fees kept apart from gateway fees, payout
taken from the stored ledger rather than recomputed, tax never added on top of the fee it sits
inside). But every one of its eight builders reads at most the newest 5,000 documents in the
workspace and then applies the **date range and event filter in memory**. Above 5,000 rows a
date-ranged report does not return a truncated answer; it returns a **wrong** one, because the
rows for the requested period were never fetched.

This is the same defect class RD-ANALYTICS-09 removed from the analytics ledger, still present
in the surface that produces GST summaries and payout statements.

The platform already contains the correct pattern. `app/api/organizer/events/[eventId]/registrations/export/route.ts`
does keyset pagination with a streamed, uncapped CSV. The finance reports simply do not use it.

**Severity counts: P0 = 1, P1 = 5, P2 = 4, P3 = 3.**

The single most important architectural conclusion: the target Reports Workspace should not be
a new system. It should be the existing registry, corrected to stream through cursors, with the
UI's hardcoded duplicate list deleted and `payout-statement` brought inside the registry.

---

## 2 · Current Architecture

```
UI        /dashboard/finance/reports  (the real reports workspace)
          /dashboard/reports          (MISLABELLED — an analytics/insights page)
          /admin/finance-reports      (platform-admin view)

API       GET  /api/organizer/reports/[kind]              sync build + optional export
          GET  /api/organizer/reports/payout-statement    outside the registry
          POST /api/organizer/reports/exports             create async export job
          GET  /api/organizer/reports/exports/[jobId]     poll
          POST /api/organizer/reports/exports/[jobId]/process
          POST /api/organizer/reports/exports/[jobId]/cancel
          GET  /api/organizer/reports/exports/[jobId]/download
          GET/POST /api/cron/report-exports               background driver

LIB       lib/reports/registry.ts    kind → {label, permission, build}
          lib/reports/builders.ts    8 builders, ALL via fetchCapped()
          lib/reports/types.ts       ReportTable / ReportFilters / REPORT_ROW_CAP = 5000
          lib/reports/format.ts      money + date rendering, rangeBounds()
          lib/reports/export.ts      serializeTables → csv | xlsx | pdf | json
          lib/reports/csv.ts / xlsx.ts / pdf.ts
          lib/reports/exportJob.ts   async job on the generic runner
          lib/reports/adminBuilders.ts
```

The design intent is sound and stated in the code: one normalized `ReportTable` that every
exporter consumes, so money and date formatting exist in exactly one place
(`lib/reports/types.ts:1-8`). That intent holds. The failure is one layer below it, in how
rows reach the table.

---

## 3 · Route / IA Audit

| Route | What it actually is | Evidence |
|---|---|---|
| `/dashboard/reports` | **An analytics page.** Imports `DashboardData`, `buildPerformanceInsights`, `PRESET_DAYS`, `EventSelector`; renders KPIs, trends and insights. Exports nothing. | `app/(dashboard)/dashboard/reports/page.tsx:13-25` |
| `/dashboard/analytics` | The analytics workspace (Overview / Registrations / Revenue / Operations / Communications) | `app/(dashboard)/dashboard/analytics/` |
| `/dashboard/finance/reports` | **The real reports workspace.** 8 report kinds, preview, export, async jobs, download. | `app/(dashboard)/dashboard/finance/reports/page.tsx:16-25` |
| `/dashboard/reports` (dir) `app/(dashboard)/reports/` | **Orphan.** Contains only `.gitkeep` — no page, no route. | `app/(dashboard)/reports/.gitkeep` |
| `/admin/finance-reports` | Platform-admin reporting, separate builders | `app/(admin)/admin/finance-reports/` |

**The mislabelling is already documented in the codebase itself.** `lib/analytics/routes.ts`
records that `/dashboard/reports` is "despite the path… the strongest analytics
implementation in the product", and names `/dashboard/finance/reports` as
`REPORTS_ROUTE_CANONICAL` — "Already canonical — no migration needed."

**Is Finance Reports actually financial-only?** Yes, currently. All 7 registry kinds plus
`payout-statement` are financial. There is **no operational, participant or communications
report** in this subsystem. Those exist elsewhere as per-event exports (§4).

**Do Analytics and Reports overlap?** Only at `/dashboard/reports`, which is analytics wearing
the Reports name. The finance reports subsystem does not duplicate analytics aggregation — it
reads ledger collections directly and emits rows, not KPIs.

---

## 4 · Complete Report Inventory

### 4a · The finance registry (`ORGANIZER_REPORTS`)

All 7 share: source = a workspace-scoped Firestore collection; generator = `lib/reports/builders.ts`;
API = `GET /api/organizer/reports/[kind]`; UI = `/dashboard/finance/reports`; formats = csv,
xlsx, pdf, json; sync **and** async; scope = **workspace (uid)**, event only as an in-memory
filter; date range = `from`/`to` as UTC days; event-type assumptions = **none**; history +
download = via the export-job system only.

| Kind | Collection | Time field | Permission |
|---|---|---|---|
| `transactions` | `platformTransactions` | `paidAt` | `transactions` |
| `settlements` | `settlementRequests` | `requestedAt` | `settlements` |
| `wallet-ledger` | `walletTransactions` | `createdAt` | `wallet` |
| `donations` | `donations` | `createdAt` | `transactions` |
| `refunds` | `donationRefunds` + `listOrganizerRefunds` | `createdAt` | `transactions` |
| `broadcast-usage` | `broadcastCampaigns` | `createdAt` | `wallet` |
| `gst` | `platformTransactions` | `paidAt` | `transactions` |

**Every one is capped at 5,000 via `fetchCapped`** — `lib/reports/builders.ts:19-30`, called at
lines 43, 95, 135, 177, 255, 331, 376, 416-418.

### 4b · Outside the registry

| Report | Route | Permission | Note |
|---|---|---|---|
| `payout-statement` | `/api/organizer/reports/payout-statement` | `settlements` | PDF statement. Correctly gated (`route.ts:17`) but **not in the registry**; the UI lists it as an 8th kind. |

### 4c · Operational / participant exports (a separate, better-built family)

These are **not** part of the reports subsystem and are not reachable from
`/dashboard/finance/reports`:

`registrations/export`, `identifiers/export`, `identifiers/tags/export`, `nominations/export`,
`speaker-applications/export`, `sponsor-applications/export`, `race-operations/races/export`,
`crm/contacts/export`, `campaigns/[slug]/export`, `admin/licenses/export`.

The registrations export is the reference implementation: `authorizeWorkspaceDownload` before
any read, workspace-ownership check on the draft, **keyset pagination**, CSV streamed and
uncapped, XLSX capped at 50,000 *with disclosure*, `maxDuration = 300`
(`app/api/organizer/events/[eventId]/registrations/export/route.ts:24,36,41,48,57,125-137`).

---

## 5 · Registry Audit

**There is one canonical registry** — `lib/reports/registry.ts` — and the API route dispatches
through it correctly, resolving permission and builder in one place
(`app/api/organizer/reports/[kind]/route.ts:29-33`).

**But it is not the source of truth for the UI.** `/dashboard/finance/reports` hardcodes its
own list:

```ts
// app/(dashboard)/dashboard/finance/reports/page.tsx:15-25
interface ReportDef { kind: string; label: string; statement?: boolean }
const REPORTS: ReportDef[] = [ …7 kinds…, { kind: 'payout-statement', … } ]
```

Consequences, all evidenced:

- **Labels are defined twice** — registry and UI — and can drift silently.
- **`payout-statement` exists only in the UI list and its own route**, never in the registry.
- **Adding a report requires two edits**, and forgetting the UI makes it invisible though callable.
- The registry carries **no export formats, no date-range capability, no event-type capability,
  no description** — so nothing in it can drive UI availability.
- **UI availability is not registry-driven and not permission-driven** (§6).

No other duplicate registry exists. `lib/reports/adminBuilders.ts` serves the admin surface and
does not redefine organizer kinds.

---

## 6 · Authorization Audit

**The core path is correct, and correct in the right order.**

```ts
// app/api/organizer/reports/[kind]/route.ts:29-38
const meta = ORGANIZER_REPORTS[kind]; if (!meta) → 404
const authz = await authorizeWorkspace(req, meta.permission)
if (!authz.ok) → authz.status            // 401 / 403
table = await meta.build(authz.workspaceUid, filters)   // ← server-resolved uid
```

`authorizeWorkspace` verifies the caller, resolves the workspace server-side, then checks the
permission (`lib/team/workspace.ts:158-166`). **Authorization happens before any expensive
read**, and `workspaceUid` is never client-supplied.

**Cross-workspace isolation holds.** Every builder query is
`where('organizerUid','==',uid)` with the server-resolved uid (`builders.ts:23`). There is no
path by which one organizer's report returns another's rows.

**The `transactions` boundary matches Analytics.** Financial kinds require `transactions` or
`settlements`; `payout-statement` requires `settlements`. Per `ROLE_PERMISSIONS`, only `owner`
and `finance` hold `transactions` — the same boundary RD-ANALYTICS-11 established. `checkin_staff`
and `checkin_lead` hold only gate permissions and are refused.

**Findings:**

- **[P2] Event-scope assignment is not enforced.** `filters.event` is client-supplied
  (`route.ts:20-23`) and applied only as an in-memory equality test (`builders.ts:48`).
  `authorizeWorkspace` checks the *permission* but never the member's `eventIds` assignment. A
  restricted non-gate member holding `transactions` can therefore request any event in their own
  workspace. Contained within the workspace — not cross-tenant — but it does not honour the
  assignment model.
- **[P3] Visible-but-forbidden.** The UI renders all 8 report buttons to every caller and only
  surfaces permission failure after the click (`page.tsx:76` handles a 403 as a thrown error).
  Not a security defect — the server refuses correctly — but it invites failure.

No fail-open path, no client-controlled workspace id, no report accessible without its
permission, and no authorization-after-load was found in the organizer reports subsystem.

---

## 7 · Financial Correctness Audit

**What is right, and genuinely well covered.** Money is never recomputed in the builders; the
stored ledger fields are authoritative (`builders.ts:1-6`). `readReportFromLedgerData` resolves
actual-over-estimate gateway fees (`builders.ts:52`). The payout statement takes the payable
**from the stored settlement rather than by subtraction** — the comment in
`lib/reports/types.ts` explains that under attendee-pays, subtracting fees understated the
payout by the whole fee total. `tests/unit/financeReportDefinitions.test.ts` covers this
carefully: actual-over-estimate, unreconciled rows reported as null rather than ₹0, tax inside
the fee and never added on top, the two companies' fees kept apart, and the payable never
presented as a running subtraction.

**What is wrong:**

- **[P0] Date-ranged financial totals are wrong above 5,000 workspace rows.** See §9. A GST
  summary or payout statement for a past period can silently under-report.
- **[P1] An unavailable money value renders as ₹0.00.**
  ```ts
  // lib/reports/format.ts — cellToDisplay
  if (value == null || value === '') return type === 'money' ? fmtMoney(0, ascii) : '—'
  ```
  A null money cell — the exact representation of "not measured" — is printed as `₹0.00` in
  CSV, PDF and the UI preview. Non-money nulls correctly render `—`. This is precisely the
  "unavailable is not zero" rule RD-ANALYTICS-01 established for analytics, inverted here for
  money specifically. Note the builders' own tests assert an unreconciled gateway fee is `null`
  "never a ₹0 gateway charge" — and then the formatter renders that null as ₹0.00.
- **[P1] Rows missing the ordered time field are invisible.** `fetchCapped` uses
  `.orderBy(timeField,'desc')` (`builders.ts:25`), and Firestore **excludes documents that lack
  the ordered field**. A `platformTransactions` row with no `paidAt` never appears in the
  transactions or GST report, and is absent from every total, with no disclosure. The same trap
  was found in RD-ANALYTICS-10 fixtures via `orderBy('updatedAt')`. `inRange`'s undated branch
  (`builders.ts:33`) can therefore never be reached through this path.
- **[P2] Failures are swallowed into a generic 500.** `route.ts:39-42` catches build errors and
  returns "Could not build the report." The distinction between "no data" and "the read failed"
  is lost, though no zero is invented at this layer.

Financial values are **not** derived from registration documents anywhere in this subsystem —
the anti-pattern the brief asks about is absent. Revenue comes from `platformTransactions`,
refunds from `donationRefunds` + `listOrganizerRefunds`, settlement from `settlementRequests`.

---

## 8 · Date / Time Audit

| Aspect | Reports | Analytics |
|---|---|---|
| Day boundary | **UTC** — `Date.parse(\`${from}T00:00:00.000Z\`)` / `T23:59:59.999Z` (`lib/reports/format.ts` `rangeBounds`) | **IST** business-day keys (`lib/dashboard/dailyStats`, `dayKey = ms + 330·60000`) |
| Inclusivity | Both bounds inclusive | Inclusive |
| Presets | None — raw `from`/`to` strings from the UI | 7D / 30D / 90D via `lib/analytics/dateRange` |
| Previous period | Not supported | `previousPeriod` + `compareMetric` |

**[P1] Reports and Analytics disagree about what a day is.** The same "1–30 September" request
returns different data in the two surfaces: a payment at 02:00 IST on 1 September is
31 August in UTC and 1 September in IST. Every Indian morning transaction between 00:00 and
05:30 IST lands on the previous day in Reports. For an India-first platform producing GST
summaries, this is a real off-by-one-day exposure, and it means a Reports figure can never be
reconciled against an Analytics figure by inspection.

**[P3] Display dates render in the server's local timezone.** `fmtDate` uses
`toLocaleDateString('en-IN', …)` with no `timeZone` option (`format.ts`), so the printed day
depends on where the process runs, and can disagree with the ISO value stored in the same cell.

Job timestamps (created/completed) come from the generic job kernel; download expiry is a
Firestore `Timestamp` compared against `Date.now()` (`download/route.ts:39-45`) — both
absolute instants, so neither is timezone-sensitive.

---

## 9 · Scale Audit — the central finding

### [P0] Cap-then-filter: the date range and event filter are applied after the cap

```ts
// lib/reports/builders.ts:19-30
async function fetchCapped(collection, uid, timeField) {
  const q = adminDb.collection(collection)
    .where('organizerUid','==',uid)
    .orderBy(timeField,'desc')
    .limit(REPORT_ROW_CAP + 1)          // 5000 + 1
  const snap = await q.get()
  ...
}

// lib/reports/builders.ts:43-51  (buildTransactions, and the same shape in all others)
const { docs, truncated } = await fetchCapped('platformTransactions', uid, 'paidAt')
for (const doc of docs) {
  if (!inRange(d.paidAt, fromMs, toMs)) continue   // ← date filter, IN MEMORY
  if (f.event && d.entityId !== f.event) continue  // ← event filter, IN MEMORY
```

The query fetches **the newest 5,000 rows in the workspace**, ignoring `from`/`to` entirely,
and only then discards what falls outside the range.

**Why it matters.** For a workspace with more than 5,000 transactions, a report for any period
older than the newest 5,000 rows returns **zero or partially correct rows**. The response sets
`truncated: true`, which the UI discloses — but "truncated" reads as *"this is the first part of
your answer"*, when the actual state is *"the rows you asked for were never queried"*. A GST
summary for last quarter can come back empty, or worse, materially short, on a busy workspace.
The same applies to `payout-statement`, which aggregates three capped fetches
(`builders.ts:416-418`).

The tradeoff is deliberate and documented — `builders.ts:1-6` says filtering is done in memory
"so no new composite indexes are required" — but the correctness consequence is not stated
anywhere in the code or surfaced to the reader.

### Behaviour at scale

| Workspace size | Behaviour |
|---|---|
| 5,000 rows | Correct and complete |
| 20,000 rows | **Unbounded-incorrect**: any range older than the newest 5,000 rows is wrong. Memory stays bounded. |
| 50,000 rows | As above, more pronounced; the newest-5,000 window may cover only days |

Classification per report: **all 8 are "bounded but incorrect"** — never unbounded, never
memory-risky, never timeout-risky. The risk is entirely correctness, not resources. Reads are
one query per collection, so there is no concurrency risk either.

### The correct pattern already exists in this repository

`app/api/organizer/events/[eventId]/registrations/export/route.ts` does what the finance
builders do not:

```ts
let cursor: QueryDocumentSnapshot | undefined
for (;;) {
  const snap = await (cursor ? baseQuery.startAfter(cursor).limit(BATCH_SIZE)
                             : baseQuery.limit(BATCH_SIZE)).get()
  …
  cursor = snap.docs[snap.docs.length - 1]
}
```

CSV is streamed page-by-page and **uncapped**; XLSX is capped at 50,000 *because the zip
requires all rows in memory*, and says so. This is the pattern the reports subsystem should
adopt, and it needs no new invention — only the composite indexes the current design was built
to avoid.

---

## 10 · Async Job Audit

Well built. `lib/reports/exportJob.ts` runs on the generic job kernel/runner rather than a
second bespoke system, and explicitly reuses the registry, the builders and the serializers
(`exportJob.ts:1-18`).

| Property | Finding |
|---|---|
| Job id | `rex_${crypto.randomUUID()}` — **not guessable** (`exportJob.ts:66`) |
| Ownership | `organizerUid` stored on the job; checked on read, poll, cancel, download |
| Status model | queued / running / completed / failed / cancelled via the shared kernel |
| Resume | Per-page commit + cursor; an interrupted chunk resumes rather than restarting |
| Leases | `EXPORT_LEASE_MS = 120_000`; a job already being driven returns `busy` |
| Idempotency | Deterministic file path; a re-run overwrites the same object |
| Budget | `EXPORT_BUDGET_MS = 55_000` inline, then the cron continues |
| Driver | `/api/cron/report-exports`, fail-closed on `CRON_SECRET`, `JOB_BATCH = 25` |

**Cross-organizer access was specifically probed and is refused:** viewing, polling,
cancelling and downloading all compare `job.organizerUid` against the server-resolved
`ctx.workspaceUid` and return 404 on mismatch (`download/route.ts:29-32`). Job ids cannot be
guessed. Expired links are refused (410), and cancelled jobs are refused even though
`cancelJob` leaves `output` populated — a case the code calls out and handles deliberately.

**[P1] The redirect defeats the controls the route enforces.** After all those checks, the
route ends:

```ts
return NextResponse.redirect(job.output.url)
```

and `job.output.url` is a Firebase Storage **capability URL**:

```ts
// lib/firebase/storage/admin.ts:34-48
metadata: { firebaseStorageDownloadTokens: token }
const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${path}?alt=media&token=${token}`
```

That URL is **permanent, unauthenticated, and bearer-only**. Once a caller follows the redirect
once, the URL is in their history, the network tab, and any proxy log — and it keeps serving the
financial report to anyone who holds it, with no auth, no ownership check, and no expiry of its
own. The header comment claims "The token URL is never exposed except through this authorized
redirect", but a redirect *is* an exposure: it is returned to the client in `Location`.

**The exposure window is 6 days wider than the product states.** App-layer expiry is 24 hours
(`EXPIRY_MS = 24*60*60*1000`, `exportJob.ts:39`), while the storage object is retained for
7 days (`RETENTION_MS = 7*24*60*60*1000`, `app/api/cron/storage-cleanup/route.ts`). For six
days after the app answers `410 This download link has expired`, the raw URL still works.
Cancelling a job has the same gap — the route returns 410 while the object remains live.

**[P1] A Firebase ID token is accepted in the query string.**

```ts
// download/route.ts:18-22
const qToken = req.nextUrl.searchParams.get('token')
const authReq = qToken ? new Request(req.url, { headers: { Authorization: `Bearer ${qToken}` } }) : req
```

Done so `<a download>` links work without custom headers. The cost is a live credential in a
URL — written to server and CDN access logs, browser history, and leaked cross-origin via
`Referer`. The credential is the caller's Firebase ID token, not a narrow download token.

**[P3] Cleanup is bounded and may lag.** `MAX_PER_PREFIX = 500`, single unpaginated page per
tick. A workspace generating more than 500 expiring objects per cron interval accumulates.
The bound is deliberate and safe; the lag is the tradeoff.

---

## 11 · Report History Audit

There is **no dedicated report-history store**. History is the `reportExportJobs` collection
itself (`REPORT_EXPORT_JOBS = 'reportExportJobs'`), read through `listActiveJobs` and the job
kernel.

| Question | Finding |
|---|---|
| Storage | `reportExportJobs/{jobId}`, one doc per export |
| Schema | Generic `Job` + `kind`, `format`, `filenameBase`, `heading`, `filters`, `output?` |
| Ownership / scope | `organizerUid` — workspace-scoped; **no event scope on the job itself** |
| Metadata | kind, format, filters, row count, truncated flag, expiry |
| Retention | Firestore docs are **never deleted**; only the storage objects are (7 days) |
| Pagination | The cron reads `listActiveJobs(…, 25)`; there is **no paged history read for the UI** |

**[P2] History accumulates without bound and has no paged reader.** Job documents are never
cleaned up, so `reportExportJobs` grows for the life of the workspace, leaving completed jobs
that point at storage objects deleted six days earlier — a permanently growing list of
permanently broken download links. There is no history endpoint with a cursor; a future
Report History UI has nothing safe to call. This is not yet a live scale problem because no UI
lists history, which is precisely why it should be settled before one is built.

---

## 12 · Export Audit

| Format | Where | Sync/Async | Bound | Memory |
|---|---|---|---|---|
| CSV | `lib/reports/csv.ts` | both | 5,000 (builder cap) | whole table in memory |
| XLSX | `lib/reports/xlsx.ts` | both | 5,000 | whole workbook in memory |
| PDF | `lib/reports/pdf.ts` | both | 5,000 | whole document in memory |
| JSON | route | sync only | 5,000 | whole table |
| CSV (registrations) | `registrations/export` | sync, streamed | **uncapped** | one batch |
| XLSX (registrations) | same | sync | 50,000, disclosed | all rows |
| ZIP | print packages / photos — outside this subsystem | — | — | — |

All four report formats route through `serializeTables` (`lib/reports/export.ts`), and all
money/date rendering goes through `lib/reports/format.ts`. **Within the reports subsystem there
is no duplication** — the single-formatter design holds.

**Duplication exists across subsystems.** `lib/reports/csv.ts` and the CSV writer used by
`registrations/export` are separate implementations with different capabilities: the reports one
builds a whole string, the registrations one streams. Analytics does not export at all today, so
Analytics/Reports export duplication does **not** currently exist — and the recommendation in
§14 is to keep it that way by having Analytics link to Reports rather than grow its own.

---

## 13 · Event-Type Capability Audit

**The reports subsystem contains no event-type coupling at all.** A search of `lib/reports/*.ts`
for bib / timing / race / pace / finish-time vocabulary returns only false positives
(`ensureSpace`, `xml:space`). All 7 registry kinds are financial and universal across
Community, Conference, Sports, Workshop, Exhibition, Cultural, Awards, Fundraising and Meetup.

Sports-specific reporting lives in entirely separate subsystems — `bibReport`, `timingReport`,
`raceOpsCsvParser`, `race-operations/races/export` — and is reached from the Sports surfaces,
not from Reports. Conference-specific exports (`speaker-applications`, `sponsor-applications`,
`nominations`) are likewise their own routes.

**So there is no hardcoded sports assumption to remove.** The finding is the inverse: because
the reports registry has **no capability field**, a future Reports Workspace that lists
operational reports would have no way to express "this report applies only to events with
timing enabled". RD-ANALYTICS-10 established the correct capability source —
`identifierConfigs/{slug}.enabled` and `.tagMapping.enabled`, never inferred from `eventType`.
The registry should carry a capability predicate before operational reports are added, not
after.

---

## 14 · Analytics vs Reports Boundary

Today the boundary is **accidentally clean at the data layer and broken at the IA layer**.

Clean: the finance builders read ledger collections and emit rows; analytics reads aggregates
and rollups and emits KPIs. Neither calls the other. There is no duplicated aggregation, no
duplicated financial logic, and no duplicated export logic — because Reports exports and
Analytics does not.

Broken: `/dashboard/reports` is an analytics page, so the two names do not mean what they say.

**Genuine duplication that does exist:**

| Duplicated | Where | Note |
|---|---|---|
| Report labels | `registry.ts` and `finance/reports/page.tsx:16-25` | two lists, drift-prone |
| Date-range semantics | `lib/reports/format.ts` (UTC) vs `lib/analytics/dateRange` (IST) | not just duplicated — **contradictory** |
| Event selection | Reports uses a plain `event` string; Analytics uses the canonical `EventSelector` + `EventContextProvider` | |
| CSV writing | `lib/reports/csv.ts` vs the streaming writer in `registrations/export` | different capabilities |

**Recommended boundary, without a second source of truth:** Analytics answers "what is
happening" from aggregates; Reports answers "give me the underlying rows" from the ledger.
They should share the **date-range contract** (`lib/analytics/dateRange`, IST) and the **event
capability resolver**, and share nothing else — Reports must keep reading rows rather than
consuming analytics' aggregates, or the two would drift into disagreeing about money.

---

## 15 · UI / UX Audit

`/dashboard/finance/reports` is a functional, honest, plain surface — a list of report kinds,
date inputs, preview, and download. It is not yet enterprise-grade:

- **No categorisation.** Eight flat entries; adding operational and participant reports would
  make an unstructured list.
- **No permission awareness.** All entries render for every caller; failure arrives as an error
  after the click.
- **No event selector.** Reports take an `event` string, disconnected from the canonical
  `EventSelector`/`EventContextProvider` the rest of the dashboard shares.
- **No date presets** and no previous-period control; Analytics has both.
- **No history view.** Export jobs are created and polled, but past exports are not listed —
  the data exists in `reportExportJobs` and nothing surfaces it.
- **Truncation disclosure exists** (`ReportTable.truncated`) — good, and the one honesty
  affordance already present. It should say *which* rows are missing, given §9.
- Mobile responsiveness was not measured; no browser QA was run in this audit.

---

## 16 · Navigation Audit

- The sidebar's Reports entry points at the **analytics** page, `/dashboard/reports`.
- `/dashboard/finance/reports` — the real reports workspace — is reached through Finance.
- `app/(dashboard)/reports/` is an **orphan directory** containing only `.gitkeep`; no route
  resolves there.
- The analytics modules built in RD-ANALYTICS-08/09/10/11 (`/dashboard/analytics/registrations`,
  `/revenue`, `/operations`, `/communications`) are **not linked from any navigation** — they are
  reachable only by direct URL, consistent with the "do not migrate routes" constraint those
  phases carried.

No stale or broken link was found; the problem is naming and absent entry points, not dead ones.

---

## 17 · Test Coverage

**Well covered** — financial *semantics*: `tests/unit/financeReportDefinitions.test.ts` (fee vs
gateway fee separation, actual-over-estimate, tax inside the fee, payout from the stored ledger,
null never rendered as a ₹0 charge at the reader layer), `payoutHistoryMask.test.ts`,
`registrationReportSources.test.ts`, `registrationExportColumns.test.ts`,
`registrationExportRoute.test.ts`, `registrationReportTruth.emu.test.ts`,
`xlsxInlineStrings.test.ts`.

**Weakly covered** — the export-job lifecycle exists in code with no dedicated lifecycle suite;
`payoutHistory.emu.test.ts` covers the payout audit trail, not report exports.

**No coverage at all:**

1. Authorization on `/api/organizer/reports/[kind]` — no test asserts a missing permission is refused
2. Download authorization / ownership on `[jobId]/download`
3. Cross-workspace isolation for reports
4. **The cap-then-filter date correctness** — no test constructs >5,000 rows and asserts a past range
5. Export-job cancellation and expiry semantics
6. Report history reads
7. `cellToDisplay` null-money rendering
8. UTC-vs-IST boundary agreement between Reports and Analytics

Item 4 is the notable gap: the P0 in §9 would have been caught by one emulator test in the
shape of `revenueLedgerBound.emu.test.ts`, which already proves this exact class of defect for
the analytics ledger.

---

## 18 · Security Findings

| ID | Finding | Severity |
|---|---|---|
| S1 | Download redirects to a permanent, unauthenticated Firebase Storage capability URL; app expiry 24h vs object retention 7 days ⇒ 6-day window where a captured URL still serves financial data after the app says 410. Cancellation has the same gap. | **P1** |
| S2 | Firebase ID token accepted in the query string (`?token=`) — credential in URLs, logs, history, `Referer`. | **P1** |
| S3 | Member `eventIds` assignment not enforced on report routes; `filters.event` is client-supplied and filtered in memory. Within-workspace only. | **P2** |
| S4 | All report entries rendered regardless of permission; 403 only after the click. | **P3** |

**Checked and found sound:** IDOR on job ids (random UUIDv4), cross-workspace access (server-resolved
`organizerUid` on every query), unauthorized financial access (permission gate before build),
privilege escalation (gate-only roles hold no financial permission), authorization-after-load
(authorization strictly precedes `meta.build`), client-controlled ownership (workspace uid never
read from the request).

---

## 19 · P0 Findings

**P0-1 — Date-ranged financial reports are incorrect above 5,000 workspace rows.**
`lib/reports/builders.ts:19-30` (`fetchCapped`) and the in-memory filters at lines 43-51, 95,
135, 177, 255, 331, 376, 416-418. The query fetches the newest 5,000 rows and applies `from`/`to`
and `event` afterwards, so any period outside that window returns wrong totals while presenting
as an authoritative report. Affects all 8 reports including `gst` and `payout-statement`.
*Why it matters:* these are used for tax filing and organizer payouts.

---

## 20 · P1 Findings

**P1-1 — Download redirect leaks a permanent capability URL** (S1). `download/route.ts:47`,
`lib/firebase/storage/admin.ts:34-48`, `exportJob.ts:39`, `cron/storage-cleanup/route.ts`.

**P1-2 — Firebase ID token accepted in the query string** (S2). `download/route.ts:18-22`.

**P1-3 — Reports use UTC day boundaries, Analytics uses IST.** `lib/reports/format.ts`
`rangeBounds` vs `lib/dashboard/dailyStats`. Off-by-one-day for every Indian transaction
between 00:00 and 05:30 IST; the two surfaces can never be reconciled by inspection.

**P1-4 — A null money cell renders as ₹0.00.** `lib/reports/format.ts` `cellToDisplay`.
"Unavailable" becomes a measured zero in CSV, PDF and preview.

**P1-5 — Rows missing the ordered time field are silently excluded.** `builders.ts:25`
(`orderBy(timeField,'desc')`). A transaction without `paidAt` never appears in any total, with
no disclosure.

---

## 21 · P2 Findings

**P2-1 — Registry is not the source of truth for the UI.** `finance/reports/page.tsx:15-25`
duplicates the kind list and adds `payout-statement`, which is absent from the registry.

**P2-2 — Member `eventIds` assignment not enforced on report routes** (S3).

**P2-3 — `reportExportJobs` grows without bound and has no paged reader.** Job docs are never
deleted while their storage objects are removed at 7 days, producing a permanently growing list
of broken links and no safe query for a future History UI.

**P2-4 — `/dashboard/reports` is an analytics page under the Reports name**, and the sidebar
points at it. The orphan `app/(dashboard)/reports/` directory compounds the confusion.

---

## 22 · P3 Findings

**P3-1 — All report entries shown regardless of permission** (S4).

**P3-2 — `fmtDate` renders in the server's local timezone** — no `timeZone` option, so the
printed day can disagree with the ISO value in the same row.

**P3-3 — Storage cleanup is a single bounded page** (`MAX_PER_PREFIX = 500`) and can lag behind
a workspace producing exports faster than the cron reclaims them.

---

## 23 · Target Reports Workspace Architecture

### Information architecture

The proposed structure fits, with one correction. `Financial` and `History` map to what exists.
`Operational`, `Participants` and `Communications` **do not exist as reports today** — they exist
as per-event exports on separate routes (§4c). `Scheduled` does not exist in any form.

```
Reports
├── Financial        ← the 7 registry kinds + payout-statement (exists)
├── Operational      ← adopt the existing per-event exports (exists, not registered)
├── Participants     ← registrations/export is already the reference implementation
├── Communications   ← does not exist; RD-ANALYTICS-11 established the aggregate sources
├── Scheduled        ← does not exist
└── History          ← reportExportJobs exists; needs retention + a paged reader
```

The honest sequencing is: **register what already exists before building what does not.**

### Registry

One registry, extended so the UI can be driven entirely from it and the duplicate list deleted:

```
kind, label, description, category,          // Financial | Operational | Participants | …
permission,                                  // unchanged
formats: ExportFormat[],                     // stops the UI guessing
scope: 'workspace' | 'event',                // payout-statement is workspace; exports are event
dateRange: boolean,
capability?: (caps: OperationalCapabilities) => boolean,   // RD-10's resolver, never eventType
build | stream                               // see Jobs
```

`payout-statement` moves inside it. Nothing else changes shape.

### Permissions

Keep exactly what exists — `authorizeWorkspace(req, meta.permission)` before any read — and add
the missing event-scope check for `scope: 'event'` reports, reusing `lib/team/eventScope.ts`
rather than inventing a second rule. The `transactions` boundary already matches Analytics and
should not move.

### Data

Reuse, and add no new store: `platformTransactions` / `settlementRequests` / `walletTransactions`
/ `donations` / `donationRefunds` for money; `registrationCounters` and status aggregates for
counts; `organizerDailyStats` for trends; `getRefundTotals` for refunds; `identifierConfigs` for
capabilities; `lib/analytics/dateRange` for the **shared IST date contract**. Reports should keep
reading rows rather than consuming analytics' aggregates — sharing the range contract without
sharing the numbers is what prevents a second source of truth.

### Jobs

The existing job model is already the right one — keep it. The change needed is in the
**builders**, not the runner: convert `build(uid, filters) → ReportTable` into a cursor-paged
`stream(uid, filters, cursor) → { rows, nextCursor }`, so the job's existing per-page commit and
resume actually page through data instead of re-fetching a capped table. This is the single
change that closes P0-1 and lifts the 5,000-row ceiling at the same time.

For downloads, replace the redirect-to-capability-URL with either a short-lived signed URL whose
own expiry matches the app's, or a proxied stream through the authorized route. Align object
retention with the stated 24-hour expiry.

### History

Add a cursor-paged history reader over `reportExportJobs`, and a retention policy for the job
documents that matches the storage retention so the two cannot disagree.

### Exports

Adopt the `registrations/export` pattern wholesale: stream CSV uncapped through a cursor; keep
XLSX and PDF capped **with disclosure**, because both require the whole document in memory. At
20k+ records CSV should stream and XLSX/PDF should refuse politely rather than truncate silently.

---

## 24 · Recommended Implementation Roadmap

**Phase 1 — P0 correctness (do first, alone).** Convert `fetchCapped` to a range-and-event-aware
query: push `from`/`to` into the Firestore query and `event` into a `where`, declaring the
composite indexes the current design avoided. Add an emulator test in the shape of
`revenueLedgerBound.emu.test.ts` that seeds >5,000 rows and asserts a past-period report is
correct. Nothing else should ship in this phase.

**Phase 2 — P1 security and honesty.** Signed or proxied downloads with matched retention;
remove the query-string token in favour of a short-lived download-scoped token; align the date
contract on IST; stop rendering null money as ₹0.00; disclose or include rows missing the
ordered time field.

**Phase 3 — Architecture.** Extend the registry, delete the duplicate UI list, bring
`payout-statement` inside, add event-scope enforcement, add the capability predicate.

**Phase 4 — History and scale.** Paged history reader, job-document retention, cursor-streamed
CSV.

**Phase 5 — UI.** Categorised workspace, permission-aware entries, canonical `EventSelector`,
shared date presets, history view.

**Phase 6 — Operational/Participants/Communications reports**, registered rather than invented,
and only after Phases 1–3.

**Test work runs inside each phase, not after it.** The gaps in §17 items 1-4 should be closed in
Phase 1 and 2 respectively.

---

## 25 · Explicit Out-of-Scope Items

Not audited, not changed, and deliberately excluded:

- `/admin/finance-reports` and `lib/reports/adminBuilders.ts` — inspected only far enough to
  confirm they are a separate surface and do not redefine organizer report kinds
- Sports reporting (`bibReport`, `timingReport`, `raceOps`) beyond confirming no coupling to
  `lib/reports`
- Certificates, print packages, photo downloads and ZIP generation
- Analytics internals already certified by RD-ANALYTICS-07 through 11
- Firestore rules and indexes — not read, not modified
- Browser/visual QA and mobile responsiveness — not performed; §15 is a code-level reading
- Any implementation, fix or migration

---

## Audit integrity statement

No application source, component, API, test, Firestore rule, Firestore index, route or
dependency was modified. No deployment, commit or push. The only file created by this phase is
`docs/RD-ANALYTICS-12-AUDIT.md`.
