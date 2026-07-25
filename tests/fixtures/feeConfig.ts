// RD-GA-HARDEN-01 — FeeConfig fixtures sourced from the REAL production fallback matrix
// (lib/fees/config.ts), so tests validate against the exact live default rates.

import { getDefaultFeeConfig } from '@/lib/fees/config'
import type { FeeConfig, PlatformPlanTier, PlatformTransactionType } from '@/lib/fees/types'

export function feeConfigFor(
  tier: PlatformPlanTier = 'starter',
  type: PlatformTransactionType = 'event_registration',
): FeeConfig {
  return getDefaultFeeConfig(type, tier)
}

export const ALL_PLAN_TIERS: PlatformPlanTier[] = ['free', 'starter', 'growth', 'pro', 'enterprise']
export const ALL_TX_TYPES: PlatformTransactionType[] = ['event_registration', 'donation', 'membership']
