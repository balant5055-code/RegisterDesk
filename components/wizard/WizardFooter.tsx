'use client'

import { useState, useEffect } from 'react'
import { createPortal }        from 'react-dom'
import Link                    from 'next/link'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { buttonVariants }      from '@/components/ui'
import { cn }                  from '@/lib/utils/cn'

interface WizardFooterProps {
  onBack?:         () => void
  backHref?:       string
  cancelHref?:     string
  backLabel?:      string
  onSaveDraft?:    () => void
  onNext:          () => void
  nextLabel?:      string
  isNextDisabled?: boolean
  isFinalStep?:    boolean
  /** "Step 2 of 7 · Visibility" — rendered as small muted context text */
  stepContext?:    string
}

// Shared ghost style for Back / Cancel / Save Draft
const GHOST =
  'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 ' +
  'text-[13px] font-medium text-muted-foreground ' +
  'transition-colors duration-150 ' +
  'hover:bg-muted/70 hover:text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'disabled:pointer-events-none disabled:opacity-40'

export function WizardFooter({
  onBack,
  backHref,
  cancelHref,
  backLabel,
  onSaveDraft,
  onNext,
  nextLabel,
  isNextDisabled = false,
  isFinalStep    = false,
  stepContext,
}: WizardFooterProps) {
  // Portal renders client-side only — avoids SSR/hydration mismatch
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  // ── Back / Cancel ────────────────────────────────────────────────────────────
  const backEl = cancelHref ? (
    <Link href={cancelHref} className={GHOST}
      aria-label={backLabel ?? 'Cancel and go back'}>
      <ArrowLeft className="size-3.5" aria-hidden />
      {backLabel ?? 'Cancel'}
    </Link>
  ) : backHref ? (
    <Link href={backHref} className={GHOST}
      aria-label={backLabel ?? 'Go back to previous step'}>
      <ArrowLeft className="size-3.5" aria-hidden />
      {backLabel ?? 'Back'}
    </Link>
  ) : onBack ? (
    <button type="button" onClick={onBack} className={GHOST}
      aria-label={backLabel ?? 'Go back to previous step'}>
      <ArrowLeft className="size-3.5" aria-hidden />
      {backLabel ?? 'Back'}
    </button>
  ) : null

  // ── Save Draft ───────────────────────────────────────────────────────────────
  const saveDraftEl = onSaveDraft ? (
    <button type="button" onClick={onSaveDraft} className={GHOST}
      aria-label="Save current progress as draft">
      Save Draft
    </button>
  ) : null

  // ── Continue label ───────────────────────────────────────────────────────────
  const continueLabel = isFinalStep
    ? (nextLabel ?? 'Submit Event')
    : (nextLabel ?? 'Continue')

  // ── Footer markup ────────────────────────────────────────────────────────────
  const footer = (
    <div
      data-wizard-footer
      className="border-t border-border bg-card shadow-[0_-1px_8px_0_rgba(0,0,0,0.05)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {/* ── Mobile (< sm) ─────────────────────────────────────────────────────
          Row 1 — [Back]  [Save Draft]  ·  step context (right)
          Row 2 — [      Continue →      ] (full-width)                      */}
      <div className="px-4 py-3 sm:hidden">
        <div className="flex items-center">
          <div className="flex items-center gap-0.5">
            {backEl ?? <span />}
            {saveDraftEl}
          </div>
          {stepContext && (
            <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/60">
              {stepContext}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onNext}
          disabled={isNextDisabled}
          aria-disabled={isNextDisabled}
          style={{ backgroundImage: 'var(--primary-gradient)' }}
          className={cn(
            buttonVariants({ variant: 'gradient' }),
            'mt-2.5 w-full justify-center',
          )}
        >
          {continueLabel}
          {!isFinalStep && <ArrowRight className="size-4" aria-hidden />}
        </button>
      </div>

      {/* ── Desktop (sm+) ─────────────────────────────────────────────────────
          3-column grid:
          [← Back]  [Save Draft]  |  Step X of Y · Name  |  [Continue →]   */}
      <div className="hidden px-5 py-3.5 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-4">

        {/* Left: Back + Save Draft */}
        <div className="flex items-center gap-0.5">
          {backEl}
          {saveDraftEl}
        </div>

        {/* Centre: step context */}
        <div className="flex justify-center">
          {stepContext && (
            <span className="text-[12px] tabular-nums text-muted-foreground/60">
              {stepContext}
            </span>
          )}
        </div>

        {/* Right: Continue */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onNext}
            disabled={isNextDisabled}
            aria-disabled={isNextDisabled}
            style={{ backgroundImage: 'var(--primary-gradient)' }}
            className={buttonVariants({ variant: 'gradient' })}
          >
            {continueLabel}
            {!isFinalStep && <ArrowRight className="size-4" aria-hidden />}
          </button>
        </div>

      </div>
    </div>
  )

  // SSR / pre-mount: render nothing in place (portal isn't available yet)
  if (!mounted) return null

  const target = document.getElementById('wizard-footer-portal')
  if (!target) return null

  return createPortal(footer, target)
}
