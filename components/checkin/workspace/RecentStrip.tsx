'use client'

// RD-CHECKIN-2.0 — the last few admissions.
//
// ═══ WHY THIS IS CHEAP ═══════════════════════════════════════════════════════
// The rows arrive already assembled from /api/checkin/ops, which reads at most
// twenty registrations through the EXISTING (organizerUid, eventSlug, checkedInAt
// DESC) composite index and resolves every operator name in ONE batched read. There
// is no per-row fetch here and none upstream — the N+1 that a "who did this" column
// usually invites is closed on the server side.
//
// It is a REVIEW surface, not a control: nothing here admits or reverses anyone.

import { Clock } from 'lucide-react'
import type { RecentCheckIn } from '@/app/api/checkin/ops/[eventId]/route'

interface Props {
  rows: RecentCheckIn[]
  /** The event's own word for its identifier. */
  identifierLabel: string
}

function clock(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

export default function RecentStrip({ rows, identifierLabel }: Props) {
  return (
    <section aria-labelledby="recent-heading" className="flex flex-col gap-2">
      <h2 id="recent-heading" className="flex items-center gap-1.5 text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Clock className="size-3.5" aria-hidden />
        Recent check-ins
      </h2>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-fs-sm text-muted-foreground">
          Nobody has been checked in yet.
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {rows.map(r => (
            <li key={r.registrationId} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-16 shrink-0 text-fs-2xs font-semibold tabular-nums text-muted-foreground">
                {clock(r.checkedInAt)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-fs-sm font-medium text-foreground">{r.attendeeName}</p>
                <p className="truncate text-fs-2xs text-muted-foreground">
                  {r.identifierValue && <>{identifierLabel} {r.identifierValue} · </>}
                  {r.passName}
                </p>
              </div>
              {/* An unresolved operator shows a dash, never a raw uid. */}
              <span className="max-w-[8rem] shrink-0 truncate text-fs-2xs text-muted-foreground" title={r.operatorName ?? undefined}>
                {r.operatorName ?? '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
