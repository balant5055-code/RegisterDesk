// In-code fallback fee configuration table.
// Replace category/tier lookup with Firestore feeConfigs reads in Phase 2+.

import type {
  FeeConfig,
  PlatformPlanTier,
  PlatformTransactionCategory,
  PlatformTransactionType,
} from './types'

const TYPE_CATEGORY: Record<PlatformTransactionType, PlatformTransactionCategory> = {
  event_registration:    'ticketed',
  workshop_fee:          'ticketed',
  conference_ticket:     'ticketed',
  marathon_registration: 'ticketed',
  exhibition_booth:      'ticketed',
  sponsorship_package:   'ticketed',
  donation:              'donation',
  membership:            'subscription',
}

// Rates: platformFeePercentBps=200 → 2.00%, gatewayFeePercentBps=200 → ~2% (Razorpay estimate)
// platformFeeFixedPaise=500 → ₹5 fixed per transaction
// All maxPaise=0 means uncapped (except pro tier)
const FALLBACK: Record<PlatformPlanTier, Record<PlatformTransactionCategory, FeeConfig>> = {
  free: {
    ticketed:     { platformFeePercentBps: 300, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise:     0, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
    donation:     { platformFeePercentBps: 300, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise:     0, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
    subscription: { platformFeePercentBps: 300, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise:     0, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
  },
  starter: {
    ticketed:     { platformFeePercentBps: 200, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise:     0, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
    donation:     { platformFeePercentBps: 200, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise:     0, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
    subscription: { platformFeePercentBps: 200, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise:     0, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
  },
  growth: {
    ticketed:     { platformFeePercentBps: 150, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise:     0, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
    donation:     { platformFeePercentBps: 100, platformFeeFixedPaise:   0, platformFeeMinPaise:   0, platformFeeMaxPaise:     0, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
    subscription: { platformFeePercentBps: 150, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise:     0, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
  },
  pro: {
    ticketed:     { platformFeePercentBps: 100, platformFeeFixedPaise:   0, platformFeeMinPaise:   0, platformFeeMaxPaise: 50000, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
    donation:     { platformFeePercentBps:  50, platformFeeFixedPaise:   0, platformFeeMinPaise:   0, platformFeeMaxPaise: 20000, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
    subscription: { platformFeePercentBps: 100, platformFeeFixedPaise:   0, platformFeeMinPaise:   0, platformFeeMaxPaise: 50000, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
  },
  // Enterprise — wires the EXISTING F.1 plan rate (0.5%, ₹200 cap) into the fee
  // engine. Single negotiated rate across categories (plans.ts defines one
  // transactionFeePercent + cap for enterprise). Not a pricing change.
  enterprise: {
    ticketed:     { platformFeePercentBps:  50, platformFeeFixedPaise:   0, platformFeeMinPaise:   0, platformFeeMaxPaise: 20000, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
    donation:     { platformFeePercentBps:  50, platformFeeFixedPaise:   0, platformFeeMinPaise:   0, platformFeeMaxPaise: 20000, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
    subscription: { platformFeePercentBps:  50, platformFeeFixedPaise:   0, platformFeeMinPaise:   0, platformFeeMaxPaise: 20000, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
  },
}

export function getTransactionCategory(
  type: PlatformTransactionType,
): PlatformTransactionCategory {
  return TYPE_CATEGORY[type]
}

export function getDefaultFeeConfig(
  type:     PlatformTransactionType,
  planTier: PlatformPlanTier = 'starter',
): FeeConfig {
  return FALLBACK[planTier][TYPE_CATEGORY[type]]
}
