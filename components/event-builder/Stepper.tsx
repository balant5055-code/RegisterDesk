'use client'

// RD-PRODUCT-01G Phase 5 — the shared Event Builder step indicator (progress rail).
//
// Extracted VERBATIM from the Event Builder monolith. It is a pure presentational
// component shared by every wizard step (mobile progress bar + desktop step row). No
// state, effects, or business logic — driven entirely by props. Moving a top-level
// component to its own file with the same imports is byte-for-byte behavior-identical.

import { Fragment } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { EASE, WIZARD_STEPS } from '@/lib/events/builder/constants'
import type { WizardStep } from '@/lib/events/builder/types'

export function Stepper({
  currentStep,
  completedValues = [],
  steps = WIZARD_STEPS,
}: {
  currentStep:      number
  completedValues?: (string | undefined)[]
  steps?:           WizardStep[]
}) {
  const totalSteps = steps.length

  return (
    <nav
      aria-label="Event creation steps"
      className="rounded-2xl border border-border bg-card px-5 py-4 shadow-[0_1px_4px_rgba(0,0,0,0.05)]"
    >
      {/* ── Mobile: step name + animated progress bar ────────────────── */}
      <div className="sm:hidden">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12.5px] font-semibold text-foreground">
            {steps[currentStep]?.name}
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {currentStep + 1}
            <span className="mx-px text-muted-foreground/40">/</span>
            {totalSteps}
          </span>
        </div>
        <div className="relative h-[2px] overflow-hidden rounded-full bg-muted">
          <motion.div
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            initial={false}
            animate={{ width: `${((currentStep + 1) / totalSteps) * 100}%` }}
            transition={{ duration: 0.45, ease: EASE }}
          />
        </div>
      </div>

      {/* ── Desktop / tablet: full-width single row, no overflow ─────── */}
      {/* flex w-full replaces overflow-x-auto + min-w-max so all 7 steps
          share the available width; connectors (flex-1 min-w-0) absorb
          any extra space and can shrink to 0 on narrow viewports        */}
      <div className="hidden w-full items-start sm:flex">
        {steps.map((step, i) => {
          const isCompleted    = i < currentStep
          const isCurrent      = i === currentStep
          const completedValue = completedValues[i]

          return (
            <Fragment key={step.name}>
              {/* ── Connector ── */}
              {i > 0 && (
                <div
                  aria-hidden
                  className="relative mx-1.5 mt-[9px] h-px min-w-0 flex-1 overflow-hidden rounded-full bg-border"
                >
                  <motion.div
                    className="absolute inset-y-0 left-0 rounded-full bg-emerald-400"
                    initial={false}
                    animate={{ width: isCompleted ? '100%' : '0%' }}
                    transition={{ duration: 0.4, ease: EASE }}
                  />
                </div>
              )}

              {/* ── Step column ── */}
              <div
                className="flex shrink-0 flex-col items-center"
                aria-current={isCurrent ? 'step' : undefined}
              >
                {/* Indicator — uniform 18 px so connector mt-[9px] aligns */}
                <div
                  className={cn(
                    'flex size-[18px] items-center justify-center rounded-full transition-all duration-300',
                    isCompleted
                      ? 'bg-emerald-500'
                      : isCurrent
                      ? 'bg-primary shadow-[0_0_0_3px_rgb(var(--primary-rgb)_/_0.15)]'
                      : 'border border-border bg-card',
                  )}
                >
                  <AnimatePresence mode="wait" initial={false}>
                    {isCompleted ? (
                      <motion.span
                        key="check"
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                      >
                        <Check className="size-[9px] text-white" aria-hidden />
                      </motion.span>
                    ) : isCurrent ? (
                      <motion.span
                        key="active"
                        className="size-[6px] rounded-full bg-white"
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                      />
                    ) : (
                      <motion.span
                        key="idle"
                        className="size-[5px] rounded-full bg-muted-foreground/30"
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                      />
                    )}
                  </AnimatePresence>
                </div>

                {/* Label */}
                <div className="mt-1.5 flex flex-col items-center">
                  <span
                    className={cn(
                      'whitespace-nowrap text-[10.5px] leading-none transition-colors duration-200',
                      isCompleted
                        ? 'font-medium text-emerald-600'
                        : isCurrent
                        ? 'font-bold text-foreground'
                        : 'font-normal text-muted-foreground',
                    )}
                  >
                    {step.name}
                  </span>
                  {isCompleted && completedValue && (
                    <motion.span
                      initial={{ opacity: 0, y: 2 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2 }}
                      className="mt-0.5 max-w-[72px] truncate whitespace-nowrap text-[9.5px] leading-none text-muted-foreground"
                    >
                      {completedValue}
                    </motion.span>
                  )}
                </div>
              </div>
            </Fragment>
          )
        })}
      </div>
    </nav>
  )
}
