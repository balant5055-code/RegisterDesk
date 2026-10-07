'use client'

// RD-ANALYTICS-08 · Registrations Intelligence.
//
// ═══ THE QUESTION THIS PAGE ANSWERS ══════════════════════════════════════════
// Not "how is the event doing" — the Overview owns that. This one answers "who has
// registered, what state are they in, and how is that moving": the lifecycle, the payment
// position, and the shape of demand across passes. So the composition and the trend are the
// main content here, not a footnote beside a headline.
//
// ═══ WHAT IT REFUSES TO DO ═══════════════════════════════════════════════════
//   • no lifetime figure carries a period delta (RD-ANALYTICS-07's rule, kept)
//   • no unmeasured count renders as 0 — every one branches on `=== null` first
//   • no composition bar reconciles to 100% when a state was not measured
//   • no waitlist row on an event whose organizer never enabled one
//   • no per-pass figure is captioned as period data — it is a lifetime tally and says so
//   • no money: this module reads registration COUNTS, and the payload it consumes carries
//     no financial field at all for a caller without `transactions`
//   • no BIB, chip, finish time or race category — those are Operations panels for sports
//     events, and registration intelligence is universal

import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import type { AnalyticsResponse } from '@/lib/analytics/contract'
import {
  statusComposition, paymentComposition, drawableSegments, passDistribution,
  waitlistEnabled, type Breakdown, type BreakdownRow,
} from '@/lib/analytics/registrationsModel'
import { useAnalyticsScope, type AnalyticsScopeState } from '../useAnalyticsScope'
import { ModuleHeader, ModuleStates, fmtDay } from '../ModuleChrome'
import { Section, RailMetric, EmptyNote, UnavailableNote, DeltaChip, UNAVAILABLE_MARK, nf } from '../overview/Primitives'
import { TrendPanel } from '../overview/TrendPanel'

/** Tone token → the class that paints a segment and its legend swatch. ONE mapping. */
const TONE: Record<BreakdownRow['tone'], string> = {
  primary:  'bg-[color:var(--primary)]',
  positive: 'bg-[color:var(--success)]',
  warning:  'bg-[color:var(--warning)]',
  danger:   'bg-[color:var(--destructive)]/70',
  neutral:  'bg-border-strong',
  muted:    'bg-muted-foreground/40',
}

export function RegistrationsAnalytics() {
  const scope = useAnalyticsScope()
  const { data } = scope

  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Analytics"
        title="Registrations"
        subtitle="Lifecycle, payment position and demand by pass for one event."
        scope={scope}
      />
      <ModuleStates scope={scope}>
        {data && <Body data={data} scope={scope} />}
      </ModuleStates>
    </div>
  )
}

function Body({ data, scope }: { data: AnalyticsResponse; scope: AnalyticsScopeState }) {
  const r = data.registrations
  const { windowLabel, baselineLabel } = scope

  const status  = useMemo(() => statusComposition(r, { waitlistEnabled: waitlistEnabled(data) }), [r, data])
  const payment = useMemo(() => paymentComposition(r), [r])
  const passes  = useMemo(() => passDistribution(r), [r])

  return (
    <>
      {/* ── 1 · The standing position. Lifetime figures, no deltas. ───────────── */}
      <section className="overflow-hidden rounded-xl border border-border bg-card"
               aria-label="Registration totals">
        <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
          <RailMetric
            label="Total registrations"
            value={r.total === null ? null : nf(r.total)}
            unavailableNote="not measured"
            sub="Every status, all time"
          />
          <RailMetric
            label="Confirmed"
            value={r.confirmed === null ? null : nf(r.confirmed)}
            unavailableNote="not measured"
            sub={r.total === null || r.confirmed === null
              ? 'Share of total unavailable'
              : `${pctText(status.rows.find(x => x.key === 'confirmed')?.pct)} of all registrations`}
          />
          <RailMetric
            label="Awaiting payment"
            value={r.paymentPending === null ? null : nf(r.paymentPending)}
            unavailableNote="not measured"
            sub="Payment not yet completed"
          />
          <RailMetric
            label="Registration pending"
            value={r.pending === null ? null : nf(r.pending)}
            unavailableNote="not measured"
            sub="Awaiting organizer approval"
          />
        </div>
      </section>

      {/* ── 2 · Movement in the selected window. Deltas live HERE. ────────────── */}
      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Section
          title="Registration trend"
          subtitle={<>Confirmed registrations per day · {drawnRange(data)}</>}
          action={<PeriodBadge
            metric={r.period.confirmed}
            windowLabel={windowLabel}
            baselineLabel={baselineLabel}
            unit="confirmed"
          />}
        >
          <TrendPanel
            series={r.byDay}
            unit="registrations"
            describe="Confirmed registrations per day"
            emptyText="No registrations in this period."
            unavailableText="Daily figures could not be read for this event."
          />
        </Section>

        <Section
          title="Status composition"
          subtitle={r.total === null
            ? 'Share of total unavailable'
            : <>Share of {nf(r.total)} registrations</>}
        >
          <CompositionPanel b={status} emptyText="No registrations yet." />
        </Section>
      </section>

      {/* ── 3 · Secondary analysis. ───────────────────────────────────────────── */}
      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section
          title="Payment split"
          subtitle="By payment status — each registration appears in exactly one row"
        >
          <CompositionPanel b={payment} emptyText="No payment activity recorded yet." />
        </Section>

        <Section
          title="Registrations by pass"
          /* The basis is stated in the caption, not left to the reader. There is no per-pass
             daily rollup, so this is a lifetime tally and captioning it with the selected
             window would be false. */
          subtitle="Confirmed registrations, all time — not limited to the selected period"
        >
          {passes.rows.length === 0
            ? <EmptyNote>No pass-level registrations recorded yet.</EmptyNote>
            : (
              <ul className="divide-y divide-border">
                {passes.rows.map(p => (
                  <li key={p.label} className="px-5 py-3">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="min-w-0 truncate text-fs-sm text-foreground">{p.label}</span>
                      <span className="shrink-0 text-fs-sm font-semibold tabular-nums text-foreground">
                        {nf(p.value)}
                        <span className="ml-2 font-normal text-fs-xs text-muted-foreground">
                          {pctText(p.pct)}
                        </span>
                      </span>
                    </div>
                    {/* No share, no bar. A width is a claim about a proportion, and
                        coalescing an uncomputable share to 0 would draw "none of the
                        confirmed registrations" for a pass that simply could not be
                        measured against its denominator. */}
                    {p.pct !== null && (
                      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-[color:var(--primary)]"
                             style={{ width: `${p.pct}%` }} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
        </Section>
      </section>

      {/* ── 4 · Cancellations, only when the window recorded any. ─────────────── */}
      {r.cancelledByDay !== null && r.cancelledByDay.some(p => p.value > 0) && (
        <Section
          title="Cancellations"
          subtitle={<>Recorded per day · {drawnRange(data)}</>}
          action={<PeriodBadge
            metric={r.period.cancelled}
            windowLabel={windowLabel}
            baselineLabel={baselineLabel}
            unit="cancelled"
            /* A RISE in cancellations is not good news, so the chip's colour must not say
               it is. The delta is inverted for presentation only; the number is unchanged. */
            invert
          />}
        >
          <TrendPanel
            series={r.cancelledByDay}
            unit="cancellations"
            describe="Cancellations recorded per day"
            emptyText="No cancellations in this period."
            unavailableText="Daily figures could not be read for this event."
          />
        </Section>
      )}

      <CoverageNotice data={data} />
    </>
  )
}

/**
 * The window figure and its comparison, sitting in a section header.
 *
 * Never beside a lifetime number — see the totals row above, which carries no chip at all.
 * A null value renders nothing rather than a dash, because a section header is not the
 * place to explain an unmeasured source; the panel beneath it already does that.
 */
function PeriodBadge({ metric, windowLabel, baselineLabel, unit, invert }: {
  metric: AnalyticsResponse['registrations']['period']['confirmed']
  windowLabel: string
  baselineLabel: string
  unit: string
  invert?: boolean
}) {
  if (metric.value === null) return null
  const showDelta = metric.delta !== null && metric.delta.pct !== null
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fs-xs text-muted-foreground">
      <span>
        <span className="font-semibold tabular-nums text-foreground">{nf(metric.value)}</span>
        {' '}{unit} in the {windowLabel}
      </span>
      {showDelta
        ? <span className="inline-flex items-center gap-x-1.5">
            <DeltaChip delta={metric.delta} invert={invert} />
            <span>vs {baselineLabel}</span>
          </span>
        : metric.unavailable === 'outside_coverage'
          ? <span>no earlier period on record to compare</span>
          : null}
    </p>
  )
}

/**
 * A proportion bar and its legend.
 *
 * The bar draws only measured, positive states. The legend lists EVERY state, so one that
 * could not be read is named as unavailable instead of vanishing — a missing legend row and
 * a zero row are both readable as "none of these", and neither is what happened.
 */
function CompositionPanel({ b, emptyText }: { b: Breakdown; emptyText: string }) {
  const segments = drawableSegments(b)

  if (b.total === null && b.rows.every(x => x.value === null)) {
    return <UnavailableNote>Registration counts could not be read for this event.</UnavailableNote>
  }
  if (segments.length === 0) return <EmptyNote>{emptyText}</EmptyNote>

  return (
    <div className="px-5 pb-5 pt-4">
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-border/60"
        role="img"
        aria-label={b.rows
          .map(x => `${x.label}: ${x.value === null ? 'not measured' : x.value}`)
          .join(', ')}
      >
        {segments.map(s => (
          <div key={s.key} className={cn('h-full', TONE[s.tone])} style={{ width: `${s.pct}%` }} />
        ))}
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {b.rows.map(x => (
          <div key={x.key} className="flex items-baseline gap-2 min-w-0">
            <span className={cn('mt-1 size-2 shrink-0 rounded-[2px]', TONE[x.tone])} aria-hidden />
            <dt className="min-w-0 flex-1 truncate text-fs-xs text-muted-foreground">{x.label}</dt>
            <dd className="shrink-0 text-fs-xs tabular-nums">
              {x.value === null
                ? <span className="text-muted-foreground">{UNAVAILABLE_MARK} not measured</span>
                : <>
                    <span className="font-semibold text-foreground">{nf(x.value)}</span>
                    <span className="ml-1.5 text-muted-foreground">{pctText(x.pct)}</span>
                  </>}
            </dd>
          </div>
        ))}
      </dl>

      {/* Two honesty notes, each rendered only when it is true. */}
      {b.incomplete && (
        <p className="mt-3.5 border-t border-border pt-3 text-fs-xs text-muted-foreground">
          One or more states could not be measured, so these shares do not add up to the whole.
        </p>
      )}
      {!b.incomplete && b.unaccounted !== null && b.unaccounted > 0 && (
        <p className="mt-3.5 border-t border-border pt-3 text-fs-xs text-muted-foreground">
          {nf(b.unaccounted)} registration{b.unaccounted === 1 ? '' : 's'} in a state not shown above.
        </p>
      )}
    </div>
  )
}

/** A percentage, or a mark. Never "0%" for something that was not measured. */
function pctText(pct: number | null | undefined): string {
  return pct === null || pct === undefined ? UNAVAILABLE_MARK : `${pct}%`
}

/** The days the charts actually draw — clipped at the coverage floor, so not the request. */
function drawnRange(data: AnalyticsResponse): string {
  const s = data.registrations.byDay
  return s === null || s.length === 0
    ? `${data.scope.range.from} → ${data.scope.range.to}`
    : `${s[0].date} → ${s[s.length - 1].date}`
}

/** Stated only when something is genuinely incomplete. Same model as the Overview's. */
function CoverageNotice({ data }: { data: AnalyticsResponse }) {
  const notes: string[] = []
  if (data.coverage.unavailable) notes.push('daily trend data could not be read')
  if (data.coverage.partial && data.coverage.since) {
    notes.push(`daily analytics begin ${fmtDay(data.coverage.since)}, so earlier days in this range are not shown`)
  }
  if (!data.limits.registrations) notes.push('registration counts are incomplete')
  if (notes.length === 0) return null

  return (
    <p className="rounded-xl border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/[0.06] px-5 py-3.5 text-fs-xs text-foreground"
       role="status">
      <span className="font-semibold">Some figures are incomplete.</span>{' '}
      Totals are complete for this event; {notes.join(', ')}.
    </p>
  )
}
