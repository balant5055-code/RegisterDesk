// RD-PRICING-02D — snapshot-first wallet settlement resolution. PURE (no side effects).
//
// The wallet credits (at order time) and debits (at refund reversal) must prefer the
// stored Order Pricing Snapshot's organizerReceives, falling back to the existing
// stored ledger value. To keep settlement mathematically identical to production, the
// snapshot value is used ONLY when it EQUALS the stored ledger `netSettlementPaise`
// (i.e. the amount that was actually credited) — so a reversal always debits EXACTLY
// what was credited, and no wallet balance can drift.
//
// resolveWalletSettlementPure is PURE (metric-free) so it is safe to call inside a
// retrying Firestore transaction; the caller records the returned `source` to metrics
// exactly once, post-commit. It NEVER re-resolves pricing (Phase 3): it only
// deserializes the STORED snapshot.

import { deserializeOrderPricingSnapshot } from './orderSnapshot'
import { recordPricingMetric } from './pricingMetrics'

export type WalletSettlementSource = 'snapshot' | 'fallback' | 'mismatch' | 'checksum_failure'

export interface WalletSettlementResolution {
  netSettlementPaise: number
  source:             WalletSettlementSource
}

/** The minimal ledger shape the wallet resolver reads. */
export interface WalletSettlementDoc {
  netSettlementPaise: number
  pricingSnapshot?:   string
}

/**
 * Resolve the wallet settlement amount, snapshot-first. Guarantees the returned value
 * EQUALS `doc.netSettlementPaise` (the credited amount): the snapshot's value is used
 * only when it is byte-equal. PURE — no metrics, no I/O beyond the in-memory deserialize.
 */
export function resolveWalletSettlementPure(doc: WalletSettlementDoc): WalletSettlementResolution {
  const stored = doc.netSettlementPaise
  if (!doc.pricingSnapshot) return { netSettlementPaise: stored, source: 'fallback' }

  const de = deserializeOrderPricingSnapshot(doc.pricingSnapshot)
  if (!de.ok) {
    const source: WalletSettlementSource = de.errors.some(e => /checksum/i.test(e)) ? 'checksum_failure' : 'fallback'
    return { netSettlementPaise: stored, source }
  }

  const snapshotNet = de.snapshot.organizerReceives.paise
  if (snapshotNet === stored) return { netSettlementPaise: snapshotNet, source: 'snapshot' }
  return { netSettlementPaise: stored, source: 'mismatch' }
}

/** Record wallet metrics for a settlement resolution (call ONCE, post-commit). */
export function recordWalletSettlementMetric(source: WalletSettlementSource): void {
  switch (source) {
    case 'snapshot':
      recordPricingMetric('walletSnapshotUsed')
      recordPricingMetric('walletShadowMatches')
      break
    case 'mismatch':
      recordPricingMetric('walletShadowMismatches')
      recordPricingMetric('walletFallbackUsed')
      break
    case 'checksum_failure':
      recordPricingMetric('walletChecksumFailures')
      recordPricingMetric('walletFallbackUsed')
      break
    case 'fallback':
      recordPricingMetric('walletFallbackUsed')
      break
  }
}

/**
 * Record wallet-CREDIT metrics from a ledger doc whose financials were already resolved
 * snapshot-first at order time (RD-PRICING-02C · `pricingSource`). Metrics only; the
 * credited value is unchanged. Call ONCE, post-commit.
 */
export function recordWalletCreditMetric(doc: {
  pricingSource?: string
  pricingSnapshotMeta?: { shadowMatch?: boolean }
}): void {
  if (doc.pricingSource === 'snapshot') {
    recordPricingMetric('walletSnapshotUsed')
    recordPricingMetric(doc.pricingSnapshotMeta?.shadowMatch ? 'walletShadowMatches' : 'walletShadowMismatches')
  } else {
    recordPricingMetric('walletFallbackUsed')
  }
}
