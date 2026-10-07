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
//   • The fee is always derived server-side; the client can never select a rate or
//     influence the fee.
//
// RD-CAPACITY-01 — the rate no longer comes from a licence tier. The capacity-based
// commercial model has one platform rate, held in
// `licensing.commercial.attendeeTransactionFeePercent` and applied by resolveFeeConfig.
// `licenseTierToFeeTier` below is RETAINED, unchanged, because reporting and historical
// reconciliation still map a STORED licence tier to the fee row it was charged under — it
// is simply no longer consulted when pricing a new transaction.

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
 * The single fee row every NEW transaction resolves against.
 *
 * RD-CAPACITY-01 · the capacity-based commercial model has no tiers, so there is no longer a
 * tier to look up and no per-organizer rate to resolve. `starter` is the canonical row:
 * uncapped, with the same fixed and minimum components the great majority of organizers were
 * already on. The PERCENTAGE it carries is overridden by
 * `licensing.commercial.attendeeTransactionFeePercent` inside resolveFeeConfig, so the rate
 * is configuration, not a table entry.
 */
const CANONICAL_FEE_TIER: PlatformPlanTier = 'starter'

/**
 * Resolves the fee plan for a NEW transaction.
 *
 * RD-CAPACITY-01 · this no longer reads the organizer's licences. Under one flat platform
 * rate there is nothing organizer-specific left to resolve, and continuing to read a tier
 * would leave the retired tier vocabulary quietly deciding money.
 *
 * Every financial-integrity rule above still holds, and the two that matter most are
 * unchanged by this: historical transactions keep their STORED fee values, and refund
 * reversals reverse the stored net rather than re-resolving anything. So this changes the
 * rate for FUTURE transactions only — which is what a platform rate change means.
 *
 * `organizerUid` is retained in the signature: every caller passes it, the argument is what
 * makes a future per-organizer negotiated rate a one-line change here, and removing it would
 * churn four call sites on the payment path for no behavioural gain.
 */
export async function getFeePlanForOrganizer(organizerUid: string): Promise<OrganizerFeePlan> {
  void organizerUid   // reserved: a future per-organizer negotiated rate resolves here
  const planTier = CANONICAL_FEE_TIER
  const headline = await resolveFeeConfig('event_registration', planTier)
  return {
    planTier,
    transactionFeePercent:  headline.platformFeePercentBps / 100,
    transactionFeeCapPaise: headline.platformFeeMaxPaise,
    feeConfigId:            `plan:${planTier}`,
  }
}
