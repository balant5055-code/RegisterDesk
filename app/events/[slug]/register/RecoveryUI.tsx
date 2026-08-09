'use client'

// RecoveryUI — making the existing draft system visible.
//
// RD-RT3.5. The draft mechanism already worked: values are written to sessionStorage on
// every change and read back on mount. The problem was that all of it was INVISIBLE —
// the draft was restored silently, so an attendee who refreshed saw their answers
// reappear with no explanation and no way to decline, and had no idea whether anything
// was being saved as they typed.
//
// Nothing here stores or reads anything itself. It renders state RegisterClient already
// owns, using the existing draft mechanism unchanged.

import { useEffect, useState } from 'react'
import { RotateCcw, WifiOff, Check, Loader2, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { CARD, TYPE } from '@/components/event-templates/shared/ui/framework'
import { buttonVariants } from '@/components/ui/button'

// ─── Recovery banner ────────────────────────────────────────────────────────────
// Restoring is now a decision, not a surprise. Shown BEFORE any value is applied, so
// "Start Over" genuinely starts over rather than undoing a restore that already ran.

export function RecoveryBanner({ fieldCount, onResume, onDiscard }: {
  /** How many answers were found — concrete beats "some data". */
  fieldCount: number
  onResume:   () => void
  onDiscard:  () => void
}) {
  return (
    <div
      role="region"
      aria-labelledby="rd-recovery-h"
      className={cn(CARD, 'mb-4 border-primary/25 bg-primary/[0.03] p-4 sm:p-5')}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10" aria-hidden>
            <RotateCcw className="size-4 text-primary" />
          </span>
          <div className="min-w-0">
            <h2 id="rd-recovery-h" className={TYPE.cardTitle}>Resume your registration?</h2>
            <p className={cn('mt-0.5', TYPE.cardBody)}>
              We found an unfinished registration with {fieldCount} {fieldCount === 1 ? 'answer' : 'answers'} saved on this device.
            </p>
          </div>
        </div>

        <div className="flex shrink-0 gap-2.5">
          <button
            type="button"
            onClick={onResume}
            className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'flex-1 sm:flex-none')}
          >
            Continue
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className={cn(buttonVariants({ variant: 'outline', size: 'md' }), 'flex-1 sm:flex-none')}
          >
            Start Over
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Autosave / connection status ───────────────────────────────────────────────
// One quiet line that answers "is my progress safe?" without ever interrupting.
//
// The relative label ticks on its own 30s interval rather than a per-second clock —
// "saved 2 minutes ago" does not need second precision, and a slow tick keeps this off
// the render path. The interval only exists once something has actually been saved.

function relativeLabel(savedAt: number, now: number): string {
  const secs = Math.max(0, Math.round((now - savedAt) / 1000))
  if (secs < 45) return 'Saved just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `Saved ${mins} minute${mins === 1 ? '' : 's'} ago`
  const hrs = Math.round(mins / 60)
  return `Saved ${hrs} hour${hrs === 1 ? '' : 's'} ago`
}

export function AutosaveStatus({ savedAt, saving, online }: {
  savedAt: number | null
  saving:  boolean
  online:  boolean
}) {
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    if (savedAt === null) return
    // Deferred out of the effect body (this repo forbids synchronous setState there),
    // then a slow tick so the relative label stays honest.
    const raf = requestAnimationFrame(() => setNow(Date.now()))
    const id  = setInterval(() => setNow(Date.now()), 30_000)
    return () => { cancelAnimationFrame(raf); clearInterval(id) }
  }, [savedAt])

  // Offline outranks everything: it is the only state that changes what the attendee
  // should do next.
  const content = !online
    ? { Icon: WifiOff, tone: 'text-amber-700', text: 'Offline — your progress is still saved on this device' }
    : saving
      ? { Icon: Loader2, tone: 'text-muted-foreground', text: 'Saving…' }
      : savedAt !== null
        ? { Icon: Check, tone: 'text-muted-foreground', text: relativeLabel(savedAt, now ?? savedAt) }
        : null

  return (
    // Always mounted and always a live region, so a state change is announced rather
    // than the whole region appearing (which some screen readers miss). Height is
    // reserved either way, so nothing shifts when the text changes.
    <div className="mb-3 flex h-4 items-center justify-end" aria-live="polite">
      {content && (
        <span className={cn('inline-flex items-center gap-1.5 text-fs-2xs font-medium', content.tone)}>
          <content.Icon
            className={cn('size-3', content.Icon === Loader2 && 'animate-spin motion-reduce:animate-none',
              content.Icon === Check && 'text-emerald-600')}
            aria-hidden
          />
          {content.text}
        </span>
      )}
    </div>
  )
}

// ─── Reassurance ────────────────────────────────────────────────────────────────
// Deliberately precise about scope: the draft lives in this browser, not an account.
// Promising "return later on any device" would be a promise sessionStorage cannot keep.

export function RecoveryReassurance() {
  return (
    <p className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-fs-2xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Check className="size-3 shrink-0 text-emerald-600" aria-hidden />
        Progress saves automatically as you type
      </span>
      <span className="inline-flex items-center gap-1.5">
        <ShieldCheck className="size-3 shrink-0 text-emerald-600" aria-hidden />
        Your answers stay on this device until you submit
      </span>
    </p>
  )
}
