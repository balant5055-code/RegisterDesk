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
export { excelParser, createExcelParser, selectResultsSheet, selectSplitsSheet, EXCEL_PROVIDER_ID } from './parsers/excel/excelParser'
// RD-RACEOPS-RESULTS-06 · the PDF provider and its PURE reconstruction layer. The server-only
// extractor (parsers/pdf/extract.ts) is deliberately NOT re-exported here: this barrel is
// imported by client code, and `unpdf` must never be reachable from a browser bundle.
export { pdfParser, createPdfParser, configurePdfParser, PDF_PROVIDER_ID } from './parsers/pdf/pdfParser'
export { reconstruct } from './parsers/pdf/reconstruct'
export { linesOfPage, linesOfDocument, isPageFurniture, medianLineGap } from './parsers/pdf/lines'
export { readTable, findHeaderLine, cellsOf, rowFor, repeatsHeader } from './parsers/pdf/table'
export { readBlocks } from './parsers/pdf/blocks'
export { PDF_PARSE_MESSAGES, pdfError } from './parsers/pdf/types'
export type { PdfPage, PdfTextItem, PdfLine, PdfParseError, PdfParseErrorCode, PdfReconstruction } from './parsers/pdf/types'
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
// RD-RACEOPS-RESULTS-04
export { parseSplitElapsed, parseTimeOfDay }     from './validation/time'
export type { TimeOfDayResult }                  from './validation/time'
export { parseRaceDistance, formatDistance, MAX_DISTANCE_METRES } from './validation/distance'
export type { DistanceParseResult }              from './validation/distance'
export {
  autoMapSplitColumns, parseSplitSheet, attachSplits, sanitizeSplits, splitKey, FINISH_TOLERANCE_MS,
} from './splits/splitSheet'
export type { SplitAutoMapResult, ParsedSplitSheet, SplitIssue, AttachSplitsOutcome } from './splits/splitSheet'
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
  PDF_SUPPORT_NOTE, RESULTS_ACCEPTED_EXTENSIONS, RESULTS_FILE_ACCEPT, RESULTS_MAX_FILE_BYTES, formatAcceptedExtensions,
  RESULTS_MAX_ROWS, RESULTS_PREVIEW_PAGE_SIZE, RESULTS_ISSUE_PREVIEW_LIMIT,
  VALIDATION_REPORT_FILENAME_STEM, formatMaxFileSize,
} from './constants'
