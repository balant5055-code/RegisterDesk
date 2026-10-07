'use client'

// RD-DASHBOARD-02 · Trend panel — registrations and revenue over time.
//
// ═══ WHAT MAKES THIS ONE HONEST ══════════════════════════════════════════════
// Its predecessor drew a 90-day chart from a capped 5,000-row sample and captioned it
// "₹X collected in the last 30 days" — a sampled figure stated as a total. This panel
// draws from organizerDailyStats (counted at write time, exact at any volume) and, when
// the data cannot support the claim, SAYS SO instead of drawing zeros:
//
//   trendUnavailable → an error with retry. Never a flat line.
//   historyPartial   → the chart renders, with an explicit note that days before
//                      coverage are not included. A zero-filled uncovered day is
//                      indistinguishable from "nobody registered", so it is disclosed.
//
// The range control is 7/30/90 only. A custom picker was rejected in design: it adds a
// date-range UI to answer a question three presets already answer.

import { useMemo, useState } from 'react'
import { AlertCircle, ArrowDownRight, ArrowUpRight, History, IndianRupee, Info, RefreshCw, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Bars, type ChartPoint } from '@/components/analytics/Charts'
import { accent } from '@/lib/dashboard/accents'
import type { DashboardTrendRange } from '@/app/api/organizer/dashboard/route'

export type TrendRange = 7 | 30 | 90
export const TREND_RANGES: TrendRange[] = [7, 30, 90]

export interface TrendDay { date: string; count: number; revenuePaise: number | null }   // null ⇒ caller may not see money

export interface TrendPanelProps {
  days:             TrendDay[]     // oldest → newest, 90 entries
  unavailable:      boolean
  historySince:     string | null
  historyPartial:   boolean
  /** Money is hidden entirely when the caller's role may not see it. */
  showRevenue:      boolean
  onRetry:          () => void
  formatCurrency:   (paise: number) => string
  /**
   * Replaces the empty-state explanation when the caller knows a better reason.
   *
   * "Your registration trend will appear here as participants sign up" is right for a live
   * event with a quiet week. It is WRONG for an unpublished draft, where nobody can sign up
   * at all — that phrasing would imply the event is open and simply unpopular.
   */
  emptyNote?:       string
}

function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function formatSince(iso: string | null): string {
  if (!iso) return 'a recent date'
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function TrendPanel({
  days, ranges, unavailable, historySince, historyPartial, showRevenue, onRetry, formatCurrency, emptyNote,
}: TrendPanelProps & {
  /**
   * RD-DASH-13 §4 · the 7/30/90 windows with their totals and deltas already computed.
   *
   * This panel used to slice `days` and reduce it twice per toggle — the window and the
   * window before it — and then call `computeDelta` on the result. Those are business
   * totals and a business percentage; the server now runs the same function over the same
   * rollup rows, so the figures are identical and there is one place they can be wrong.
   *
   * `days` is still here, and still needed: the chart draws a bar per day.
   */
  ranges: DashboardTrendRange[]
}) {
  const [range, setRange]   = useState<TrendRange>(30)
  const [metric, setMetric] = useState<'registrations' | 'revenue'>('registrations')

  // Revenue is not merely hidden in the UI — the API omits it — so a gated role must
  // never land on the revenue tab.
  const activeMetric = showRevenue ? metric : 'registrations'

  const sliced = useMemo(() => days.slice(-range), [days, range])

  const points: ChartPoint[] = useMemo(() => sliced.map(d => ({
    label: shortDay(d.date),
    value: activeMetric === 'revenue' ? Math.round((d.revenuePaise ?? 0) / 100) : d.count,
  })), [sliced, activeMetric])

  /** The window the toggles select, RESOLVED by the server. */
  const active = useMemo(
    () => ranges.find(r => r.days === range) ?? null,
    [ranges, range],
  )
  const total = activeMetric === 'revenue'
    ? (active?.revenue?.totalPaise ?? 0)
    : (active?.registrations.total ?? 0)

  /** Busiest day in the window — a derived fact, not an estimate. */
  const peak = useMemo(() => {
    if (points.length === 0) return null
    return points.reduce((best, p) => (p.value > best.value ? p : best), points[0])
  }, [points])

  // Accent follows the metric: money is money-toned, volume is people-toned.
  const a = accent(activeMetric === 'revenue' ? 'money' : 'people')

  /** Same-length previous window — resolved server-side, read here. */
  const rangeDelta = activeMetric === 'revenue'
    ? active?.revenue?.delta
    : active?.registrations.delta

  // Does the requested range reach back before coverage?
  const rangePartial = historyPartial && Boolean(historySince) && sliced.length > 0
    && sliced[0].date < (historySince as string)

  /**
   * ═══ "NO ACTIVITY" vs "NO HISTORY" ═════════════════════════════════════════
   * These are different facts and the panel used to conflate them: `total === 0` won
   * outright, so a window with NO ROLLUP COVERAGE rendered "No registration activity in
   * this period" — an assertion that nothing happened.
   *
   * For an event with thousands of real registrations whose daily rollups only begin at
   * the epoch, that sentence is simply false. The registrations exist; the per-day
   * breakdown for those days does not. Saying "no activity" turns a gap in our own
   * bookkeeping into a claim about the organizer's business.
   *
   * So when the window is empty AND uncovered, the panel says the history is not
   * available — and says from when it is.
   */
  const noCoverageAtAll = total === 0 && historyPartial && sliced.length > 0
    && (!historySince || sliced[sliced.length - 1].date < historySince)
  const uncoveredEmpty  = total === 0 && rangePartial

  return (
    // h-full + flex column: the panel shares a grid row with Upcoming events, which is
    // usually taller. Without this the chart kept its fixed height and left a large
    // blank area below it — the "huge empty white space" this pass set out to remove.
    // The bars now grow into that space instead, which makes them easier to read.
    <section aria-labelledby="trend-heading" className="flex h-full flex-col overflow-hidden rounded-surface border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        {/* The accent switches with the metric, so the chart body and its heading
            always agree about what is being measured. */}
        <span
          className={cn('flex size-6 shrink-0 items-center justify-center rounded-control', a.tile)}
          aria-hidden
        >
          {activeMetric === 'revenue' ? <IndianRupee className="size-3.5" /> : <TrendingUp className="size-3.5" />}
        </span>
        <h2 id="trend-heading" className="text-fs-sm font-semibold text-foreground">
          {activeMetric === 'revenue' ? 'Revenue' : 'Registrations'}
        </h2>

        {showRevenue && (
          <div role="tablist" aria-label="Metric" className="flex rounded-control border border-border p-0.5">
            {(['registrations', 'revenue'] as const).map(m => (
              <button
                key={m}
                role="tab"
                aria-selected={activeMetric === m}
                onClick={() => setMetric(m)}
                className={cn(
                  'rounded-[3px] px-2 py-0.5 text-fs-2xs font-medium transition-colors',
                  activeMetric === m ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m === 'revenue' ? 'Revenue' : 'Registrations'}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex rounded-control border border-border p-0.5" role="group" aria-label="Time range">
          {TREND_RANGES.map(r => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              aria-pressed={range === r}
              className={cn(
                'rounded-[3px] px-2 py-0.5 text-fs-2xs font-medium transition-colors',
                range === r ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {unavailable ? (
        <div role="alert" className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <AlertCircle className="size-5 text-destructive" aria-hidden />
          <p className="text-fs-sm font-medium text-foreground">Trend data could not be loaded</p>
          <p className="max-w-sm text-fs-xs text-muted-foreground">
            This is a loading problem, not a report of zero activity.
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 inline-flex items-center gap-1.5 rounded-control border border-border px-2.5 py-1 text-fs-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <RefreshCw className="size-3.5" aria-hidden /> Retry
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-3">
            <p className="text-fs-2xl font-semibold tabular-nums tracking-tight text-foreground">
              {activeMetric === 'revenue' ? formatCurrency(total) : total.toLocaleString('en-IN')}
            </p>
            {/* Peak day — a real, derived fact that gives the bars a reference point
                instead of leaving the reader to eyeball the tallest column. */}
            {peak && peak.value > 0 && (
              <span className="text-fs-2xs text-muted-foreground">
                {/* `points` holds RUPEES for the revenue series (the chart divides by
                    100), while formatCurrency takes PAISE — so it is converted back
                    here rather than rendering a figure 100× too small. */}
                peak {activeMetric === 'revenue' ? formatCurrency(peak.value * 100) : peak.value.toLocaleString('en-IN')} on {peak.label}
              </span>
            )}
          </div>
          <p className="flex flex-wrap items-center gap-x-2 px-4 pb-1 text-fs-2xs text-muted-foreground">
            <span>
              {activeMetric === 'revenue' ? 'Confirmed revenue' : 'Confirmed registrations'} · last {range} days
            </span>
            {/* Period-over-period for the SELECTED range, computed from the same
                rollup series the bars are drawn from — so the caption and the chart
                can never disagree. Omitted when the previous window had nothing to
                compare against; "up from zero" is not a percentage. */}
            {rangeDelta && rangeDelta.pct !== null && (
              <span className={cn('inline-flex items-center gap-0.5 font-semibold',
                rangeDelta.direction === 'up' ? 'text-accent-money-fg'
                  : rangeDelta.direction === 'down' ? 'text-accent-critical-fg' : 'text-muted-foreground')}>
                {rangeDelta.direction === 'up' ? <ArrowUpRight className="size-3" aria-hidden />
                  : rangeDelta.direction === 'down' ? <ArrowDownRight className="size-3" aria-hidden /> : null}
                {Math.abs(rangeDelta.pct)}% vs previous {range} days
              </span>
            )}
          </p>

          {/* ═══ EMPTY vs BLANK ══════════════════════════════════════════════════
              A 90-day chart of all-zero bars is a large empty rectangle that reads as
              a broken widget. When the window genuinely holds no activity, say so and
              say what will fill it — the reader learns something either way. */}
          {total === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-8 text-center">
              <span className={cn('flex size-8 items-center justify-center rounded-control',
                uncoveredEmpty || noCoverageAtAll ? accent('neutral').tile : a.tile)} aria-hidden>
                {uncoveredEmpty || noCoverageAtAll ? <History className="size-4" /> : <TrendingUp className="size-4" />}
              </span>
              <p className="mt-0.5 text-fs-sm font-medium text-foreground">
                {uncoveredEmpty || noCoverageAtAll
                  ? 'Daily history not available for this period'
                  : `No ${activeMetric === 'revenue' ? 'revenue' : 'registration activity'} in this period`}
              </p>
              <p className="max-w-sm text-fs-xs text-muted-foreground">
                {uncoveredEmpty || noCoverageAtAll
                  // Explicitly NOT "no registrations". The totals above are real and come
                  // from the counters; only the per-day breakdown is missing.
                  ? `Day-by-day totals ${historySince ? `begin on ${formatSince(historySince)}` : 'have not started yet'}. Registrations before then are counted in the totals above, but their daily history was not recorded — so it is not shown as zero.`
                  : emptyNote ?? (activeMetric === 'revenue'
                    ? 'Confirmed paid registrations will appear here as they come in.'
                    : 'Your registration trend will appear here as participants sign up.')}
              </p>
              {/* A shorter range often IS covered, so offer the move rather than leaving
                  the reader at a dead end. */}
              {(uncoveredEmpty || noCoverageAtAll) && range !== 7 && (
                <button
                  type="button"
                  onClick={() => setRange(7)}
                  className="mt-1.5 inline-flex items-center gap-1 rounded-control border border-border px-2 py-1 text-fs-2xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Try the last 7 days
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-1 flex-col px-4 pb-3 pt-1">
              <Bars
                data={points}
                axis
                barClassName={activeMetric === 'revenue' ? 'bg-accent-money-fg/85 group-hover:bg-accent-money-fg' : 'bg-accent-people-fg/85 group-hover:bg-accent-people-fg'}
                height="100%"
                label={`${activeMetric === 'revenue' ? 'Revenue' : 'Registrations'} over the last ${range} days`}
                format={activeMetric === 'revenue' ? (n => formatCurrency(n * 100)) : undefined}
              />
            </div>
          )}

          {rangePartial && (
            <p className="flex items-start gap-1.5 border-t border-border bg-muted/40 px-4 py-2 text-fs-2xs text-muted-foreground">
              <Info className="mt-px size-3 shrink-0" aria-hidden />
              <span>
                History before {formatSince(historySince)} is not included — daily totals began then.
                Earlier days are shown as no activity, not as measured zeros.
              </span>
            </p>
          )}
        </>
      )}
    </section>
  )
}
