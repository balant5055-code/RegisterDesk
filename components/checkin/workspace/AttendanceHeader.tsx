'use client'

// RD-CHECKIN-2.0 — the gate header: who is working, where, and how the event stands.
//
// ═══ EVERY NUMBER HERE IS SERVER-AUTHORITATIVE ═══════════════════════════════
// Registered, Checked in and Remaining come from the canonical attendance counters
// via /api/checkin/ops — the SAME source the organizer's attendance view reads, so
// the two can never disagree. Nothing on this strip is derived from a loaded
// participant list, and page length is never used as a total.
//
// ═══ UNKNOWN IS NOT ZERO ═════════════════════════════════════════════════════
// When the aggregate could not be read the server sends null, and this renders an
// em dash with an explicit "counts unavailable" note. A gate showing "0 / 0" on race
// morning is a different — and far more alarming — claim than "we could not count",
// and the operator must be able to tell which one they are looking at.

import { cn } from '@/lib/utils/cn'

interface Props {
  eventName:     string
  operatorName:  string
  checkedIn:     number | null
  totalExpected: number | null
  statsUnavailable: boolean
  online:        boolean
  /** Set while a refresh is in flight, so the strip can dim rather than flicker. */
  refreshing?:   boolean
}

const fmt = (n: number | null): string => (typeof n === 'number' ? n.toLocaleString('en-IN') : '—')

/** One metric. `tone` is never the only signal — every value is also labelled. */
function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-fs-2xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={cn(
        'mt-0.5 truncate text-fs-lg font-bold tabular-nums',
        accent ? 'text-primary' : 'text-foreground',
      )}>
        {value}
      </dd>
    </div>
  )
}

export default function AttendanceHeader({
  eventName, operatorName, checkedIn, totalExpected, statsUnavailable, online, refreshing,
}: Props) {
  const remaining = typeof checkedIn === 'number' && typeof totalExpected === 'number'
    ? Math.max(0, totalExpected - checkedIn)
    : null

  const pct = typeof checkedIn === 'number' && typeof totalExpected === 'number' && totalExpected > 0
    ? Math.round((checkedIn / totalExpected) * 100)
    : null

  return (
    <header className="flex flex-col gap-3 border-b border-border pb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-fs-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Check-in
          </p>
          <h1 className="truncate text-fs-xl font-bold leading-tight text-foreground" title={eventName}>
            {eventName}
          </h1>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {/* Connection state is TRUTHFUL and carries a word, never colour alone. */}
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-fs-2xs font-semibold',
              online ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning',
            )}
          >
            <span className={cn('size-1.5 rounded-full', online ? 'bg-success' : 'bg-warning')} aria-hidden />
            {online ? 'Online' : 'Offline'}
          </span>
          <span className="max-w-[12rem] truncate text-fs-2xs text-muted-foreground" title={operatorName}>
            {operatorName}
          </span>
        </div>
      </div>

      <dl
        className={cn(
          'grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4',
          refreshing && 'opacity-60 transition-opacity',
        )}
        aria-busy={refreshing || undefined}
      >
        <Metric label="Registered" value={fmt(totalExpected)} />
        <Metric label="Checked in" value={fmt(checkedIn)} accent />
        <Metric label="Remaining"  value={fmt(remaining)} />
        <Metric label="Progress"   value={pct === null ? '—' : `${pct}%`} />
      </dl>

      {statsUnavailable && (
        <p role="status" className="text-fs-2xs text-warning">
          Attendance counts are unavailable right now. Check-in still works — the numbers above are not current.
        </p>
      )}
    </header>
  )
}
