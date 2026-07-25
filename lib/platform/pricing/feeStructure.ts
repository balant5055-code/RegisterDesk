// RD-PRICING-02A — fee-structure resolution. SERVER-ONLY.
//
// The reconciled engine does NOT invent its own fee matrix: it resolves the SAME
// production FeeConfig (lib/fees) so the default configuration is production by
// construction (Phase 3). `resolveFeeConfig` = the production FALLBACK matrix overlaid
// with the Business Configuration `fees` section — the identical source the live fee
// engine reads. The commercial model + algorithm (commercial.ts) layer on top.

import { resolveFeeConfig } from '@/lib/fees/resolveFeeConfig'
import type { EventLicenseTier } from '@/lib/licensing/eventLicense'
import type { FeeConfig, PlatformPlanTier, PlatformTransactionType } from '@/lib/fees/types'

/**
 * Map an Event License tier to the fee-engine plan tier. Mirrors the (private)
 * `licenseTierToFeeTier` in lib/billing/feeEngine.ts: identity except professional →
 * 'pro'. Replicated here as a 1-liner; shadowCompare.ts validates the resulting math
 * against production, so any divergence surfaces immediately.
 */
export function licenseTierToFeeTier(tier: EventLicenseTier): PlatformPlanTier {
  return tier === 'professional' ? 'pro' : tier
}

/**
 * Reverse of `licenseTierToFeeTier`, for the order-snapshot integration where only the
 * production plan tier is on hand: pro → professional, else identity. The fee-only
 * 'free' tier has no license equivalent → 'starter' (the free license).
 */
export function feeTierToLicenseTier(tier: PlatformPlanTier): EventLicenseTier {
  switch (tier) {
    case 'pro':          return 'professional'
    case 'professional': return 'professional'   // RD-LICENSE-GA-01 — V2 fee tier (2,500), maps to the V1 professional license
    case 'business':     return 'professional'   // RD-LICENSE-GA-01 — V2 fee tier (5,000) = pro economics
    case 'growth':       return 'growth'
    case 'enterprise':   return 'enterprise'
    case 'starter':      return 'starter'
    case 'free':         return 'starter'
  }
}

/** Resolve the production FeeConfig for an event's license tier + transaction type. */
export function resolveEngineFeeConfig(
  tier: EventLicenseTier,
  transactionType: PlatformTransactionType = 'event_registration',
): Promise<FeeConfig> {
  return resolveFeeConfig(transactionType, licenseTierToFeeTier(tier))
}
