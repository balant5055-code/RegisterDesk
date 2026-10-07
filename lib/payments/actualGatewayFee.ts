// RD-FIN-01 · Persist the gateway fee Razorpay actually charged.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// `gatewayFeeActualPaise` was declared in `lib/fees/types.ts`, read in four places, and
// written in NONE — 0 of 775 production rows carried a value. Every gateway figure on the
// platform was therefore the 2% estimate from `lib/fees/engine.ts`, correctly labelled
// "est." but never able to become anything else.
//
// The 2026-08 reconciliation measured the cost of that: the estimate came to ₹8,350.30
// against ₹8,162.65 actually charged on the same 775 payments — 2.3% high, because a flat
// 2% models neither method mix nor Razorpay's real per-method pricing.
//
// ═══ WHERE THE NUMBER COMES FROM ═════════════════════════════════════════════
// The `payment.captured` webhook payload carries `fee` and `tax` on the payment entity.
// That is authoritative gateway data arriving over a signature-verified channel — not a
// percentage, not a client value, and not a second Razorpay API call. Nothing here
// computes a fee; if the payload does not carry one, nothing is written and the estimate
// stands.
//
// ⚠ Razorpay's `fee` is TAX-INCLUSIVE. Verified against the export: `amount − fee =
// credit` holds exactly, and `tax` is a COMPONENT of `fee`, not an addition to it. So
// `gatewayFeeActualPaise` is the full charge and `gatewayTaxPaise` is the GST inside it.
// Adding them together double-counts the tax.

import { adminDb } from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import type { PlatformTransactionDocument } from '@/lib/fees/types'

/** The subset of a Razorpay payment entity this cares about. */
export interface GatewayFeePayload {
  fee?:   unknown
  tax?:   unknown
  id?:    unknown
}

export interface ActualGatewayFee {
  gatewayFeeActualPaise: number
  gatewayTaxPaise:       number
}

/**
 * Read fee/tax out of a payment entity — PURE, so the parsing rules are testable.
 *
 * Returns null unless the fee is a usable non-negative integer. Razorpay sends `null` for
 * both on an authorized-but-not-yet-captured payment, and a partially-written actual is
 * worse than a clearly-labelled estimate: it would flip `gatewayFeeBasis` to 'actual'
 * while carrying a zero.
 */
export function extractActualGatewayFee(payment: GatewayFeePayload | undefined | null): ActualGatewayFee | null {
  if (!payment) return null
  const fee = payment.fee
  const tax = payment.tax
  if (typeof fee !== 'number' || !Number.isInteger(fee) || fee < 0) return null
  const taxPaise = typeof tax === 'number' && Number.isInteger(tax) && tax >= 0 ? tax : 0
  // Tax is a component of the fee. A tax larger than the fee means the payload is not
  // what this code believes it is, so refuse rather than persist a contradiction.
  if (taxPaise > fee) return null
  return { gatewayFeeActualPaise: fee, gatewayTaxPaise: taxPaise }
}

/**
 * Write the actual fee onto an existing ledger row.
 *
 * Idempotent and write-once: a row that already carries an actual fee is left alone, so
 * repeated `payment.captured` deliveries cannot rewrite settled economics. Missing rows
 * are a no-op — the ledger entry may simply not exist yet, and this must never create one.
 *
 * Never throws. A failure here degrades the figure to the estimate, which is exactly what
 * the reader already handles; it must not fail a webhook and trigger a retry storm.
 */
export async function recordActualGatewayFee(
  transactionId: string,
  fee:           ActualGatewayFee,
  context:       { paymentId?: string; settlementId?: string } = {},
): Promise<{ written: boolean; reason?: string }> {
  try {
    const ref = adminDb.collection('platformTransactions').doc(transactionId)
    return await adminDb.runTransaction(async tx => {
      const snap = await tx.get(ref)
      if (!snap.exists) return { written: false, reason: 'no_ledger_row' }

      const data = snap.data() as PlatformTransactionDocument
      if (typeof data.gatewayFeeActualPaise === 'number') {
        return { written: false, reason: 'already_actual' }
      }

      tx.update(ref, {
        gatewayFeeActualPaise: fee.gatewayFeeActualPaise,
        gatewayTaxPaise:       fee.gatewayTaxPaise,
        ...(context.settlementId ? { settlementId: context.settlementId } : {}),
        updatedAt: new Date(),
      })
      return { written: true }
    })
  } catch (err) {
    captureFinancialError(err, {
      scope: 'razorpay.actual_gateway_fee_failed',
      transactionId,
      paymentId: context.paymentId,
    })
    return { written: false, reason: 'error' }
  }
}
