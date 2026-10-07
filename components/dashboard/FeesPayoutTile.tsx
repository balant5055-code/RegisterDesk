'use client'

// RD-DASHBOARD-12 · Fees & payout — the fourth primary card.
//
// ═══ WHY IT REPLACED EVENT STATUS ════════════════════════════════════════════
// Event status is one word the organizer can read from the Event Selector and the events
// list. "What do I actually get paid, and what was taken out?" is a question the dashboard
// could not answer at all, and it is the one an organizer asks after every event.
//
// ═══ EVERY FIGURE IS RECORDED, NONE IS DERIVED HERE ══════════════════════════
// The card renders `DashboardFees` verbatim. The server aggregates `platformTransactions`
// through the Finance module's own resolver, so the dashboard cannot disagree with
// /dashboard/finance, and no percentage is applied to anything on this screen.
//
// ═══ THE GATEWAY FEE SAYS WHAT IT IS MADE OF ═════════════════════════════════
// The server resolves it per transaction — what Razorpay actually charged where that is
// recorded, the stored estimate everywhere else — and sends the BASIS with the number.
// This card renders that basis rather than deciding it, because only the server knows how
// many rows were reconciled. A fee shown bare would read as settled fact; a fee shown as
// ₹0 because nothing was reconciled would be worse. Both are refused here.
//
// "est." means every transaction in scope is estimated; "part est." means some are and
// some are not. The tooltip carries the coverage and the tax, which is a COMPONENT of the
// fee — Razorpay reports amount − fee = credit, so the two are never added together.

import Link from 'next/link'
import { ArrowRight, Landmark } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { kpiFill, ON_FILL } from '@/lib/dashboard/accents'
import { CardMotif } from './CardMotif'
import type { DashboardFees } from '@/app/api/organizer/dashboard/route'

const FINANCE_HREF = '/dashboard/finance'

export function FeesPayoutTile({ fees, formatCurrency, className }: {
  fees: DashboardFees
  formatCurrency: (paise: number) => string
  className?: string
}) {
  // A null figure is UNMEASURED, never zero. "—" is the only honest render for it.
  const money = (v: number | null) => (v === null ? '—' : formatCurrency(v))
  const scopeLabel = fees.scope === 'workspace' ? 'All events' : undefined

  // The gateway line, assembled from the server's resolution. Suffix and tooltip both come
  // from `gatewayBasis`; nothing here re-derives whether the figure is a fact or a forecast.
  const gateway = ((): { value: string; title: string | undefined } => {
    if (fees.gatewayFeePaise === null) return { value: '—', title: undefined }
    const amount = money(fees.gatewayFeePaise)
    const { withActual, total } = fees.gatewayCoverage
    const tax = fees.gatewayTaxPaise !== null
      ? ` Includes ${money(fees.gatewayTaxPaise)} tax — a component of this fee, not an addition to it.`
      : ''
    if (fees.gatewayBasis === 'actual') {
      return { value: amount, title: `What Razorpay actually charged, across all ${total ?? 0} transactions.${tax}` }
    }
    if (fees.gatewayBasis === 'mixed') {
      return {
        value: `${amount} part est.`,
        title: `${withActual ?? 0} of ${total ?? 0} transactions carry the fee Razorpay actually charged; the rest are shown at their recorded estimate.${tax}`,
      }
    }
    return {
      value: `${amount} est.`,
      title: 'Recorded estimate. No transaction in scope carries a settled gateway fee yet.',
    }
  })()

  return (
    <section
      aria-label="Fees and payout"
      // The gold→amber fill. Ink here is a deep brown, not white: no gold light enough
      // to still read as gold can carry white type, so the card keeps its hue and changes
      // its ink. `kpiFill` publishes that ink as --foreground for the whole subtree.
      style={kpiFill('fees')}
      className={cn(
        'relative flex h-full min-w-0 flex-col overflow-hidden rounded-surface p-3.5',
        'shadow-[0_6px_20px_-8px_rgb(0_0_0_/_0.28)]',
        className,
      )}
    >
      <CardMotif kind="finance" onFill />

      {/* Header — icon and title on ONE row, the same structure every KPI card uses. */}
      <div className="relative flex h-8 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-surface', ON_FILL.tile)} aria-hidden>
            <Landmark className="size-4" />
          </span>
          <span className="min-w-0 truncate text-fs-xs font-medium text-muted-foreground">
            Fees &amp; payout
          </span>
        </span>
        {scopeLabel && (
          <span className="shrink-0 rounded-control bg-white/25 px-2 py-1 text-fs-2xs font-medium text-foreground ring-1 ring-inset ring-white/25">
            {scopeLabel}
          </span>
        )}
      </div>

      {fees.unavailable ? (
        <>
          <p className="relative mt-2 text-fs-2xl font-semibold leading-none tabular-nums text-muted-foreground/50">—</p>
          <p className="relative mt-1 text-fs-2xs leading-snug text-muted-foreground">
            Settlement figures could not be loaded, so none are shown.
          </p>
        </>
      ) : (
        <>
          {/* NET PAYOUT is the headline: it is the number the organizer is owed. */}
          <p className="relative mt-3 text-fs-2xl font-bold leading-none tracking-tight tabular-nums text-foreground">
            {money(fees.netPayoutPaise)}
          </p>
          <p className="relative mt-1.5 text-fs-2xs text-muted-foreground">
            Net payout
            {fees.transactions !== null && <> · {fees.transactions.toLocaleString('en-IN')} transaction{fees.transactions === 1 ? '' : 's'}</>}
          </p>

          {/* The breakdown — a compact list, NOT three more cards. */}
          <dl className="relative mt-auto space-y-1.5 border-t border-border pt-2.5 text-fs-2xs">
            <Line label="Platform fee" value={money(fees.platformFeePaise)} />
            <Line
              label="Razorpay fee"
              value={gateway.value}
              title={gateway.title}
            />
            <Line label="Total fees" value={money(fees.totalFeesPaise)} strong />
          </dl>
        </>
      )}

      <Link
        href={FINANCE_HREF}
        className="relative mt-2.5 inline-flex items-center gap-1 text-fs-2xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        View finance <ArrowRight className="size-3" aria-hidden />
      </Link>
    </section>
  )
}

function Line({ label, value, strong, title }: {
  label: string; value: string; strong?: boolean; title?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3" title={title}>
      <dt className="min-w-0 truncate text-muted-foreground">{label}</dt>
      {/* Right-aligned tabular numerals: the three amounts line up on their decimal
          regardless of width, which is the whole reason the block reads as a statement
          rather than as three unrelated rows. */}
      <dd className={cn('shrink-0 text-right tabular-nums', strong ? 'font-semibold' : 'font-medium', 'text-foreground')}>
        {value}
      </dd>
    </div>
  )
}
