'use client'

// RD-RACEOPS-01 Sprint 2 · Session-only import history.
//
// Per the brief: "Import History — session only. No persistence." This lists the uploads
// made in THIS browser tab and is cleared by a reload. It is deliberately NOT the
// Race Operations History page (which stays an empty state until Sprint 8, when a
// durable `raceOperationsHistory` collection exists).

import { Card, StatusChip } from '@/components/ui'
import type { ImportSessionEntry } from '@/features/race-operations/hooks/useResultImportSession'

export interface ImportSessionHistoryProps {
  entries: readonly ImportSessionEntry[]
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
}

export function ImportSessionHistory({ entries }: ImportSessionHistoryProps) {
  if (entries.length === 0) return null

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-fs-md font-semibold text-foreground">This session</h3>
        <p className="text-fs-2xs text-muted-foreground">
          Not saved — cleared when you reload
        </p>
      </div>

      <ul className="mt-3 space-y-1.5">
        {entries.map(e => (
          <li
            key={e.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/60 px-3 py-2"
          >
            <span className="text-fs-2xs tabular-nums text-muted-foreground">{fmtTime(e.at)}</span>
            <span className="min-w-0 flex-1 truncate text-fs-sm font-medium text-foreground">
              {e.fileName}
            </span>
            {e.outcome === 'failed' ? (
              <StatusChip tone="danger">Not read</StatusChip>
            ) : (
              <>
                <span className="text-fs-sm text-muted-foreground">
                  {e.rowsFound.toLocaleString('en-IN')} rows · {e.validRows.toLocaleString('en-IN')} valid
                </span>
                <StatusChip tone={e.errorCount > 0 ? 'warning' : 'success'}>
                  {e.errorCount > 0
                    ? `${e.errorCount.toLocaleString('en-IN')} error${e.errorCount === 1 ? '' : 's'}`
                    : 'Clean'}
                </StatusChip>
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}
