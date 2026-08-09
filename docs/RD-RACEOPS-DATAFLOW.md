# Race Operations — Data Flow

Current as of **Sprint 2 (Result Import Foundation)**.
Architecture rationale: [`RD-RACEOPS-01-phase0-audit.md`](./RD-RACEOPS-01-phase0-audit.md).
Change log: [`RD-RACEOPS-CHANGELOG.md`](./RD-RACEOPS-CHANGELOG.md).

---

## 1. End-to-end flow as built

```
┌─ ORGANIZER ─────────────────────────────────────────────────────────────────┐
│  Sidebar ▸ Operations ▸ 🏁 Race Operations ▸ Publish Results               │
└───────────────────────────┬────────────────────────────────────────────────┘
                            ▼
                  RaceOpsAccessGate                      UI gate: owner | admin
                            │                            mirrors requireAdmin()
                            ▼
   ┌────────────── 1 · SELECT EVENT ──────────────┐
   │ useRaceOpsEvents                             │
   │   GET /api/organizer/events   ← EXISTING     │  already workspace-scoped:
   │   (cursor-paginated, limit 50)               │  users/{workspaceUid}/eventDrafts
   │   → EventListItem[] → RaceOpsEventRow[]      │
   │   resolveRaceOpsEligibility(lifecycle,races) │  ineligible events shown, disabled
   └───────────────────────┬──────────────────────┘
                           ▼
   ┌────────────── 2 · SELECT RACE ───────────────┐
   │ event.passes  ←  SAME response, no 2nd call  │  DISTANCE **IS** A PASS (D2)
   │   EventPassSummary → RaceOpsRaceSelection    │  no distance entity exists
   └───────────────────────┬──────────────────────┘
                           ▼
   ┌────────────── 3 · UPLOAD ────────────────────┐
   │ ResultsFileDropzone  (.csv | .xlsx, ≤15 MB)  │
   │            ▼                                 │
   │ resolveParser(file)   extension→size→provider│  PDF/ZIP → "planned" message
   └───────────────────────┬──────────────────────┘
                           ▼
   ┌────────────── PARSER LAYER (providers) ──────┐
   │                                              │
   │   ResultParser (interface)                   │
   │      ├─ excelParser  read-excel-file/browser │→ selectResultsSheet → matrix
   │      └─ csvParser    readCsvText (RFC-4180)  │→ matrix
   │                        │                     │
   │                    tabulate()                │  ONE header + row-number impl
   │                        ▼                     │
   │                   ParsedTable                │  headers (original casing)
   │                   {headers,rows,provider,    │  rows[].rowNumber = FILE row
   │                    sheetName}                │  header is row 1
   └───────────────────────┬──────────────────────┘
                           ▼
   ┌────────────── 4 · COLUMN MAPPING ────────────┐
   │ autoMapColumns(headers)                      │  alias table, 2 passes
   │   + parser.presetMapping (vendor providers)  │
   │   + ColumnMappingPanel (manual override)     │  in memory ONLY — no persistence
   │                        ▼                     │
   │ applyMapping(table, mapping)                 │
   │                        ▼                     │
   │        ***  NormalizedRaceResult[]  ***      │  ◀── THE canonical model
   └───────────────────────┬──────────────────────┘
                           ▼
   ┌────────────── 5 · VALIDATION ────────────────┐
   │ validateResults(results, {unmappedHeaders})  │
   │   pass 1: whole-set indexes (dup bib / row)  │  NO FIRESTORE QUERY — by contract
   │   pass 2: per-row rules                      │  self-contained, pure
   │                        ▼                     │
   │ ValidationResult {rows, issues, summary,     │
   │                   canPreview}                │
   │   → ValidationSummaryPanel   (4 tiles)       │
   │   → buildValidationReportCsv → download      │  csvRow() from lib/utils/csv
   └───────────────────────┬──────────────────────┘
                           ▼
   ┌────────────── 6 · PREVIEW ───────────────────┐
   │ ResultsPreviewTable                          │  components/admin table primitives
   │   Bib · Chip · Gun · Status · Notes          │  errors shown, never hidden
   └───────────────────────┬──────────────────────┘
                           ▼
                    ██  SPRINT 2 ENDS  ██
                           │
      ┌────────────────────┴─────────────────────┐
      │  NOT BUILT: import · ranking · publish   │
      │  certificates · public results · photos  │
      └──────────────────────────────────────────┘
```

## 2. What crosses which boundary

| Boundary | Payload | Notes |
|---|---|---|
| Browser → server | **nothing new** | Sprint 2 adds no API route. Only the two pre-existing GETs are called. |
| File → parser | `ResultFileSource` (`{name,size,text?,arrayBuffer?}`) | Minimal structural shape, so providers are testable without a `File`. |
| Parser → mapping | `ParsedTable` | Provider-neutral. Original header casing, file-true row numbers. |
| Mapping → everything downstream | `NormalizedRaceResult[]` | The only shape validation/preview/(future ranking) may read. |
| Validation → UI / report | `ValidationResult` | Row issues + file issues + summary. |
| → Firestore | **nothing** | No write, no read, no rule, no index, no collection. |

## 3. The canonical model

```ts
NormalizedRaceResult {
  rowNumber       // 1-based FILE row (header = 1) — survives blank/malformed rows
  bibNumber       // string|null — string because "0042" and "A101" are both real
  chipTimeMs      // number|null — whole ms
  gunTimeMs       // number|null
  chipTimeRaw     // string|null — the organizer's own text, echoed in report/preview
  gunTimeRaw      // string|null
  status          // 'finished'|'dnf'|'dns'|'dq'
  statusRaw       // string|null
  gender          // string|null  ┐
  category        // string|null  ├ FROM THE FILE ONLY (Phase 0 · D4)
  ageGroup        // string|null  ┘
  rawRow          // Record<string,string> — full original row
  sourceProvider  // 'csv'|'excel'|<future vendor id>
}
```

**Naming precision.** `category` here is the competition category **as written in the
uploaded file**. RegisterDesk already uses "category" for three other things —
`passes[].raceDetails.category` (pass builder), `registrations.bibCategory` (identifier
label), `identifierConfigs.pools[].by:'category'` (pool strategy). This is a fourth,
distinct value and is never reconciled against any of them. Same for `gender` /
`ageGroup`: never inferred from `registrations.attendee.formResponses`, which is optional
and unindexed.

## 4. Adding a provider (the extensibility contract)

```ts
// 1. implement
export const raceTecParser: ResultParser = {
  id: 'racetec', label: 'RaceTec', extensions: ['.csv'],
  presetMapping: { bibNumber: 'RaceNo', chipTime: 'NetTime' },   // known layout
  supports(file) { /* sniff the vendor signature */ },
  parse(file)    { /* → ParsedTable */ },
}

// 2. register — vendor providers ABOVE the generic ones
export const RESULT_PARSERS = [raceTecParser, excelParser, csvParser]
```

Nothing else changes. Validation, the summary, the report and the preview are untouched
because they read `NormalizedRaceResult` only. `resolveParser` picks the **first**
provider whose `supports()` is true, so a vendor provider claiming `.csv` must sniff its
own signature and let `csvParser` remain the fallback.

## 5. Validation rules

| Code | Severity | Fires when |
|---|---|---|
| `MISSING_BIB` | error | bib cell empty |
| `DUPLICATE_BIB` | error | same bib on another row (case-insensitive); **both** rows flagged, each naming the other |
| `MISSING_TIME` | error | no chip time **and** status is not DNF/DNS/DQ |
| `INVALID_TIME` | error | chip time present but unreadable |
| `TIME_OUT_OF_RANGE` | error | parses, but ≤0 or >240 h |
| `MALFORMED_ROW` | error | every cell blank |
| `DUPLICATE_ROW` | warning | whole row identical to another |
| `UNRECOGNISED_STATUS` | warning | status cell present but unknown → treated as Finished |
| `INVALID_GUN_TIME` | warning | gun time unreadable (ignored, never blocking) |
| `GUN_BEFORE_CHIP` | warning | gun < chip — usually swapped columns |
| `UNMAPPED_COLUMN` | warning | file-level; a header feeds no canonical field |

Errors block a row (`usable: false`). Warnings never do. **Preview is offered whenever at
least one row is usable** — rows with errors are still displayed and flagged, because the
organizer needs to see what is wrong.

## 6. Accepted time formats

`hh:mm:ss` · `h:mm:ss` · `mm:ss` (minutes may exceed 59) · `.fff` or `,fff` fraction ·
Excel fraction-of-day (`0.075`) · Excel `Date` duration cells → `hh:mm:ss(.mmm)` in UTC.
Rejected: `ABC`, `DNF`, `1:2:3:4`, `00:00:00`, negatives, `>240 h`, day-fractions ≥ 1.

## 7. Open decision carried forward

**The certificate module has ONE `finishTime` field; the canonical model has TWO times.**
`GenerateCertificateInput` (`lib/certificates/generate.ts:57`) takes a single
`finishTime: string`, while `NormalizedRaceResult` carries `chipTimeMs` **and**
`gunTimeMs`. Whichever is chosen becomes what `{{finishTime}}` renders. Recommendation:
**chip time**, since it is the participant's own net time and what a finisher expects to
see on a certificate — with gun time available as a future distinct placeholder. This is
a **Sprint 6** decision and is gated behind the still-unapproved Phase 0 decision **D3**.
Nothing in Sprint 2 depends on it.
