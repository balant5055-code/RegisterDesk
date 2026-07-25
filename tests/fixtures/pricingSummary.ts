// RD-GA-HARDEN-01 — PricingSummary fixture.
//
// resolveEffectivePricingSummary() reads Firebase, so tests build an equivalent summary
// PURELY (same construction the production resolver uses: computeReconciledFees over a
// real FeeConfig + the money helper). This yields a valid PricingSummary for snapshot,
// checksum, and validation tests without any I/O.

import { computeReconciledFees, DEFAULT_COMMERCIAL_MODEL } from '@/lib/platform/pricing/commercial'
import { paiseToRupees } from '@/lib/platform/pricing/units'
import { feeConfigFor } from './feeConfig'
import type { Money, PricingSummary } from '@/lib/platform/pricing/types'

const money = (paise: number): Money => ({ paise, rupees: paiseToRupees(paise) })

export function buildPricingSummary(opts?: {
  ticketPricePaise?: number
  resolvedAt?: string
  registrationLimit?: number
}): PricingSummary {
  const ticket    = opts?.ticketPricePaise ?? 100000
  const limit     = opts?.registrationLimit ?? 100
  const feeConfig = feeConfigFor('starter', 'event_registration')
  const fees      = computeReconciledFees(ticket, feeConfig, DEFAULT_COMMERCIAL_MODEL, 0)

  return {
    pricingVersion:       2,
    configurationVersion: 1,
    resolvedAt:           opts?.resolvedAt ?? '2026-07-21T00:00:00.000Z',
    currency:             'INR',
    commercial:           DEFAULT_COMMERCIAL_MODEL,
    feeStructure:         feeConfig,
    license: {
      tier:              'starter',
      registrationLimit: { value: limit, source: 'default' },
      licensePrice:      { paise: 0, rupees: 0, source: 'default' },
    },
    registrationLimit: { value: limit, source: 'default' },
    ticketPrice:      money(fees.grossAmountPaise),
    platformFee:      money(fees.platformFeeBasePaise),
    platformGst:      money(fees.platformFeeGstPaise),
    platformFeeTotal: money(fees.platformFeeTotalPaise),
    gatewayProvider:  'razorpay',
    gatewayFee:       money(fees.gatewayFeeBasePaise),
    gatewayGst:       money(fees.gatewayFeeGstPaise),
    gatewayCost:      money(fees.gatewayFeeTotalPaise),
    convenienceFee:   money(fees.convenienceFeePaise),
    attendeePays:      money(fees.chargeAmountPaise),
    organizerReceives: money(fees.netSettlementPaise),
    platformRevenue:   money(fees.platformRevenuePaise),
    trace: {
      registrationLimit: { value: limit, source: 'default' },
      convenienceFee:    { value: 0, source: 'default' },
    },
  }
}

/** An unlimited-tier summary (registrationLimit = Infinity) to exercise the null↔Infinity path. */
export function buildUnlimitedSummary(): PricingSummary {
  const s = buildPricingSummary({ registrationLimit: 100 })
  return {
    ...s,
    license: { ...s.license, registrationLimit: { value: Infinity, source: 'default' } },
    registrationLimit: { value: Infinity, source: 'default' },
    trace: { ...s.trace, registrationLimit: { value: Infinity, source: 'default' } },
  }
}
