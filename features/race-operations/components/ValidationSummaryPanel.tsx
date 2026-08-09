'use client'

// RD-RACEOPS-01 Sprint 2 · Validation summary + issue list + report download.
//
// States plainly that nothing has been imported, because nothing has: Sprint 2 performs
// no Firestore write. The downloadable CSV is the artefact the organizer sends back to
// their timing company.

import { useCallback } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Download, FileWarning } from 'lucide-react'
import { Banner, Card, buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import {
  RESULTS_ISSUE_PREVIEW_LIMIT, VALIDATION_REPORT_FILENAME_STEM,
  buildValidationReportCsv, validationReportFilename,
  type ValidationResult,
} from '@/features/race-operations/import'

export interface ValidationSummaryPanelProps {
  validation: ValidationResult
  raceName:   string
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

export function ValidationSummaryPanel({ validation, raceName }: ValidationSummaryPanelProps) {
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

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Rows found"  value={summary.rowsFound}    tone="neutral" icon={FileWarning}   />
        <Tile label="Valid rows"  value={summary.validRows}    tone="success" icon={CheckCircle2}  />
        <Tile label="Warnings"    value={summary.warningCount} tone="warning" icon={AlertTriangle} />
        <Tile label="Errors"      value={summary.errorCount}   tone="danger"  icon={AlertCircle}   />
      </div>

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
                    {' — '}
                    {i.message}
                  </p>
                  {i.value !== '' && (
                    <p className="mt-0.5 truncate font-mono text-fs-2xs text-muted-foreground">
                      value: {i.value}
                    </p>
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
