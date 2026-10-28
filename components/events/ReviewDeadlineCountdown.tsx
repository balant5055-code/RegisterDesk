'use client'

// RD-REVIEW-02 — the review deadline countdown (Changes Requested / Action Required).
//
// DISPLAY ONLY. The deadline comes from the server (`changesDueAt` / `actionDueAt`); the server alone
// decides when it has passed (resubmission and closure refuse after it; the scheduler closes the
// event). This only shows the time left, ticking once a second.
//
// Urgency is carried by an icon AND words, never colour alone: more than 12 h neutral, 4–12 h amber,
// under 4 h red, then an explicit "Deadline passed" state.

import { useEffect, useState } from 'react'
import { Clock, AlertTriangle, AlertOctagon, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { deadlineTone, formatRemaining, type DeadlineTone } from '@/lib/events/reviewDeadline'

const TONE: Record<DeadlineTone, { icon: typeof Clock; box: string; ink: string; word: string }> = {
  neutral:  { icon: Clock,         box: 'border-border bg-muted/40',              ink: 'text-foreground',  word: 'Time left' },
  warning:  { icon: AlertTriangle, box: 'border-warning/30 bg-warning/10',        ink: 'text-foreground',  word: 'Less than 12 hours left' },
  critical: { icon: AlertOctagon,  box: 'border-destructive/30 bg-destructive/10', ink: 'text-destructive', word: 'Less than 4 hours left' },
  expired:  { icon: XCircle,       box: 'border-destructive/30 bg-destructive/5',  ink: 'text-destructive', word: 'Deadline passed' },
}

export function ReviewDeadlineCountdown({ dueAt, label, expiredText, className }: {
  /** Server-stored deadline, epoch ms. */
  dueAt:       number
  /** What the deadline is, e.g. "Changes due" / "Closes automatically". */
  label:       string
  /** Shown once the deadline has passed (the server will act on it). */
  expiredText: string
  className?:  string
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const remaining = dueAt - now
  const tone = deadlineTone(remaining)
  const t = TONE[tone]
  const Icon = t.icon
  const at = new Date(dueAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div className={cn('flex min-w-0 items-start gap-2 rounded-control border p-2.5', t.box, className)} data-tone={tone}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', t.ink)} aria-hidden />
      <div className="min-w-0">
        <p className={cn('text-fs-xs font-semibold', t.ink)}>
          {tone === 'expired' ? t.word : `${label}: ${at}`}
        </p>
        {tone === 'expired' ? (
          <p className="mt-0.5 text-fs-2xs text-muted-foreground">{expiredText}</p>
        ) : (
          // role=timer with live updates OFF: the time is readable on demand, never announced every second.
          <p className="mt-0.5 text-fs-2xs text-muted-foreground" role="timer" aria-live="off">
            <span className="sr-only">{t.word}. </span>
            <span className="font-mono tabular-nums text-foreground" aria-label={`Time remaining ${formatRemaining(remaining)}`}>{formatRemaining(remaining)}</span>
            <span aria-hidden> · {t.word}</span>
          </p>
        )}
      </div>
    </div>
  )
}
