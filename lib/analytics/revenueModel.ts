// RD-ANALYTICS-09 · the Revenue module's derivations. PURE — no Firestore, no React.
//
// ═══ WHY FINANCIAL ARITHMETIC DOES NOT LIVE IN A COMPONENT ═══════════════════
// Every function here operates on integer PAISE and returns integer paise. Formatting to
// rupees happens once, at the presentation boundary, and never before a calculation. A
// component that divided by 100 to display and then added the results would introduce
// floating-point error into a figure an organizer reconciles against a bank statement.
//
// ═══ THE RULE EVERY FUNCTION OBEYS ═══════════════════════════════════════════
// A derived figure is published ONLY when every input was measured. `MaybeMoney` carries
// that distinction, and the one thing this module must never do is turn `{ ok: false }`
// into a zero — which is how "we could not read the ledger" becomes "₹0 collected".
//
// ═══ AND THE VOCABULARY ══════════════════════════════════════════════════════
// Five money figures reach this module and NONE of them is interchangeable:
//
//   confirmedRevenue  Σ ticket `amount` over CONFIRMED registrations. Refund-STABLE.
//   netRevenue        the above, less COMPLETED refunds. A different question.
//   grossCollected    what the payment GATEWAY captured. A different population.
//   netSettlement     the gateway's own net, after its fees.
//   refunds           money actually returned, from the refund ledger.
//
// The module names each one and never lets "Revenue" stand unqualified for any of them.

import type { MaybeMoney } from '@/lib/finance/gatewayFee'
import type { AnalyticsResponse, Count, RevenueAnalytics } from '@/lib/analytics/contract'

/** Paise → "₹1,25,000". The ONLY place a financial number becomes text. */
export function inrPaise(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(Math.trunc(paise) / 100)
}

/** A money value for display, or null when it was not measured. Never "₹0" for unknown. */
export function displayMoney(m: MaybeMoney | undefined): string | null {
  return m && m.ok ? inrPaise(m.paise) : null
}

/**
 * Why a money figure is missing, in words the reader can act on.
 *
 * `out_of_budget` is the one that matters: it does NOT mean the read failed, it means the
 * event has more ledger rows than the bounded read may fetch, so any sum would be partial.
 * Saying "unavailable" for that would invite a retry that cannot help.
 */
export function moneyUnavailableNote(m: MaybeMoney | undefined): string {
  if (!m || m.ok) return ''
  switch (m.reason) {
    case 'out_of_budget': return 'too many ledger entries to total safely'
    case 'query_failed':  return 'could not be read'
    default:              return 'not available'
  }
}

/** One row of a money breakdown. `paise` null ⇒ unmeasured; never rendered as zero. */
export interface MoneyRow {
  key:   string
  label: string
  /** What this figure IS, in one line. Every financial row carries its definition. */
  definition: string
  money: MaybeMoney | undefined
  tone:  'primary' | 'positive' | 'warning' | 'danger' | 'neutral' | 'muted'
  /** RD-ANALYTICS-12-26 · a unit rendered after the figure, e.g. "/day". Optional. */
  suffix?: string
  /**
   * RD-ANALYTICS-12-33 · the figure has NO DENOMINATOR — a measured fact, not a failed read.
   * When set, the renderer prints the unavailable mark with THIS note and never the
   * read-failure wording; the payload's own `reason` is left untouched.
   */
  emptyDenominatorNote?: string
}

/**
 * The headline financial figures, each with its definition attached.
 *
 * Order is the reading order an organizer needs: what was sold, what went back, what is
 * left. `netRevenue` sits third because it is derived from the two above it, and a reader
 * who sees the inputs first can check the arithmetic.
 */
export function revenueHeadlines(r: RevenueAnalytics): MoneyRow[] {
  return [
    { key: 'confirmed', label: 'Confirmed revenue',
      definition: 'Ticket value of confirmed registrations, all time',
      money: r.confirmedRevenue, tone: 'primary' },
    { key: 'refunds', label: 'Completed refunds',
      definition: 'Money returned, from the refund ledger',
      money: r.refunds, tone: 'danger' },
    { key: 'net', label: 'Net revenue',
      definition: 'Confirmed revenue less completed refunds',
      money: r.netRevenue, tone: 'positive' },
  ]
}

/**
 * The gateway's own figures.
 *
 * Kept in a SEPARATE group from the headlines, because they count a different population:
 * captures made through the payment gateway, not confirmed registrations. A free
 * registration contributes to confirmed revenue and never appears here; a capture whose
 * registration was later cancelled appears here and not there. Presenting them in one list
 * would invite the reader to subtract across that boundary.
 */
export function gatewayRows(r: RevenueAnalytics): MoneyRow[] {
  return [
    { key: 'gross', label: 'Gross collected',
      definition: 'Captured by the payment gateway for this event',
      money: r.grossCollected, tone: 'neutral' },
    { key: 'platformFee', label: 'Platform fee',
      definition: 'RegisterDesk fee on those captures',
      money: r.platformFee, tone: 'muted' },
    { key: 'gst', label: 'GST on platform fee',
      definition: 'Tax charged on the platform fee',
      money: r.gst, tone: 'muted' },
    { key: 'gatewayFee', label: 'Gateway fee',
      definition: 'Charged by the payment gateway',
      money: r.gatewayFee, tone: 'muted' },
    { key: 'net', label: 'Net settlement',
      definition: 'What the gateway settles to the organizer, after its fees',
      money: r.netSettlement, tone: 'positive' },
  ]
}

/**
 * Was any gateway figure measured?
 *
 * Used to decide whether the gateway section is worth drawing at all. When every figure is
 * unavailable the section states ONE reason rather than repeating it five times.
 */
export function gatewayAvailability(r: RevenueAnalytics): {
  anyMeasured: boolean
  reasonNote:  string
} {
  const rows = gatewayRows(r)
  return {
    anyMeasured: rows.some(x => x.money?.ok),
    reasonNote:  moneyUnavailableNote(r.grossCollected),
  }
}

/**
 * The period revenue figure and its comparison — from the SHARED overview metric.
 *
 * Deliberately not recomputed here. `overview.revenuePaise` is period-against-preceding-
 * period, both sides summed from the same rollup rows, and it is ABSENT for a caller
 * without `transactions`. Re-deriving it in this module would create a second financial
 * comparison that could disagree with the Overview's, and would need its own omission rule.
 */
export function periodRevenue(data: AnalyticsResponse) {
  return data.overview.revenuePaise ?? null
}

/**
 * Revenue per pass, with its basis and share.
 *
 * Shares are taken against the sum of the passes shown, because `byPass` measures confirmed
 * ticket VALUE per pass — comparing it to `confirmedRevenue` would be comparing it to a
 * figure computed over the same population by a different reader, and any rounding or
 * timing difference between the two would surface as a share that does not reach 100%.
 */
export function revenueByPass(r: RevenueAnalytics): {
  rows: { label: string; paise: number; pct: number | null }[]
  totalPaise: number
  basis: RevenueAnalytics['byPassBasis']
} {
  const totalPaise = r.byPass.reduce((n, p) => n + p.valuePaise, 0)
  return {
    rows: r.byPass.map(p => ({
      label: p.label,
      paise: p.valuePaise,
      pct: totalPaise > 0 ? Math.round((p.valuePaise / totalPaise) * 1000) / 10 : null,
    })),
    totalPaise,
    basis: r.byPassBasis,
  }
}

/**
 * RD-ANALYTICS-12-26 · the derived money figures, each with the basis it was computed on.
 *
 * Read straight off the payload's `intelligence` block: the arithmetic happened in the
 * producer, and this function only decides how to say it. Every definition names the
 * denominator or the window, because a derived figure without its basis is exactly the
 * kind of number that gets compared against the wrong thing.
 *
 * Tolerates a payload without the block — an older fixture, or a producer that omitted it —
 * by returning no rows rather than rows that claim ₹0.
 */
export function intelligenceRows(r: RevenueAnalytics, windowLabel: string): MoneyRow[] {
  const i = r.intelligence
  if (!i) return []
  const aovDenominator = i.averageOrderValue.denominator
  return [
    { key: 'velocity', label: 'Revenue velocity',
      definition: `Confirmed revenue per day, ${windowLabel}`,
      money: i.velocity.perDayPaise, tone: 'primary', suffix: '/day' },
    { key: 'aov', label: 'Average order value',
      definition: aovDenominator !== null && aovDenominator > 0
        ? `Confirmed revenue ÷ ${aovDenominator.toLocaleString('en-IN')} paid registrations, all time`
        : 'Confirmed revenue per paid registration, all time',
      money: i.averageOrderValue.paise, tone: 'neutral',
      // A denominator of exactly 0 is measured: nothing was paid, so there is no average.
      // Null means the count itself could not be read, which stays a read failure.
      ...(aovDenominator === 0 ? { emptyDenominatorNote: 'No paid registrations yet' } : {}) },
    { key: 'beforeDiscount', label: 'Ticket value before discount',
      definition: i.beforeDiscount.discount.ok
        ? `Confirmed revenue plus ${inrPaise(i.beforeDiscount.discount.paise)} of discount given`
        : 'Confirmed revenue plus discount given — discount could not be read',
      money: i.beforeDiscount.paise, tone: 'muted' },
  ]
}

/**
 * RD-ANALYTICS-12-26 · the refund figures for the window, and the rate — as display values.
 *
 * `ratePct` is null when unmeasured OR when confirmed revenue is zero, and the caller must
 * render that as absent rather than as 0%: a free event with a refund is not a 0% refund
 * rate, it is a rate with no denominator.
 */
export function refundIntelligence(r: RevenueAnalytics): {
  ratePct:       number | null
  periodAmount:  string | null
  periodCount:   number | null
  comparison:    RevenueAnalytics['intelligence']['refundsInPeriod']['comparison'] | null
  periodNote:    string
} | null {
  const i = r.intelligence
  if (!i) return null
  return {
    ratePct:      i.refundRate.pct,
    periodAmount: displayMoney(i.refundsInPeriod.amount),
    periodCount:  i.refundsInPeriod.count,
    comparison:   i.refundsInPeriod.comparison,
    periodNote:   moneyUnavailableNote(i.refundsInPeriod.amount),
  }
}

/**
 * The paying population, as COUNTS — never as money.
 *
 * ═══ WHY THIS IS NOT A REVENUE BREAKDOWN ═════════════════════════════════════
 * "Paid registrations" and "confirmed revenue" are related and different: a paid
 * registration may since have been cancelled, a confirmed one may be free, and neither
 * count carries an amount. Publishing these as counts beside the money — rather than
 * attaching rupee values to them — is what keeps the two measures from being read as one.
 */
export function payingPopulation(reg: AnalyticsResponse['registrations']): {
  key: string; label: string; definition: string; value: Count
}[] {
  return [
    { key: 'paid', label: 'Paid registrations', value: reg.paid,
      definition: 'Payment completed' },
    { key: 'free', label: 'Free registrations', value: reg.free,
      definition: 'No payment required' },
    { key: 'awaiting', label: 'Awaiting payment', value: reg.paymentPending,
      definition: 'Payment not yet completed' },
    { key: 'refundPending', label: 'Refund in progress', value: reg.refundPending,
      definition: 'Refund requested, not yet completed' },
    { key: 'refunded', label: 'Refunded', value: reg.refunded,
      definition: 'Registration whose payment was returned' },
  ]
}
