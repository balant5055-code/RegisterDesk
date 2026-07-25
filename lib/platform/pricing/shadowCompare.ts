// RD-PRICING-02A — shadow comparison. PURE, no I/O, no logging, no consumer.
//
// Runs the OLD production fee engine (lib/fees/engine.ts · calculateFee) and the NEW
// reconciled engine (commercial.ts · computeReconciledFees) over the SAME gross amount
// and FeeConfig, and compares them field-for-field. Under the DEFAULT commercial model
// (→ organizer_pays) every field must match. This is the equivalence proof that gates
// payment integration; it is a utility only — no consumer wires it.

import { calculateFee } from '@/lib/fees/engine'
import type { FeeConfig, PlatformTransactionType } from '@/lib/fees/types'
import { computeReconciledFees, commercialToFeeModel, DEFAULT_COMMERCIAL_MODEL } from './commercial'
import type { CommercialModel } from './types'

export interface FeeFieldDifference {
  field:      string
  production: number
  engine:     number
}

export interface FeeComparison {
  match:       boolean
  differences: FeeFieldDifference[]
  /** null when the commercial model has no single production FeeModel equivalent. */
  comparedAs:  'organizer_pays' | 'customer_pays' | null
}

/**
 * Compare production `calculateFee` against the reconciled `computeReconciledFees` for
 * one (gross, config, commercial) triple. Returns match + any field differences.
 *
 * Fields compared (Phase 6): platform fee base / GST / total, gateway fee, the Razorpay
 * ORDER amount (chargeAmount), and the organizer SETTLEMENT (netSettlement) — i.e.
 * attendee pays + organizer receives. Only meaningful when the commercial model maps to
 * a production FeeModel; otherwise `comparedAs` is null and `match` is false.
 */
export function compareFeeComputation(
  grossAmountPaise: number,
  config: FeeConfig,
  commercial: CommercialModel = DEFAULT_COMMERCIAL_MODEL,
  transactionType: PlatformTransactionType = 'event_registration',
): FeeComparison {
  const feeModel = commercialToFeeModel(commercial)
  if (feeModel === null) {
    return { match: false, differences: [], comparedAs: null }
  }

  const prod = calculateFee({ transactionType, grossAmountPaise, feeModel, config })
  const eng  = computeReconciledFees(grossAmountPaise, config, commercial)

  const differences: FeeFieldDifference[] = []
  const cmp = (field: string, production: number, engine: number): void => {
    if (production !== engine) differences.push({ field, production, engine })
  }

  cmp('platformFeeBase',  prod.platformFeeBasePaise,    eng.platformFeeBasePaise)
  cmp('platformFeeGst',   prod.platformFeeGstPaise,     eng.platformFeeGstPaise)
  cmp('platformFeeTotal', prod.platformFeeTotalPaise,   eng.platformFeeTotalPaise)
  cmp('gatewayFee',       prod.gatewayFeeEstimatePaise, eng.gatewayFeeBasePaise)
  cmp('attendeePays',     prod.chargeAmountPaise,       eng.chargeAmountPaise)     // Razorpay order amount
  cmp('organizerReceives',prod.netSettlementPaise,      eng.netSettlementPaise)    // settlement

  return { match: differences.length === 0, differences, comparedAs: feeModel }
}
