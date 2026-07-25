// RD-PAYMENT-02 Phase 4 — the ONE canonical checkout charge computation. PURE (no I/O),
// so it is fully unit-testable. Order creation calls this to decide the Razorpay order
// amount and the persisted fee breakdown.
//
// FEATURE-GATED by pricingEngineEnabled — the ONLY activation switch:
//   • OFF (production today): charge EXACTLY the ticket amount (finalAmountPaise), with no
//     engine involvement and no breakdown — byte-identical to how checkout has always
//     behaved. No second flag, no per-model branching in the caller.
//   • ON: the canonical engine is authoritative. organizer_pays →
//     chargeAmountPaise === finalAmountPaise (ticket, unchanged); customer_pays →
//     chargeAmountPaise === ticket + platform + gateway fees. Uses the SAME primitives as
//     the ledger and the Event Builder preview: resolveEffectiveFeeModel + calculateFee +
//     toFeeBreakdownRecord — no duplicate fee math.

import { calculateFee } from './engine'
import { toFeeBreakdownRecord } from './feeBreakdown'
import { resolveEffectiveFeeModel } from './feeModelResolution'
import type { FeeBreakdownRecord, FeeConfig, FeeModel } from './types'

export interface CheckoutChargeInput {
  pricingEngineEnabled: boolean
  finalAmountPaise:     number            // the ticket amount after early-bird + coupon (gross)
  eventFeeModel:        FeeModel | null    // event's ENGINE fee model candidate (mapped builder→engine)
  feeConfig?:           FeeConfig          // required when the engine is on; unused when off
  context?:             { organizerUid?: string; eventId?: string }
}

export interface CheckoutCharge {
  amountPaise: number                // the Razorpay order amount (== finalAmountPaise under organizer_pays)
  feeModel:    FeeModel
  financials?: FeeBreakdownRecord     // populated only when the engine ran (flag on)
}

/**
 * Resolve the amount to charge at checkout. When the pricing engine is dormant (or no fee
 * config is supplied) this returns the ticket amount unchanged with no breakdown — exactly
 * today's behaviour. When enabled, it resolves the effective fee model canonically and
 * returns the engine's chargeAmountPaise plus the persisted breakdown.
 */
export function resolveCheckoutCharge(input: CheckoutChargeInput): CheckoutCharge {
  if (!input.pricingEngineEnabled || !input.feeConfig) {
    // Dormant: charge exactly as today — the ticket, no engine, no breakdown.
    return { amountPaise: input.finalAmountPaise, feeModel: 'organizer_pays' }
  }
  const feeModel = resolveEffectiveFeeModel({ ...input.context, eventFeeModel: input.eventFeeModel })
  const feeResult = calculateFee({
    transactionType:  'event_registration',
    grossAmountPaise: input.finalAmountPaise,
    feeModel,
    config:           input.feeConfig,
  })
  return {
    amountPaise: feeResult.chargeAmountPaise,
    feeModel,
    financials:  toFeeBreakdownRecord(feeModel, feeResult),
  }
}
