'use client'

import Link from 'next/link'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

interface WizardFooterProps {
  onBack?:     () => void
  backHref?:   string
  cancelHref?: string
  backLabel?:  string
  onSaveDraft?: () => void
  onNext:          () => void
  nextLabel?:      string
  isNextDisabled?: boolean
  isFinalStep?:    boolean
}

export function WizardFooter({
  onBack,
  backHref,
  cancelHref,
  backLabel,
  onSaveDraft,
  onNext,
  nextLabel,
  isNextDisabled = false,
  isFinalStep = false,
}: WizardFooterProps) {

  // ── Back element (shared between layouts) ─────────────────────────────
  const backEl = cancelHref ? (
    <Link
      href={cancelHref}
      className={buttonVariants({ variant: 'outline' })}
      aria-label={backLabel ?? 'Cancel and go back'}
    >
      {backLabel ?? 'Cancel'}
    </Link>
  ) : backHref ? (
    <Link
      href={backHref}
      className={buttonVariants({ variant: 'outline' })}
      aria-label={backLabel ?? 'Go back to previous step'}
    >
      <ArrowLeft className="size-4" aria-hidden />
      {backLabel ?? 'Back'}
    </Link>
  ) : onBack ? (
    <button
      type="button"
      onClick={onBack}
      className={buttonVariants({ variant: 'outline' })}
      aria-label={backLabel ?? 'Go back to previous step'}
    >
      <ArrowLeft className="size-4" aria-hidden />
      {backLabel ?? 'Back'}
    </button>
  ) : null

  return (
    // Outer sticky wrapper: bg covers the full area including the gap above the border.
    // mt-6 lives INSIDE this wrapper so bg-background fills the margin space too.
    // safe-area-inset-bottom keeps the footer off the iPhone home indicator.
    <div
      className="sticky bottom-0 z-10 bg-background"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="mt-6 border-t border-border pt-3 pb-2">

      {/* ── Mobile layout (< sm) ───────────────────────────────────────────
          Row 1: Back  ←→  Next
          Row 2: Save Draft (full-width, only when available)           */}
      <div className="flex flex-col gap-2 sm:hidden">
        <div className="flex items-center justify-between gap-2">
          {/* Back / Cancel */}
          {backEl ?? <div className="size-10 w-px" />}

          {/* Next / Publish */}
          <button
            type="button"
            onClick={onNext}
            disabled={isNextDisabled}
            aria-disabled={isNextDisabled}
            className={cn(buttonVariants({ variant: 'primary' }), 'min-w-[80px]')}
          >
            {isFinalStep ? (nextLabel ?? 'Publish') : (nextLabel ?? 'Next')}
            {!isFinalStep && nextLabel === undefined && <ArrowRight className="size-4" aria-hidden />}
          </button>
        </div>

        {/* Save Draft — full-width secondary row */}
        {onSaveDraft && (
          <button
            type="button"
            onClick={onSaveDraft}
            className={cn(buttonVariants({ variant: 'outline' }), 'w-full justify-center')}
            aria-label="Save current progress as draft"
          >
            Save Draft
          </button>
        )}
      </div>

      {/* ── Desktop layout (sm+) ──────────────────────────────────────────
          [Back / Cancel]   [Save Draft]   [Next / Publish]              */}
      <div className="hidden sm:flex items-center justify-between gap-4">

        {/* Left */}
        <div className="flex shrink-0">
          {backEl ?? <div className="h-10 w-px" />}
        </div>

        {/* Center */}
        <div className="flex justify-center">
          {onSaveDraft && (
            <button
              type="button"
              onClick={onSaveDraft}
              className={buttonVariants({ variant: 'outline' })}
              aria-label="Save current progress as draft"
            >
              Save Draft
            </button>
          )}
        </div>

        {/* Right */}
        <div className="flex shrink-0 justify-end">
          <button
            type="button"
            onClick={onNext}
            disabled={isNextDisabled}
            aria-disabled={isNextDisabled}
            className={buttonVariants({ variant: 'primary' })}
          >
            {isFinalStep ? (nextLabel ?? 'Publish Event') : (nextLabel ?? 'Next')}
            {!isFinalStep && nextLabel === undefined && <ArrowRight className="size-4" aria-hidden />}
          </button>
        </div>

      </div>

      </div>  {/* end inner mt-6 wrapper */}
    </div>
  )
}
