'use client'

// RD-RACEOPS-01 Sprint 2 · Validation summary + issue list + report download.
//
// States plainly that nothing has been imported, because nothing has: Sprint 2 performs
// no Firestore write. The downloadable CSV is the artefact the organizer sends back to
// their timing company.

import { useCallback, type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Download, FileWarning, ListChecks, Loader2, XCircle } from 'lucide-react'
import { Banner, Card, buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import {
  RESULTS_ISSUE_PREVIEW_LIMIT, VALIDATION_REPORT_FILENAME_STEM,
  buildValidationReportCsv, validationReportFilename,
  type ValidationResult,
} from '@/features/race-operations/import'
import { RESULT_FIELD_LABEL, type ResultField } from '@/features/race-operations/types/results'
import type { StartListCheckState } from '@/features/race-operations/hooks/useStartListCheck'

export interface ValidationSummaryPanelProps {
  validation: ValidationResult
  raceName:   string
  /** RD-RACEOPS-02C · the server's dry-run start-list check; every number shown is its own. */
  startList?: StartListCheckState
  /**
   * RD-RACEOPS-RESULTS-04 · what the optional Splits sheet contributed, or null when the
   * workbook had no such sheet.
   *
   * Shown because a silent success is indistinguishable from a silent miss: an organizer who
   * filled in checkpoints needs to see that they were read, and one who expected them to be
   * read needs to see that they were not.
   */
  splits?: { participants: number; rows: number } | null
}

/** One line of the preview: a tick when the count is zero problems, a cross otherwise. */
function CheckLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-fs-sm">
      {ok
        ? <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
        : <XCircle className="size-4 shrink-0 text-destructive" aria-hidden />}
      <span className={ok ? 'text-foreground' : 'font-medium text-foreground'}>{children}</span>
    </li>
  )
}

/** What to change, per issue code — the correction column of the error list. */
const CORRECTION: Record<string, string> = {
  MISSING_BIB:         'Add the bib number, or remove the row.',
  DUPLICATE_BIB:       'Keep one row per bib; delete the extra.',
  MISSING_TIME:        'Add the chip time, or set Status to DNF / DNS / DQ.',
  INVALID_TIME:        'Write the time as hh:mm:ss, for example 01:48:32.',
  TIME_OUT_OF_RANGE:   'Check the column is a duration, not a date or a clock time.',
  MALFORMED_ROW:       'Delete the empty row.',
  DUPLICATE_ROW:       'Delete one of the identical rows.',
  UNRECOGNISED_STATUS: 'Use Finished, DNF, DNS or DQ (or leave it blank for a finisher). LAP, OTL, DNP and similar words are not results RegisterDesk can publish.',
  INVALID_GUN_TIME:    'Write the gun time as hh:mm:ss, or leave it blank.',
  GUN_BEFORE_CHIP:     'Check the Chip Time and Gun Time columns are not swapped.',
  UNMAPPED_COLUMN:     'No change needed unless this column holds a supported field — map it above.',
  // RD-RACEOPS-RESULTS-04 · distance, and the optional Splits sheet.
  INVALID_DISTANCE:    'Write the distance with its unit — 21.1 KM, 10 Km or 5000 m. Without a unit RegisterDesk will not guess between kilometres and metres.',
  PROVIDER_CALCULATED_COLUMN: 'No change needed. RegisterDesk works out positions, pace and speed itself from the times, the distance and the start list.',
  SPLIT_MISSING_BIB:   'Every row on the Splits sheet needs the bib it belongs to.',
  SPLIT_MISSING_NAME:  'Name the checkpoint — 5KM, Lap 2, T1.',
  SPLIT_NO_TIME:       'Give the checkpoint an Elapsed Time (time since the start) or a Split Time.',
  SPLIT_INVALID_TIME:  'Write checkpoint times as hh:mm:ss. 0:00 is allowed for the start line.',
  DUPLICATE_SPLIT:     'A checkpoint may appear once per bib; delete the extra row.',
  ORPHAN_SPLIT_BIB:    'Add the bib to the Results sheet, or remove its rows from the Splits sheet.',
  TOO_MANY_SPLITS:     'Reduce the number of checkpoints for this bib.',
  SPLIT_TIME_DECREASING: 'Check the elapsed times: they must grow along the course.',
  SPLIT_INVALID_TIME_OF_DAY: 'Time of Day is a clock reading between 00:00:00 and 23:59:59 — use Elapsed Time for time since the start.',
  SPLIT_INVALID_DISTANCE: 'Add the unit to the checkpoint distance, or leave it blank.',
  SPLIT_FINISH_MISMATCH: 'Check which value is the finish. Both were kept exactly as you supplied them.',
}

interface TileProps {
  label: string
  value: number
  tone:  'neutral' | 'success' | 'warning' | 'danger'
  icon:  typeof CheckCircle2
}

const TONE_CLS: Record<TileProps['tone'], { box: string; icon: string }> = {
  neutral: { box: 'bg-muted',              icon: 'text-muted-foreground' },
  success: { box: 'bg-success/10',         icon: 'text-success' },
  warning: { box: 'bg-warning/10',         icon: 'text-warning' },
  danger:  { box: 'bg-destructive/10',     icon: 'text-destructive' },
}

function Tile({ label, value, tone, icon: Icon }: TileProps) {
  const cls = TONE_CLS[tone]
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
      <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', cls.box)} aria-hidden>
        <Icon className={cn('size-4', cls.icon)} />
      </div>
      <div className="min-w-0">
        <p className="text-[20px] font-bold leading-none text-foreground">
          {value.toLocaleString('en-IN')}
        </p>
        <p className="mt-0.5 text-fs-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

/** The bib on a given file row, for the error list. */
function rowBib(validation: ValidationResult, rowNumber: number | null): string | null {
  if (rowNumber === null) return null
  return validation.rows.find(r => r.result.rowNumber === rowNumber)?.result.bibNumber ?? null
}

export function ValidationSummaryPanel({ validation, raceName, startList, splits }: ValidationSummaryPanelProps) {
  const { summary, issues } = validation

  const downloadReport = useCallback(() => {
    const csv  = buildValidationReportCsv(issues)
    const name = validationReportFilename(
      VALIDATION_REPORT_FILENAME_STEM,
      raceName,
      new Date().toISOString().slice(0, 10),
    )
    // Client-side download — no server round trip, nothing stored.
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [issues, raceName])

  const shown = issues.slice(0, RESULTS_ISSUE_PREVIEW_LIMIT)
  const hidden = issues.length - shown.length

  const n = (v: number) => v.toLocaleString('en-IN')
  // Distinct bibs, not rows: a bib on two rows is ONE duplicate bib.
  const duplicateBibs = new Set(issues.filter(i => i.code === 'DUPLICATE_BIB').map(i => i.value.trim().toUpperCase())).size
  const invalidTimes  = issues.filter(i => i.code === 'INVALID_TIME' || i.code === 'TIME_OUT_OF_RANGE' || i.code === 'MISSING_TIME').length
  const usableRows    = validation.rows.filter(r => r.usable).length

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Rows found"  value={summary.rowsFound}    tone="neutral" icon={FileWarning}   />
        <Tile label="Valid rows"  value={summary.validRows}    tone="success" icon={CheckCircle2}  />
        <Tile label="Warnings"    value={summary.warningCount} tone="warning" icon={AlertTriangle} />
        <Tile label="Errors"      value={summary.errorCount}   tone="danger"  icon={AlertCircle}   />
      </div>

      {/* RD-RACEOPS-RESULTS-04 · the Splits sheet, when the workbook had one. */}
      {splits && (
        <p className="text-fs-sm text-muted-foreground">
          {splits.rows === 0
            ? 'The Splits sheet is empty, so no checkpoint times will be published.'
            : `${n(splits.rows)} checkpoint ${splits.rows === 1 ? 'row' : 'rows'} read for ${n(splits.participants)} ${splits.participants === 1 ? 'participant' : 'participants'}. They appear on each participant's own result page, never on the leaderboard.`}
        </p>
      )}

      {/* ── RD-RACEOPS-02C · the preview, in plain checks. File-level figures come from the
          validation that just ran in this browser; start-list figures come from the server's
          dry run and are shown only once it has answered — never estimated. */}
      <Card>
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted" aria-hidden>
            <ListChecks className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-fs-md font-semibold text-foreground">{n(summary.rowsFound)} rows detected</h3>
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2" aria-live="polite">
              <CheckLine ok={summary.errorCount === 0}>{n(usableRows)} usable result row{usableRows === 1 ? '' : 's'}</CheckLine>
              <CheckLine ok={duplicateBibs === 0}>{n(duplicateBibs)} duplicate bib{duplicateBibs === 1 ? '' : 's'}</CheckLine>
              <CheckLine ok={invalidTimes === 0}>{n(invalidTimes)} missing or invalid time{invalidTimes === 1 ? '' : 's'}</CheckLine>
              {startList?.phase === 'done' && (
                <>
                  <CheckLine ok>{n(startList.result.matched)} bib{startList.result.matched === 1 ? '' : 's'} on the start list</CheckLine>
                  <CheckLine ok={startList.result.unknownRunner === 0}>{n(startList.result.unknownRunner)} unknown bib{startList.result.unknownRunner === 1 ? '' : 's'}</CheckLine>
                  <CheckLine ok={startList.result.wrongRace === 0}>{n(startList.result.wrongRace)} bib{startList.result.wrongRace === 1 ? '' : 's'} entered in a different race</CheckLine>
                  {!startList.result.rosterTruncated && (
                    <CheckLine ok>{n(startList.result.missingResult)} registered participant{startList.result.missingResult === 1 ? '' : 's'} without a result</CheckLine>
                  )}
                </>
              )}
            </ul>
            {startList?.phase === 'checking' && (
              <p className="mt-2 flex items-center gap-2 text-fs-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Checking bibs against the start list…
              </p>
            )}
            {startList?.phase === 'error' && (
              <p className="mt-2 text-fs-sm text-muted-foreground">
                {startList.message} The check runs again during Import.
              </p>
            )}
            {startList?.phase === 'done' && startList.result.rosterTruncated && (
              <p className="mt-2 text-fs-sm text-muted-foreground">
                This event&apos;s start list is larger than the check can read in one pass, so participants without a result were not counted.
              </p>
            )}
            {startList?.phase === 'done' && startList.result.issues.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {startList.result.issues.filter(i => i.code !== 'MISSING_RESULT').slice(0, 50).map((i, idx) => (
                  <li key={`${i.code}-${i.bibNumber}-${idx}`} className="grid gap-x-3 rounded-lg border border-border/60 px-3 py-2 text-fs-sm sm:grid-cols-[6rem_6rem_1fr]">
                    <span className="font-semibold text-foreground">{i.rowNumber === null ? 'Start list' : `Row ${i.rowNumber}`}</span>
                    <span className="font-mono text-foreground">Bib {i.bibNumber}</span>
                    <span className="text-muted-foreground">
                      {i.detail}{' '}
                      {i.code === 'UNKNOWN_RUNNER' && 'Correct the bib, or add the participant to the event before importing.'}
                      {i.code === 'WRONG_RACE' && 'Move the row to that race\'s file, or correct the bib.'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>

      <Banner tone={summary.errorCount > 0 ? 'warning' : 'info'} title="Nothing has been imported">
        This is a validation pass only. No results have been saved, and nothing has been
        published. {summary.errorCount > 0
          ? 'Download the report below and send it to your timing provider to correct the flagged rows.'
          : 'Review the preview below before continuing.'}
      </Banner>

      {issues.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-fs-md font-semibold text-foreground">
                Issues found
              </h3>
              <p className="mt-0.5 text-fs-sm text-muted-foreground">
                {summary.errorCount.toLocaleString('en-IN')} error
                {summary.errorCount === 1 ? '' : 's'} and {summary.warningCount.toLocaleString('en-IN')} warning
                {summary.warningCount === 1 ? '' : 's'} across {summary.rowsFound.toLocaleString('en-IN')} rows.
              </p>
            </div>
            <button
              type="button"
              onClick={downloadReport}
              className={buttonVariants({ variant: 'outline', size: 'sm', className: 'shrink-0' })}
            >
              <Download className="size-4" aria-hidden />
              Download report (CSV)
            </button>
          </div>

          <ul className="mt-4 space-y-1.5">
            {shown.map((i, idx) => (
              <li
                key={`${i.code}-${i.rowNumber ?? 'file'}-${idx}`}
                className="flex items-start gap-2.5 rounded-lg border border-border/60 px-3 py-2"
              >
                <span
                  className={cn(
                    'mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                    i.severity === 'error'
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-warning/10 text-warning',
                  )}
                >
                  {i.severity}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-fs-sm text-foreground">
                    <span className="font-semibold">
                      {i.rowNumber === null ? 'File' : `Row ${i.rowNumber}`}
                    </span>
                    {rowBib(validation, i.rowNumber) && <> · <span className="font-mono">Bib {rowBib(validation, i.rowNumber)}</span></>}
                    {i.field && <> · {RESULT_FIELD_LABEL[i.field as ResultField] ?? i.field}</>}
                    {' — '}
                    {i.message}
                  </p>
                  {i.value !== '' && (
                    <p className="mt-0.5 truncate font-mono text-fs-2xs text-muted-foreground">
                      value: {i.value}
                    </p>
                  )}
                  {CORRECTION[i.code] && (
                    <p className="mt-0.5 text-fs-2xs text-muted-foreground">{CORRECTION[i.code]}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {hidden > 0 && (
            <p className="mt-3 text-fs-sm text-muted-foreground">
              Showing the first {RESULTS_ISSUE_PREVIEW_LIMIT.toLocaleString('en-IN')} issues.
              The downloaded report contains all {issues.length.toLocaleString('en-IN')}.
            </p>
          )}
        </Card>
      )}
    </div>
  )
}
