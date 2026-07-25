// License-based transaction-fee engine. Server-only.
//
// THE single source of truth for "what fee does this organizer pay?". Resolves the
// organizer's EFFECTIVE Event License tier (their highest active event license, or
// an admin override) via lib/licensing/workspaceEntitlements and maps it to the
// fee-engine tier, so every NEW transaction's fee derives from the active license.
//
// Financial-integrity rules (enforced by callers, documented here):
//   • Only NEW transactions call this. Historical platformTransactions, refunds,
//     settlements, reports and wallets keep their STORED fee values.
//   • Refund reversals reverse the original STORED net — never re-resolve a license.
//   • The fee is always derived server-side from the stored licenses; the client can
//     never select a tier or influence the fee.

import { getWorkspaceEntitlements } from '@/lib/licensing/workspaceEntitlements'
import { resolveFeeConfig } from '@/lib/fees/resolveFeeConfig'
import type { PlatformPlanTier } from '@/lib/fees/types'
import { LICENSE_VERSION_V2, type AnyEventLicenseTier, type LicenseVersion } from '@/lib/licensing/eventLicense'

export interface OrganizerFeePlan {
  planTier:               PlatformPlanTier   // resolved fee tier (for the stored ledger)
  transactionFeePercent:  number             // headline (event/ticketed) %, derived from config
  transactionFeeCapPaise: number             // headline cap (0 = uncapped)
  feeConfigId:            string             // `plan:<tier>` — recorded on the ledger
}

/**
 * Event License tier → fee-engine PlatformPlanTier — the ONE canonical mapping, driven by
 * the license's stored `version` (never inferred by name). Each mapping targets the fee
 * row whose rate equals the tier's `transactionFeePercent` in lib/licensing/eventLicense.ts:
 *
 *   V1 (unchanged): starter→starter(2%) · growth→growth(1.5%) · professional→pro(1%) · enterprise→enterprise(0.5%)
 *   V2:             free→starter(2%) · starter→growth(1.5%) · professional→professional(1%) · business→business(1%) · enterprise→enterprise(0.5%)
 *
 * V1 stays byte-for-byte (no finance regression); V2 tiers all resolve to a valid fee row
 * (no crash on Business/Free). No fee formula changes — only the tier→row lookup.
 */
export function licenseTierToFeeTier(tier: AnyEventLicenseTier, version: LicenseVersion): PlatformPlanTier {
  if (version >= LICENSE_VERSION_V2) {
    switch (tier) {
      case 'free':         return 'starter'       // V2 Free 2.0% == starter row
      case 'starter':      return 'growth'         // V2 Starter 1.5% == growth row
      case 'professional': return 'professional'   // V2 Professional 1% (own row)
      case 'business':     return 'business'        // V2 Business 1% (own row)
      case 'enterprise':   return 'enterprise'      // V2 Enterprise 0.5%
      default:             return 'starter'         // defensive — never reached for a valid V2 tier
    }
  }
  // V1 vocabulary — historical, unchanged. 'professional' → the fee table's legacy 'pro' key.
  if (tier === 'professional') return 'pro'
  if (tier === 'starter' || tier === 'growth' || tier === 'enterprise') return tier
  return 'starter'   // defensive — never reached for a valid V1 tier
}

/**
 * Resolves the organizer's active fee plan. Always reads the stored licenses
 * server-side — there is no client-supplied path to a lower fee.
 */
export async function getFeePlanForOrganizer(organizerUid: string): Promise<OrganizerFeePlan> {
  const { effectiveTier, effectiveVersion } = await getWorkspaceEntitlements(organizerUid)
  const planTier = licenseTierToFeeTier(effectiveTier, effectiveVersion)
  const headline = await resolveFeeConfig('event_registration', planTier)
  return {
    planTier,
    transactionFeePercent:  headline.platformFeePercentBps / 100,
    transactionFeeCapPaise: headline.platformFeeMaxPaise,
    feeConfigId:            `plan:${planTier}`,
  }
}
