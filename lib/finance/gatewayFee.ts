// RD-FIN-10 · The money vocabulary, and the gateway fee resolver. PURE.
//
// Split out of financeAnalytics.ts, which imports the Admin SDK at module scope and so boots
// Firestore on import. Everything here is arithmetic over plain numbers — no Firestore, no
// clock, no configuration, no rate — which is exactly what makes the fee resolution testable
// without a live project, and what keeps it honest: it cannot reach for a figure it was not
// handed, so it can never quietly substitute one.

/**
 * Why a figure is missing. `null` is never used to mean zero: a Finance surface showing ₹0
 * for "we could not measure this" is worse than one that says so, because the reader cannot
 * tell the difference.
 */
export type Unavailable =
  | 'no_authoritative_field'   // no row in scope stores it (e.g. gateway tax before reconciliation)
  | 'requires_index'           // computable, but no verified index supports it
  | 'query_failed'             // a read failed at runtime
  | 'out_of_budget'            // a bounded fan-out or read stopped before finishing

export interface Money { paise: number }
export type MaybeMoney = { ok: true; paise: number } | { ok: false; reason: Unavailable }

export const money = (paise: number): MaybeMoney => ({ ok: true, paise: Math.trunc(paise) })
export const gone  = (reason: Unavailable): MaybeMoney => ({ ok: false, reason })

/**
 * How the gateway fee over a set of transactions was arrived at.
 *
 * `mixed` is not a hedge. It is the state every workspace passes through while actual gateway
 * facts arrive on new payments and historical rows still carry only an estimate. Collapsing it
 * into `actual` would relabel estimated money as reconciled; collapsing it into `estimated`
 * would throw away facts already held. It is reported as itself.
 */
export type GatewayFeeBasis = 'actual' | 'estimated' | 'mixed'

export interface GatewayResolution {
  /**
   * Per-transaction `gatewayFeeActualPaise ?? gatewayFeeEstimatePaise`, summed — exact in all
   * three basis states. See `resolveGatewayFee` for the arithmetic.
   *
   * ⚠ TAX-INCLUSIVE. `tax` below is the GST COMPONENT of this figure, not a sibling charge.
   * The gateway's own statement satisfies amount − fee = credit, so adding the two together
   * counts the tax twice and overstates what was taken.
   */
  fee:      MaybeMoney
  /** GST contained WITHIN `fee`, over the rows carrying an actual. Never added to it. */
  tax:      MaybeMoney
  basis:    GatewayFeeBasis
  /** How many rows in scope carry an actual gateway fact, out of how many rows there are. */
  coverage: { withActual: number | null; total: number | null }
}

/** The covered-row aggregate: gateway facts, plus the estimate OF THOSE SAME ROWS. */
export interface CoveredGatewayRows {
  count: number
  sums: {
    gatewayFeeActualPaise:   number
    gatewayTaxPaise:         number
    gatewayFeeEstimatePaise: number
  }
}

/**
 * Resolve the gateway fee from two aggregates.
 *
 * ═══ PER-TRANSACTION RESOLUTION, DONE IN AGGREGATE ═══════════════════════════
 * The rule is per transaction: use the actual when that row has one, else its estimate. A sum
 * cannot branch per row, but this identity gets there exactly:
 *
 *     Σ actual(covered)  +  [ Σ estimate(all) − Σ estimate(covered) ]
 *
 * The bracket is the estimate of precisely the rows with no actual, so every transaction
 * contributes exactly one of its two figures — never both, never neither.
 */
export function resolveGatewayFee(input: {
  /** Ledger rows in scope. */
  total:       number | null
  /** Sum of `gatewayFeeEstimatePaise` across ALL rows in scope. */
  estimateAll: number | null
  /** Aggregate over covered rows only; null when that read failed or is unindexed. */
  covered:     CoveredGatewayRows | null
}): GatewayResolution {
  const { total, estimateAll, covered } = input
  const estimateOnly = estimateAll === null ? gone('query_failed') : money(estimateAll)

  // No covered-row read at all. Coverage is UNKNOWN, and unknown is never guessed at: the
  // estimate is reported as an estimate, which is the one thing that can be stood behind.
  if (!covered) {
    return { fee: estimateOnly, tax: gone('requires_index'), basis: 'estimated',
             coverage: { withActual: null, total } }
  }
  // The read succeeded and found nothing: no row here has ever been reconciled. A ₹0 "actual"
  // would be a fabricated fact, so the tax reports itself absent rather than zero.
  if (covered.count === 0) {
    return { fee: estimateOnly, tax: gone('no_authoritative_field'), basis: 'estimated',
             coverage: { withActual: 0, total } }
  }

  const fullyCovered = total !== null && covered.count >= total

  const fee: MaybeMoney = estimateAll === null
    ? (fullyCovered
        ? money(covered.sums.gatewayFeeActualPaise)   // fully covered: the estimate is not needed
        : gone('query_failed'))                       // partial, and the blend is unmeasurable
    : money(covered.sums.gatewayFeeActualPaise + (estimateAll - covered.sums.gatewayFeeEstimatePaise))

  return {
    fee,
    tax:      money(covered.sums.gatewayTaxPaise),
    basis:    fullyCovered ? 'actual' : 'mixed',
    coverage: { withActual: covered.count, total },
  }
}

// ═══ RD-FEE-04 · GATEWAY VARIANCE — a reconciliation METRIC, never money movement ════════════
//
// Variance = Σ estimate − Σ actual, over ONLY the rows Razorpay has reported a fee for.
//
//   estimate  the FROZEN gatewayFeeEstimatePaise written onto the ledger row at settlement — the
//             figure the organizer's net was computed with (2% all-in by business rule).
//   actual    gatewayFeeActualPaise from the verified payment.captured webhook (tax-INCLUSIVE).
//
// Positive ⇒ the estimate exceeded the actual gateway cost; negative ⇒ it fell short. It is NOT
// organizer profit, NOT RegisterDesk platform revenue, and it changes NO payable, net, wallet or
// payout — nothing here writes anything.
//
// A row without an actual fee is NEVER read as an actual of ₹0: it is excluded from the
// comparison and its estimate is reported separately as "awaiting Razorpay's fee", so an
// unreconciled payment cannot manufacture a variance.

export interface GatewayVariance {
  /** Ledger rows in scope. */
  transactions:        number | null
  /** Rows carrying a Razorpay actual fee — the ONLY population compared. */
  reconciled:          number | null
  /** Σ frozen estimate over the reconciled rows. */
  estimatedReconciled: MaybeMoney
  /** Σ Razorpay actual fee over the reconciled rows (tax-inclusive). */
  actual:              MaybeMoney
  /** GST contained WITHIN `actual` — a component, never added to it. */
  actualTax:           MaybeMoney
  /** estimatedReconciled − actual. */
  variance:            MaybeMoney
  /** Σ frozen estimate over rows still awaiting Razorpay's fee (excluded from the variance). */
  estimatedAwaiting:   MaybeMoney
  /** Σ frozen estimate over every row in scope. */
  estimatedAll:        MaybeMoney
  basis:               GatewayFeeBasis
}

/** Pure: the variance from the same two aggregates the gateway resolver uses. */
export function resolveGatewayVariance(input: {
  total:       number | null
  estimateAll: number | null
  covered:     CoveredGatewayRows | null
  /** Why an unavailable covered read is unavailable (index missing, or a bounded scan stopped). */
  coveredUnavailable?: Unavailable
}): GatewayVariance {
  const { total, estimateAll, covered } = input
  const estimatedAll = estimateAll === null ? gone('query_failed') : money(estimateAll)
  if (!covered) {
    const why = input.coveredUnavailable ?? 'requires_index'
    return { transactions: total, reconciled: null, estimatedReconciled: gone(why), actual: gone(why), actualTax: gone(why),
             variance: gone(why), estimatedAwaiting: gone(why), estimatedAll, basis: 'estimated' }
  }
  if (covered.count === 0) {
    return { transactions: total, reconciled: 0, estimatedReconciled: gone('no_authoritative_field'),
             actual: gone('no_authoritative_field'), actualTax: gone('no_authoritative_field'),
             variance: gone('no_authoritative_field'), estimatedAwaiting: estimatedAll, estimatedAll, basis: 'estimated' }
  }
  const est = covered.sums.gatewayFeeEstimatePaise
  const act = covered.sums.gatewayFeeActualPaise
  return {
    transactions:        total,
    reconciled:          covered.count,
    estimatedReconciled: money(est),
    actual:              money(act),
    actualTax:           money(covered.sums.gatewayTaxPaise),
    variance:            money(est - act),
    estimatedAwaiting:   estimateAll === null ? gone('query_failed') : money(estimateAll - est),
    estimatedAll,
    basis:               total !== null && covered.count >= total ? 'actual' : 'mixed',
  }
}
