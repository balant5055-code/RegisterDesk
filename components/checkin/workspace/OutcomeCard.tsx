'use client'

// RD-CHECKIN-2.0 — the three outcomes of an admission attempt.
//
// ═══ ALREADY-CHECKED-IN MUST NOT LOOK LIKE A NEW ADMISSION ═══════════════════
// This is the requirement that shapes the whole component. A duplicate scan and a
// successful one are the two states an operator reads at a glance, at arm's length,
// in daylight, while a queue waits — so they differ in ICON, in WORD, in BORDER and
// in the sentence underneath, never in colour alone. The duplicate state leads with
// the ORIGINAL timestamp and the ORIGINAL operator, because "when did this person
// already come through, and who let them in" is the actual question being asked.
//
// Nothing here writes anything. The card renders what the server returned and hands
// the operator's next action back to the caller.

import { CheckCircle2, AlertTriangle, XCircle, CloudOff, RotateCcw, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

/**
 * `queued` is the OFFLINE admission, and it is a distinct state on purpose.
 *
 * An offline check-in has been recorded on THIS DEVICE only. The server has not
 * seen it, has not applied the eligibility rules to it, and may still refuse it on
 * replay. Rendering that as "Check-in successful" would present a device-local
 * write as an authoritative admission — exactly what the audit found the old
 * surface doing. So it gets its own word, its own icon and its own sentence.
 */
export type OutcomeKind = 'success' | 'already' | 'queued' | 'error'

export interface Outcome {
  kind:   OutcomeKind
  /** The attendee's name, or the headline for an error. */
  title:  string
  /** Category / pass, and the identifier when one is issued. */
  subtitle?: string
  /** ISO timestamp of the admission this card is about. */
  at?:    string | null
  /** Who performed it. For a duplicate this is the ORIGINAL operator. */
  by?:    string | null
  /** A second line explaining an error, when the code alone is not enough. */
  detail?: string
}

interface Props {
  outcome:  Outcome
  busy:     boolean
  /** Offered after this operator's own admission, inside the correction window. */
  onUndo?:  () => void
  onNext:   () => void
  nextLabel: string
}

/** HH:MM:SS in the viewer's own locale. Seconds matter at a gate. */
function clock(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
}

const CHROME: Record<OutcomeKind, { ring: string; icon: string; label: string }> = {
  success: { ring: 'border-success/40 bg-success/5',         icon: 'text-success',     label: 'Check-in successful' },
  already: { ring: 'border-warning/50 bg-warning/10',        icon: 'text-warning',     label: 'Already checked in' },
  queued:  { ring: 'border-warning/50 bg-warning/5',         icon: 'text-warning',     label: 'Queued — not yet confirmed' },
  error:   { ring: 'border-destructive/40 bg-destructive/5', icon: 'text-destructive', label: 'Not checked in' },
}

export default function OutcomeCard({ outcome, busy, onUndo, onNext, nextLabel }: Props) {
  const chrome = CHROME[outcome.kind]
  const time   = clock(outcome.at)

  const Icon = outcome.kind === 'success' ? CheckCircle2
    : outcome.kind === 'already' ? AlertTriangle
    : outcome.kind === 'queued'  ? CloudOff
    : XCircle

  return (
    <section
      role="status"
      aria-live="assertive"
      className={cn('flex flex-col gap-4 rounded-2xl border p-5', chrome.ring)}
    >
      <div className="flex items-start gap-3">
        <Icon className={cn('mt-0.5 size-7 shrink-0', chrome.icon)} aria-hidden />
        <div className="min-w-0 flex-1">
          {/* The WORD, not just the colour — this is the line an operator reads. */}
          <p className={cn('text-fs-2xs font-bold uppercase tracking-wider', chrome.icon)}>
            {chrome.label}
          </p>
          <p className="mt-1 break-words text-fs-xl font-bold leading-tight text-foreground">
            {outcome.title}
          </p>
          {outcome.subtitle && (
            <p className="mt-0.5 text-fs-sm font-medium text-muted-foreground">{outcome.subtitle}</p>
          )}
          {outcome.detail && (
            <p className="mt-2 text-fs-sm text-foreground">{outcome.detail}</p>
          )}
        </div>
      </div>

      {(time || outcome.by) && (
        <dl className="grid grid-cols-2 gap-3 border-t border-border/60 pt-3">
          {time && (
            <div>
              <dt className="text-fs-2xs uppercase tracking-wider text-muted-foreground">
                {outcome.kind === 'already' ? 'Originally at' : 'Checked in at'}
              </dt>
              <dd className="mt-0.5 text-fs-sm font-semibold tabular-nums text-foreground">{time}</dd>
            </div>
          )}
          {outcome.by && (
            <div className="min-w-0">
              <dt className="text-fs-2xs uppercase tracking-wider text-muted-foreground">
                {outcome.kind === 'already' ? 'Originally by' : 'Checked in by'}
              </dt>
              <dd className="mt-0.5 truncate text-fs-sm font-semibold text-foreground">{outcome.by}</dd>
            </div>
          )}
        </dl>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onNext}
          autoFocus
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-fs-md font-semibold text-primary-foreground"
        >
          {nextLabel}
          <ArrowRight className="size-4" aria-hidden />
        </button>

        {onUndo && (
          <button
            type="button"
            onClick={onUndo}
            disabled={busy}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-4 py-3 text-fs-sm font-semibold text-foreground disabled:opacity-50"
          >
            <RotateCcw className="size-4" aria-hidden />
            Undo
          </button>
        )}
      </div>
    </section>
  )
}
