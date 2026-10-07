'use client'

// RD-DASH-11A · Check-in status.
//
// ═══ WHY THIS IS NOT REGISTRATION STATUS ═════════════════════════════════════
// Registration Status asks how one population DIVIDES — every status, summing to a whole —
// and a ring answers that. Check-in asks how far one number has travelled toward another:
// 288 of 2,295, with 2,007 still to come. That is progress along a track, and a second ring
// beside the first would say "these are the same kind of question" when they are not.
//
// So this card is horizontal and full-width: the figure, the distance still to cover, and
// what remains — read left to right, the way progress is read.
//
// ═══ IT COMPUTES NOTHING ═════════════════════════════════════════════════════
// `checkedIn`, `confirmed`, `remaining` and `percentage` all arrive resolved from
// lib/dashboard/checkInStatus. No subtraction, no division and no clamping happens here —
// two places doing the same arithmetic is two places that can disagree.
//
// ═══ THE ONE NUMBER IT REFUSES TO TIDY ═══════════════════════════════════════
// `checkedIn` can exceed `confirmed`: cancelling a registration decrements the confirmed
// counter and leaves the attendance shard alone, so a participant cancelled after checking
// in stays counted at the gate and leaves the roll. `Math.min(rate, 100)` would make that
// disappear behind a plausible number. The true figure is shown and the condition is named.

import { ScanLine } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent } from '@/lib/dashboard/accents'
import { SectionCard } from '@/components/dashboard/SectionCard'
import type { CheckInPassRow, CheckInStatus } from '@/lib/dashboard/checkInStatus'

const n = (v: number) => v.toLocaleString('en-IN')
/** One decimal, and never rounded up to a completion the data has not reached. */
const pct = (v: number) => `${v.toFixed(1)}%`

const FILL       = 'var(--checkin-fill)'
const TRACK      = 'var(--dist-track)'
const TINT       = 'var(--checkin-tint)'
const INK        = 'var(--checkin-ink)'
const ALERT_TINT = 'var(--checkin-alert-tint)'
const ALERT_INK  = 'var(--checkin-alert-ink)'

// ─── The track ──────────────────────────────────────────────────────────────────

/**
 * The progress bar.
 *
 * The WIDTH is clamped at 100 because a bar cannot be longer than its track — the FIGURE
 * beside it is not, so an over-count still reads as over. A non-zero share always paints
 * something: a 0.4% sliver that rounds to no pixels reads as "none", which is a different
 * fact from "a few".
 */
function Track({ percentage }: { percentage: number | null }) {
  const width = percentage === null ? 0 : Math.min(100, Math.max(percentage, percentage > 0 ? 1.5 : 0))
  return (
    // aria-hidden: every figure it encodes is written beside it, so announcing the bar would
    // repeat them as bare numbers with no unit.
    <div className="h-2.5 w-full overflow-hidden rounded-pill" style={{ background: TRACK }} aria-hidden>
      <div className="h-full rounded-pill" style={{ width: `${width}%`, backgroundImage: FILL }} />
    </div>
  )
}

// ─── Per pass ───────────────────────────────────────────────────────────────────

/**
 * One pass's gate progress.
 *
 * Included because it is the one breakdown that changes what an organizer DOES: three
 * distances checking in at 8%, 17% and 37% is a staffing decision, not a statistic. The
 * rows arrive in the organizer's configured order and are never sorted here.
 */
function PassRow({ row }: { row: CheckInPassRow }) {
  const spoken = row.confirmed === null
    ? `${row.label}: ${n(row.checkedIn)} checked in`
    : `${row.label}: ${n(row.checkedIn)} of ${n(row.confirmed)} checked in, ${row.percentage === null ? '' : pct(row.percentage)}`
  return (
    <div className="min-w-0" role="group" aria-label={spoken}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-fs-2xs font-medium text-foreground">{row.label}</span>
        <span className="shrink-0 text-fs-2xs tabular-nums text-muted-foreground">
          {row.confirmed === null ? n(row.checkedIn) : `${n(row.checkedIn)} / ${n(row.confirmed)}`}
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-pill" style={{ background: TRACK }} aria-hidden>
        <div
          className="h-full rounded-pill"
          style={{
            width: `${row.percentage === null ? 0 : Math.min(100, Math.max(row.percentage, row.checkedIn > 0 ? 2 : 0))}%`,
            backgroundImage: FILL,
          }}
        />
      </div>
    </div>
  )
}

// ─── The card ───────────────────────────────────────────────────────────────────

export function CheckInPanel({ status, scopeLabel, href = '/dashboard/check-in' }: {
  status:     CheckInStatus
  /** The event this covers. Check-in is a per-event gate operation, never a workspace one. */
  scopeLabel: string
  href?:      string
}) {
  const { state, checkedIn, confirmed, remaining, percentage, exceedsConfirmed, complete, byPass } = status

  /** Every state that has nothing to plot renders as one centred line — never as 0 of 0. */
  const message =
    state === 'unavailable'   ? { title: 'Check-in data unavailable',
                                  body: 'These counters could not be read, so nothing here is shown as zero.' }
    : state === 'not_supported' ? { title: 'Select an event to view check-in progress',
                                  body: 'Check-in is a per-event gate operation, so there is no workspace-wide figure to show. An event must also be published before it can take check-ins.' }
    : state === 'no_confirmed'  ? { title: 'No confirmed participants yet',
                                  body: 'Check-in progress appears once the first registration is confirmed.' }
    : null

  return (
    <SectionCard
      title="Check-in status"
      leading={
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-control', accent('verify').tile)} aria-hidden>
          <ScanLine className="size-3.5" />
        </span>
      }
      // The EXISTING check-in surface. No route is invented.
      href={href}
      hrefLabel="Open check-in"
      className="h-full"
      bodyClassName="flex flex-col"
    >
      {message ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center"
          {...(state === 'unavailable' ? { role: 'alert' as const } : {})}
        >
          <p className="text-fs-sm font-medium text-foreground">{message.title}</p>
          <p className="max-w-md text-fs-2xs text-muted-foreground">{message.body}</p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 px-4 py-3">
          {/* ── PROGRESS · figure, track, rate — read left to right ── */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
            <div className="shrink-0">
              <p className="text-fs-2xl font-semibold tabular-nums tracking-tight text-foreground leading-none">
                {n(checkedIn ?? 0)}
              </p>
              <p className="mt-1 text-fs-2xs text-muted-foreground">checked in</p>
            </div>

            <div className="min-w-0 flex-1">
              <Track percentage={percentage} />
              <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 text-fs-2xs text-muted-foreground">
                {/* `remaining` is null exactly when the counts disagree — the line then says
                    so instead of printing a negative or a soothing zero. */}
                {remaining !== null
                  ? <span><span className="font-semibold text-foreground">{n(remaining)}</span> remaining</span>
                  : <span className="font-semibold text-foreground">More check-ins than confirmed</span>}
                <span aria-hidden>·</span>
                <span><span className="font-semibold text-foreground">{n(confirmed ?? 0)}</span> confirmed</span>
                <span aria-hidden>·</span>
                <span className="min-w-0 break-words">{scopeLabel}</span>
              </p>
            </div>

            <div className="shrink-0">
              <span
                className="inline-block rounded-control px-2 py-1 text-fs-sm font-semibold tabular-nums"
                style={exceedsConfirmed
                  ? { background: ALERT_TINT, color: ALERT_INK }
                  : { background: TINT, color: INK }}
              >{percentage === null ? '—' : pct(percentage)}</span>
              <p className="mt-1 text-fs-2xs text-muted-foreground">of confirmed</p>
            </div>
          </div>

          {/* ── The two conditions worth a sentence of their own ── */}
          {exceedsConfirmed && (
            <p role="alert" className="rounded-surface px-2.5 py-2 text-fs-2xs"
               style={{ background: ALERT_TINT, color: ALERT_INK }}>
              <span className="font-semibold">More check-ins than confirmed registrations.</span>{' '}
              A participant cancelled after checking in stays counted at the gate. The figures
              above are the recorded ones and are not adjusted.
            </p>
          )}
          {complete && (
            <p className="rounded-surface px-2.5 py-2 text-fs-2xs font-medium"
               style={{ background: TINT, color: INK }}>
              All confirmed participants have checked in.
            </p>
          )}
          {checkedIn === 0 && !complete && (
            <p className="text-fs-2xs text-muted-foreground">
              All confirmed participants remain to be checked in.
            </p>
          )}

          {/* ── BY PASS · the breakdown that changes what an organizer does ── */}
          {byPass.length > 0 && (
            <div className="mt-auto border-t border-border pt-2.5">
              <p className="mb-2 text-fs-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Checked in by pass
              </p>
              <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {byPass.map(r => <PassRow key={r.passId} row={r} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  )
}
