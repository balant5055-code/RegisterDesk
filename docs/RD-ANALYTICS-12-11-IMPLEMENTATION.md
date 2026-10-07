# RD-ANALYTICS-12-11 — Reports History

**Status:** complete. A bounded server-side READER over the existing `reportExportJobs`
collection, plus a History tab on the existing Reports workspace. No second export system, no
new permission, no retention, no route, no navigation change. Index definition added and **not
deployed**. Not committed, not pushed, not deployed.

---

## A · What was there before

The export spine was complete and correct — create → job → process → artifact → notify →
authenticated download → fresh short-lived signed URL — with one gap at the end: **nothing
could list it.**

A background export existed only in the React state of the tab that started it
(`const [exportJob, setExportJob] = useState(...)`). Refresh the page and a finished report
became unreachable: the job document was still there, the artifact still had six days of
retention left, and no surface in the product could name either. The only way back to a report
was to generate it again.

`reportExportJobs` has no `match` block in `firestore.rules`, so the client SDK is denied by
default. That is deliberate — a job document carries the workspace uid and the storage path —
and it is why History had to be a server projection rather than a listener.

## B · Architecture

```
reportExportJobs  ──▶  readReportHistory()  ──▶  /api/organizer/reports/history  ──▶  History tab
   (unchanged)          bounded · gated             authz + projection                (list + Load more)
                                │
                                └── permissionForExportJob() — the same predicate the
                                    poll, process, cancel and download routes use
```

One collection, one permission gate, one download route. History adds a reader and a tab.

## C · Endpoint

`GET /api/organizer/reports/history?cursor=<opaque>&limit=<≤25>`

`history` is a static sibling of the dynamic `[kind]` segment, which the App Router resolves
first — the shape `exports/` already had here. No report kind is named `history`, so nothing is
shadowed.

```
{ success: true, jobs: ReportHistoryEntry[], nextCursor: string | null, hasMore: boolean }
```

## D · Authorization

`authorizeAnyWorkspace(req)` — the same helper the sibling export routes use, and the one that
excludes gate-only roles (`isCheckinOnlyRole`). A `checkin_staff` or `checkin_lead` caller is
refused with **403**, not given an empty list: a list of financial exports is not a gate
operator's business, and answering "200, nothing here" would imply the question was reasonable.

No new permission was created. No parallel authorization path exists.

## E · Permission filtering

Every row is gated by `permissionForExportJob(job)`, which resolves the kind through
`ORGANIZER_REPORTS`. `null` — an unregistered kind — is a **refusal**, exactly as the download
route treats it, not "no permission required".

A hidden job contributes nothing to the response: not its kind, dates, size, status, creator or
existence. Test 11 asserts each of those by string.

| Role | Sees |
|---|---|
| owner | every export |
| finance | transactions / settlements / wallet-ledger / donations / refunds / broadcast-usage / gst |
| admin, manager | nothing (200, empty) |
| checkin_lead, checkin_staff | refused, 403 |

A caller holding no report permission at all short-circuits before the query — proving you can
see nothing should not cost 250 document reads (test 12).

## F · Workspace isolation

`where('organizerUid', '==', authz.workspaceUid)` is a **query filter**, and `workspaceUid`
comes from the authenticated session — never from the request. Reading the collection and
comparing afterwards would put every workspace's exports through this process, which is both a
scale defect and a disclosure waiting for one missing `continue`.

Test 7 proves it by counting: with three foreign jobs present, the read returns one document,
not four.

## G · Pagination — the one hard problem

Visibility is per report kind, and Firestore cannot evaluate that predicate. The naive
implementation reads 25 documents, drops what the caller may not see, and returns 7 — a sparse
page whose cursor, taken from the last *visible* row, then re-scans or skips everything between
it and the true page end.

The fix separates the two page sizes:

| | |
|---|---|
| **Source page** — per Firestore read | 50 |
| **Visible page** — what the caller gets | 25 (also the maximum) |
| **Scan bound** — most documents one request may read | 250 |

The reader pulls source pages until the visible page fills, the source is exhausted, or the
scan bound is hit — and **the cursor advances to the last document consumed, visible or not.**
That is what guarantees progress: a request that reads 250 invisible jobs still returns a
cursor 250 documents further on, so "Load more" cannot loop. Five Firestore reads per request,
maximum, regardless of workspace size.

### The bug this caught

The first implementation treated a short source read as exhaustion. But filling the visible
page mid-snapshot leaves documents behind — 40 jobs returned 25 with `hasMore: false`, and the
remaining 15 were **unreachable**. Now both conditions must hold: the page was read to the end
*and* it came back short. Unit tests 15/16 pin it.

### Why the permission is not pushed into the query

`where('kind', 'in', allowedKinds)` would make every page dense and remove the loop. Rejected
on two grounds: it needs a third index column where the approved audit specifies exactly
`organizerUid ASC, createdAt DESC`, and it would make a locally-derived kind list — not
`permissionForExportJob` — the thing that decides access. One gate, applied to every row, is
worth a scan bound.

## H · Cursor

An opaque base64url encoding of `{ s: seconds, n: nanoseconds }` — the position in the
`createdAt DESC` ordering, and nothing else.

The obvious encoding, the last scanned document's id (as `/api/organizer/notifications` uses),
**could not be used**: the last scanned document is frequently one the caller may not see, and
handing back its `rex_<uuid>` would disclose a hidden export's existence on every page turn.
Base64 would not have helped — encoding is not concealment.

So the cursor names no job, no workspace and no caller (test 22), and is meaningless in another
workspace because the query's `organizerUid` comes from the session. A malformed cursor is
**rejected with 400**, not ignored — silently restarting from the newest row would present page
one again and read as a History that never ends.

## I · Page size

Default and maximum 25; a smaller `limit` is honoured, a larger one is clamped. There is no
`page` or `skip` parameter to supply — offset pagination is not merely discouraged here, it is
absent (test 23).

## J · Firestore index

Added to `firestore.indexes.json`, one definition, **not deployed**:

```json
{ "collectionGroup": "reportExportJobs", "queryScope": "COLLECTION",
  "fields": [ { "fieldPath": "organizerUid", "order": "ASCENDING" },
              { "fieldPath": "createdAt",    "order": "DESCENDING" } ] }
```

Required because the query combines an equality filter with an `orderBy` on a different field.
The keyset cursor needs no `__name__` column: `orderBy('createdAt','desc')` already carries an
implicit `__name__ DESC` tie-break, and the cursor is a value on the ordered field.

> **This is the one thing no test in this phase can validate.** The Firestore emulator does not
> enforce index definitions, so the emulator suite passing says nothing about production, where
> the same query fails with `FAILED_PRECONDITION` until the index is built. **History will not
> work in production until this index is deployed.** The RD-12-07 `settlementRequests` index is
> also still undeployed; neither was deployed here.

## K · Safe projection

`toExportJobView()` was left **unchanged** — the active-export panel and the poll route depend
on it, and it exposes `job.error` raw, which is acceptable for a job on screen in memory and
not for a durable workspace-wide list. History has its own projection in a new module instead.

What a row carries: `jobId`, `kind`, `status`, `format`, `createdAt`, `completedAt`,
`expiresAt`, `range`, `rowCount`, `truncated`, `download`, `failure`, `createdByYou`.

Deliberately absent, each for a reason:

| Omitted | Why |
|---|---|
| `organizerUid` | tenancy, resolved server-side |
| `output.path` | the storage location of a financial artifact |
| `url` | no signed URL is ever minted during a list read |
| `contentType` | nothing in the UI branches on it |
| `lockedUntil`, `cursor`, `counts` | worker lease and chunk bookkeeping |
| `error` | the raw stored message — see below |
| `createdBy` | a raw uid; `createdByYou` answers the only question the UI asks |

Attribution without an identifier: `createdBy === callerUid` becomes a boolean, so the row can
say "by you" without publishing a uid (test 29).

## L · Errors

Every failed job answers with one fixed string: *"Report generation failed. Generate it
again."* The stored `error` is untouched and still reaches server logs; it never reaches the
browser. A seeded `FirebaseError: 7 PERMISSION_DENIED: Missing index on projects/rd-prod/…`
was confirmed absent from the rendered page in the browser QA, not only in a unit test.

Route-level failures log server-side and answer *"Could not load report history."* — a
Firestore message can name the collection, the index it wants and the project.

## M · Unknown / retired kinds

Two halves:

- **Server** — an unregistered kind has no permission to check against, so
  `permissionForExportJob` returns `null` and the row is refused. The request still succeeds;
  one strange document does not fail the list (test 36).
- **Client** — resolves labels through `REPORT_CATALOG[row.kind]?.label ?? row.kind ?? 'Unknown
  report'`, so a kind it cannot resolve renders as itself rather than blanking the row.

Verified in the browser: a seeded `legacy-attendance-report` job appears nowhere in the feed.

## N · payout-statement

It is in the catalogue but **not** in `ORGANIZER_REPORTS`, so the export-create route rejects it
with 400 before a job document can exist — **no payout-statement export job can currently be
created** (test 37 asserts this rather than assuming it). A legacy row would not crash the
reader (test 38); it would be filtered for the same reason a retired kind is. Its endpoint,
builder, PDF rendering and specialization are untouched.

## O · Status handling

The real state machine only: `pending` → `processing` → `completed` / `failed` / `cancelled`,
rendered as Queued / Generating / Completed / Failed / Cancelled. Status is printed as a word,
never signalled by colour alone.

**There is no `expired` status and none was invented.** Download availability is a separate
fact, derived from `output.expiresAt`, shown as a second label — so a completed job whose file
is gone still reads `Completed · file expired`, which is what actually happened.

## P · Artifact expiry

Three clocks, kept distinct:

| Clock | Lifetime | Effect in History |
|---|---|---|
| job document | never deleted | the row is always there |
| stored artifact | ~7 days (`RETENTION_MS`) | — |
| download link | 24 hours (`EXPIRY_MS`) | `Download expired`, no button |

`historyDownloadState` mirrors the download route's own decisions exactly — 410 cancelled, 409
no output, 410 expired — so History never advertises a download the route would refuse. A
cancelled job may still carry an `output` (`cancelJob` does not clear it) and is correctly
shown as unavailable.

No signed URL is generated while listing. No artifact lifetime was extended.

## Q · Download

History reuses `downloadExport(jobId, fallback?)` — the existing helper that calls the existing
route with an `Authorization` header, follows its 302 to a freshly-minted short-lived signature,
and hands the blob to the browser. No History-specific download route exists (test 16). No token
travels in a URL. No signed URL is stored (test 17). Exactly one function in the page performs an
export download (test 18).

The optional `fallback` names the file only when the response carries no `Content-Disposition`;
the active panel passes nothing and behaves as before.

## R · UI

`[ Reports ] [ History ]` on `/dashboard/finance/reports` — a `role="tablist"` with real
buttons and `aria-selected`, not a route. Local state, not a query parameter, because
`searchParams` in a page makes it dynamic.

Rows are compact: report label + format, then date range · created · attribution · row count;
a status pill; and the action. The tab bar is **hidden entirely** when the caller has no finance
report at all — 12-10's empty state ends the page, and offering History there would invite a
click that proves a negative.

## S · Relationship to the active export panel

Unchanged and still on the Reports tab. Live job → panel; every job → History. Both read
`reportExportJobs`; no shared state layer was introduced.

## T · Loading / empty / error / end states

Spinner on first read; *"No report exports yet"* with a note that files last 24 hours; a
generic error with **Try again**; *"End of history"* when the feed is exhausted; **Load more**
while it is not. A **Refresh** control re-reads from the top.

## U · Tests

| File | Cases | What it defends |
|---|---|---|
| `tests/unit/reportHistoryReader.test.ts` | **45** | The real GET handler, with only `verifyCaller`/`activeMemberships` and Firestore stubbed. The Firestore fake honours where/orderBy/startAfter/limit and **counts documents**, so boundedness is asserted, not assumed. |
| `tests/unit/reportsHistoryUi.test.ts` | **31** | The page-level claims that are otherwise unverifiable — one workspace, no new route, download reuse, no client Firestore, the four list states. |
| `tests/emulator/reportHistoryScale.emu.test.ts` | **9** | Real Firestore, 20,525 seeded jobs. |

`reportExportAuthorization.test.ts` (40 cases) was not touched or weakened.

Two cases in `reportsWorkspacePresentation.test.ts` were **updated, not deleted**: 12-10's
"no History was implemented" scope guard would now pin the product backwards, so it was
rewritten to assert the shape it was protecting (History is a mode of this page, reads the
server, and never touches Firestore); and case 30b's exact-string match absorbed the added
`mode === 'reports'` guard.

## V · Browser validation — performed

Emulator + seeded owner/finance/manager + 38 seeded export jobs covering every state + a
production build served on 3187 + Playwright, with screenshots **read**.

| Check | Result |
|---|---|
| Reports tab still renders discovery, filters and the export panel | ✅ |
| History first page | 25 rows |
| every seeded state rendered (Completed/Failed/Cancelled/Queued/Generating/Download expired) | ✅ |
| download buttons only on downloadable rows | 20 buttons, expired rows labelled |
| retired-kind job listed | **no** — correctly hidden |
| raw failure message, storage path or contentType in the page | **none** |
| `createdByYou` attribution | ✅ ("by you" present on own rows, absent on the finance member's) |
| Load more | 25 → **37** rows (38 seeded − 1 hidden retired kind) |
| **history survives a full page reload** | ✅ 25 rows — the defect this phase exists for |
| Download click → endpoint | `GET /api/organizer/reports/exports/rex_seed_txn/download` |
| finance sees the feed | 25 rows |
| manager: tabs offered | **0**, empty state shown, no report name or job metadata leaked |
| manager calling the endpoint with a real ID token | **200, jobs=0, no metadata** |
| owner calling it directly | 200, 25 jobs, opaque cursor, no storage path |
| overflow at 1440 / 834 / 390 | 0px / 0px / 0px |
| clipped report names | 0 at every width (after the fix below) |
| keyboard: Tab reaches the History tab, Enter activates it | ✅ `:focus-visible` true, 4px ring, `aria-selected=true`, 25 rows |

### The defect the browser found

At 390px the row was `flex-1` beside the status pill and the Download button. Both fitted; the
report **name** did not, and `truncate` clipped it to "Transacti…". Rows without a download
button were unaffected, so the list disagreed with itself about how wide a name may be — and
every numeric check passed: 0px page overflow, action reachable. Only the screenshot showed it.

Fixed with `w-full min-w-0 sm:w-auto sm:flex-1`, so the text takes its own line below `sm` and
the controls wrap beneath. The QA script now measures `scrollWidth > clientWidth` per title,
which is what truncation actually is — 0 clipped titles at all three widths.

### The one console error, attributed

`503` on the download click. The server log gives the cause: *"Could not load the default
credentials"* — GCS V4 signing is a local HMAC over a service-account key, and the emulator app
initialises with `projectId` only. **Signed downloads cannot be exercised in the emulator at
all**; this is the pre-existing limitation documented in RD-12-04, not a History defect. The
route behaved exactly as designed: it refused with 503 rather than falling back to a capability
URL.

## W · Scale validation — performed

Real Firestore, one workspace of **20,000** export jobs, a second of 25, a third of 500 whose
kind no registry entry describes.

| Property | Result |
|---|---|
| first page over 20,000 jobs | 25 rows, `hasMore: true` — **a reader that had walked the collection would have found the end** |
| newest first, exactly | first and 25th row are the expected seeded ids |
| keyset cursor across 8 pages | 200 rows, **contiguous descending, no skips, no repeats** |
| cross-workspace | the 25-job workspace pages to exactly 25 and stops |
| 500 invisible jobs | 0 rows, still bounded, still returns an advancing cursor |
| continuing past all 500 | terminates in under 10 turns |
| projection from real documents | no storage path, no workspace uid, no contentType |
| caller with no report permission | 0 rows, `hasMore: false`, no cursor |

Whole file: 9 passed, ~13s including the seed.

## X · Validation summary

| Gate | Result |
|---|---|
| `reportHistoryReader.test.ts` | **45 passed** |
| `reportsHistoryUi.test.ts` | **31 passed** |
| `reportsWorkspacePresentation` + `reportRegistryMetadata` + `reportExportAuthorization` | **174 passed** (with the two new files) |
| **full unit suite** | **334 files — 9,090 passed, 1 skipped, 0 failed** |
| emulator — History scale | **9 passed** |
| emulator — `reportHistoricalScope` + `adminFinanceHistoricalScope` | **35 passed** (all three files together) |
| TypeScript | **PASS** — exit 0 |
| ESLint — every file this phase touched | **PASS** — 0 problems |
| **production build** (`npm run build`) | **PASS** — exit 0, 2m25s; `/api/organizer/reports/history` registered |

`tests/emulator/capturedRecovery.emu.test.ts` test 15 was not run and not fixed, per the brief.

**ESLint, honestly:** a repository-wide `npx eslint app components lib scripts tests config`
reports **88 errors and 103 warnings, none in any file this phase touched** — they sit in
admin finance, communications and event-tab components belonging to other work. The count is
unchanged by this phase.

## Y · Files changed

| File | Why |
|---|---|
| `lib/reports/history.ts` | **New** — bounded reader, gate, cursor, projection |
| `app/api/organizer/reports/history/route.ts` | **New** — the endpoint |
| `app/(dashboard)/dashboard/finance/reports/page.tsx` | History tab, `HistoryPanel`, `StatusPill`, `downloadExport` fallback |
| `firestore.indexes.json` | **+1 index definition** (14 lines), not deployed |
| `tests/unit/reportHistoryReader.test.ts` | **New** — 45 cases |
| `tests/unit/reportsHistoryUi.test.ts` | **New** — 31 cases |
| `tests/emulator/reportHistoryScale.emu.test.ts` | **New** — 9 cases |
| `tests/unit/reportsWorkspacePresentation.test.ts` | 2 cases updated (12-10 scope guard superseded) |
| `scripts/qa/rd-analytics-12-11-fixture.mjs` | **New** — seeded job states |
| `scripts/qa/rd-analytics-12-11-shots.mjs` | **New** — browser QA |
| `scripts/qa/rd-analytics-12-11-checks.mjs` | **New** — focus ring + authenticated endpoint checks |
| `docs/RD-ANALYTICS-12-11-IMPLEMENTATION.md` | This document |

One change to `downloadExport` beyond the fallback: it now reads `user` rather than
`userRef.current`. React Compiler correctly refuses a ref read inside a value that escapes the
component, and the function is now passed to `HistoryPanel` as a prop. Same auth state.

## Z · Confirmations

- **Firestore rules unchanged** — `firestore.rules` is byte-identical (mtime 3 Sept, a
  pre-existing working-tree modification from an earlier phase) and still contains **zero**
  references to `reportExportJobs`, which is why the client cannot read it.
- **Indexes** — exactly one added, not deployed. No existing index altered or removed. The
  RD-12-07 `settlementRequests` index remains undeployed.
- **No report builders, `exportJob.ts`, `registry.ts`, `catalog.ts` or `permissionForExportJob`
  changed.** No export processing, no signed-download implementation, no financial semantics.
- **No new permission, no new collection, no schema change, no retention, no scheduled reports.**
- **No navigation or route changes** — `config/workspaceNav.ts`, sidebar, breadcrumbs,
  `/dashboard/reports`, `/dashboard/analytics` untouched. No `/dashboard/finance/reports/history`.
- **No date-semantics change** — reports remain inclusive UTC day bounds.
- **No filters implemented** on History, per §22's minimal first version.
- **Not deployed, not committed, not pushed.** HEAD unchanged at `b7e5fdf`, nothing staged.

## AA · Deviations

1. **A retired/unregistered kind is hidden rather than displayed as "Unknown report".** §12 asks
   the renderer to cope with one; it does. But visibility is decided by
   `permissionForExportJob`, which returns `null` for an unregistered kind, and §36 forbids
   changing that logic. Every sibling route treats `null` as a refusal; History does not become
   the one place that treats it as "no permission required". The client-side fallback exists and
   is tested, so a kind that is registered but later renamed still renders.

2. **No status filter.** §22 permitted one "only if cheap and query-safe". It is neither: a
   server-side status filter needs a third index column beyond the approved definition, and an
   in-memory one would make pages sparser — the exact problem §6 exists to avoid.

3. **`createdBy` is projected as a boolean, not a name.** Resolving display names means a
   per-row team lookup. `createdByYou` answers the question the UI actually asks at zero cost
   and publishes no uid.

## AB · Remaining issues

1. **The index is not deployed, so History will not work in production yet.** The emulator does
   not enforce indexes, so nothing in this phase can catch that; the first production request
   would fail with `FAILED_PRECONDITION`. Deploying `firestore:indexes` is a prerequisite for
   release, and was deliberately not done here.

2. **Signed downloads remain unexercised end-to-end.** The emulator cannot sign GCS URLs
   (RD-12-04). History's download path was verified to reach the correct route with the correct
   job id; the signature itself has still only ever been tested by unit assertions.

3. **`hasMore` reveals that a workspace *may* contain more export jobs.** A caller who can see
   none but whose workspace holds many receives `hasMore: true` and an empty page. Bounded
   pagination cannot both guarantee termination and conceal the existence of unreadable source
   documents. The signal carries no kind, date, size, status or creator, and the empty state
   never says "there are reports you cannot see" — but it is not nothing, and it is recorded
   here rather than glossed.

4. **Two `reportsWorkspacePresentation` cases now encode 12-11's shape.** If History is ever
   removed, those cases fail — correctly, but they are cross-phase coupling worth knowing about.

5. **`docs/RD-ANALYTICS-12-01-IMPLEMENTATION.md` remains outstanding.** Not created here, per
   instruction.
