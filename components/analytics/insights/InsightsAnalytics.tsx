'use client'

// RD-ANALYTICS-12-31 · Insights — what needs attention, and the evidence for it.
//
// ═══ WHAT THIS PAGE IS ═══════════════════════════════════════════════════════
// A list of cards, each one an interpretation of a figure on another Analytics page: what
// happened, why it matters, the evidence, and where to look next. It renders the output of
// `buildInsights(response)` and nothing else — no fetch of its own, no arithmetic of its
// own, no styling that suggests a model wrote it.
//
// ═══ WHAT IT REFUSES TO DO ═══════════════════════════════════════════════════
//   • never says which protected figure is missing — a reader without `transactions`
//     simply sees no money card
//   • never says "everything is fine" — the empty state says what was checked and that no
//     rule cleared its floor
//   • never carries colour as the only signal of severity — the word is printed
//   • never shows a raw field path — the evidence line is a sentence

import { useMemo } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils/cn'
import type { AnalyticsResponse, Insight, InsightSeverity } from '@/lib/analytics/contract'
import { buildInsights, MAX_SURFACED } from '@/lib/analytics/insightsRules'
import { ANALYTICS_ROUTE_CANONICAL } from '@/lib/analytics/routes'
import { EVENT_PARAM } from '@/lib/events/eventContext'
import { useAnalyticsScope, type AnalyticsScopeState } from '../useAnalyticsScope'
import { ModuleHeader, ModuleStates } from '../ModuleChrome'
import { DeltaChip, UNAVAILABLE_MARK, nf } from '../overview/Primitives'

export function InsightsAnalytics() {
  const scope = useAnalyticsScope()
  const { data } = scope
  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Analytics"
        title="Insights"
        subtitle="What changed, what needs attention, and the figures behind each observation."
        scope={scope}
      />
      <ModuleStates scope={scope} subject="insight">
        {data && <Body data={data} scope={scope} />}
      </ModuleStates>
    </div>
  )
}

function Body({ data, scope }: { data: AnalyticsResponse; scope: AnalyticsScopeState }) {
  const { windowLabel, baselineLabel } = scope
  const result = useMemo(() => buildInsights(data, { windowLabel, baselineLabel }), [data, windowLabel, baselineLabel])
  const params = useSearchParams()
  const eventId = params.get(EVENT_PARAM)
  const withEvent = (href: string) => (eventId ? `${href}?${EVENT_PARAM}=${encodeURIComponent(eventId)}` : href)

  // Every block unreadable is a different fact from "nothing cleared a floor".
  const nothingReadable = data.coverage.unavailable
    && data.registrations.confirmed === null
    && data.operations.attendance.checkedIn === null
    && data.communications.totalMessages === null

  if (result.insights.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-card px-5 py-6" aria-label="Insights">
        {nothingReadable ? (
          <p className="text-fs-sm text-muted-foreground" role="status">
            This event&apos;s analytics could not be read, so no observations can be made yet.
          </p>
        ) : (
          <>
            <h2 className="text-fs-sm font-semibold text-foreground">No significant changes detected</h2>
            <p className="mt-1 text-fs-xs text-muted-foreground">
              {result.evaluated} checks ran over the {windowLabel} and the all-time figures — capacity,
              attendance, registrations, revenue where permitted, communications and registration
              mix. None cleared its floor. This is not a statement that everything is fine; it is
              a statement that nothing moved enough to be worth a card.
            </p>
          </>
        )}
      </section>
    )
  }

  return (
    <>
      <p className="text-fs-xs text-muted-foreground">
        {result.insights.length} of {result.evaluated} checks cleared their floors
        {result.candidates > result.insights.length && ` (${result.candidates - result.insights.length} overlapping or beyond the top ${MAX_SURFACED} are not shown)`}.
        Each card names the figure it was read from; &ldquo;in the {windowLabel}&rdquo; means a windowed
        figure, &ldquo;all time&rdquo; means a lifetime one.
      </p>
      <section aria-label="Insights">
        <h2 className="sr-only">Insights</h2>
        <ol className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
          {result.insights.map(i => <Card key={i.id} insight={i} href={withEvent(`${ANALYTICS_ROUTE_CANONICAL}/${i.module}`)} actionHref={i.action ? withEvent(i.action.href) : null} />)}
        </ol>
      </section>
      <p className="rounded-xl border border-border bg-muted/30 px-5 py-3.5 text-fs-xs text-muted-foreground">
        <span className="font-semibold text-foreground">How these are chosen.</span>{' '}
        A change earns a card only when the previous period is on record and the change clears
        a minimum size in both absolute and percentage terms; an all-time figure earns one only
        past a documented floor. These are business floors, not statistical tests, and every
        card can be traced to the figure on the page it links to.
      </p>
    </>
  )
}

const SEVERITY_LABEL: Record<InsightSeverity, string> = {
  critical: 'Critical', warning: 'Needs attention', positive: 'Positive', info: 'Observation',
}
const SEVERITY_CLASS: Record<InsightSeverity, string> = {
  critical: 'bg-[color:var(--destructive)]/10 text-[color:var(--destructive)]',
  warning:  'bg-[color:var(--warning)]/10 text-[color:var(--warning)]',
  positive: 'bg-[color:var(--success)]/10 text-[color:var(--success)]',
  info:     'bg-muted text-muted-foreground',
}

function Card({ insight: i, href, actionHref }: { insight: Insight; href: string; actionHref: string | null }) {
  const e = i.evidence
  return (
    <li className="rounded-xl border border-border bg-card">
      <article className="flex h-full flex-col px-5 py-4" aria-labelledby={`${i.id}-title`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full px-2 py-0.5 text-fs-2xs font-semibold', SEVERITY_CLASS[i.severity])}>
            {SEVERITY_LABEL[i.severity]}
          </span>
          <span className="text-fs-2xs uppercase tracking-[0.08em] text-muted-foreground">
            {e.window === 'period' ? 'selected period' : 'all time'}
          </span>
        </div>
        <h3 id={`${i.id}-title`} className="mt-2 text-fs-sm font-semibold text-foreground">{i.title}</h3>
        <p className="mt-1 text-fs-xs text-muted-foreground">{i.summary}</p>

        {/* The evidence line: the figure, its baseline and its movement — not a field path. */}
        <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-fs-xs">
          <span className="text-fs-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Evidence</span>
          <span className="font-semibold tabular-nums text-foreground">{fmt(e.value, e.unit)}</span>
          {e.baseline !== undefined && (
            <span className="tabular-nums text-muted-foreground">
              from {fmt(e.baseline, e.unit)}
            </span>
          )}
          {e.delta && <DeltaChip delta={e.delta} invert={i.rule.endsWith('_decline') || i.rule === 'cancellations_rise' || i.rule === 'refunds_rise'} />}
          {e.coverage.partial && <span className="text-muted-foreground">· coverage partial</span>}
        </p>

        {/* RD-ANALYTICS-12-33 · ≥ 40px hit areas on both links, without growing the type:
            the links are flex items with a minimum height, and the row's top padding shrinks
            by the same amount so the card does not get taller. */}
        <div className="mt-auto flex flex-wrap items-center gap-x-4 pt-1 text-fs-xs">
          <Link href={href} className="inline-flex min-h-10 items-center rounded font-medium text-[color:var(--primary-text)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]">
            View analytics
          </Link>
          {i.action && actionHref && (
            <Link href={actionHref} className="inline-flex min-h-10 items-center rounded text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]">
              {i.action.label}
            </Link>
          )}
        </div>
      </article>
    </li>
  )
}

function fmt(v: number | null, unit: Insight['evidence']['unit']): string {
  if (v === null) return UNAVAILABLE_MARK
  if (unit === 'paise') return `₹${Math.round(v / 100).toLocaleString('en-IN')}`
  if (unit === 'pct') return `${v}%`
  return nf(v)
}
