'use client'

// RD-EVENT-21 · Section Health dashboard for Review & Publish.
//
// ═══ THIS COMPONENT DECIDES NOTHING ══════════════════════════════════════════
// Every value it renders — section name, score, status, issue count, navigation target —
// is computed by `buildSectionHealth()` in `lib/events/publishRequirements.ts`, the same
// engine the server publish gate uses. There is no categorisation, no thresholding and no
// severity logic here. If a status looks wrong, the engine is wrong.
//
// `stepIndex` comes from the engine too, so "Fix now" reuses the wizard's existing
// `onGoToStep` navigation rather than mapping sections to steps a second time.

import { CheckCircle2, AlertCircle, AlertTriangle, Lightbulb, ArrowRight } from 'lucide-react'
import type { PublishSectionHealth, PublishSeverity } from '@/lib/events/publishRequirements'
import { cn } from '@/lib/utils/cn'

/** Presentation per status. Keyed by the engine's own vocabulary — never re-derived. */
const STATUS_STYLE: Record<PublishSeverity | 'complete', {
  label: string
  Icon: typeof CheckCircle2
  tone: string
  bar: string
}> = {
  complete:   { label: 'Complete',   Icon: CheckCircle2,   tone: 'text-emerald-600 dark:text-emerald-400', bar: 'bg-emerald-500' },
  critical:   { label: 'Critical',   Icon: AlertCircle,    tone: 'text-destructive',                        bar: 'bg-destructive' },
  warning:    { label: 'Warning',    Icon: AlertTriangle,  tone: 'text-amber-600 dark:text-amber-400',      bar: 'bg-amber-500' },
  suggestion: { label: 'Suggestion', Icon: Lightbulb,      tone: 'text-sky-600 dark:text-sky-400',          bar: 'bg-sky-500' },
}

interface Props {
  sections: PublishSectionHealth[]
  /** The wizard's existing navigation. Not called for sections with nothing to fix. */
  onGoToStep?: (step: number, fieldHint?: string) => void
}

export function PublishSectionHealthGrid({ sections, onGoToStep }: Props) {
  // Sections with no requirements are complete by definition and carry no information;
  // showing ten cards where six are permanently empty is noise, not completeness.
  const meaningful = sections.filter(s => s.total > 0)
  if (meaningful.length === 0) return null

  return (
    <section aria-labelledby="section-health-heading" className="space-y-3">
      <h3 id="section-health-heading" className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
        Section Health
      </h3>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {meaningful.map(s => {
          const style = STATUS_STYLE[s.status]
          const issues = s.total - s.passed
          const canFix = s.status !== 'complete' && s.stepIndex !== null && !!onGoToStep
          return (
            <li
              key={s.section}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold text-foreground">{s.section}</p>
                  <p className={cn('mt-0.5 flex items-center gap-1.5 text-[12px] font-medium', style.tone)}>
                    <style.Icon className="size-3.5 shrink-0" aria-hidden />
                    {style.label}
                    {issues > 0 && (
                      <span className="text-muted-foreground">
                        · {issues} issue{issues === 1 ? '' : 's'}
                      </span>
                    )}
                  </p>
                </div>
                <span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">
                  {s.score}%
                </span>
              </div>

              {/* aria-hidden: the percentage and status are already announced above, so the
                  bar is decoration. A second progressbar role would read the same fact twice. */}
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className={cn('h-full rounded-full transition-[width] duration-500', style.bar)} style={{ width: `${s.score}%` }} />
              </div>

              {canFix && (
                <button
                  type="button"
                  onClick={() => onGoToStep!(s.stepIndex!)}
                  className="inline-flex items-center gap-1 self-start rounded-md text-[13px] font-medium text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  Fix now
                  <span className="sr-only"> — {s.section}, go to {s.stepName}</span>
                  <ArrowRight className="size-3.5" aria-hidden />
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
