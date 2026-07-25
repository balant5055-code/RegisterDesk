// RD-PAYMENT-02 Phase 3 — the ONE fee-calculation path for the Event Builder previews.
// Replaces the old page-local `calcFees`, which duplicated (and diverged from) the
// canonical engine — it taxed platform+gateway for GST, whereas the engine (and therefore
// actual checkout/settlement) taxes the platform fee ONLY. This adapter routes every
// preview through the canonical engine so what the organizer sees matches what is charged
// and settled.
//
// PURE + client-safe: `calculateFee`, `resolveEffectiveFeeModel`, and
// `builderFeeModelToEngine` are all dependency-free, so this runs in the wizard with no
// server imports. It is DISPLAY-ONLY — the authoritative per-order charge is still computed
// server-side; this uses the wizard's representative display rates (FeeRates).

import { calculateFee } from '@/lib/fees/engine'
import { resolveEffectiveFeeModel } from '@/lib/fees/feeModelResolution'
import type { FeeConfig } from '@/lib/fees/types'
import { builderFeeModelToEngine, type FeeModel, type FeeBreakdown, type FeeRates } from './types'

// Build an engine FeeConfig from the wizard's representative display rates. Fixed/min/max
// are 0 (the preview shows the representative percentage rate; the authoritative per-tier
// caps are applied server-side at charge time).
function engineConfigFromRates(rates: FeeRates): FeeConfig {
  return {
    platformFeePercentBps: Math.round(rates.platformPercent * 100),
    platformFeeFixedPaise: 0,
    platformFeeMinPaise:   0,
    platformFeeMaxPaise:   0,
    gatewayFeePercentBps:  Math.round(rates.gatewayPercent * 100),
    gatewayFeeFixedPaise:  0,
    gstRatePercent:        rates.gstPercent,
  }
}

/**
 * Compute the display fee breakdown for a ticket price under the builder's fee model,
 * via the canonical engine. `model` is the builder value ('organizer_absorbs' today, as
 * attendee_pays stays "Coming Soon"); it is mapped to the engine model and resolved
 * through the canonical resolver — never hardcoded — so previews will track Attendee Pays
 * automatically once it is activated. Today every event resolves to organizer_pays.
 */
export function computeFeePreview(ticketPrice: number, model: FeeModel, rates: FeeRates): FeeBreakdown {
  const feeModel = resolveEffectiveFeeModel({ eventFeeModel: builderFeeModelToEngine(model) })
  const r = calculateFee({
    transactionType:  'event_registration',
    grossAmountPaise: Math.round(ticketPrice * 100),
    feeModel,
    config:           engineConfigFromRates(rates),
  })
  return {
    ticketPrice,
    platformFee:   r.platformFeeBasePaise      / 100,
    gatewayFee:    r.gatewayFeeEstimatePaise    / 100,
    gstOnFees:     r.platformFeeGstPaise        / 100,   // platform-fee GST only (matches the engine)
    totalFees:     (r.platformFeeTotalPaise + r.gatewayFeeEstimatePaise) / 100,
    attendeePays:  r.chargeAmountPaise          / 100,
    organizerGets: r.netSettlementPaise         / 100,
  }
}
