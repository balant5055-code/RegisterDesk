'use client'

// RD-ANALYTICS-09 · Revenue Intelligence.
//
// ═══ THE QUESTION THIS PAGE ANSWERS ══════════════════════════════════════════
// "What did this event sell, what went back, and what is left" — followed by the gateway's
// own account of the same money, kept deliberately apart from it.
//
// ═══ WHAT IT REFUSES TO DO ═══════════════════════════════════════════════════
//   • no unavailable figure renders as ₹0 — every one branches on `ok` first, and says WHY
//   • no rupee arithmetic: every calculation happened server-side in integer paise, and
//     `inrPaise` is the only place a number becomes currency text
//   • no delta beside a lifetime figure; the comparison sits with the period figure
//   • no gateway figure carries the bare word "Revenue"
//   • no "paid registrations equals revenue" — counts and money are separate groups
//   • the whole module is absent without `transactions`; it is not hidden in React

import { useMemo } from 'react'
import { cn } from '@/lib/utils/cn'
import type { AnalyticsResponse } from '@/lib/analytics/contract'
import {
  revenueHeadlines, gatewayRows, gatewayAvailability, periodRevenue, revenueByPass,
  payingPopulation, displayMoney, moneyUnavailableNote, inrPaise, type MoneyRow,
  intelligenceRows, refundIntelligence,
} from '@/lib/analytics/revenueModel'
import { useAnalyticsScope, type AnalyticsScopeState } from '../useAnalyticsScope'
import { ModuleHeader, ModuleStates, fmtDay } from '../ModuleChrome'
import { Section, EmptyNote, UnavailableNote, DeltaChip, UNAVAILABLE_MARK, nf } from '../overview/Primitives'
import { TrendPanel } from '../overview/TrendPanel'

const TONE: Record<MoneyRow['tone'], string> = {
  primary:  'text-foreground',
  positive: 'text-[color:var(--success)]',
  danger:   'text-[color:var(--destructive)]',
  warning:  'text-[color:var(--warning)]',
  neutral:  'text-foreground',
  muted:    'text-muted-foreground',
}

export function RevenueAnalytics() {
  const scope = useAnalyticsScope()
  const { data } = scope

  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Analytics"
        title="Revenue"
        subtitle="Ticket revenue, refunds and gateway settlement for one event."
        scope={scope}
      />
      <ModuleStates scope={scope}>
        {data && (data.revenue
          ? <Body data={data} revenue={data.revenue} scope={scope} />
          : <NoFinancialAccess />)}
      </ModuleStates>
    </div>
  )
}

/**
 * What a caller without `transactions` sees.
 *
 * The `revenue` key is ABSENT from their payload — this is not a hidden section, there is
 * nothing to hide. Saying so plainly is better than an empty page that looks broken.
 */
function NoFinancialAccess() {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-14 text-center">
      <p className="text-fs-md font-semibold text-foreground">Financial analytics are not available to you</p>
      <p className="mx-auto mt-1.5 max-w-md text-fs-sm text-muted-foreground">
        Revenue reporting requires the Transactions permission. No financial figures were
        sent to this page.
      </p>
    </div>
  )
}

function Body({ data, revenue, scope }: {
  data: AnalyticsResponse
  revenue: NonNullable<AnalyticsResponse['revenue']>
  scope: AnalyticsScopeState
}) {
  const { windowLabel, baselineLabel } = scope

  const headlines = useMemo(() => revenueHeadlines(revenue), [revenue])
  const gateway   = useMemo(() => gatewayRows(revenue), [revenue])
  const gatewayOk = useMemo(() => gatewayAvailability(revenue), [revenue])
  const passes    = useMemo(() => revenueByPass(revenue), [revenue])
  const paying    = useMemo(() => payingPopulation(data.registrations), [data.registrations])
  const period    = periodRevenue(data)
  const intel     = useMemo(() => intelligenceRows(revenue, windowLabel), [revenue, windowLabel])
  const refunds   = useMemo(() => refundIntelligence(revenue), [revenue])

  return (
    <>
      {/* ── 1 · The money, in reading order: sold → returned → kept. Lifetime, no chips. ── */}
      <section className="overflow-hidden rounded-xl border border-border bg-card"
               aria-label="Revenue totals">
        <div className="grid divide-y divide-border sm:grid-cols-3 sm:divide-y-0 sm:divide-x">
          {headlines.map(row => <MoneyMetric key={row.key} row={row} />)}
        </div>
      </section>

      {/* ── 1b · RD-ANALYTICS-12-26 · derived figures, each stating what it was divided by.
             Rendered only when the producer published the block, so an older payload shows
             nothing here rather than three rows claiming ₹0. ────────────────────────── */}
      {intel.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-border bg-card"
                 aria-label="Revenue intelligence">
          <div className="grid divide-y divide-border sm:grid-cols-3 sm:divide-y-0 sm:divide-x">
            {intel.map(row => <MoneyMetric key={row.key} row={row} />)}
          </div>
          {refunds && (
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 border-t border-border px-5 py-3 text-fs-xs text-muted-foreground">
              <span>
                <span className="font-semibold uppercase tracking-[0.08em]">Refund rate</span>{' '}
                {refunds.ratePct === null
                  ? <span>{UNAVAILABLE_MARK}<span className="ml-1.5">needs measured revenue above zero</span></span>
                  : <span className="font-semibold tabular-nums text-foreground">{refunds.ratePct}%</span>}
                {refunds.ratePct !== null && <span className="ml-1.5">of confirmed revenue returned</span>}
              </span>
              <span>
                <span className="font-semibold uppercase tracking-[0.08em]">Refunds {windowLabel}</span>{' '}
                {refunds.periodAmount === null
                  ? <span>{UNAVAILABLE_MARK}<span className="ml-1.5">{refunds.periodNote}</span></span>
                  : <>
                      <span className="font-semibold tabular-nums text-foreground">{refunds.periodAmount}</span>
                      {refunds.periodCount !== null && <span className="ml-1.5">across {nf(refunds.periodCount)} {refunds.periodCount === 1 ? "refund" : "refunds"}</span>}
                      {refunds.comparison?.delta && refunds.comparison.delta.pct !== null
                        ? <span className="ml-2 inline-flex items-center gap-x-1.5">
                            <DeltaChip delta={refunds.comparison.delta} /><span>vs {baselineLabel}</span>
                          </span>
                        : refunds.comparison?.unavailable === 'outside_coverage'
                          ? <span className="ml-2">no earlier period on record to compare</span>
                          : null}
                    </>}
              </span>
            </div>
          )}
        </section>
      )}

      {/* ── 2 · Movement in the selected window. Deltas appear here and on the windowed
             refund line above — both against the same baseline, both refused when it is
             outside coverage. ─────────────────────────────────────────────────────── */}
      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Section
          title="Revenue trend"
          subtitle={<>Confirmed ticket revenue per day · {drawnRange(data)}</>}
          action={period && period.value !== null ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fs-xs text-muted-foreground">
              <span>
                <span className="font-semibold tabular-nums text-foreground">{inrPaise(period.value)}</span>
                {' '}in the {windowLabel}
              </span>
              {period.delta && period.delta.pct !== null
                ? <span className="inline-flex items-center gap-x-1.5">
                    <DeltaChip delta={period.delta} /><span>vs {baselineLabel}</span>
                  </span>
                : period.unavailable === 'outside_coverage'
                  ? <span>no earlier period on record to compare</span>
                  : null}
            </p>
          ) : null}
        >
          <TrendPanel
            series={revenue.byDay?.map(p => ({ date: p.date, value: p.valuePaise })) ?? null}
            unit="revenue"
            format={inrPaise}
            describe="Confirmed ticket revenue per day"
            emptyText="No revenue recorded in this period."
            unavailableText="Daily revenue could not be read for this event."
          />
        </Section>

        <Section
          title="Payment gateway"
          subtitle="Captures for this event — a different population from ticket revenue"
        >
          {!gatewayOk.anyMeasured ? (
            <UnavailableNote>
              Gateway figures {gatewayOk.reasonNote || 'are not available'} for this event.
            </UnavailableNote>
          ) : (
            <dl className="divide-y divide-border">
              {gateway.map(row => (
                <div key={row.key} className="flex items-baseline justify-between gap-4 px-5 py-2.5">
                  <div className="min-w-0">
                    <dt className="truncate text-fs-sm text-foreground">{row.label}</dt>
                    <p className="mt-0.5 truncate text-fs-2xs text-muted-foreground">{row.definition}</p>
                  </div>
                  <dd className={cn('shrink-0 text-fs-sm font-semibold tabular-nums', TONE[row.tone])}>
                    {displayMoney(row.money) ?? (
                      <span className="font-normal text-muted-foreground">
                        {UNAVAILABLE_MARK} {moneyUnavailableNote(row.money)}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Section>
      </section>

      {/* ── 3 · Secondary. Counts and money kept in separate panels on purpose. ───── */}
      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section
          title="Revenue by pass"
          subtitle="Confirmed ticket value, all time — not limited to the selected period"
        >
          {passes.rows.length === 0
            ? <EmptyNote>No pass-level revenue recorded yet.</EmptyNote>
            : (
              <ul className="divide-y divide-border">
                {passes.rows.map(p => (
                  <li key={p.label} className="px-5 py-3">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="min-w-0 truncate text-fs-sm text-foreground">{p.label}</span>
                      <span className="shrink-0 text-fs-sm font-semibold tabular-nums text-foreground">
                        {inrPaise(p.paise)}
                        <span className="ml-2 font-normal text-fs-xs text-muted-foreground">
                          {p.pct === null ? UNAVAILABLE_MARK : `${p.pct}%`}
                        </span>
                      </span>
                    </div>
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

        <Section
          title="Paying population"
          /* Counts, not money. "Paid registrations" is not "confirmed revenue": a paid
             registration may have been cancelled, and a confirmed one may be free. */
          subtitle="Registrations by payment status — counts, not amounts"
        >
          <dl className="divide-y divide-border">
            {paying.map(row => (
              <div key={row.key} className="flex items-baseline justify-between gap-4 px-5 py-2.5">
                <div className="min-w-0">
                  <dt className="truncate text-fs-sm text-foreground">{row.label}</dt>
                  <p className="mt-0.5 truncate text-fs-2xs text-muted-foreground">{row.definition}</p>
                </div>
                <dd className="shrink-0 text-fs-sm font-semibold tabular-nums text-foreground">
                  {row.value === null
                    ? <span className="font-normal text-muted-foreground">{UNAVAILABLE_MARK} not measured</span>
                    : nf(row.value)}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      </section>

      {/* ── 4 · The estimate, last, and only when every input was measured. ───────── */}
      <ProfitNote revenue={revenue} />
      <CoverageNotice data={data} />
    </>
  )
}

/** One headline figure. Lifetime, so it never carries a comparison chip. */
function MoneyMetric({ row }: { row: MoneyRow }) {
  const value = displayMoney(row.money)
  return (
    <div className="min-w-0 px-5 py-4">
      <p className="text-fs-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {row.label}
      </p>
      {value === null ? (
        <p className="mt-1.5 text-fs-md font-medium text-muted-foreground">
          {UNAVAILABLE_MARK}
          {/* RD-ANALYTICS-12-33 · an empty denominator is not a failed read and must not
              wear its words. The mark is the same; the sentence is the fact. */}
          <span className="ml-1.5 text-fs-xs font-normal">
            {row.emptyDenominatorNote ?? moneyUnavailableNote(row.money)}
          </span>
        </p>
      ) : (
        <p className={cn('mt-1.5 font-semibold tabular-nums',
                         'text-[length:var(--fs-xl)]', 'leading-none', TONE[row.tone])}>
          {value}
          {row.suffix && <span className="ml-0.5 text-fs-sm font-normal text-muted-foreground">{row.suffix}</span>}
        </p>
      )}
      <p className="mt-1.5 text-fs-xs text-muted-foreground">{row.definition}</p>
    </div>
  )
}

/**
 * The profit estimate, stated as an estimate with its formula visible.
 *
 * Rendered only when the producer published one — which it does only when net settlement,
 * completed refunds and communication spend were ALL measured. Printing the formula is the
 * point: a single "Profit" figure with no arithmetic behind it is what RD-ANALYTICS-02 had
 * to remove.
 */
function ProfitNote({ revenue }: { revenue: NonNullable<AnalyticsResponse['revenue']> }) {
  if (!revenue.profitEstimate.ok) return null
  return (
    <p className="rounded-xl border border-border bg-muted/30 px-5 py-3.5 text-fs-xs text-muted-foreground">
      <span className="font-semibold text-foreground">
        Estimated retained: {inrPaise(revenue.profitEstimate.paise)}
      </span>{' '}
      — net settlement less completed refunds less communication spend. An estimate, shown
      only because all three inputs were measured for this event.
    </p>
  )
}

/** The days the chart actually draws — clipped at the coverage floor, not the request. */
function drawnRange(data: AnalyticsResponse): string {
  const s = data.revenue?.byDay
  return !s || s.length === 0
    ? `${data.scope.range.from} → ${data.scope.range.to}`
    : `${s[0].date} → ${s[s.length - 1].date}`
}

/** Stated only when something is genuinely incomplete. The RD-07 model, reused. */
function CoverageNotice({ data }: { data: AnalyticsResponse }) {
  const notes: string[] = []
  if (data.coverage.unavailable) notes.push('daily revenue could not be read')
  if (data.coverage.partial && data.coverage.since) {
    notes.push(`daily analytics begin ${fmtDay(data.coverage.since)}, so earlier days in this range are not shown`)
  }
  if (!data.limits.ledger) notes.push('payment gateway figures are incomplete for this event')
  if (!data.limits.passValue) notes.push('per-pass revenue is incomplete')
  if (notes.length === 0) return null

  return (
    <p className="rounded-xl border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/[0.06] px-5 py-3.5 text-fs-xs text-foreground"
       role="status">
      <span className="font-semibold">Some figures are incomplete.</span>{' '}
      Confirmed revenue is complete for this event; {notes.join(', ')}.
    </p>
  )
}
