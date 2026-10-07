'use client'

// RD-ANALYTICS-06 · the Analytics Overview.
//
// ═══ THE COMPOSITION, AND WHY IT IS NOT A GRID OF CARDS ══════════════════════
// The brief a reader actually has is a narrative, not a matrix: how is this event doing,
// is it growing, has the money arrived, will it fill, will they turn up. So the page is
// four regions in that order, and the first one carries a single figure at real scale with
// the supporting numbers seamed beside it. A uniform 2×4 card grid answers none of those
// questions first — it answers all of them equally, which is the same as answering none.
//
// ═══ WHAT IT REFUSES TO DO ═══════════════════════════════════════════════════
//   • no metric is ever rendered as 0 when it is unmeasured
//   • no financial element exists at all without the permission — not disabled, ABSENT
//   • no module is rendered and then hidden; `capabilities.modules` decides beforehand
//   • no insight is written here; the tested engine produces them
//   • one request feeds the whole page

import { useMemo } from 'react'
import { TrendingUp, TrendingDown, Minus, Trophy, Target, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buildPerformanceInsights, type PerformanceInsight } from '@/lib/dashboard/insights'
import { useAnalyticsScope } from '../useAnalyticsScope'
import { ModuleHeader, ModuleStates } from '../ModuleChrome'
import type { AnalyticsResponse } from '@/lib/analytics/contract'
import {
  HeroMetric, RailMetric, CapacityMeter, Section, EmptyNote, PeriodMovement, RailMovement,
  nf, inr,
} from './Primitives'
import { TrendPanel } from './TrendPanel'

/** Icon per insight kind. The engine emits a stable `kind` and knows nothing about icons. */
const INSIGHT_ICON: Record<PerformanceInsight['kind'], React.ElementType> = {
  top_event: Trophy, velocity_up: TrendingUp, velocity_down: TrendingDown,
  velocity_flat: Minus, velocity_total: TrendingUp,
  empty_published: AlertCircle, nearly_full: Target,
}

export function AnalyticsOverview() {
  /**
   * RD-ANALYTICS-08 · the fetch, the range state and the event-scope derivation moved to
   * `useAnalyticsScope`, unchanged in behaviour.
   *
   * They lived here while there was one module. A second module copying the block would
   * have given the workspace two places where the window is chosen and two chances for one
   * of them to drift — the same duplication RD-ANALYTICS-04 removed from the insight
   * engines. This page's markup is untouched; only where its data comes from has changed.
   */
  const scope = useAnalyticsScope()
  const { data, windowLabel, baselineLabel } = scope

  /**
   * The comparison the velocity insight is allowed to speak for. See the note at its use.
   * A null delta — no baseline, or a baseline before rollup coverage — yields null, so the
   * insight is absent rather than asserting a steady pace it cannot know.
   */
  const velocity = useMemo(() => {
    const reg = data?.overview.registrations
    if (!data || !reg || reg.value === null || !reg.delta) return null
    return data.scope.range.preset === '7d' ? { total: reg.value, delta: reg.delta } : null
  }, [data])

  /**
   * Insights come from the tested engine, fed the ONE event in scope.
   *
   * `fillPct` is passed as the server resolved it; this component never divides to obtain
   * it. When capacity is unmeasured the event is passed with a null capacity, which is
   * exactly what stops the "nearly full" rule from firing on an uncapped event.
   */
  const insights = useMemo<PerformanceInsight[]>(() => {
    if (!data) return []
    const r = data.registrations
    return buildPerformanceInsights({
      events: [{
        name:            data.scope.eventName ?? 'This event',
        lifecycleStatus: 'published',
        registered:      r.confirmed ?? 0,
        capacity:        r.capacity,
        fillPct:         r.capacityUsedPct ?? 0,
      }],
      // RD-ANALYTICS-07 · a real baseline exists now, but the engine's sentence names
      // "the last 7 days vs the prior week" verbatim. Feeding it a 30- or 90-day
      // comparison would print a true number beneath a false window, so the insight is
      // offered only when the served window is the one that sentence describes.
      week: velocity,
      trendUnavailable: data.coverage.unavailable,
    })
  }, [data, velocity])

  const showRevenue = Boolean(data?.capabilities.modules.includes('revenue') && data?.revenue)

  return (
    <div className="space-y-5">
      {/* RD-ANALYTICS-12-33 · the shared chrome. The H1 names the MODULE — every other
          module does, and the event's own name lives in the top bar beside its selector —
          and the states (no selection, unknown event, loading skeleton, error) are the
          ones every module shows, so the Overview cannot drift from its siblings. */}
      <ModuleHeader
        eyebrow="Analytics"
        title="Overview"
        subtitle="How this event is doing — registrations, revenue where permitted, arrivals and capacity."
        scope={scope}
      />

      <ModuleStates scope={scope} subject="performance">
        {data && <OverviewBody data={data} insights={insights} showRevenue={showRevenue} windowLabel={windowLabel} baselineLabel={baselineLabel} />}
      </ModuleStates>
    </div>
  )
}

// ─── The composed body ────────────────────────────────────────────────────────

function OverviewBody({ data, insights, showRevenue, windowLabel, baselineLabel }: {
  data: AnalyticsResponse
  insights: PerformanceInsight[]
  showRevenue: boolean
  windowLabel: string
  baselineLabel: string
}) {
  const r = data.registrations
  const o = data.operations
  const rev = data.revenue

  const confirmedRevenue = rev?.confirmedRevenue
  const revenueValue = confirmedRevenue?.ok ? inr(confirmedRevenue.paise) : null

  /**
   * The days the chart actually draws.
   *
   * Taken from the series itself rather than from the requested range, because the two
   * differ whenever the coverage floor clips the start of the window — and the chart's own
   * caption is the last place that difference should be papered over.
   */
  const drawnRange = r.byDay === null || r.byDay.length === 0
    ? `${data.scope.range.from} → ${data.scope.range.to}`
    : `${r.byDay[0].date} → ${r.byDay[r.byDay.length - 1].date}`

  return (
    <>
      {/* ── 1 · Snapshot. ONE composed container: the dominant figure, then a seamed
             rail. Not four bordered boxes — a carded block beside uncarded columns
             reads as assembled from parts. ────────────────────────────────────── */}
      <section className="overflow-hidden rounded-xl border border-border bg-card"
               aria-label="Event performance snapshot">
        <div className="grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,2fr)]">
          <div className="border-b border-border bg-muted/40 p-6 lg:border-b-0 lg:border-r">
            {/* RD-ANALYTICS-07 · the headline stays LIFETIME and carries no delta. The
                period movement is its own line below, because the two describe different
                windows and stacking them would invite one to be read as the other. */}
            <HeroMetric
              label="Confirmed registrations"
              value={r.confirmed === null ? null : nf(r.confirmed)}
              unavailableNote="Registration counts could not be read"
              footnote={
                r.total === null
                  ? 'All time · total across all statuses unavailable'
                  : <>All time · {nf(r.total)} total across every status</>
              }
            />
            <PeriodMovement
              value={data.overview.registrations.value}
              delta={data.overview.registrations.delta}
              reason={data.overview.registrations.unavailable}
              unit="confirmed"
              windowLabel={windowLabel}
              baselineLabel={baselineLabel}
            />
            <StatusComposition r={r} />
          </div>

          {/* The rail. Hairline seams, no per-item borders. */}
          <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-2 lg:grid-cols-2">
            {/* RD-ANALYTICS-07 · the same rule as the hero, at rail scale: the figure is
                LIFETIME confirmed revenue, so the chip may not hang off it. The delta
                belongs beside the period figure it was computed from. */}
            {showRevenue && (
              <RailMetric
                label="Confirmed revenue"
                value={revenueValue}
                unavailableNote="not measured"
                sub={<>
                  All time · Σ ticket value over confirmed registrations
                  {data.overview.revenuePaise?.value != null && (
                    <RailMovement className="mt-1"
                                  text={`${inr(data.overview.revenuePaise.value)} in the ${windowLabel}`}
                                  delta={data.overview.revenuePaise.delta} />
                  )}
                </>}
              />
            )}
            <RailMetric
              label="Checked in"
              value={o.checkedIn === null ? null : nf(o.checkedIn)}
              unavailableNote="not measured"
              sub={<>
                {o.attendancePct === null
                  ? 'All time · attendance rate unavailable'
                  : o.checkedIn === 0
                    ? 'All time · no check-ins yet'
                    : `All time · ${o.attendancePct}% of confirmed`}
                {/* Arrivals WITHIN the window, from the rollups' own checkedIn column —
                    not inferred from registrations, which would invent an attendance
                    history the platform never recorded. */}
                {data.overview.checkedIn.value === null ? null : (
                  <RailMovement className="mt-1"
                                text={`${nf(data.overview.checkedIn.value)} in the ${windowLabel}`}
                                delta={data.overview.checkedIn.delta} />
                )}
              </>}
            />
            {/* RD-ANALYTICS-07 · TERMINOLOGY. This counts registrations whose PAYMENT has
                not completed. The status-composition legend beside it counts registrations
                whose REGISTRATION is pending approval. Different populations, so they now
                carry different words — "Awaiting payment" and "Registration pending" — and
                neither is called just "Pending". */}
            <RailMetric
              label="Awaiting payment"
              value={r.paymentPending === null ? null : nf(r.paymentPending)}
              unavailableNote="not measured"
              sub={r.refundPending === null || r.refundPending === 0
                ? 'All time · payment not yet completed'
                : `All time · ${nf(r.refundPending)} refund${r.refundPending === 1 ? '' : 's'} in progress`}
            />
            <RailMetric
              label="Cancelled"
              value={r.cancelled === null ? null : nf(r.cancelled)}
              unavailableNote="not measured"
              sub={r.waitlisted === null || r.waitlisted === 0
                ? 'All time'
                : `All time · ${nf(r.waitlisted)} waitlisted`}
            />
          </div>
        </div>
      </section>

      {/* ── 2 · Trend intelligence ──────────────────────────────────────────── */}
      <div className={cn('grid gap-5', showRevenue && 'xl:grid-cols-2')}>
        {/* RD-ANALYTICS-07 · the subtitle names the days actually DRAWN, not the days
            requested. Where the coverage floor clips the series they differ, and stating
            the request over a shorter chart tells the reader the quiet stretch at the
            start of their range was measured — which is the one thing clipping exists to
            avoid claiming. */}
        <Section
          title="Registration trend"
          subtitle={`Confirmed registrations per day · ${drawnRange}`}
        >
          <TrendPanel
            series={r.byDay}
            unit="registrations"
            describe="Confirmed registrations per day"
            emptyText="No registrations in this period."
            unavailableText="Daily figures could not be read for this event."
          />
        </Section>

        {/* Absent entirely without the permission — never a disabled-looking money card. */}
        {showRevenue && (
          <Section
            title="Revenue trend"
            subtitle="Confirmed ticket value per day"
          >
            {/* The money series names its unit in the field (`valuePaise`) so a consumer
                cannot mistake paise for rupees; the chart takes a neutral `value`. */}
            <TrendPanel
              series={rev?.byDay ? rev.byDay.map(p => ({ date: p.date, value: p.valuePaise })) : null}
              unit="revenue"
              format={inr}
              describe="Confirmed ticket revenue per day"
              emptyText="No revenue recorded in this period."
              unavailableText="Daily revenue could not be read for this event."
            />
          </Section>
        )}
      </div>

      {/* ── 3 · Health + insights ───────────────────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Section title="Capacity" subtitle="Confirmed registrations against configured capacity">
          <div className="px-5 py-5">
            <CapacityMeter
              pct={r.capacityUsedPct}
              registered={r.confirmed}
              capacity={r.capacity}
            />
            {r.remaining !== null && (
              <p className="mt-3 text-fs-xs text-muted-foreground">
                {nf(r.remaining)} place{r.remaining === 1 ? '' : 's'} remaining
              </p>
            )}
          </div>
        </Section>

        <Section title="Highlights" subtitle="Observations derived from this event's own figures — the Insights module ranks them">
          {insights.length === 0 ? (
            <EmptyNote>Not enough activity yet to draw a conclusion.</EmptyNote>
          ) : (
            <ul className="divide-y divide-border">
              {insights.map((ins, i) => {
                const Icon = INSIGHT_ICON[ins.kind]
                return (
                  <li key={i} className="flex items-start gap-3 px-5 py-3.5">
                    <Icon
                      className={cn('mt-0.5 size-4 shrink-0',
                        ins.tone === 'positive' ? 'text-[color:var(--success)]'
                          : ins.tone === 'warning' ? 'text-[color:var(--warning)]'
                          : 'text-muted-foreground')}
                      aria-hidden
                    />
                    <p className="text-fs-sm text-foreground">{ins.text}</p>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>
      </div>

      {/* ── 4 · Data trust. Only rendered when something is genuinely incomplete. ── */}
      <CoverageNotice data={data} />
    </>
  )
}

/**
 * What the 640 is actually made of.
 *
 * A stacked proportion bar plus its legend — the one breakdown that belongs beside the
 * headline figure, because "480 confirmed of 640" immediately raises "and the other 160?".
 * Every segment is a measured count; a status whose count is unavailable is omitted from
 * the bar and named in the legend as unavailable, never drawn as a zero-width segment that
 * would read as "none".
 */
function StatusComposition({ r }: { r: AnalyticsResponse['registrations'] }) {
  const rows = [
    { key: 'confirmed',  label: 'Confirmed',  value: r.confirmed,  className: 'bg-[color:var(--primary)]' },
    // "Registration pending", never bare "Pending" — the rail's "Awaiting payment" is a
    // different population and the two used to sit on one screen sharing a word.
    { key: 'pending',    label: 'Registration pending', value: r.pending, className: 'bg-[color:var(--warning)]' },
    { key: 'cancelled',  label: 'Cancelled',  value: r.cancelled,  className: 'bg-[color:var(--destructive)]/70' },
    { key: 'waitlisted', label: 'Waitlisted', value: r.waitlisted, className: 'bg-border-strong' },
    { key: 'rejected',   label: 'Rejected',   value: r.rejected,   className: 'bg-muted-foreground/40' },
  ] as const

  const measured = rows.filter(x => x.value !== null && x.value > 0)
  const total = measured.reduce((n, x) => n + (x.value ?? 0), 0)
  if (total === 0) return null

  return (
    <div className="mt-6 border-t border-border/70 pt-5">
      <p className="text-fs-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Status composition
      </p>
      <div className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-border/60"
           role="img"
           aria-label={`Registration status composition: ${measured.map(x => `${x.label} ${x.value}`).join(', ')}`}>
        {measured.map(x => (
          <div key={x.key} className={cn('h-full', x.className)}
               style={{ width: `${((x.value ?? 0) / total) * 100}%` }} />
        ))}
      </div>
      <dl className="mt-3.5 grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-3 lg:grid-cols-2">
        {rows.map(x => (
          <div key={x.key} className="flex items-center gap-2 min-w-0">
            <span className={cn('size-2 shrink-0 rounded-[2px]', x.className)} aria-hidden />
            <dt className="truncate text-fs-xs text-muted-foreground">{x.label}</dt>
            <dd className="ml-auto text-fs-xs font-semibold tabular-nums text-foreground">
              {x.value === null ? '—' : nf(x.value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * What the numbers do and do not cover.
 *
 * Deliberately silent when everything is complete — a permanent disclaimer trains the
 * reader to ignore it, which costs the warning its meaning on the day it matters. The
 * wording is user-facing: "supporting activity data" rather than the name of a collection.
 */
/** A day key as a readable date, in a fixed zone so it cannot drift by a day. */
function fmtDay(dayKey: string): string {
  const ms = Date.parse(`${dayKey}T00:00:00Z`)
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    : dayKey
}

function CoverageNotice({ data }: { data: AnalyticsResponse }) {
  const notes: string[] = []
  if (data.coverage.unavailable) notes.push('daily trend data could not be read')
  if (data.coverage.partial && data.coverage.since) {
    // Plain language, and the date the reader can act on — not the name of a collection.
    notes.push(`daily analytics begin ${fmtDay(data.coverage.since)}, so earlier days in this range are not shown`)
  }
  if (!data.limits.ledger) notes.push('payment ledger figures are incomplete')
  if (!data.limits.passValue) notes.push('per-pass revenue is incomplete')
  if (!data.limits.communications) notes.push('communication activity is incomplete')
  if (!data.limits.certificates) notes.push('certificate activity is incomplete')

  if (notes.length === 0) return null

  return (
    <p className="rounded-xl border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/[0.06] px-5 py-3.5 text-fs-xs text-foreground"
       role="status">
      <span className="font-semibold">Some figures are incomplete.</span>{' '}
      Registration counts are complete for this event; {notes.join(', ')}.
    </p>
  )
}
