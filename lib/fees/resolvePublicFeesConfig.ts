// Server-only. THE single runtime source for the client-facing (public, non-secret)
// fee terms after GA-3 S4B. Reads the Business Configuration `fees` section for the
// enable/inclusive/collection flags + display labels, and derives a representative
// effective `platformFeePercent` / `gatewayFeePercent` / `gstPercent` from
// resolveFeeConfig (per-tier matrix ⊕ config) for a starter registration — so the
// client never hardcodes a rate. The authoritative charge is still computed
// per-transaction server-side.

import { businessConfig } from '@/lib/config/businessConfigService'
import { resolveFeeConfig } from './resolveFeeConfig'
import type { PublicFeesConfig } from './publicFeesShared'

export async function getPublicFeesConfig(): Promise<PublicFeesConfig> {
  const [section, resolved] = await Promise.all([
    businessConfig.getSection('fees'),
    resolveFeeConfig('event_registration', 'starter'),
  ])
  return {
    platformFeePercent:     resolved.platformFeePercentBps / 100,
    gatewayFeeEnabled:      section.gatewayFeeEnabled,
    gatewayFeePercent:      resolved.gatewayFeePercentBps / 100,
    gstEnabled:             section.gstEnabled,
    gstPercent:             resolved.gstRatePercent,
    gstInclusive:           section.gstInclusive,
    feeCollectionMethod:    section.feeCollectionMethod,
    platformFeeDisplayName: section.platformFeeDisplayName,
    gstDescription:         section.gstDescription,
  }
}
