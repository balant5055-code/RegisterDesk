'use client'

// RD-RACEOPS-01 Sprint 2 · Preview table — the end of Sprint 2.
//
// Built from the shared table primitives in components/admin (TableFrame/THead/Th/
// TBody/Tr/Td/TableStateRow), whose barrel says: "Import from here — never re-hand-roll
// these in a page." They are presentation-only with no admin coupling.
//
// Rows carrying errors are shown, not hidden — the organizer needs to see exactly what
// is wrong. Nothing here writes anything.

import { useMemo, useState } from 'react'
import { AlertCircle, AlertTriangle } from 'lucide-react'
import {
  TBody, Td, TableFrame, TableStateRow, THead, Th, Tr, LoadMoreButton, StatusPill,
  type PillTone,
} from '@/components/admin'
import { cn } from '@/lib/utils/cn'
import { RACE_RESULT_STATUS_LABEL, type RaceResultStatus } from '@/features/race-operations/types/results'
import {
  RESULTS_PREVIEW_PAGE_SIZE, formatRaceTime, type ValidatedRow,
} from '@/features/race-operations/import'

/** Result status → the EXISTING StatusPill tone vocabulary (components/admin/StatusPill).
 *  No new colour is introduced: finished reads as success, DNF as a caution, DQ as a
 *  hard stop, DNS as neutral because not starting is not a fault. */
const STATUS_TONE: Record<RaceResultStatus, PillTone> = {
  finished: 'success',
  dnf:      'warning',
  dns:      'neutral',
  dq:       'danger',
}

export interface ResultsPreviewTableProps {
  rows: readonly ValidatedRow[]
}

type Filter = 'all' | 'issues'

export function ResultsPreviewTable({ rows }: ResultsPreviewTableProps) {
  const [filter, setFilter]   = useState<Filter>('all')
  const [visible, setVisible] = useState(RESULTS_PREVIEW_PAGE_SIZE)

  const filtered = useMemo(
    () => (filter === 'issues' ? rows.filter(r => r.issues.length > 0) : rows),
    [rows, filter],
  )
  const page    = filtered.slice(0, visible)
  const hasMore = filtered.length > page.length
  const issueRowCount = useMemo(() => rows.filter(r => r.issues.length > 0).length, [rows])

  return (
    <div className="space-y-3">
      {issueRowCount > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter preview rows">
          {([
            { key: 'all'    as Filter, label: `All rows (${rows.length.toLocaleString('en-IN')})` },
            { key: 'issues' as Filter, label: `Needs attention (${issueRowCount.toLocaleString('en-IN')})` },
          ]).map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => { setFilter(key); setVisible(RESULTS_PREVIEW_PAGE_SIZE) }}
              aria-pressed={filter === key}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-fs-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                filter === key
                  ? 'border-primary/50 bg-primary/[0.06] text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <TableFrame>
        <THead>
          <Th scope="col">Row</Th>
          <Th scope="col">Bib</Th>
          <Th scope="col">Chip Time</Th>
          <Th scope="col">Gun Time</Th>
          <Th scope="col">Status</Th>
          <Th scope="col">Notes</Th>
        </THead>
        <TBody>
          {page.length === 0 ? (
            <TableStateRow colSpan={6}>No rows to show.</TableStateRow>
          ) : page.map(({ result, issues, usable }) => {
            const hasError = !usable
            return (
              <Tr key={result.rowNumber}>
                <Td className="tabular-nums text-muted-foreground">{result.rowNumber}</Td>

                <Td className={cn('font-medium', !result.bibNumber && 'text-destructive')}>
                  {result.bibNumber ?? '—'}
                </Td>

                <Td className="tabular-nums">
                  {result.chipTimeMs !== null
                    ? formatRaceTime(result.chipTimeMs)
                    : <span className={cn(result.chipTimeRaw ? 'font-mono text-destructive' : 'text-muted-foreground')}>
                        {result.chipTimeRaw ?? '—'}
                      </span>}
                </Td>

                <Td className="tabular-nums">
                  {result.gunTimeMs !== null
                    ? formatRaceTime(result.gunTimeMs)
                    : <span className="text-muted-foreground">{result.gunTimeRaw ?? '—'}</span>}
                </Td>

                <Td>
                  <StatusPill tone={STATUS_TONE[result.status]}>
                    {RACE_RESULT_STATUS_LABEL[result.status]}
                  </StatusPill>
                </Td>

                <Td>
                  {issues.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <ul className="space-y-1">
                      {issues.map((i, idx) => (
                        <li key={`${i.code}-${idx}`} className="flex items-start gap-1.5">
                          {i.severity === 'error'
                            ? <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                            : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />}
                          <span className={cn('text-fs-2xs leading-snug', hasError ? 'text-foreground' : 'text-muted-foreground')}>
                            {i.message}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Td>
              </Tr>
            )
          })}
        </TBody>
      </TableFrame>

      {hasMore && (
        <LoadMoreButton
          onClick={() => setVisible(v => v + RESULTS_PREVIEW_PAGE_SIZE)}
          label={`Show ${Math.min(RESULTS_PREVIEW_PAGE_SIZE, filtered.length - page.length)} more rows`}
        />
      )}

      <p className="text-fs-sm text-muted-foreground">
        Showing {page.length.toLocaleString('en-IN')} of {filtered.length.toLocaleString('en-IN')} rows.
        Nothing on this screen has been saved.
      </p>
    </div>
  )
}
