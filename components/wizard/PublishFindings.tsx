'use client'

// RD-EVENT-25 · Enterprise Findings panel for Review & Publish.
//
// ═══ PRESENTATION ONLY ═══════════════════════════════════════════════════════
// This file contains no publish logic. It does not decide severity, section, or where
// "Fix now" navigates — all three arrive on each `PublishBlocker`, produced by
// `toPublishBlocker()` in the shared engine. There is no switch on requirement id, no step
// mapping, and no re-derivation of categories.
//
// The three groups are rendered from `report.findings.critical / warning / suggestion`.
// A group is NEVER hidden when empty: the empty state is how an organizer learns what each
// severity level means, and a disappearing section teaches nothing.

import { AlertCircle, AlertTriangle, Lightbulb, CheckCircle2, ArrowRight } from 'lucide-react'
import type { PublishBlocker, PublishSeverity } from '@/lib/events/publishRequirements'
import { cn } from '@/lib/utils/cn'

/**
 * Why a tier matters, in the organizer's terms.
 *
 * Copy lives here rather than on the requirement because it describes the SEVERITY LEVEL,
 * not the individual finding — putting it on each requirement would repeat the same sentence
 * seven times and let the tiers drift apart.
 */
const TIER = {
  critical: {
    heading: 'Critical Issues',
    consequence: 'Publishing is blocked until these are resolved.',
    Icon: AlertCircle,
    emptyTitle: 'No publishing blockers',
    emptyBody: 'This event satisfies every mandatory publishing requirement.',
    // Strongest emphasis: filled icon chip, tinted card, coloured left edge.
    card: 'border-destructive/25 bg-destructive/[0.04]',
    chip: 'bg-destructive/10 text-destructive',
    rail: 'bg-destructive',
    label: 'text-destructive',
  },
  warning: {
    heading: 'Warnings',
    consequence: 'You can publish, but these are strongly recommended.',
    Icon: AlertTriangle,
    emptyTitle: 'No recommended improvements',
    emptyBody: 'Your event already follows all recommended publishing practices.',
    card: 'border-amber-200/70 bg-amber-50/40 dark:border-amber-900/40 dark:bg-amber-950/10',
    chip: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    rail: 'bg-amber-500',
    label: 'text-amber-700 dark:text-amber-400',
  },
  suggestion: {
    heading: 'Suggestions',
    consequence: 'Optional improvements that make your event stronger.',
    Icon: Lightbulb,
    emptyTitle: 'No optional improvements',
    emptyBody: 'Your event already includes every optional enhancement currently supported.',
    // Lowest emphasis: neutral surface, no tint.
    card: 'border-border bg-card',
    chip: 'bg-muted text-muted-foreground',
    rail: 'bg-border',
    label: 'text-muted-foreground',
  },
} as const satisfies Record<PublishSeverity, unknown>

interface Props {
  findings: {
    critical:   PublishBlocker[]
    warning:    PublishBlocker[]
    suggestion: PublishBlocker[]
  }
  /** The wizard's existing navigation. Nothing else is needed to make Fix now work. */
  onGoToStep?: (step: number, fieldHint?: string) => void
}

/** Rendered in severity order — criticals always first. */
const ORDER: PublishSeverity[] = ['critical', 'warning', 'suggestion']

export function PublishFindingsPanel({ findings, onGoToStep }: Props) {
  return (
    <div className="space-y-6">
      {ORDER.map(severity => (
        <FindingGroup
          key={severity}
          severity={severity}
          items={findings[severity]}
          onGoToStep={onGoToStep}
        />
      ))}
    </div>
  )
}

function FindingGroup({
  severity, items, onGoToStep,
}: { severity: PublishSeverity; items: PublishBlocker[]; onGoToStep?: Props['onGoToStep'] }) {
  const tier = TIER[severity]
  const headingId = `findings-${severity}`

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 id={headingId} className="text-[14px] font-semibold text-foreground">
          {tier.heading}
        </h3>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums', tier.chip)}>
          {items.length}
        </span>
        <p className="text-[12px] text-muted-foreground">{tier.consequence}</p>
      </div>

      {items.length === 0 ? (
        <EmptyState title={tier.emptyTitle} body={tier.emptyBody} />
      ) : (
        <ul className="space-y-2.5">
          {items.map(item => (
            <FindingCard key={item.id} item={item} severity={severity} onGoToStep={onGoToStep} />
          ))}
        </ul>
      )}
    </section>
  )
}

function FindingCard({
  item, severity, onGoToStep,
}: { item: PublishBlocker; severity: PublishSeverity; onGoToStep?: Props['onGoToStep'] }) {
  const tier = TIER[severity]
  return (
    <li className={cn('relative overflow-hidden rounded-xl border p-4 pl-5 transition-colors', tier.card)}>
      {/* Severity rail — decorative; the tier is already announced by the group heading. */}
      <span className={cn('absolute inset-y-0 left-0 w-1', tier.rail)} aria-hidden />

      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full', tier.chip)}>
          <tier.Icon className="size-3.5" aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <p className="text-[13.5px] font-semibold text-foreground">{item.title}</p>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {item.section}
            </span>
          </div>

          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            {item.description}
          </p>
          {/* The tier's consequence is NOT repeated per card. It was, on the first pass —
              five criticals meant "Publishing is blocked until these are resolved." five
              times, which reads as noise and buries the per-finding text that actually
              differs. It belongs once, in the group header, where the severity is declared. */}

          {onGoToStep && (
            <button
              type="button"
              onClick={() => onGoToStep(item.stepIndex, item.fieldHint)}
              className="mt-2.5 inline-flex items-center gap-1 rounded-md text-[13px] font-semibold text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              Fix now
              {/* The visible label repeats on every card, so screen-reader users get the
                  destination too — otherwise a list of identical "Fix now" links. */}
              <span className="sr-only"> — {item.title}, go to {item.step}</span>
              <ArrowRight className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-muted/20 p-4">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-hidden />
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-foreground">{title}</p>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}
