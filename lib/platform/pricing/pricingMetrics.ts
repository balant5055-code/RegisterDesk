// RD-PRICING-02C — payment pricing diagnostics. In-memory, process-level counters.
//
// No persistence, no schema, no PII, no UI. Operational visibility only: how often the
// stored snapshot was used vs. the lib/fees fallback, and the shadow-match rate. Counts
// reset on process restart — they are a live health signal, not an audit ledger (the
// per-order source/shadow result is recorded on the ledger doc itself).

export interface PricingMetricsSnapshot {
  // RD-PRICING-02C — payment ledger financial source.
  snapshotUsed:     number   // stored snapshot was the financial source
  fallbackUsed:     number   // lib/fees was the financial source
  checksumFailures: number   // snapshot present but failed deserialize/checksum/validate
  shadowMatches:    number   // reconciled engine matched production
  shadowMismatches: number   // reconciled engine differed from production (→ fallback)

  // RD-PRICING-02D — wallet settlement (credit + refund-reversal debit) source.
  walletSnapshotUsed:     number
  walletFallbackUsed:     number
  walletShadowMatches:    number
  walletShadowMismatches: number
  walletChecksumFailures: number

  // RD-PRICING-02E — finance read models. The last two are GAUGES (last-observed
  // version), not counters — set via recordFinanceVersions.
  financeSnapshotUsed:     number
  financeFallbackUsed:     number
  financeChecksumFailures: number
  financeSnapshotVersion:  number   // last observed snapshot envelope version
  financePricingVersion:   number   // last observed pricing model version

  // RD-PRICING-02F — reports / analytics / dashboard / export read models.
  reportSnapshotUsed:     number
  reportFallbackUsed:     number
  reportChecksumFailures: number
  reportSnapshotVersion:  number   // last observed (gauge)
  reportPricingVersion:   number   // last observed (gauge)
}

type CounterKey = keyof PricingMetricsSnapshot

const counters: PricingMetricsSnapshot = {
  snapshotUsed:     0,
  fallbackUsed:     0,
  checksumFailures: 0,
  shadowMatches:    0,
  shadowMismatches: 0,
  walletSnapshotUsed:     0,
  walletFallbackUsed:     0,
  walletShadowMatches:    0,
  walletShadowMismatches: 0,
  walletChecksumFailures: 0,
  financeSnapshotUsed:     0,
  financeFallbackUsed:     0,
  financeChecksumFailures: 0,
  financeSnapshotVersion:  0,
  financePricingVersion:   0,
  reportSnapshotUsed:     0,
  reportFallbackUsed:     0,
  reportChecksumFailures: 0,
  reportSnapshotVersion:  0,
  reportPricingVersion:   0,
}

export function recordPricingMetric(key: CounterKey): void {
  counters[key] += 1
}

/** Set the last-observed finance version gauges (RD-PRICING-02E). */
export function recordFinanceVersions(snapshotVersion: number, pricingVersion: number): void {
  counters.financeSnapshotVersion = snapshotVersion
  counters.financePricingVersion  = pricingVersion
}

/** Set the last-observed report version gauges (RD-PRICING-02F). */
export function recordReportVersions(snapshotVersion: number, pricingVersion: number): void {
  counters.reportSnapshotVersion = snapshotVersion
  counters.reportPricingVersion  = pricingVersion
}

/** A snapshot copy of the current counters. */
export function getPricingMetrics(): PricingMetricsSnapshot {
  return { ...counters }
}

/** Reset all counters (tests / diagnostics). */
export function resetPricingMetrics(): void {
  for (const k of Object.keys(counters) as CounterKey[]) counters[k] = 0
}
