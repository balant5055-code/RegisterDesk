// RD-PRICING-02C — snapshot-first financial resolution for the Payments pipeline. PURE-ish.
//
// resolveLedgerFinancials PREFERS the stored Order Pricing Snapshot and FALLS BACK to
// the production fee engine (lib/fees). Because the snapshot is used ONLY when it is
// internally valid AND its shadow comparison matched production, the chosen values are
// provably identical to lib/fees under the current (default) commercial model — so
// ledger, settlement, and wallet numbers are byte-for-byte unchanged this sprint.
//
// The production fee engine remains the automatic fallback for: missing snapshot,
// deserialize/checksum failure, invalid snapshot, or a shadow mismatch. Payments are
// NEVER rejected (Phase 5).

import { deserializeOrderPricingSnapshot } from './orderSnapshot'
import { recordPricingMetric } from './pricingMetrics'
import type { FeeCalculationResult } from '@/lib/fees/types'
import type { OrderPricingEvidence } from './orderIntegration'

export type FinancialSource = 'snapshot' | 'fallback'

/** The ledger + credit financial fields, sourced from either the snapshot or lib/fees. */
export interface LedgerFinancials {
  source:                  FinancialSource
  platformFeeBasePaise:    number
  platformFeeGstPaise:     number
  platformFeeTotalPaise:   number
  gatewayFeeEstimatePaise: number
  netSettlementPaise:      number
}

function fromFeeResult(r: FeeCalculationResult): LedgerFinancials {
  return {
    source:                  'fallback',
    platformFeeBasePaise:    r.platformFeeBasePaise,
    platformFeeGstPaise:     r.platformFeeGstPaise,
    platformFeeTotalPaise:   r.platformFeeTotalPaise,
    gatewayFeeEstimatePaise: r.gatewayFeeEstimatePaise,
    netSettlementPaise:      r.netSettlementPaise,
  }
}

function fromSnapshot(fields: {
  platformFee: { paise: number }; platformGst: { paise: number }; platformFeeTotal: { paise: number }
  gatewayFee: { paise: number };  organizerReceives: { paise: number }
}): LedgerFinancials {
  return {
    source:                  'snapshot',
    platformFeeBasePaise:    fields.platformFee.paise,
    platformFeeGstPaise:     fields.platformGst.paise,
    platformFeeTotalPaise:   fields.platformFeeTotal.paise,
    gatewayFeeEstimatePaise: fields.gatewayFee.paise,
    netSettlementPaise:      fields.organizerReceives.paise,
  }
}

/**
 * Resolve the authoritative financial fields for a NEW order. Prefers the snapshot in
 * `evidence` (deserialize → checksum → validate → shadow-match) and falls back to the
 * production fee engine result. Records diagnostics. Never throws.
 */
export function resolveLedgerFinancials(
  feeResult: FeeCalculationResult,
  evidence:  OrderPricingEvidence,
): LedgerFinancials {
  const json = evidence.pricingSnapshot
  if (!json) { recordPricingMetric('fallbackUsed'); return fromFeeResult(feeResult) }

  const de = deserializeOrderPricingSnapshot(json)
  if (!de.ok) {
    if (de.errors.some(e => e.toLowerCase().includes('checksum'))) recordPricingMetric('checksumFailures')
    recordPricingMetric('fallbackUsed')
    return fromFeeResult(feeResult)
  }

  const matched = evidence.pricingSnapshotMeta?.shadowMatch === true
  recordPricingMetric(matched ? 'shadowMatches' : 'shadowMismatches')
  if (!matched) { recordPricingMetric('fallbackUsed'); return fromFeeResult(feeResult) }

  recordPricingMetric('snapshotUsed')
  return fromSnapshot(de.snapshot)
}

/**
 * Read a HISTORICAL order's financials from its STORED snapshot ONLY (Phase 4). Never
 * calls resolveEffectivePricingSummary(); returns null when the snapshot is absent or
 * invalid so the caller can use the order's stored ledger fields / lib/fees.
 */
export function readStoredSnapshotFinancials(pricingSnapshotJson: string | null | undefined): LedgerFinancials | null {
  if (!pricingSnapshotJson) return null
  const de = deserializeOrderPricingSnapshot(pricingSnapshotJson)
  if (!de.ok) {
    if (de.errors.some(e => e.toLowerCase().includes('checksum'))) recordPricingMetric('checksumFailures')
    return null
  }
  return fromSnapshot(de.snapshot)
}
