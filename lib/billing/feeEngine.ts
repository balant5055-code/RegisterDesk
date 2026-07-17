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
import type { EventLicenseTier } from '@/lib/licensing/eventLicense'

export interface OrganizerFeePlan {
  planTier:               PlatformPlanTier   // resolved fee tier (for the stored ledger)
  transactionFeePercent:  number             // headline (event/ticketed) %, derived from config
  transactionFeeCapPaise: number             // headline cap (0 = uncapped)
  feeConfigId:            string             // `plan:<tier>` — recorded on the ledger
}

// Event License tier → fee-engine PlatformPlanTier. Identity for starter/growth/
// enterprise; the license 'professional' maps to the fee table's legacy 'pro' key.
function licenseTierToFeeTier(tier: EventLicenseTier): PlatformPlanTier {
  return tier === 'professional' ? 'pro' : tier
}

/**
 * Resolves the organizer's active fee plan. Always reads the stored licenses
 * server-side — there is no client-supplied path to a lower fee.
 */
export async function getFeePlanForOrganizer(organizerUid: string): Promise<OrganizerFeePlan> {
  const { effectiveTier } = await getWorkspaceEntitlements(organizerUid)
  const planTier = licenseTierToFeeTier(effectiveTier)
  const headline = await resolveFeeConfig('event_registration', planTier)
  return {
    planTier,
    transactionFeePercent:  headline.platformFeePercentBps / 100,
    transactionFeeCapPaise: headline.platformFeeMaxPaise,
    feeConfigId:            `plan:${planTier}`,
  }
}
