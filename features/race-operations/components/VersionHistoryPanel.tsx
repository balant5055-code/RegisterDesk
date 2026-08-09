'use client'

// RD-RACEOPS-01 Sprint 4 · Version history — ORGANIZER ONLY, READ-ONLY.
//
// Every published import session for a race IS a version, so this needs no new storage: it
// reads the sessions that Sprint 3 already keeps immutably. Public pages never see it.
//
// No rollback UI, per the brief — the list is informational only.

import { Clock, FileText, User } from 'lucide-react'
import { Card, EmptyState, StatusChip } from '@/components/ui'
import {
  IMPORT_SESSION_STATUS_LABEL, type ImportSessionView,
} from '@/features/race-operations/types/session'

const TONE = {
  published: 'success',
  draft:     'warning',
  cancelled: 'danger',
} as const

export interface VersionHistoryPanelProps {
  sessions: readonly ImportSessionView[]
  raceName?: string
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

export function VersionHistoryPanel({ sessions, raceName }: VersionHistoryPanelProps) {
  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No imports yet"
        description={raceName
          ? `Nothing has been imported for ${raceName} yet.`
          : 'Import and publish results to build a version history.'}
      />
    )
  }

  // Newest first; version numbers count up from the oldest so v1 is the first ever import.
  const ordered = [...sessions]
  const versionOf = new Map<string, number>()
  ;[...ordered].reverse().forEach((s, i) => versionOf.set(s.sessionId, i + 1))

  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-fs-base">
          <caption className="sr-only">Import version history</caption>
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-4 py-3">Version</th>
              <th scope="col" className="px-4 py-3">Published by</th>
              <th scope="col" className="px-4 py-3">Published at</th>
              <th scope="col" className="px-4 py-3">Rows</th>
              <th scope="col" className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {ordered.map(s => (
              <tr key={s.sessionId} className="hover:bg-muted/20">
                <td className="px-4 py-3">
                  <span className="font-semibold tabular-nums text-foreground">
                    v{versionOf.get(s.sessionId)}
                  </span>
                  <span className="ml-2 truncate text-fs-2xs text-muted-foreground">
                    {s.passName}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <User className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate font-mono text-fs-2xs">
                      {s.publishedBy ?? s.uploadedBy}
                    </span>
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="size-3.5 shrink-0" aria-hidden />
                    {fmt(s.publishedAt ?? s.uploadedAt)}
                  </span>
                </td>
                <td className="px-4 py-3 tabular-nums text-foreground">
                  {s.storedRows.toLocaleString('en-IN')}
                  <span className="ml-1 text-fs-2xs text-muted-foreground">
                    of {s.totalRows.toLocaleString('en-IN')}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <StatusChip tone={TONE[s.status]}>
                    {IMPORT_SESSION_STATUS_LABEL[s.status]}
                  </StatusChip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
