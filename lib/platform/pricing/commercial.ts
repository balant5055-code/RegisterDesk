// RD-PRICING-02A — configurable commercial model + reconciled fee algorithm. PURE.
//
// `computeReconciledFees` is a generalization of the production fee engine
// (lib/fees/engine.ts · calculateFee). It mirrors that math exactly and adds the two
// axes production hardcodes: an independent platform/gateway fee payer, an optional
// gateway GST, and an optional convenience fee. Under DEFAULT_COMMERCIAL_MODEL it is
// FIELD-FOR-FIELD identical to `calculateFee(feeModel: 'organizer_pays')` — proven by
// shadowCompare.ts. No I/O, no side effects; safe on client or server.

import type { FeeConfig } from '@/lib/fees/types'
import type { CommercialModel, ReconciledFeeResult, PlatformSettings } from './types'

/**
 * The default commercial model — MIRRORS PRODUCTION. Organizer bears both fees, GST
 * applies to the platform fee only, no gateway GST, no convenience fee. Equivalent to
 * production's universally-used `organizer_pays`.
 */
export const DEFAULT_COMMERCIAL_MODEL: CommercialModel = {
  platformFeePaidBy:     'organizer',
  gatewayFeePaidBy:      'organizer',
  convenienceFeeEnabled: false,
  gatewayGstEnabled:     false,
  platformGstEnabled:    true,
}

/**
 * CERT-D1 gate (RD-PAYMENT-02 Phase 0.6). The commercial model is part of the pricing
 * engine, which is dormant until `features.pricingEngineEnabled` is true. While dormant,
 * the EFFECTIVE model is forced to `DEFAULT_COMMERCIAL_MODEL` (production organizer_pays)
 * regardless of any stored `commercial` value — so the order-pricing snapshot (the only
 * production consumer of the commercial model, via resolveEffectivePricingSummary →
 * buildOrderPricingEvidence → resolveLedgerFinancials) can never diverge from what
 * checkout actually charges. When the flag is on, the stored model flows through unchanged.
 * The stored value is untouched: admin read/write round-trips still see the raw config.
 */
export function effectiveCommercialModel(settings: PlatformSettings): CommercialModel {
  return settings.features.pricingEngineEnabled ? settings.commercial : DEFAULT_COMMERCIAL_MODEL
}

function zeroResult(grossAmountPaise: number): ReconciledFeeResult {
  return {
    grossAmountPaise,
    platformFeeBasePaise:  0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0,
    gatewayFeeBasePaise:   0, gatewayFeeGstPaise:  0, gatewayFeeTotalPaise:  0,
    convenienceFeePaise:   0,
    chargeAmountPaise:     grossAmountPaise,
    netSettlementPaise:    grossAmountPaise,
    platformRevenuePaise:  0,
    attendeeBearsPaise:    0,
    organizerBearsPaise:   0,
  }
}

/**
 * Reconciled fee computation. `config` is a production `FeeConfig` (bps + fixed +
 * min/max + gst); `commercial` selects who bears what. `convenienceFeePaise` applies
 * only when `commercial.convenienceFeeEnabled`.
 *
 * The platform-fee base math (percent + fixed, then min/max clamp) and the gateway-fee
 * estimate are copied verbatim from `calculateFee` so results cannot drift.
 */
export function computeReconciledFees(
  grossAmountPaise: number,
  config: FeeConfig,
  commercial: CommercialModel,
  convenienceFeePaise = 0,
): ReconciledFeeResult {
  if (grossAmountPaise <= 0) return zeroResult(Math.max(0, grossAmountPaise))

  // Platform fee — percent + fixed, then clamp (identical to calculateFee).
  const rawFee = Math.round(grossAmountPaise * config.platformFeePercentBps / 10_000)
    + config.platformFeeFixedPaise
  const platformFeeBase = config.platformFeeMaxPaise > 0
    ? Math.min(config.platformFeeMaxPaise, Math.max(config.platformFeeMinPaise, rawFee))
    : Math.max(config.platformFeeMinPaise, rawFee)
  const platformFeeGst = commercial.platformGstEnabled
    ? Math.round(platformFeeBase * config.gstRatePercent / 100)
    : 0
  const platformFeeTotal = platformFeeBase + platformFeeGst

  // Gateway fee estimate (identical to calculateFee) + optional GST.
  const gatewayFeeBase = Math.round(grossAmountPaise * config.gatewayFeePercentBps / 10_000)
    + config.gatewayFeeFixedPaise
  const gatewayFeeGst = commercial.gatewayGstEnabled
    ? Math.round(gatewayFeeBase * config.gstRatePercent / 100)
    : 0
  const gatewayFeeTotal = gatewayFeeBase + gatewayFeeGst

  const convenience = commercial.convenienceFeeEnabled ? Math.max(0, Math.round(convenienceFeePaise)) : 0

  // Attribution: each fee falls on the attendee (added to the charge) or the organizer
  // (deducted from settlement). Convenience is attendee-facing when enabled.
  let attendeeBears = convenience
  let organizerBears = 0
  if (commercial.platformFeePaidBy === 'attendee') attendeeBears  += platformFeeTotal
  else                                             organizerBears += platformFeeTotal
  if (commercial.gatewayFeePaidBy === 'attendee')  attendeeBears  += gatewayFeeTotal
  else                                             organizerBears += gatewayFeeTotal

  const chargeAmount    = grossAmountPaise + attendeeBears
  const netSettlement   = Math.max(0, grossAmountPaise - organizerBears)
  const platformRevenue = platformFeeBase + convenience   // GST remitted; gateway is Razorpay's

  return {
    grossAmountPaise,
    platformFeeBasePaise:  platformFeeBase,
    platformFeeGstPaise:   platformFeeGst,
    platformFeeTotalPaise: platformFeeTotal,
    gatewayFeeBasePaise:   gatewayFeeBase,
    gatewayFeeGstPaise:    gatewayFeeGst,
    gatewayFeeTotalPaise:  gatewayFeeTotal,
    convenienceFeePaise:   convenience,
    chargeAmountPaise:     chargeAmount,
    netSettlementPaise:    netSettlement,
    platformRevenuePaise:  platformRevenue,
    attendeeBearsPaise:    attendeeBears,
    organizerBearsPaise:   organizerBears,
  }
}

/**
 * Map a commercial model to the closest production FeeModel, for shadow comparison.
 * The default (organizer bears both) is `organizer_pays`; attendee-bears-both with no
 * extra toggles is `customer_pays`. Other combinations have no single production
 * equivalent (returns null) — they are new capabilities, not reconciled behavior.
 */
export function commercialToFeeModel(c: CommercialModel): 'organizer_pays' | 'customer_pays' | null {
  const noExtras = !c.convenienceFeeEnabled && !c.gatewayGstEnabled && c.platformGstEnabled
  if (c.platformFeePaidBy === 'organizer' && c.gatewayFeePaidBy === 'organizer' && noExtras) return 'organizer_pays'
  if (c.platformFeePaidBy === 'attendee'  && c.gatewayFeePaidBy === 'attendee'  && noExtras) return 'customer_pays'
  return null
}
