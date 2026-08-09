// RD-RACEOPS-01 Sprint 2 · Result import — internal surface.
//
// The pipeline, in order:
//
//   file ─ resolveParser ─▶ ResultParser ─▶ ParsedTable
//                                              │
//                              autoMapColumns ─┤ (+ manual override)
//                                              ▼
//                          applyMapping ─▶ NormalizedRaceResult[]
//                                              ▼
//                        validateResults ─▶ ValidationResult ─▶ summary · report · preview
//
// Sprint 2 STOPS at preview. Nothing here writes to Firestore, ranks, or publishes.

// ── Parsers (provider architecture) ─────────────────────────────────────────
export { RESULT_PARSERS, resolveParser }        from './parsers/registry'
export type { ResolveParserOutcome }            from './parsers/registry'
export { csvParser, CSV_PROVIDER_ID }           from './parsers/csv/csvParser'
export { readCsvText }                          from './parsers/csv/readCsvText'
export { excelParser, createExcelParser, selectResultsSheet, EXCEL_PROVIDER_ID } from './parsers/excel/excelParser'
export type { WorkbookReader, WorkbookSheet }   from './parsers/excel/excelParser'
export { tabulate, cellToString }               from './parsers/tabulate'
export type { RawCell }                         from './parsers/tabulate'
export { extensionOf }                          from './parsers/types'
export type { ResultParser, ResultFileSource, ParseOutcome } from './parsers/types'

// ── Mapping ─────────────────────────────────────────────────────────────────
export { autoMapColumns, missingRequiredFields } from './mapping/autoMap'
export type { AutoMapResult }                    from './mapping/autoMap'
export { applyMapping, resolveStatus, isUnrecognisedStatus } from './mapping/applyMapping'
export { HEADER_ALIASES, ALIAS_TO_FIELD, normalizeHeader }   from './mapping/aliases'

// ── Validation ──────────────────────────────────────────────────────────────
export { validateResults }                       from './validation/engine'
export type { ValidateOptions }                  from './validation/engine'
export { parseRaceTime, formatRaceTime, MAX_RACE_DURATION_MS } from './validation/time'
export type { TimeParseResult }                  from './validation/time'
export { VALIDATION_ISSUES, ISSUE_META, severityOf } from './validation/types'
export type {
  IssueSeverity, ValidationIssue, ValidationIssueCode,
  ValidatedRow, ValidationResult, ValidationSummary,
} from './validation/types'
export {
  buildValidationReportCsv, validationReportFilename,
  VALIDATION_REPORT_HEADERS, NO_VALUE_PLACEHOLDER,
} from './validation/report'

// ── Tunables ────────────────────────────────────────────────────────────────
export {
  RESULTS_ACCEPTED_EXTENSIONS, RESULTS_FILE_ACCEPT, RESULTS_MAX_FILE_BYTES,
  RESULTS_MAX_ROWS, RESULTS_PREVIEW_PAGE_SIZE, RESULTS_ISSUE_PREVIEW_LIMIT,
  VALIDATION_REPORT_FILENAME_STEM, formatMaxFileSize,
} from './constants'
