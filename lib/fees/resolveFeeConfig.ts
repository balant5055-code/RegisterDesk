// Server-only. THE single runtime source for a transaction's FeeConfig after
// RD-CONF-06. Starts from the per-license fee matrix (lib/fees/config.ts — the code
// default) and overlays the Business Configuration `fees` section: the GLOBAL knobs
// (GST, gateway) always apply; `platformFeePercent` / `donationPlatformFee` are
// OPTIONAL overrides (null → inherit the per-tier matrix), so with no stored config
// the resolved FeeConfig is byte-for-byte the code default (zero regression).
//
// The pure calculation (lib/fees/engine.ts calculateFee) and the FeeConfig shape are
// unchanged — only where the rates come from moves to config.
//
// EXTENSIBLE (Step 8): an optional context (organizerUid / eventId) is accepted but
// NOT yet applied — future organizer/event override layers slot in here without
// changing any caller.

import { businessConfig } from '@/lib/config/businessConfigService'
import { getDefaultFeeConfig, getTransactionCategory } from './config'
import type { FeeConfig, PlatformPlanTier, PlatformTransactionType } from './types'

export interface FeeResolutionContext {
  organizerUid?: string   // reserved for a future organizer-override layer
  eventId?:      string   // reserved for a future event-override layer
}

export async function resolveFeeConfig(
  type: PlatformTransactionType,
  planTier: PlatformPlanTier = 'starter',
  context?: FeeResolutionContext,
): Promise<FeeConfig> {
  void context   // reserved: future organizer/event override layers hook in here
  const base = getDefaultFeeConfig(type, planTier)   // per-tier/category code default
  const fees = await businessConfig.getSection('fees')

  // Donation category uses its own platform-fee override; everything else uses the
  // general one. `null` means "keep the per-tier matrix rate".
  const platformOverride = getTransactionCategory(type) === 'donation'
    ? fees.donationPlatformFee
    : fees.platformFeePercent

  // Master enable switches (default true → no-op): disabling zeroes the component.
  // The per-tier `platformFeeType`/flat/min/max completion fields stay reserved —
  // the pure calculation is intentionally unchanged this sprint.
  const platformBps = fees.platformFeeEnabled === false
    ? 0
    : platformOverride != null ? Math.round(platformOverride * 100) : base.platformFeePercentBps

  return {
    ...base,
    platformFeePercentBps: platformBps,
    gstRatePercent:        fees.gstEnabled === false ? 0 : fees.gstPercent,
    gatewayFeePercentBps:  fees.gatewayFeeEnabled ? Math.round(fees.gatewayFeePercent * 100) : 0,
  }
}
