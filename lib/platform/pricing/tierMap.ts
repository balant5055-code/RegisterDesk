// RD-PRICING-01C-PREP — Tier reconciliation layer. PURE, client-safe.
//
// Bridges the TWO tier vocabularies so the engine can resolve any stored event
// WITHOUT a data migration:
//
//   Production (lib/licensing/eventLicense · EventLicenseTier)   — 4 tiers
//     starter · growth · professional · enterprise
//   Engine    (lib/platform/pricing · PricingTierId)             — 5 tiers
//     free · starter · professional · business · enterprise
//
// The mapping is by ROLE / registration-limit, aligned to the roadmap the engine's
// future config encodes (free=200, starter=1000, professional=2500, business=5000):
//
//   production starter      (FREE,   100)   → engine free        (the free entry tier)
//   production growth        (₹999,  1,000) → engine starter     (first paid, 1,000)
//   production professional (₹2,499, 5,000) → engine business    (5,000)
//   production enterprise   (₹4,999, ∞)     → engine enterprise  (unlimited)
//
// engine 'professional' (roadmap 2,500) is a NET-NEW tier with NO production
// counterpart — no stored event ever resolves to it. It exists only so the future
// 5-tier model can be switched on via admin config after migration.
//
// This layer changes NO runtime behavior: pricingEngineEnabled is false and nothing
// consumes it yet (consumer migration is RD-PRICING-01C).

import type { EventLicenseTier } from '@/lib/licensing/eventLicense'
import type { PlatformSettings, PricingTierId, TierDefinition } from './types'

/**
 * Production EventLicenseTier → engine PricingTierId.
 *
 * TOTAL over EventLicenseTier (all four keys present), so mapping a stored event's
 * license tier can never yield `undefined`. The compiler enforces completeness: add
 * a production tier and this record fails to type-check until it is mapped.
 */
export const PRODUCTION_TO_ENGINE_TIER: Record<EventLicenseTier, PricingTierId> = {
  starter:      'free',
  growth:       'starter',
  professional: 'business',
  enterprise:   'enterprise',
}

/**
 * Engine PricingTierId → production EventLicenseTier (reverse of the above).
 *
 * PARTIAL by design: engine 'professional' has no production origin, so it is absent.
 * Use `mapEngineTierToProduction` for a checked lookup.
 */
export const ENGINE_TO_PRODUCTION_TIER: Partial<Record<PricingTierId, EventLicenseTier>> = {
  free:       'starter',
  starter:    'growth',
  business:   'professional',
  enterprise: 'enterprise',
}

/** Map a production license tier to its engine tier. Never undefined (total map). */
export function mapProductionTierToEngine(tier: EventLicenseTier): PricingTierId {
  return PRODUCTION_TO_ENGINE_TIER[tier]
}

/** Map an engine tier back to production, or null for the engine-only 'professional' tier. */
export function mapEngineTierToProduction(tier: PricingTierId): EventLicenseTier | null {
  return ENGINE_TO_PRODUCTION_TIER[tier] ?? null
}

/**
 * Resolve the engine TierDefinition for a stored event's production license tier.
 *
 * Never returns undefined: the production→engine map is total, and a resolved
 * PlatformSettings always contains all five engine tiers (the resolver fills every
 * PRICING_TIER_ID from defaults). This is the accessor a future consumer (01C) uses
 * instead of indexing `settings.licensing.tiers` with a raw production tier string.
 */
export function resolveTierForProductionLicense(
  settings: PlatformSettings,
  tier: EventLicenseTier,
): TierDefinition {
  return settings.licensing.tiers[mapProductionTierToEngine(tier)]
}
