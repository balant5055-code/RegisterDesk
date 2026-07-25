// RD-PRICING-02B — order pricing snapshot integration. SERVER-ONLY.
//
// buildOrderPricingEvidence resolves an immutable pricing snapshot + shadow-comparison
// for one order, to be attached ADDITIVELY to the platform-transaction ledger. It is
// INFORMATIONAL ONLY — lib/fees remains the financial source of truth (Phase 4).
//
// GUARANTEE: this NEVER throws and NEVER fails the order. Any error (config read,
// resolve, invalid snapshot) yields an empty result → the order is written without the
// snapshot, exactly as before this sprint (Phase 3/5/7).
//
// No PII is recorded (Phase 6): only versions, the commercial model, and the shadow
// result. The caller passes the EXACT production FeeConfig the live fee engine used, so
// the snapshot mirrors production and the shadow comparison is apples-to-apples.

import { resolveEffectivePricingSummary } from './pricingSummary'
import {
  createOrderPricingSnapshot,
  validateOrderPricingSnapshot,
  serializeOrderPricingSnapshot,
} from './orderSnapshot'
import { compareFeeComputation } from './shadowCompare'
import { feeTierToLicenseTier } from './feeStructure'
import type { FeeConfig, PlatformPlanTier, PlatformTransactionType } from '@/lib/fees/types'

export interface OrderPricingEvidenceInput {
  grossAmountPaise: number
  planTier:         PlatformPlanTier
  feeConfig:        FeeConfig            // the EXACT config the production fee engine used
  transactionType:  PlatformTransactionType
  resolvedAt?:      string
}

/** Diagnostic meta (no PII) stored alongside the serialized snapshot. */
export interface OrderPricingSnapshotMeta {
  pricingVersion:        number
  configurationVersion:  number
  snapshotVersion:       number
  platformFeePaidBy:     string
  gatewayFeePaidBy:      string
  platformGstEnabled:    boolean
  gatewayGstEnabled:     boolean
  convenienceFeeEnabled: boolean
  shadowMatch:           boolean
  shadowDifferenceCount: number
}

export interface OrderPricingEvidence {
  pricingSnapshot?:     string   // serialized immutable OrderPricingSnapshot
  pricingSnapshotMeta?: OrderPricingSnapshotMeta
}

/**
 * Resolve the pricing snapshot + shadow comparison for an order. Returns {} on ANY
 * failure or if the snapshot is internally invalid — never throws, never blocks.
 */
export async function buildOrderPricingEvidence(
  input: OrderPricingEvidenceInput,
): Promise<OrderPricingEvidence> {
  try {
    const tier = feeTierToLicenseTier(input.planTier)

    const summary = await resolveEffectivePricingSummary(
      { license: { tier } },
      input.grossAmountPaise,
      { feeConfig: input.feeConfig, resolvedAt: input.resolvedAt },
    )

    const snapshot = createOrderPricingSnapshot(summary)

    // Phase 5: reject ONLY if the snapshot is internally invalid (checksum / totals) —
    // never because production and the new engine differ.
    const check = validateOrderPricingSnapshot(snapshot)
    if (!check.ok) return {}

    // Phase 3: shadow-verify against production over the SAME config (never fails the order).
    const comparison = compareFeeComputation(
      input.grossAmountPaise,
      input.feeConfig,
      summary.commercial,
      input.transactionType,
    )

    return {
      pricingSnapshot: serializeOrderPricingSnapshot(snapshot),
      pricingSnapshotMeta: {
        pricingVersion:        summary.pricingVersion,
        configurationVersion:  summary.configurationVersion,
        snapshotVersion:       snapshot.snapshotVersion,
        platformFeePaidBy:     summary.commercial.platformFeePaidBy,
        gatewayFeePaidBy:      summary.commercial.gatewayFeePaidBy,
        platformGstEnabled:    summary.commercial.platformGstEnabled,
        gatewayGstEnabled:     summary.commercial.gatewayGstEnabled,
        convenienceFeeEnabled: summary.commercial.convenienceFeeEnabled,
        shadowMatch:           comparison.match,
        shadowDifferenceCount: comparison.differences.length,
      },
    }
  } catch {
    return {}
  }
}
