# Race Operations — Changelog

Module: `features/race-operations/` · Ticket: **RD-RACEOPS-01**
Architecture: [`RD-RACEOPS-01-phase0-audit.md`](./RD-RACEOPS-01-phase0-audit.md) ·
Data flow: [`RD-RACEOPS-DATAFLOW.md`](./RD-RACEOPS-DATAFLOW.md) ·
Schema: [`RD-RACEOPS-FIRESTORE.md`](./RD-RACEOPS-FIRESTORE.md) ·
Lifecycle: [`RD-RACEOPS-IMPORT-LIFECYCLE.md`](./RD-RACEOPS-IMPORT-LIFECYCLE.md)

---

## Sprint 4 — Public Results & Certificate Integration

### Phase A audit result: **PASS with 3 findings** (all reported before any code)

| # | Check | Result |
|---|---|---|
| 1 | Import Sessions remain immutable | ✅ `doc.create()` not `set()`; only lifecycle fields mutate, each at most once. |
| 2 | Official Snapshot exists and is the ONLY public read model | ❌ **FINDING A — it did not exist.** Sprint 3 built `raceImportSessions` + `results` only. Building it is Sprint 4's own brief, so this reshaped the sprint rather than blocking it. |
| 3 | Public pages never read Draft Imports | ✅ vacuously (no public surface existed) — now enforced structurally, see below. |
| 4 | Certificate integration points exist | ✅ The seam exists: `distance`/`finishTime`/`position` hardcoded `''` at 2 sites. D3 is now approved, so it is wired. |
| 5 | Existing public layout/components reused | ✅ Same server-component + `generateMetadata` + `BASE_URL` pattern as `app/events`. |
| 6 | Firestore indexes support public queries | ❌ **FINDING B** — Sprint 3's 3 indexes are all `organizerUid`-scoped. Public queries needed 5 new ones. Added. |
| 7 | No RBAC changes | ✅ `lib/team/` untouched. |
| 8 | No Firestore schema drift | ✅ Sprint 3's collections unchanged; Sprint 4 adds a new one additively. |
| 9 | Public routes do not expose organizer-only data | ✅ Enforced by pure field-by-field projections, unit-tested. |
| 10 | Design tokens/components reused | ✅ Only existing font-size tokens, `--primary-gradient`, `bg-card`, `border-border`… No new colour, size or radius. |

#### FINDING C (security) — certificates cannot be served publicly by bib

Reported **before** coding, because it changes a headline deliverable.

- A certificate is addressed by `registrationId`, which the existing code calls *"the
  capability token (non-guessable UUID)"* — that IS the access-control model.
- Attendee certificate access requires a session (`requireAttendee()`).
- A **bib is printed on a shirt and published on the leaderboard.**
- There is also no `eventSlug + bibNumber` index on `registrations`, and Sprint 3 explicitly
  deferred bib→registration matching, so the capability does not exist anyway.

Serving PDFs by bib would make every participant's certificate publicly enumerable — a
security regression in existing, working code. **Implemented safely:** the runner page shows
certificate availability and routes to the existing authenticated attendee flow. The
participant still downloads their certificate; they sign in first, as they already must.
A public-download design (per-result capability token emailed at publish) is sketched in
`RD-RACEOPS-PUBLIC-RESULTS.md` §6 and needs your approval.

#### FINDING D — the canonical model had no participant name

The leaderboard's "Runner" column and name search require a name; `NormalizedRaceResult`
had none. Added `participantName` as an **optional** field (defaults null) plus mapping
aliases. Results still work end-to-end for a timing file that carries only bibs.

### Root cause

Sprint 3 left results stored, ranked and published — and **visible to nobody**. There was no
participant surface and no read model safe to expose: the Sprint 3 rows are tenant-scoped,
exist regardless of publish state, and carry the operator's raw file content. Publishing had
to gain a second output.

### Architecture decisions

1. **The Official Snapshot is a physically separate collection**, not a view or a filter.
   Public code imports the snapshot repo and nothing else — `raceImportSessions` is not in
   the import graph of any public page.
2. **Build before flip.** The snapshot is written while the session is still `draft`, in
   `building` state (never publicly readable). `/publish` flips the session
   `draft→published` **and** the snapshot `building→live` in ONE transaction, so no public
   page can observe a half-copied race.
3. **Version, don't delete.** Entries carry `v`; public queries filter on it. A superseded
   version stops matching without a mass delete.
4. **The entry id IS the normalised bib** — bib lookup is one document GET, O(1).
5. **Projections are PURE and live outside the repo** (`utils/publicProjection.ts`), built
   field-by-field with no spreads. The security boundary is unit-tested without booting
   Firebase Admin. (This was a refactor forced by a failing test — the original design put
   the projection inside the Firestore repo, which made the boundary untestable. The test
   was right.)
6. **Server components by default** — the search box is the only client component on the
   entire public surface.

### Files created — 14 · Files modified — 12

Full table in [`RD-RACEOPS-PUBLIC-RESULTS.md`](./RD-RACEOPS-PUBLIC-RESULTS.md) §10.
Headlines: `types/snapshot.ts`, `repositories/snapshotRepo.ts`, `services/publicResults.ts`,
`services/certificateResults.ts` (D3), 4 public pages, 1 API route, 3 pure utils, 2 public
components, the organizer `VersionHistoryPanel`, and 1 test suite (+34 cases).

Modified outside the module: `firestore.rules` (+1 deny block), `firestore.indexes.json`
(+5 indexes), and — **under approved D3** — `lib/certificates/jobs.ts` and
`app/api/organizer/events/[eventId]/certificates/issue/route.ts`. Both certificate edits are
additive and fail-soft: with no published results the resolver returns `''`, so behaviour is
byte-identical to Sprint 3.

### Verification

| Gate | Baseline | Sprint 4 |
|---|---|---|
| `npx tsc --noEmit` (cache deleted) | 0 | **0** |
| `npm test` | 69 files / 627 | **70 files / 664, all passing** (+1 suite, +37 cases) |
| `npm run lint` — full | 204 (93 err / 111 warn) | **204 (93/111) — unchanged** |
| `npx eslint` — new + modified only | — | **exit 0, no output** |
| `npm run build` | 0 | **exit 0** — all 4 public routes + the new API route registered |
| `firestore.indexes.json` | 88 | valid JSON, **93** |

> **Note on a transient blocker.** Mid-sprint, `tsc` reported five errors in
> `components/event-templates/**` (a JSX comment placed among element *attributes*). None was
> a Race Operations file; they belong to the uncommitted `event-templates` refactor that has
> been in the working tree since Sprint 1, and `EventDetailsFramework.tsx` was written at
> 22:46 — three hours after the last Race Operations write. I did not touch them, since they
> were mid-edit and outside this sprint. They were repaired externally before the final
> verification run, and every gate above is green on the current tree. Worth knowing that the
> refactor is still uncommitted and can break the build again.

### Risks

| ID | Risk | Sev | Mitigation |
|---|---|---|---|
| S4-R1 | **Runner names from the timing file are published verbatim** — a misspelling or joke name goes public | **High** | Optional, trimmed, capped at 120 chars. **No moderation step exists.** A per-race "hide names" switch is the fix. |
| S4-R2 | ISR (5 min) means a freshly published race is invisible briefly | Med | Documented; on-demand revalidation at publish is the follow-up. |
| S4-R3 | Name search is prefix-only | Med | Stated in the field hint and the empty state. |
| S4-R4 | A snapshot left `building` blocks publish | Med | Publish returns a clear 422; rebuilding resumes and reuses the version. |
| S4-R5 | Public pages use the Admin SDK, so Firestore rules are not the enforcement layer | Med | Enforcement is the pure projection + `status == 'live'` on every read; rules stay deny-all as a tripwire. |
| S4-R6 | Superseded entries are never deleted | Low | Deliberate — bounded publish path, forensics preserved. |

### Not verified

- **No live Firestore run.** No snapshot has been built, gone live, or been read against a
  real database. Still the largest untested surface.
- **Firestore rules and indexes are still not deployed** (now 5 more indexes). The public
  pages will fail with index errors until `npm run deploy:firebase` runs.
- **No visual QA**, no Lighthouse/perf measurement, no SEO validation against a live crawler.
- **D3 not verified end-to-end** — the resolver is unit-tested and type-checked, but no
  certificate has actually been generated with a real published snapshot behind it.

### Stop condition

Sprint 4 ends here. **Not started:** Cloudflare R2, photos, finisher badges, AI photo
matching. The runner page deliberately renders **no** placeholders for photos or badges — an
empty promise on a participant-facing page is worse than no promise.

---

## Sprint 3 — Import Engine, Ranking & Publish

### Phase A audit result: **PASS** (no conflicts; stop condition not triggered)

| Check | Result |
|---|---|
| Parser architecture remains isolated | ✅ The entire `import/parsers/**` tree is imported by exactly **one** file — `import/index.ts`. Nothing else reaches into a provider. |
| `NormalizedRaceResult` remains the only downstream contract | ✅ `validation/engine.ts`, `validation/report.ts`, `ResultsPreviewTable`, `ValidationSummaryPanel` — grep for `ParsedTable` or `parsers/` across all four: **0 hits**. Downstream is provider-blind. |
| No Firestore writes currently exist | ✅ Grep for `adminDb`/`firebase-admin`/`FieldValue`/`setDoc`/`writeBatch`/`runTransaction` across the module: only **doc-comment** matches. Zero Firestore access. |
| No API duplication | ✅ Zero Race Ops routes existed, so duplication was impossible. |
| No RBAC changes | ✅ `lib/team/` clean at `git status`. |
| No Firestore schema drift | ✅ `firestore.rules` clean; `firestore.indexes.json` was modified by **pre-existing uncommitted work** (a `registrations` composite) — diffed and confirmed to contain **0** race references. |

One coupling noted and accepted: `validation/engine.ts` imports `isUnrecognisedStatus` from
`mapping/applyMapping`. That is a pure predicate, not a provider or a `ParsedTable`, and
reusing it is what stops the status-alias table being duplicated. Not a contract violation.

### Root cause

Sprint 2 ended at Preview: everything lived in the browser and nothing was persisted. An
organizer could prove a timing file was trustworthy but had no way to *keep* it. Sprint 3
adds the first backend pipeline — an immutable Import Session, durable draft results,
server-authoritative ranking, and a publish that is a single guarded status change.

### Architecture decisions

1. **The session is the unit of immutability.** `doc.create()` — not `set()` — so a session
   can never overwrite an existing one; a re-upload always mints a new session. Only the
   lifecycle fields mutate, each at most once.
2. **Results are a subcollection of their session.** A cancelled session's rows can never be
   mistaken for live data, and no mega top-level collection accumulates.
3. **Deterministic row ids (`row-{rowNumber}`).** This is the whole idempotency story: a
   chunk re-sent after a dropped connection overwrites identical documents instead of
   duplicating them.
4. **The server re-validates.** The browser's validation is a convenience; the same *pure*
   engine runs again server-side and only rows the server considers usable are stored. This
   is why the engine was written SDK-free in Sprint 2 — one implementation, two runtimes.
5. **The lifecycle guard is a pure function.** `decideTransition` is unit-tested without
   Firestore, and the publish transaction calls that same function — so the tested guard is
   the enforced guard, not a parallel re-implementation.
6. **Ranking is resumable, not batched-in-one-shot.** Firestore supplies the sort
   (`chipTimeMs`, `rowNumber` — a *total* order, so paging is gap-free across tied times) and
   `rankCursor` carries the tie state, so a tie split across a page boundary still resolves
   to one shared rank. Follows the existing drive-loop convention rather than adding new job
   infrastructure.
7. **Appending rows invalidates a completed ranking.** `rankedAt` is cleared, so publish is
   blocked until ranking re-runs. Failing closed is the safe direction.
8. **Publish reconciles before it commits.** `storedRows` is checked against an aggregate
   `count()` of the subcollection, so a half-written import cannot be published.

### Files created — 20

**Types (1)** — `types/session.ts`
**Lifecycle (1)** — `lifecycle/transitions.ts` (pure state machine)
**Ranking (2)** — `ranking/ties.ts` (tie policy) · `ranking/engine.ts`
**Repositories, server-only (3)** — `repositories/eventReadRepo.ts` (read-only by
construction) · `repositories/sessionRepo.ts` · `repositories/resultRepo.ts`
**Services, server-only (2)** — `services/authorize.ts` · `services/importService.ts`
**Client (3)** — `hooks/useSessionCommit.ts` · `components/SessionReviewPanel.tsx` ·
`utils/fileHash.ts`
**API routes (6)** — `sessions/route.ts` (POST create, GET list) ·
`sessions/[sessionId]/route.ts` (GET detail) · `.../results/route.ts` (POST append, GET page) ·
`.../rank/route.ts` · `.../publish/route.ts` · `.../cancel/route.ts`
**Tests (2, +39 cases)** — `tests/unit/raceOpsRanking.test.ts` ·
`tests/unit/raceOpsSessionLifecycle.test.ts`

### Files modified — 5

| File | Change | Why necessary |
|---|---|---|
| `firestore.rules` | **+1 block** — explicit `allow read, write: if false` for `raceImportSessions/{id}` **and** its `results/{rowId}` subcollection | The repo's stated doctrine: every server-only collection gets an explicit deny as a tripwire. Rules do **not** cascade, so the subcollection needs its own — exactly as the existing `registrations/{id}/auditLog` deny documents. Sprint 3 is the first sprint to create a collection, so this is the sprint that adds the denies. |
| `firestore.indexes.json` | **+3 composite indexes** | The three queries introduced (session list, duplicate-publish guard, ranking walk) cannot run without them. Purely additive; nothing existing altered. |
| `features/.../hooks/useResultImportSession.ts` | Added `fileHash`, computed via the new `hashFile` | The Import Session records file provenance, which the Sprint 2 hook did not capture. Non-fatal by design — `hashFile` returns `''` rather than throwing. |
| `features/.../publish-results/PublishResultsFlow.tsx` | Stage 7 (import → rank → review → publish) replaces the Sprint 3 placeholders; remaining placeholders re-scoped to genuinely-later work; selecting a different event/race now resets the commit too | This is the flow Sprint 3 exists to complete. |
| `features/.../index.ts` | Exports the lifecycle + ranking surface | Module public surface for routes and tests. |

**Outside the module: only the two Firestore config files.** No existing collection, route,
component, lib module or type was touched. `lib/team/` untouched — authorization reuses
`requireAdmin` with no new permission, and a unit test still pins `ALL_PERMISSIONS` at 9.

### Verification

| Gate | Baseline | Sprint 3 |
|---|---|---|
| `npx tsc --noEmit` (cache deleted) | 0 | **0** |
| `npm test` | 67 files / 588 | **69 files / 627, all passing** (+2 suites, +39 cases) |
| `npm run lint` — full | 204 (93 err / 111 warn) | **204 (93/111) — unchanged** |
| `npx eslint` — new + modified only | — | **exit 0, no output** |
| `npm run build` | 0 | **exit 0** |
| `firestore.indexes.json` | — | valid JSON, 88 indexes |

One new lint warning appeared mid-implementation — an unused parameter on a `passKeyOf(_r)`
helper I had written as an extensibility hook for multi-pass ranking. I removed the
abstraction rather than suppressing the warning: a session is single-pass by definition, so
the indirection was dead weight, and the honest single-sequence implementation is documented
instead. Baseline stayed at 204.

### Risks

| ID | Risk | Sev | Mitigation |
|---|---|---|---|
| S3-R1 | **Published results cannot be unpublished.** | **High** | Out of scope per the brief, so the mitigation is preventive: ranking must complete, `storedRows` must reconcile with the real count, a second published session per race is refused, and the organizer reviews statistics + ranking before the button is enabled. The UI says plainly that publish cannot be undone in this release. **Unpublish should be Sprint 4's first item.** |
| S3-R2 | Client-side mapping means the server cannot verify the mapping was applied faithfully; `fileHash` is self-reported | Med | Accepted and documented (`RD-RACEOPS-FIRESTORE.md` §7). The actor is the organizer publishing their own event's results — they could equally edit the source file. Every field that matters for integrity (event, race, tenant, actor, timestamps) is server-derived, and the server re-validates every row. Moving the parse server-side is the fix if results ever become platform-attested. |
| S3-R3 | A 50,000-row import is ~125 append calls + ~125 rank calls from the browser | Med | Every call is idempotent and resumable; the rank loop has a 500-call hard stop so a server bug cannot spin the tab forever. **Not measured at that scale** — see below. |
| S3-R4 | `storedRows` could drift from reality if a batch partially failed | Med | Firestore batches are atomic, so a partial batch is not possible; publish additionally reconciles against an aggregate `count()`. |
| S3-R5 | The new composite indexes must be deployed before the queries run | Med | Appended in the same sprint as the queries. **`npm run deploy:firebase` has not been run** — the first session list or rank call will fail with an index error until it is. |
| S3-R6 | `overallRank === passRank` today, which may not be what "Overall" was meant to mean | Med | Written from one sequence (so they cannot drift) and kept as separate fields (so they can diverge later). **Needs your decision** — `RD-RACEOPS-IMPORT-LIFECYCLE.md` §4. |
| S3-R7 | Ranking pages by `(chipTimeMs, rowNumber)`; a row whose `chipTimeMs` changed mid-walk could be skipped | Low | Rows are immutable once written, and appending rows resets `rankedAt` so a re-rank starts clean. |

### Not verified

- **No visual QA in a browser.** Gates are type-check, lint, unit test and build only.
- **No live Firestore run.** No session has actually been created, ranked or published
  against a real database — the repositories and transactions are exercised by type-checking
  and by the pure guards they delegate to, **not** by integration tests. This is the largest
  untested surface in the sprint.
- **Firestore rules and indexes are not deployed** (S3-R5).
- **No 50,000-row scale measurement** (S3-R3).
- **Concurrency (two simultaneous publishes) is proven by the pure guard + transaction
  design, not by an actual race test.**

### Stop condition

**Sprint 3 ends after Publish, as specified.** Not built and not started: public results,
participant result pages, certificate changes, photo upload, finisher badges, AI features,
unpublish/supersede, gender/age/category ranking, and bib-matching against real
`registrations`. Published results are stored and ranked but surfaced to **nobody** outside
the organizer's workspace.

---

## Sprint 2 — Result Import Foundation

### Phase A audit result: **PASS** (no conflicts, no stop condition triggered)

| # | Check | Result |
|---|---|---|
| 1 | Race Operations remains isolated | ✅ Only the 4 route files import the module, all via `features/race-operations/index.ts`. Verified by grep. |
| 2 | No unnecessary modification of existing modules | ✅ Sprint 1's only shared edits remain `config/navigation.ts` (+8) and `config/workspaceNav.ts` (+21), **0 deletions**. Sprint 2 adds none. |
| 3 | Sidebar follows existing nav architecture | ✅ One `WorkspaceNavGroup` in `WORKSPACE_NAV`; `Sidebar.tsx` still reads that array verbatim. |
| 4 | Event selector reuses existing Organizer Event APIs | ✅ `GET /api/organizer/events` only — already scoped to `users/{workspaceUid}/eventDrafts` behind `authorizeWorkspace`. No all-events query anywhere. |
| 5 | Race selector maps to existing Event Passes; **no new Distance model** | ✅ `EventPassSummary → RaceOpsRaceSelection`, from the same response. Grep for a distance entity: **0 hits.** |
| 6 | Reuse existing UI | ✅ / ⚠️ — see finding **F-1** |
| 7 | No new RBAC | ✅ `lib/team/` untouched; a unit test pins `ALL_PERMISSIONS` at 9 entries with no `raceOperations`. |
| 8 | No Firestore schema changes | ✅ No collection created, read, or written. |
| 9 | No Firestore rules changes | ✅ `firestore.rules` untouched. |
| 10 | No new API routes | ✅ **Zero.** Parsing is client-side; validation is self-contained by contract, so none is needed. |
| 11 | Canonical model verified before implementing | ✅ / ⚠️ — see findings **F-2**, **F-3** |

#### F-1 — There is still no shared upload component to reuse

Re-confirmed from Phase 0. Every upload site hand-rolls its own input:
`ImportParticipantsDrawer.tsx`, `BrandingMediaSection.tsx`, `TemplatesPanel.tsx`,
`PropertiesPanel.tsx`, `Step3View.tsx`. Extracting a shared one would mean editing five
production files, which this sprint forbids. **Resolution:** the module builds exactly
**one** `ResultsFileDropzone` and every Race Operations upload uses it. Everything else
is genuinely reused — see "UI reuse" below.

#### F-2 — `parseCsvText` exists but cannot serve results import

`lib/events/builder/contacts.ts` has a tested CSV parser. I probed it before writing
another, and it has three defects **against this use case** (it is entirely correct for
its own):

| Behaviour | Consequence for results |
|---|---|
| Lower-cases headers (`Bib No` → `bib no`) | The mapping UI could not show the organizer their own heading. |
| Filters blank lines before indexing | File row numbers shift — the validation report would cite rows the organizer cannot find. |
| Mis-parses RFC-4180 `""` (`"he said ""hi"""` → `he said hi`) | Silent data corruption. |
| Returns `[]` for a header-only file | Cannot be distinguished from a truly empty file — two different messages. |

**Resolution:** `parseCsvText` is left untouched. `readCsvText` is RFC-4180-correct,
preserves casing and row numbers, and hands off to the shared `tabulate` so CSV and Excel
share one header/row-number implementation. The reason is recorded in the file header so
a future "just reuse the other parser" refactor is informed, and three unit tests pin
each divergence.

#### F-3 — `category` is already overloaded three ways; `chipTime`/`gunTime` vs certificate `finishTime`

`category` exists as `passes[].raceDetails.category`, `registrations.bibCategory`, and
`identifierConfigs.pools[].by:'category'`. `NormalizedRaceResult.category` is a **fourth,
distinct** value — "as written in the uploaded file" — and is never reconciled against the
others. Documented at the definition site and in the data-flow doc.

Separately: `GenerateCertificateInput` has **one** `finishTime`, the canonical model has
**two** times. Which one feeds `{{finishTime}}` is a **Sprint 6** decision behind the
still-unapproved **D3**; recorded in the data-flow doc §7. Nothing in Sprint 2 depends on it.

No name collisions: `NormalizedRaceResult`, `ResultParser`, `ExcelParser`, `CSVParser`,
`chipTime`, `gunTime`, `ageGroup`, `sourceProvider` — **0 pre-existing hits each.**

---

### Root cause

Sprint 1 delivered navigation and selection; stages 3–6 were honest placeholders. A race
result arrives as a machine-generated export from a third-party timing system
(RaceTec, MyLaps, NovaRace, or a hand-rolled spreadsheet) — so there is no single format
to code against, and RegisterDesk had **no** result-shaped model, parser, or validator of
any kind. Sprint 2 builds the intake path: read any supported file, normalise it to one
internal model, prove it is trustworthy, and show the organizer exactly what it contains
— all **before** anything touches the database.

### Architecture decisions

1. **Provider architecture with a hard convergence point.** `ResultParser` implementations
   emit a provider-neutral `ParsedTable`; `applyMapping` turns that into
   `NormalizedRaceResult[]`. Validation, summary, report and preview read **only** the
   canonical model, so a new vendor provider requires no downstream change. Vendor
   providers may declare a `presetMapping` so a known layout skips manual mapping.
2. **Zero API routes.** `read-excel-file/browser` parses in the tab, and the brief
   mandates validation against uploaded data only. A route would have added a network
   hop, a payload limit and an attack surface for no gain. Sprint 3 (which must reach
   real registrations) is where the first route appears.
3. **Row numbers are file-true.** The header is row 1; blank interior rows are retained
   as empty rows. Everything the organizer is told cites a row they can actually open.
   Only trailing all-blank rows are trimmed, as a spreadsheet-export artefact.
4. **Bibs are strings.** `"0042"` and `"A101"` are both real bibs, and
   `registrations.bibNumber` is already a string. Numeric coercion would corrupt data.
5. **Errors block a row; warnings never do. Preview opens if ANY row is usable.** An
   all-or-nothing gate would hide the very file the organizer needs to inspect.
6. **A blank status becomes `finished`, not `dnf`.** Inventing a DNF for an incomplete
   row would silently alter results. It surfaces instead as `MISSING_TIME`.
7. **Own size/row caps.** `RESULTS_MAX_ROWS = 50,000`, `RESULTS_MAX_FILE_BYTES = 15 MB` —
   deliberately *not* the registration importer's 2,000 / 5 MB, which bound a
   human-entered template. A large city marathon legitimately exceeds 20,000 finishers.
8. **The validation report reuses `lib/utils/csv.ts`.** Every value in it is third-party
   file content, so the platform's formula/DDE-injection neutralisation must apply.

### Files created — 22

**Canonical model + tunables (2)**
`types/results.ts` · `import/constants.ts`

**Parser layer (8)**
`import/parsers/types.ts` (the `ResultParser` contract) · `import/parsers/tabulate.ts`
(shared matrix→table) · `import/parsers/registry.ts` (extension point + upload gate) ·
`import/parsers/csv/readCsvText.ts` · `import/parsers/csv/csvParser.ts` ·
`import/parsers/excel/excelParser.ts` · `import/parsers/excel/workbookErrors.ts` ·
`import/index.ts`

**Mapping (3)**
`import/mapping/aliases.ts` · `import/mapping/autoMap.ts` · `import/mapping/applyMapping.ts`

**Validation (4)**
`import/validation/types.ts` (issue catalogue) · `import/validation/engine.ts` ·
`import/validation/time.ts` · `import/validation/report.ts`

**Hook (1)** — `hooks/useResultImportSession.ts`

**Components (5)** — `components/ResultsFileDropzone.tsx` ·
`components/ColumnMappingPanel.tsx` · `components/ValidationSummaryPanel.tsx` ·
`components/ResultsPreviewTable.tsx` · `components/ImportSessionHistory.tsx`

**Tests (5, +136 cases)** — `tests/unit/raceOpsCsvParser.test.ts` ·
`raceOpsExcelParser.test.ts` · `raceOpsResultTime.test.ts` ·
`raceOpsColumnMapping.test.ts` · `raceOpsResultValidation.test.ts`

### Files modified — 3, all inside the module

| File | Change | Why necessary |
|---|---|---|
| `features/race-operations/publish-results/PublishResultsFlow.tsx` | Stages 3–6 swapped from `PlannedStage` placeholders to the live pipeline; stage-3/4 placeholders that Sprint 2 delivered were removed and the remaining ones re-scoped to Sprint 3/5; selecting a different event or race now resets the session. | This is the flow Sprint 2 exists to fill in. Resetting on re-selection matters: a file uploaded for the 10K must not silently carry over to the 21K. |
| `features/race-operations/types/index.ts` | Re-exports `./results` | Keeps `@/features/race-operations/types` as the module's single type entry point. |
| `features/race-operations/index.ts` | Exports the canonical model + pipeline functions | The module's public surface; route files and tests import only from here. |

**Files modified outside the module: 0.** No shared file, no existing module, no Firestore
artefact, no API route was touched in Sprint 2.

### UI reuse (no duplication)

| Need | Reused from |
|---|---|
| Cards, banners, empty/error states, status chips, spinner, skeleton, button styles | `components/ui` barrel |
| Preview table (frame/head/th/body/tr/td/state-row), pagination, status pills | `components/admin` barrel — its own header says "import from here — never re-hand-roll" |
| CSV cell encoding (+ injection defence) | `lib/utils/csv.ts` (`csvRow`) |
| Excel reading | `read-excel-file/browser`, existing dependency, same dynamic-import pattern as the registration importer |
| Class merging | `lib/utils/cn.ts` |
| Type scale, colours, radii, spacing | `styles/tokens.css` variables (font-size tokens, `success`/`warning`/`destructive`, `border-strong`) — **no new colour or size introduced** |
| Auth token | `components/auth/AuthProvider` (`useAuth`) |

Built new (justified): `ResultsFileDropzone` (F-1), `readCsvText` (F-2), and a native
`<select>` for mapping — `components/ui/CustomSelect` takes `options: string[]` and
selects **by label**, so it cannot express "canonical field → header" without a parallel
lookup; a native select is keyboard/SR-correct for free and fully token-styled.

### Verification

| Gate | Baseline | Sprint 2 |
|---|---|---|
| `npx tsc --noEmit` (cache deleted first) | 0 | **0** |
| `npm test` | 62 files / 460 tests | **67 files / 588 tests, all passing** (+5 suites, +128 cases) |
| `npm run lint` — full | 204 problems (93 err / 111 warn) | **204 (93/111) — unchanged** |
| `npx eslint` — new + modified files only | — | **exit 0, no output** |
| `npm run build` | exit 0 | **exit 0** |

Two tests failed on first run. Both were real and both are worth recording:

1. **`--` as the report's "no value" placeholder was wrong.** `lib/utils/csv.ts` treats a
   leading `-` as a formula trigger, so `csvCell` correctly rewrote `--` to `'--`. The
   encoder is right — that guard is the platform's CSV-injection defence and every value
   in this report is third-party content. The placeholder became `n/a`, which needs no
   escaping. This is a **documented deviation from the brief's example table.**
2. **A test asserted against correct behaviour.** It built 300 all-blank rows to check the
   report is never truncated, but `tabulate` correctly trims trailing all-blank rows as a
   spreadsheet artefact. The test was fixed to use non-blank invalid rows; the code was not
   changed.

### Risks

| ID | Risk | Sev | Mitigation |
|---|---|---|---|
| S2-R1 | A large file (50k rows) parsed on the main thread could stall the tab | Med | Row/byte caps enforced **before** parsing; the preview paints 50 rows at a time and the issue list is capped at 200 while the download stays complete. Not yet measured against a real 50k file — see "not verified". |
| S2-R2 | Auto-mapping guesses a column wrong (a lone "Time" is chip or gun?) | Med | Auto-map is a convenience, never an authority: every field is visibly shown and overridable, double-mapped columns are called out, and unmapped headers are reported as warnings rather than ignored. |
| S2-R3 | An organizer reads "validated" as "imported" | Med | Every surface says otherwise — a persistent banner, a summary line, and preview footer text all state that nothing has been saved. |
| S2-R4 | `mm:ss` vs `hh:mm:ss` ambiguity — is `45:00` 45 min or 45 h? | Low | Two parts always mean mm:ss (how timing systems write sub-hour results); pinned by unit test. `>240 h` is rejected outright, so a mis-mapped date cell cannot pass as a time. |
| S2-R5 | Session state lost on reload (mapping + history) | Low | Intended — the brief specifies session-only with no persistence. The UI says "cleared when you reload". |
| S2-R6 | A vendor provider registered after `csvParser` would never be reached for `.csv` | Low | Documented in `registry.ts`: vendor providers go **above** the generic ones and must sniff their own signature. |

### Not verified

- **No visual QA in a browser.** Every gate here is type-check, lint, unit test and build.
- **No real `.xlsx` fixture.** The Excel provider's workbook reader is *injected* and
  tested with literal sheet data; `read-excel-file` itself is exercised only at runtime.
  A real timing export has not been round-tripped.
- **No 50,000-row performance measurement** (S2-R1).
- **The access gate has not been exercised against a live `manager`/`checkin_staff`/
  `finance` team member** — only unit-tested.

### Screenshots

**None.** The brief requests them and I could not produce any honestly: capturing these
screens needs a signed-in organizer session with a published sports event and a real
timing file, which this environment has no credentials for. Rather than fabricate or
mock-up images, the flow is documented as an ASCII diagram in
[`RD-RACEOPS-DATAFLOW.md`](./RD-RACEOPS-DATAFLOW.md) §1. Point me at a dev login with a
seeded sports event (`npm run seed:demo` exists) and I will capture the six stages.

### Stop condition

**Sprint 2 ends at Preview, as specified.** Not built, and not started: Firestore writes,
import execution, ranking, publish, certificate integration, public results, participant
results, photos, finisher badges. Sprint 3 awaits approval.

---

## Sprint 1 — Foundation

Navigation (`🏁 Race Operations` in the Operations section), 4 pages (hub, Publish
Results, Photos, History), access gate (owner + admin via the existing matrix), event
selection from `GET /api/organizer/events`, race selection from event passes, and honest
`PlannedStage` placeholders for stages 3–6.

- Files created: 20 · Files modified outside the module: **2**
  (`config/navigation.ts`, `config/workspaceNav.ts`), append-only, +29/−0.
- Zero API routes, zero Firestore changes, zero RBAC changes.
- Gates: tsc 0 · 62 files/460 tests · lint 204 (unchanged) · build 0.
- Full record: [`RD-RACEOPS-01-phase0-audit.md`](./RD-RACEOPS-01-phase0-audit.md) §14.

## Sprint 0 — Phase 0 audit

Architecture, Firestore, UI and certificate audit; decisions **D1** (`features/` not
`src/`), **D2** (distance = pass), **D3** (certificate placeholder wiring — **still
unapproved**), **D4** (ranking scope), **D5** (`components/admin` reuse). No code.
