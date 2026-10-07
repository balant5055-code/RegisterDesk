// RD-RACEOPS-01 Sprint 2 · Validation engine.
//
// PURE. No SDK, no I/O, and — per the sprint brief — **no Firestore query of any kind**.
// Validation is strictly self-contained: the uploaded data is checked against itself and
// against the canonical model. Cross-checking bibs against real registrations is a
// LATER sprint's job and is deliberately absent here.
//
// Consumes ONLY NormalizedRaceResult[], so a future RaceTec/MyLaps provider needs no
// change to this file.

import type {
  ColumnMapping, NormalizedRaceResult,
} from '@/features/race-operations/types/results'
import { NON_FINISHING_STATUSES } from '@/features/race-operations/types/results'
import { isUnrecognisedStatus } from '../mapping/applyMapping'
import { parseRaceTime } from './time'
import { parseRaceDistance } from './distance'
import {
  severityOf,
  type IssueSeverity, type ValidatedRow, type ValidationIssue, type ValidationIssueCode,
  type ValidationResult, type ValidationSummary,
} from './types'

function issue(
  code:      ValidationIssueCode,
  rowNumber: number | null,
  message:   string,
  value:     string,
  field?:    string,
): ValidationIssue {
  return { code, severity: severityOf(code), rowNumber, message, value, field }
}

/** A row is malformed when every mapped-or-not cell is blank — a structural artefact
 *  rather than data. Interior blank rows reach here because the tabulator keeps them so
 *  row numbers stay faithful to the file. */
function isBlankRow(r: NormalizedRaceResult): boolean {
  return Object.values(r.rawRow).every(v => v === '')
}

/** Identity used for duplicate-ROW detection (as opposed to duplicate-BIB): the whole
 *  original row, so two genuinely identical lines are caught even without a bib. */
function rowFingerprint(r: NormalizedRaceResult): string {
  return Object.keys(r.rawRow).sort().map(k => `${k}=${r.rawRow[k]}`).join('')
}

/** Bibs are compared case-insensitively and trimmed: "a101" and "A101" are one bib. */
function bibKey(bib: string): string {
  return bib.trim().toUpperCase()
}

export interface ValidateOptions {
  /** Headers present in the file but mapped to no canonical field. Reported as
   *  informational warnings so nothing is silently ignored. */
  unmappedHeaders?: readonly string[]
  /** The mapping in force — recorded so the caller can prove what was validated. */
  mapping?:         ColumnMapping
  /**
   * RD-RACEOPS-RESULTS-04 · headers RegisterDesk calculates for itself (provider ranks,
   * pace, speed), from `autoMapColumns`. Reported as "calculated by RegisterDesk" rather
   * than as unknown columns — a provider export is 20 columns wide and 12 of them are
   * theirs to print and ours to compute.
   */
  calculatedHeaders?: readonly string[]
  /**
   * RD-RACEOPS-RESULTS-04 · issues raised while reading the SPLITS sheet and attaching it
   * (orphan bib, duplicate checkpoint, backwards times, finish mismatch). They are produced
   * by `import/splits/splitSheet.ts`, which is the only layer that sees both sheets, and are
   * folded in here so one summary and one report describe the whole upload.
   */
  splitIssues?:     readonly {
    code: ValidationIssueCode; severity: IssueSeverity; rowNumber: number | null
    bibNumber: string | null;  message: string
  }[]
}

export function validateResults(
  results: readonly NormalizedRaceResult[],
  options: ValidateOptions = {},
): ValidationResult {
  const rows: ValidatedRow[] = []

  // ── Pass 1: whole-set indexes (duplicates need every row before deciding) ────
  const bibRowNumbers = new Map<string, number[]>()
  const fingerprintRowNumbers = new Map<string, number[]>()

  for (const r of results) {
    if (r.bibNumber) {
      const key = bibKey(r.bibNumber)
      const list = bibRowNumbers.get(key)
      if (list) list.push(r.rowNumber)
      else bibRowNumbers.set(key, [r.rowNumber])
    }
    if (!isBlankRow(r)) {
      const fp = rowFingerprint(r)
      const list = fingerprintRowNumbers.get(fp)
      if (list) list.push(r.rowNumber)
      else fingerprintRowNumbers.set(fp, [r.rowNumber])
    }
  }

  // ── Pass 2: per-row rules ───────────────────────────────────────────────────
  for (const r of results) {
    const rowIssues: ValidationIssue[] = []

    if (isBlankRow(r)) {
      rowIssues.push(issue('MALFORMED_ROW', r.rowNumber,
        'This row is empty. Remove it, or fill in the bib number and time.', ''))
      rows.push({ result: r, issues: rowIssues, usable: false })
      continue
    }

    // ── Bib ──
    if (!r.bibNumber) {
      rowIssues.push(issue('MISSING_BIB', r.rowNumber,
        'No bib number in this row.', '', 'bibNumber'))
    } else {
      const others = (bibRowNumbers.get(bibKey(r.bibNumber)) ?? []).filter(n => n !== r.rowNumber)
      if (others.length > 0) {
        rowIssues.push(issue('DUPLICATE_BIB', r.rowNumber,
          `Bib ${r.bibNumber} also appears on row ${others.length === 1 ? others[0] : others.join(', ')}.`,
          r.bibNumber, 'bibNumber'))
      }
    }

    // ── Chip time. Not expected for DNF / DNS / DQ. ──
    const timeExpected = !NON_FINISHING_STATUSES.includes(r.status)
    if (timeExpected) {
      if (r.chipTimeRaw === null) {
        rowIssues.push(issue('MISSING_TIME', r.rowNumber,
          'No finish time in this row. Add a time, or mark the row DNF / DNS / DQ.', '', 'chipTime'))
      } else if (r.chipTimeMs === null) {
        const parsed = parseRaceTime(r.chipTimeRaw)
        const outOfRange = !parsed.ok && parsed.reason === 'out_of_range'
        rowIssues.push(outOfRange
          ? issue('TIME_OUT_OF_RANGE', r.rowNumber,
              'This finish time is outside the plausible range for a race.', r.chipTimeRaw, 'chipTime')
          : issue('INVALID_TIME', r.rowNumber,
              'This finish time could not be read. Use hh:mm:ss (for example 01:48:32).',
              r.chipTimeRaw, 'chipTime'))
      }
    }

    // ── Gun time (optional; problems are warnings, never blockers) ──
    if (r.gunTimeRaw !== null && r.gunTimeMs === null) {
      rowIssues.push(issue('INVALID_GUN_TIME', r.rowNumber,
        'This gun time could not be read and will be ignored.', r.gunTimeRaw, 'gunTime'))
    }
    if (r.gunTimeMs !== null && r.chipTimeMs !== null && r.gunTimeMs < r.chipTimeMs) {
      rowIssues.push(issue('GUN_BEFORE_CHIP', r.rowNumber,
        'Gun time is earlier than chip time, which is usually the two columns being swapped.',
        r.gunTimeRaw ?? '', 'gunTime'))
    }

    // ── RD-RACEOPS-RESULTS-04 · distance ──
    // Only a value that was SUPPLIED and could not be read is a problem; no column at all
    // is the normal case and stays silent (pace and speed are then simply unavailable).
    if (r.distanceRaw !== null && r.distanceMeters === null) {
      const parsed = parseRaceDistance(r.distanceRaw)
      rowIssues.push(issue('INVALID_DISTANCE', r.rowNumber,
        !parsed.ok && parsed.reason === 'no_unit'
          ? `Distance "${r.distanceRaw}" has no unit. Write 21.1 KM, 10 Km or 5000 m — RegisterDesk will not guess between kilometres and metres.`
          : `Distance "${r.distanceRaw}" could not be read. Write it as a number and a unit, for example 10 KM.`,
        r.distanceRaw, 'distance'))
    }

    // ── Status ──
    if (r.statusRaw !== null && isUnrecognisedStatus(r.statusRaw)) {
      rowIssues.push(issue('UNRECOGNISED_STATUS', r.rowNumber,
        `Status "${r.statusRaw}" was not recognised. Use Finished, DNF, DNS or DQ — this row is not imported until it is corrected.`,
        r.statusRaw, 'status'))
    }

    // ── Duplicate whole row ──
    const dupRows = (fingerprintRowNumbers.get(rowFingerprint(r)) ?? []).filter(n => n !== r.rowNumber)
    if (dupRows.length > 0) {
      rowIssues.push(issue('DUPLICATE_ROW', r.rowNumber,
        `This row is identical to row ${dupRows.length === 1 ? dupRows[0] : dupRows.join(', ')}.`,
        '', undefined))
    }

    rows.push({
      result: r,
      issues: rowIssues,
      usable: !rowIssues.some(i => i.severity === 'error'),
    })
  }

  // ── File-level issues ───────────────────────────────────────────────────────
  const fileIssues: ValidationIssue[] = [
    ...(options.unmappedHeaders ?? [])
      .filter(h => h !== '')
      .map(header => issue('UNMAPPED_COLUMN', null,
        `Column "${header}" is not used and will be ignored.`, header)),
    // RD-RACEOPS-RESULTS-04 · named, not merely ignored.
    ...(options.calculatedHeaders ?? [])
      .filter(h => h !== '')
      .map(header => issue('PROVIDER_CALCULATED_COLUMN', null,
        `Column "${header}" is calculated by RegisterDesk from the times and distance, so it is not imported.`, header)),
  ]

  // RD-RACEOPS-RESULTS-04 · splits issues are attributed to the RESULT row where one is
  // known, so a blocking split problem makes that row unusable and cannot be published.
  const splitIssues: ValidationIssue[] = (options.splitIssues ?? []).map(s => ({
    code: s.code, severity: s.severity, rowNumber: s.rowNumber, message: s.message,
    value: s.bibNumber ?? '', field: undefined,
  }))
  if (splitIssues.length > 0) {
    for (const row of rows) {
      const mine = splitIssues.filter(s => s.rowNumber === row.result.rowNumber)
      if (mine.length === 0) continue
      row.issues = [...row.issues, ...mine]
      row.usable = row.usable && !mine.some(i => i.severity === 'error')
    }
  }
  // Anything not attributable to a result row (a missing column, an orphan bib) is file-level.
  const rowNumbers = new Set(rows.map(r => r.result.rowNumber))
  const unattributed = splitIssues.filter(s => s.rowNumber === null || !rowNumbers.has(s.rowNumber))

  const allIssues = [...rows.flatMap(r => r.issues), ...fileIssues, ...unattributed]

  const errorRows   = rows.filter(r => !r.usable).length
  const warningRows = rows.filter(r => r.usable && r.issues.length > 0).length

  const summary: ValidationSummary = {
    rowsFound:    rows.length,
    validRows:    rows.filter(r => r.usable && r.issues.length === 0).length,
    warningRows,
    errorRows,
    errorCount:   allIssues.filter(i => i.severity === 'error').length,
    warningCount: allIssues.filter(i => i.severity === 'warning').length,
  }

  return {
    rows,
    issues: allIssues,
    summary,
    // Preview is offered whenever at least one row is usable. Rows with errors are
    // still shown and clearly flagged — the organizer needs to SEE what is wrong, and
    // hiding the file behind an all-or-nothing gate would make the report unusable.
    canPreview: summary.rowsFound > 0 && rows.some(r => r.usable),
  }
}
