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

  // 2026-10-01 luxury pass: NUMBERED steps in the brand indigo (done = tinted tick, current =
  // filled with a halo, ahead = outlined number) joined by a rail that fills as you go; on a
  // phone, the step's name over a SEGMENTED bar (one segment a step) instead of a 2px line.
  return (
    <nav
      aria-label="Event creation steps"
      className="rounded-surface border border-border/80 bg-card px-4 py-3.5 shadow-[0_1px_2px_rgb(15_23_42_/_0.04)] sm:px-5 sm:py-4"
    >
      {/* ── Mobile: step name + segmented progress ────────────────────── */}
      <div className="sm:hidden">
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-fs-sm font-semibold text-foreground">
            {steps[currentStep]?.name}
          </span>
          <span className="shrink-0 text-fs-2xs font-semibold uppercase tracking-[0.12em] tabular-nums text-muted-foreground">
            Step {currentStep + 1}
            <span className="mx-1 text-muted-foreground/50">of</span>
            {totalSteps}
          </span>
        </div>
        <div className="flex gap-1" aria-hidden>
          {steps.map((step, i) => (
            <span key={step.name} className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <motion.span
                className="absolute inset-y-0 left-0 rounded-full bg-primary"
                initial={false}
                animate={{ width: i <= currentStep ? '100%' : '0%', opacity: i < currentStep ? 0.55 : 1 }}
                transition={{ duration: 0.4, ease: EASE, delay: i === currentStep ? 0.1 : 0 }}
              />
            </span>
          ))}
        </div>
      </div>

      {/* ── Desktop / tablet: one row; connectors flex and can shrink to 0 ── */}
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
                  className="relative mx-1.5 mt-[13px] h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border/80"
                >
                  <motion.div
                    className="absolute inset-y-0 left-0 rounded-full bg-primary/60"
                    initial={false}
                    animate={{ width: i <= currentStep ? '100%' : '0%' }}
                    transition={{ duration: 0.4, ease: EASE }}
                  />
                </div>
              )}

              {/* ── Step column ── */}
              <div
                className="flex shrink-0 flex-col items-center"
                aria-current={isCurrent ? 'step' : undefined}
              >
                {/* Indicator — uniform 28 px so the connector's mt-[13px] centres on it */}
                <div
                  className={cn(
                    'flex size-7 items-center justify-center rounded-full text-fs-2xs font-semibold tabular-nums transition-all duration-300',
                    isCompleted
                      ? 'bg-primary/10 text-[color:var(--primary-text)]'
                      : isCurrent
                      ? 'bg-primary text-primary-foreground shadow-[0_0_0_4px_rgb(var(--primary-rgb)_/_0.14)]'
                      : 'border border-border bg-card text-muted-foreground',
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
                        <Check className="size-3.5" strokeWidth={2.75} aria-hidden />
                      </motion.span>
                    ) : (
                      <motion.span
                        key={isCurrent ? 'active' : 'idle'}
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.6, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                      >
                        {i + 1}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>

                {/* Label */}
                <div className="mt-2 flex flex-col items-center">
                  <span
                    className={cn(
                      'whitespace-nowrap text-[10.5px] leading-none transition-colors duration-200 lg:text-fs-2xs',
                      isCompleted
                        ? 'font-medium text-foreground/80'
                        : isCurrent
                        ? 'font-semibold text-[color:var(--primary-text)]'
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
                      className="mt-1 max-w-[80px] truncate whitespace-nowrap text-[10px] leading-none text-muted-foreground"
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
