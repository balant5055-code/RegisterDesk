# RD-ANALYTICS-12-08 — Reports Registry Metadata & Consolidation

**Status:** complete. Metadata consolidation only — no runtime behaviour changed. Not
committed, not pushed, not deployed. No Firestore rules, indexes or collections touched; the
`settlementRequests` index from 12-07 remains **undeployed**.

---

## 1 · The problem

The registry described a report as `{ kind, label, permission, build }` — enough to dispatch
it, nothing a UI could render from. So `app/(dashboard)/dashboard/finance/reports/page.tsx`
carried its own array of the same eight reports with the labels restated:

```ts
interface ReportDef { kind: string; label: string; statement?: boolean }
const REPORTS: ReportDef[] = [ { kind: 'transactions', label: 'Transactions' }, …8 entries ]
```

Two definitions of one thing, free to drift, and adding a report meant remembering both.
`payout-statement` existed only in that UI list and its own route — described nowhere on the
server.

## 2 · Metadata model

`ReportDefinition` in `lib/reports/types.ts`. Nine fields, each present because something
consumes it — nothing speculative, and no configuration framework:

| Field | Why |
|---|---|
| `kind`, `label` | identity and display; previously duplicated |
| `description` | the workspace needs one factual line per report |
| `category: 'financial'` | single-member union — a non-financial report must be added deliberately, not by typo |
| `permission` | the existing `TeamPermission`; now defined once |
| `formats` | `Exclude<ExportFormat,'json'>[]` — reuses the existing union rather than restating it |
| `scope: 'workspace' \| 'event'` | every current report is workspace-wide; the workspace needs the distinction |
| `dateRange` | true for all eight |
| `output: 'table' \| 'statement'` | **replaces the UI's `statement?: boolean`** — see below |
| `capability?: never` | reserved, set by nothing; documented for future operational reports |

**`output` is not decoration.** The UI's `statement: true` flag drove four behaviours: which
route to call, which preview to render, which formats to offer, and whether background export
is available. Removing the duplicate list without modelling that would have lost all four.

**Categories deliberately stop at `financial`.** No `registrations` / `operations` /
`communications` / `participants` were added — no report belongs to them yet.

## 3 · Where the metadata lives, and why it is split

| File | Contents |
|---|---|
| `lib/reports/catalog.ts` | **new, pure** — `REPORT_CATALOG` (8 entries) + `REPORT_DEFINITIONS`. No Firestore, no builders. |
| `lib/reports/registry.ts` | `ORGANIZER_REPORTS` **derived from the catalogue** + `TABLE_BUILDERS`; re-exports the catalogue for server callers. |

**The split was forced by a real hazard, caught before it shipped.** `page.tsx` is a client
component. `registry.ts` *value*-imports the builders, which import `@/lib/firebase/admin` — so
importing the registry from the page would have pulled `firebase-admin` into the browser
bundle. `tsc` does not catch this. The same trap is documented in
`lib/discovery/completedDestinations.ts`, which was split for exactly this reason; this follows
that precedent rather than inventing one. Tests 18 and 19 pin it.

**Label and permission now have one definition.** `ORGANIZER_REPORTS` is built from
`REPORT_CATALOG`, so the runtime map and the UI cannot disagree — proven structurally by test 8.

## 4 · payout-statement registration

**Registered in the catalogue; deliberately NOT added to the dispatch map.**

It does not share the table contract: `buildPayoutStatement` returns a `PayoutStatement`, not a
`ReportTable`; it renders through `payoutStatementPdf`, not `serializeTables`; and it answers on
its own route. Adding it to `ORGANIZER_REPORTS` would have made it resolvable at
`/api/organizer/reports/payout-statement` **and** acceptable to the export-job create route —
both of which would then call `meta.build` and receive the wrong shape. That would be a
behaviour change disguised as consolidation.

So registration here means *described once, in the catalogue the UI reads*. **No second builder
was created, no calculation was touched, and its route is byte-identical.** Tests 10-13 cover
permission (`settlements`), builder identity, PDF-only format, and route behaviour.

## 5 · Finance Reports UI

The hardcoded array is gone; `REPORTS = REPORT_DEFINITIONS`. Preserved exactly:

- **order** — catalogue declaration order matches the old array, asserted by test 20; no
  `order` field was added, because the object is already ordered and a second source of
  ordering could disagree with it
- **labels** — same strings, now defined once
- **formats** — `['pdf']` for the statement, `['csv','xlsx','pdf']` otherwise
- **filters, async export, previews, visual design** — untouched; `def.statement` became
  `isStatement(def)` reading `output === 'statement'`

No route changed, no page renamed, no workspace built.

## 6 · Authorization — unchanged

The UI knowing a permission is **presentation, not authorization**. Nothing server-side was
removed or relaxed:

- sync route: `authorizeWorkspace(req, meta.permission)` **before** `meta.build` — ordering
  asserted by test 22
- export job: `permissionForExportJob` still reads `ORGANIZER_REPORTS[job.kind]?.permission`
  (test 23)
- download: the 12-03/12-04 boundary is untouched; its 40-case suite still passes
- gate-role exclusion, admin finance authorization: untouched
- **no second permission map** — test 24 asserts the registry contains no literal permission
  string of its own

## 7 · Format verification

Traced, not assumed. Table reports genuinely support csv/xlsx/pdf via `serializeTables`;
`payout-statement`'s route contains `format !== 'pdf'` → 400, so it is `['pdf']` alone.

**`json` is deliberately absent from `formats`.** Every route answers `format=json` for in-app
preview, but that is a route capability and not a download — listing it would make the field
mean two things. Documented rather than invented, per the brief. Tests 14-16.

## 8 · Tests

`tests/unit/reportRegistryMetadata.test.ts` — **24 cases, all passing**.

| Brief | Covered by |
|---|---|
| A complete metadata | 1, 2 |
| B seven kinds still registered | 5 |
| C payout-statement exactly once | 10 |
| D no duplicates | 3 |
| E permissions match prior behaviour | 6 |
| F builder dispatch correct (by identity) | 7 |
| G formats match exporters | 14, 15, 16 |
| H UI list removed | 17, 20, 21 |
| I existing authorization tests pass | see §9 |
| J unknown kinds fail closed | 9 |
| §18 payout regression | 10-13 |
| — one definition of label/permission | 8, 24 |
| — catalogue purity / client-bundle safety | 18, 19 |
| — server still authorizes, before reading | 22, 23 |

No existing test was weakened or deleted.

## 9 · Validation

| Gate | Result |
|---|---|
| focused — `reportRegistryMetadata.test.ts` | **24 passed** |
| existing report/finance tests (4 files) | **123 passed** |
| full unit suite | **327 files, 8909 collected: 8908 passed, 1 skipped, 0 failed, 0 timeouts** |
| TypeScript | **PASS** — exit 0, no errors |
| ESLint | **PASS** |
| production build | **PASS** — exit 0, 68s; `/dashboard/finance/reports` present |
| emulator | **not run** — no emulator-backed code path changed |

The first full-unit run showed 5 failures; all five passed in isolation (144/144) and the
second full run was clean at 327 files. They were cold-start timeouts under a loaded machine —
4 reported `Test timed out in 5000ms`, and the fifth (`publicShellMigration`, another session's
file) passed in isolation too. Nothing was changed to make them pass.

## 10 · Files changed

| File | Why |
|---|---|
| `lib/reports/types.ts` | `ReportDefinition` + `ReportCategory` / `ReportScope` / `ReportOutput` |
| `lib/reports/catalog.ts` | **New** — the pure catalogue (8 entries) |
| `lib/reports/registry.ts` | `ORGANIZER_REPORTS` derived from the catalogue; re-exports it |
| `app/(dashboard)/dashboard/finance/reports/page.tsx` | Reads `REPORT_DEFINITIONS`; `statement` flag → `output` |
| `tests/unit/reportRegistryMetadata.test.ts` | **New** — 24 cases |
| `docs/RD-ANALYTICS-12-08-IMPLEMENTATION.md` | This document |

**Deviation from the brief, stated:** it anticipated extending `registry.ts` in place. A new
`catalog.ts` was required because the client page cannot import a module that value-imports
`firebase-admin`. This is one small pure module, not a framework, and follows an existing
in-repo precedent.

## 11 · Not touched

Report builders, financial calculations, ledger/refund/settlement/GST/payout semantics,
per-event exports, admin reports, print exports, routes, Analytics, report history, scheduled
reports, storage, `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `package.json`,
`package-lock.json`.

**No deploy. No commit. No push. No index deployed.**
