'use client'

import { useState, useEffect, useRef } from 'react'
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
  /**
   * RD-EVENT-COMMERCE-05D — an optional SECONDARY action beside Back (same ghost style as Save
   * Draft), e.g. a live event's Review → "License & Services" while "Save Changes" stays primary.
   */
  secondaryAction?: { label: string; onClick: () => void; disabled?: boolean; /** RD-EVENT-COMMERCE-05E — false for Cancel / Done (no forward arrow). */ arrow?: boolean }
}

// Shared ghost style for Back / Cancel / Save Draft
const GHOST =
  'inline-flex min-h-10 items-center gap-1.5 rounded-control px-2.5 ' +
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
  secondaryAction,
}: WizardFooterProps) {
  // Portal renders client-side only — avoids SSR/hydration mismatch
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  // RD-EVENT-COMMERCE-05D — publish the footer's height as a CSS variable so toasts (ToastProvider)
  // rise ABOVE this fixed footer instead of covering its buttons; cleared when the footer unmounts.
  const footerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = footerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const set = () => root.style.setProperty('--wizard-footer-h', `${Math.ceil(el.getBoundingClientRect().height)}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => { ro.disconnect(); root.style.removeProperty('--wizard-footer-h') }
  }, [mounted])

  // ── Back / Cancel ────────────────────────────────────────────────────────────
  const backEl = cancelHref ? (
    <Link href={cancelHref} className={GHOST}
      aria-label={backLabel ?? 'Cancel and go back'}>
      <ArrowLeft className="size-3.5" aria-hidden />
      <span className="max-[379px]:sr-only">{backLabel ?? 'Cancel'}</span>
    </Link>
  ) : backHref ? (
    <Link href={backHref} className={GHOST}
      aria-label={backLabel ?? 'Go back to previous step'}>
      <ArrowLeft className="size-3.5" aria-hidden />
      <span className="max-[379px]:sr-only">{backLabel ?? 'Back'}</span>
    </Link>
  ) : onBack ? (
    <button type="button" onClick={onBack} className={GHOST}
      aria-label={backLabel ?? 'Go back to previous step'}>
      <ArrowLeft className="size-3.5" aria-hidden />
      <span className="max-[379px]:sr-only">{backLabel ?? 'Back'}</span>
    </button>
  ) : null

  // ── Save Draft ───────────────────────────────────────────────────────────────
  const saveDraftEl = onSaveDraft ? (
    <button type="button" onClick={onSaveDraft} className={GHOST}
      aria-label="Save current progress as draft">
      Save Draft
    </button>
  ) : secondaryAction ? (
    <button type="button" onClick={secondaryAction.onClick} disabled={secondaryAction.disabled} className={GHOST}>
      {secondaryAction.label}
      {secondaryAction.arrow !== false && <ArrowRight className="size-3.5" aria-hidden />}
    </button>
  ) : null

  // ── Continue label ───────────────────────────────────────────────────────────
  const continueLabel = isFinalStep
    ? (nextLabel ?? 'Submit Event')
    : (nextLabel ?? 'Continue')

  // ── Footer markup ────────────────────────────────────────────────────────────
  const footer = (
    <div
      ref={footerRef}
      data-wizard-footer
      className="border-t border-border bg-card shadow-[0_-1px_8px_0_rgba(0,0,0,0.05)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {/* ── Mobile (< sm) ─────────────────────────────────────────────────────
          2026-10-01: ONE row — [Back] [Save Draft] ········ [Continue →]. The step
          context is already on screen in the Stepper, so the second row was repetition.
          Under 380px the back link drops its word (its aria-label still names it).   */}
      <div className="flex items-center gap-2 px-3 py-2.5 sm:hidden">
        <div className="flex min-w-0 items-center gap-0.5">
          {backEl ?? <span />}
          {saveDraftEl}
        </div>
        <button
          type="button"
          onClick={onNext}
          disabled={isNextDisabled}
          aria-disabled={isNextDisabled}
          style={{ backgroundImage: 'var(--primary-gradient)' }}
          className={cn(
            buttonVariants({ variant: 'gradient' }),
            'ml-auto min-h-11 shrink-0 justify-center px-5',
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
