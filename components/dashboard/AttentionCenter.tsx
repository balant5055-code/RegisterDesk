'use client'

// RD-DASHBOARD-04 · Attention Center.
//
// The first thing on the dashboard, and the answer to the first question a command
// center must answer: **does anything need me right now?**
//
// ═══ WHY A CARD ROW, NOT A LIST ══════════════════════════════════════════════
// The previous pass rendered a stacked list. Correct, but it read as a table of
// problems — four rows of equal grey, scanned top to bottom. As a row of bordered
// cards each signal becomes a discrete object carrying its own severity edge, and the
// whole set is taken in with one horizontal sweep, which is what this question
// deserves.
//
// It renders NOTHING when there is nothing wrong. A permanent "all clear" panel
// trains the organizer to skip that region, which is exactly how the real alert gets
// missed. Absence is the healthy state and reads as such.
//
// Every signal comes from lib/dashboard/insights.ts — deterministic rules over data
// the platform already holds. Nothing here is estimated or invented.

import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ChevronDown, Info, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { accent, type AccentTone } from '@/lib/dashboard/accents'
import type { AttentionSignal, AttentionSeverity } from '@/lib/dashboard/insights'

const SEVERITY_ICON: Record<AttentionSeverity, React.ElementType> = {
  critical: ShieldAlert,
  warning:  AlertTriangle,
  info:     Info,
}

// Severity reads through the SHARED accent system rather than raw palette classes, so
// "critical" is the same red the KPI tiles, the capacity bars and the status donut
// use. Severity is the one place on this dashboard where colour carries urgency, so it
// must not drift from the rest of the page.
const SEVERITY_TONE: Record<AttentionSeverity, AccentTone> = {
  critical: 'critical',
  warning:  'pending',
  info:     'people',
}

const SEVERITY_LABEL: Record<AttentionSeverity, string> = {
  critical: 'Critical',
  warning:  'Warning',
  info:     'Heads up',
}

/** Cards shown before the set collapses behind a disclosure. */
const VISIBLE = 4

function SignalCard({ signal }: { signal: AttentionSignal }) {
  const Icon = SEVERITY_ICON[signal.severity]
  const a = accent(SEVERITY_TONE[signal.severity])

  return (
    <li className="relative flex min-w-0 flex-col justify-between gap-2.5 overflow-hidden rounded-surface border border-border bg-card p-3 pl-4">
      {/* A 2px severity edge, not a filled card. Four saturated blocks side by side
          would all shout equally and stop being triage. */}
      <span className={cn('absolute inset-y-0 left-0 w-[2px]', a.bar)} aria-hidden />

      <div className="flex min-w-0 items-start gap-2">
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-control', a.tile)} aria-hidden>
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-fs-sm font-medium text-foreground" title={signal.title}>
            {signal.title}
          </span>
          <span className="mt-0.5 block text-fs-2xs leading-snug text-muted-foreground">
            {signal.detail}
          </span>
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        {/* Severity as a LABELLED chip — colour alone is not an accessible signal. */}
        <span className={cn('shrink-0 rounded-control px-1.5 py-0.5 text-fs-2xs font-semibold', a.tile)}>
          {SEVERITY_LABEL[signal.severity]}
        </span>
        {signal.actionHref && (
          <Link
            href={signal.actionHref}
            className={cn(
              'shrink-0 rounded-control border border-border px-2 py-1 text-fs-2xs font-medium text-foreground',
              'transition-colors hover:border-border-strong hover:bg-muted',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            )}
          >
            {signal.actionLabel ?? 'Open'}
          </Link>
        )}
      </div>
    </li>
  )
}

export function AttentionCenter({ signals }: { signals: AttentionSignal[] }) {
  const [expanded, setExpanded] = useState(false)

  if (signals.length === 0) return null

  const shown    = expanded ? signals : signals.slice(0, VISIBLE)
  const hidden   = signals.length - shown.length
  const critical = signals.filter(s => s.severity === 'critical').length

  return (
    <section aria-labelledby="attention-heading" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="attention-heading" className="text-fs-md font-semibold text-foreground">
          Attention Center
        </h2>
        {critical > 0 && (
          <span className={cn('rounded-control px-1.5 py-0.5 text-fs-2xs font-semibold', accent('critical').tile)}>
            {critical} critical
          </span>
        )}
        <span className="text-fs-2xs text-muted-foreground">
          {signals.length} {signals.length === 1 ? 'item needs' : 'items need'} attention
        </span>
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded={expanded}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-control text-fs-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            View all {signals.length} <ChevronDown className="size-3.5" aria-hidden />
          </button>
        )}
      </div>

      {/* Four across on desktop, two on tablet, one on mobile — the cards stay
          readable instead of being squeezed into a horizontal scroller. */}
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {shown.map(signal => <SignalCard key={signal.id} signal={signal} />)}
      </ul>
    </section>
  )
}
