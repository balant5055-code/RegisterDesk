// RD-RACEOPS-01 Sprint 2 · Downloadable validation report (CSV).
//
// PURE — returns a string. The organizer hands this file back to their timing company,
// so it must be complete and must cite the row numbers they see in their own file.
//
// Cell encoding REUSES lib/utils/csv.ts (`csvRow`) — the platform's single source of
// truth for CSV escaping, which also neutralises formula/DDE injection. That matters
// here: every value echoed into this report is third-party file content, so a cell
// beginning `=` or `@` must not execute when the report is opened in Excel.

import { csvRow } from '@/lib/utils/csv'
import { ISSUE_META, type ValidationIssue } from './types'

export const VALIDATION_REPORT_HEADERS = ['Row', 'Severity', 'Issue', 'Field', 'Value', 'Detail'] as const

/**
 * Placeholder for "there was no value".
 *
 * The sprint brief illustrates this as `--`. It cannot be, and the reason is a feature
 * rather than a limitation: `-` is a formula trigger in `lib/utils/csv.ts`, so `csvCell`
 * correctly rewrites `--` to `'--` to stop Excel evaluating it. Bypassing that guard
 * would remove the platform's CSV-injection defence from a report built entirely out of
 * third-party file content. `n/a` carries the same meaning and needs no escaping.
 */
export const NO_VALUE_PLACEHOLDER = 'n/a'

/**
 * Builds the full report. Never truncated — the on-screen issue list is capped for
 * rendering, but the downloaded file always contains every issue.
 *
 * Ordered by row number, with file-level issues last, so it reads top-to-bottom against
 * the organizer's own spreadsheet.
 */
export function buildValidationReportCsv(issues: readonly ValidationIssue[]): string {
  const ordered = [...issues].sort((a, b) => {
    if (a.rowNumber === null && b.rowNumber === null) return 0
    if (a.rowNumber === null) return 1
    if (b.rowNumber === null) return -1
    return a.rowNumber - b.rowNumber
  })

  const lines = [csvRow([...VALIDATION_REPORT_HEADERS])]

  for (const i of ordered) {
    lines.push(csvRow([
      i.rowNumber === null ? 'File' : i.rowNumber,
      i.severity === 'error' ? 'Error' : 'Warning',
      ISSUE_META[i.code]?.label ?? i.code,
      i.field ?? '',
      i.value === '' ? NO_VALUE_PLACEHOLDER : i.value,
      i.message,
    ]))
  }

  // CRLF: Excel is the near-universal consumer of this report on Windows.
  return `${lines.join('\r\n')}\r\n`
}

/** Filename an organizer will recognise, e.g. `validation-report-10K-2026-07-26.csv`. */
export function validationReportFilename(stem: string, raceName: string, isoDate: string): string {
  const safeRace = raceName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'race'
  return `${stem}-${safeRace}-${isoDate}.csv`
}
