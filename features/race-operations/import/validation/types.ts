// RD-RACEOPS-01 Sprint 2 · Validation vocabulary.
//
// SDK-free. Every issue the engine can raise is declared ONCE here, so the summary,
// the on-screen list and the downloadable CSV report all describe the same thing.

import type { NormalizedRaceResult } from '@/features/race-operations/types/results'

export type IssueSeverity = 'error' | 'warning'

/**
 * Every issue code the engine can emit.
 *
 * ERRORS block progress. WARNINGS do not — they are things the organizer should look
 * at but which do not make the data unusable.
 */
export type ValidationIssueCode =
  // ── errors ──
  | 'MISSING_BIB'
  | 'DUPLICATE_BIB'
  | 'MISSING_TIME'
  | 'INVALID_TIME'
  | 'MALFORMED_ROW'
  | 'TIME_OUT_OF_RANGE'
  // ── RD-RACEOPS-RESULTS-04 · distance + splits (errors) ──
  | 'INVALID_DISTANCE'
  | 'SPLIT_MISSING_BIB'
  | 'SPLIT_MISSING_NAME'
  | 'SPLIT_NO_TIME'
  | 'SPLIT_INVALID_TIME'
  | 'DUPLICATE_SPLIT'
  | 'ORPHAN_SPLIT_BIB'
  | 'TOO_MANY_SPLITS'
  | 'SPLIT_TIME_DECREASING'
  // ── warnings ──
  | 'DUPLICATE_ROW'
  | 'UNRECOGNISED_STATUS'
  | 'INVALID_GUN_TIME'
  | 'GUN_BEFORE_CHIP'
  | 'UNMAPPED_COLUMN'
  // ── RD-RACEOPS-RESULTS-04 · splits (warnings) ──
  | 'SPLIT_INVALID_TIME_OF_DAY'
  | 'SPLIT_INVALID_DISTANCE'
  | 'SPLIT_FINISH_MISMATCH'
  | 'PROVIDER_CALCULATED_COLUMN'

export interface ValidationIssueMeta {
  code:     ValidationIssueCode
  severity: IssueSeverity
  /** Short label used in the report's "Issue" column and the on-screen list. */
  label:    string
}

/** THE issue catalogue. No severity or label is written anywhere else. */
export const VALIDATION_ISSUES: readonly ValidationIssueMeta[] = [
  { code: 'MISSING_BIB',         severity: 'error',   label: 'Missing bib'                },
  { code: 'DUPLICATE_BIB',       severity: 'error',   label: 'Duplicate bib'              },
  { code: 'MISSING_TIME',        severity: 'error',   label: 'Missing time'               },
  { code: 'INVALID_TIME',        severity: 'error',   label: 'Invalid time'               },
  { code: 'TIME_OUT_OF_RANGE',   severity: 'error',   label: 'Time out of range'          },
  { code: 'MALFORMED_ROW',       severity: 'error',   label: 'Malformed row'              },
  { code: 'DUPLICATE_ROW',       severity: 'warning', label: 'Duplicate row'              },
  // RD-RACEOPS-02E · blocking: an unknown status word must not be published as a finish.
  { code: 'UNRECOGNISED_STATUS', severity: 'error',   label: 'Unrecognised status'        },
  { code: 'INVALID_GUN_TIME',    severity: 'warning', label: 'Invalid gun time'           },
  { code: 'GUN_BEFORE_CHIP',     severity: 'warning', label: 'Gun time before chip time'  },
  { code: 'UNMAPPED_COLUMN',     severity: 'warning', label: 'Unrecognised column'        },
  // ── RD-RACEOPS-RESULTS-04 ──
  // A distance that cannot be read is an ERROR rather than a dropped value: pace and speed
  // are published from it, and a blank distance beside a filled-in column reads as a bug.
  { code: 'INVALID_DISTANCE',     severity: 'error',   label: 'Distance needs a unit'      },
  { code: 'SPLIT_MISSING_BIB',    severity: 'error',   label: 'Split without a bib'        },
  { code: 'SPLIT_MISSING_NAME',   severity: 'error',   label: 'Split without a name'       },
  { code: 'SPLIT_NO_TIME',        severity: 'error',   label: 'Split without a time'       },
  { code: 'SPLIT_INVALID_TIME',   severity: 'error',   label: 'Split time unreadable'      },
  { code: 'DUPLICATE_SPLIT',      severity: 'error',   label: 'Duplicate checkpoint'       },
  { code: 'ORPHAN_SPLIT_BIB',     severity: 'error',   label: 'Splits for an unknown bib'  },
  { code: 'TOO_MANY_SPLITS',      severity: 'error',   label: 'Too many checkpoints'       },
  { code: 'SPLIT_TIME_DECREASING', severity: 'error',  label: 'Split times go backwards'   },
  { code: 'SPLIT_INVALID_TIME_OF_DAY', severity: 'warning', label: 'Time of day unreadable' },
  { code: 'SPLIT_INVALID_DISTANCE',    severity: 'warning', label: 'Split distance needs a unit' },
  { code: 'SPLIT_FINISH_MISMATCH',     severity: 'warning', label: 'Last split differs from the chip time' },
  // Not a problem at all — the honest name for a column RegisterDesk works out itself.
  { code: 'PROVIDER_CALCULATED_COLUMN', severity: 'warning', label: 'Calculated by RegisterDesk' },
] as const

export const ISSUE_META: Readonly<Record<ValidationIssueCode, ValidationIssueMeta>> =
  Object.fromEntries(VALIDATION_ISSUES.map(i => [i.code, i])) as Record<ValidationIssueCode, ValidationIssueMeta>

export function severityOf(code: ValidationIssueCode): IssueSeverity {
  return ISSUE_META[code].severity
}

/** One issue on one row (or on the file, when `rowNumber` is null). */
export interface ValidationIssue {
  code:      ValidationIssueCode
  severity:  IssueSeverity
  /** null ⇒ a file-level issue (e.g. an unmapped column) rather than a row issue. */
  rowNumber: number | null
  /** Organizer-facing sentence. */
  message:   string
  /** The offending value, echoed verbatim from the file. '' when not applicable. */
  value:     string
  /** Which canonical field the issue concerns, when it concerns one. */
  field?:    string
}

/** A row plus its issues. `usable` = has no error. */
export interface ValidatedRow {
  result: NormalizedRaceResult
  issues: ValidationIssue[]
  usable: boolean
}

export interface ValidationSummary {
  rowsFound:    number
  validRows:    number
  warningRows:  number
  errorRows:    number
  /** Total issue counts (a row can carry several). */
  errorCount:   number
  warningCount: number
}

export interface ValidationResult {
  rows:    ValidatedRow[]
  /** Row issues + file-level issues, in row order then file order. */
  issues:  ValidationIssue[]
  summary: ValidationSummary
  /** True when there is at least one usable row and no blocking error. */
  canPreview: boolean
}
