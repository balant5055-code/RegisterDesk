// RD-PRICING-01E-PREP / RD-PRICING-02A — unified pricing summary. SERVER-ONLY, pure(ish).
//
// resolveEffectivePricingSummary(event, ticketPricePaise) → the ONE immutable pricing
// contract Payments / Wallet / Finance / Reports will consume (RD-PRICING-02A+). It
// only READS config (no writes, no order, no gateway) and returns a deep-frozen object.
//
// RD-PRICING-02A: the fee math now runs through the RECONCILED commercial model
// (commercial.ts · computeReconciledFees) over the production FeeConfig (feeStructure.ts).
// Under the DEFAULT commercial model this reproduces production's fee engine exactly —
// see shadowCompare.ts. Nothing consumes this yet.

import { resolvePlatformPricing } from './resolver'
import { resolveEffectivePlatformConfiguration } from './api'
import { resolveEngineFeeConfig } from './feeStructure'
import { computeReconciledFees, effectiveCommercialModel } from './commercial'
import { computeTicketTax } from './tax'
import { paiseToRupees } from './units'
import type { FeeConfig } from '@/lib/fees/types'
import type { TaxConfig } from './tax'
import type { PricingSummary, Money, TracedMoney, TracedValue } from './types'
import type { PricingEventView } from './types'

/** The summary MODEL version. Bump when the computation below changes. */
export const PRICING_SUMMARY_VERSION = 2

// ─── Money helpers (all ₹↔paise via units.ts — never a manual ×/÷ 100) ────────────

const money = (paise: number): Money => ({ paise, rupees: paiseToRupees(paise) })

const tracedMoney = (t: TracedValue<number>): TracedMoney =>
  ({ paise: t.value, rupees: paiseToRupees(t.value), source: t.source })

function deepFreeze<T>(o: T): T {
  Object.freeze(o)
  for (const key of Object.keys(o as object)) {
    const v = (o as Record<string, unknown>)[key]
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v)
  }
  return o
}

export interface PricingSummaryOptions {
  /** ISO 8601 timestamp to stamp as `resolvedAt`. Defaults to now. Injectable for determinism. */
  resolvedAt?: string
  /**
   * Override the resolved fee structure. Integration callers (RD-PRICING-02B) pass the
   * EXACT production FeeConfig the live fee engine used, so the snapshot's fees mirror
   * production and the shadow comparison is apples-to-apples. Omit to resolve normally.
   */
  feeConfig?: FeeConfig
  /**
   * RD-PRODUCT-01E — the resolved ticket-tax settings (org → event → pass hierarchy,
   * see taxProfile.ts). When provided, the organizer's GST on the ticket sale is computed
   * ONCE here and attached as `summary.tax`. Omit for no ticket tax (the field is left off).
   */
  taxConfig?: TaxConfig
}

/**
 * Resolve the immutable pricing summary for pricing `ticketPricePaise` under `event`'s
 * effective configuration + the platform commercial model + the production fee
 * structure. Flag-gated transparently via the config resolve.
 */
export async function resolveEffectivePricingSummary(
  event: PricingEventView,
  ticketPricePaise: number,
  opts: PricingSummaryOptions = {},
): Promise<PricingSummary> {
  const settings = await resolvePlatformPricing()
  const config   = await resolveEffectivePlatformConfiguration(event)
  const feeConfig = opts.feeConfig ?? await resolveEngineFeeConfig(config.license.tier, 'event_registration')

  // CERT-D1 gate: while the pricing engine is dormant (pricingEngineEnabled=false) the
  // commercial model is forced to production organizer_pays, so this snapshot — the only
  // production consumer of the commercial model — can never diverge from what checkout
  // charges. Used for BOTH the fee math and the stamped `summary.commercial` so the
  // snapshot, its shadow comparison, and settlement stay internally consistent.
  const commercial = effectiveCommercialModel(settings)

  const fees = computeReconciledFees(
    ticketPricePaise,
    feeConfig,
    commercial,
    config.convenienceFeePaise.value,
  )

  const summary: PricingSummary = {
    pricingVersion:       PRICING_SUMMARY_VERSION,
    configurationVersion: settings.metadata.version,
    resolvedAt:           opts.resolvedAt ?? new Date().toISOString(),
    currency:             'INR',

    commercial,
    feeStructure: feeConfig,

    license: {
      tier:              config.license.tier,
      registrationLimit: config.license.maxRegistrations,
      licensePrice:      tracedMoney(config.license.licensePricePaise),
    },
    registrationLimit: config.registrationLimit,

    ticketPrice:      money(fees.grossAmountPaise),
    platformFee:      money(fees.platformFeeBasePaise),
    platformGst:      money(fees.platformFeeGstPaise),
    platformFeeTotal: money(fees.platformFeeTotalPaise),
    gatewayProvider:  settings.gateway.provider,
    gatewayFee:       money(fees.gatewayFeeBasePaise),
    gatewayGst:       money(fees.gatewayFeeGstPaise),
    gatewayCost:      money(fees.gatewayFeeTotalPaise),
    convenienceFee:   money(fees.convenienceFeePaise),

    attendeePays:      money(fees.chargeAmountPaise),
    organizerReceives: money(fees.netSettlementPaise),
    platformRevenue:   money(fees.platformRevenuePaise),

    // RD-PRODUCT-01E — ticket-level GST, computed once on the ticket price when configured.
    ...(opts.taxConfig ? { tax: computeTicketTax(fees.grossAmountPaise, opts.taxConfig) } : {}),

    trace: {
      registrationLimit: config.registrationLimit,
      convenienceFee:    config.convenienceFeePaise,
    },
  }

  return deepFreeze(summary)
}
