// RD-PRICING-01B — Platform Pricing Engine · frozen code defaults.
//
// The resolver falls back to THIS when `platformSettings/default` is absent/invalid,
// so the engine always resolves a complete, valid PlatformSettings even with an
// empty Firestore. PURE — no side effects.
//
// RD-PRICING-01C-PREP: these defaults now MIRROR today's live production licensing
// (lib/licensing/eventLicense · V1_DEFINITIONS) so that when the engine is eventually
// switched on it reproduces production numbers EXACTLY — no capacity/pricing change.
// The future business model (free=200, starter=1,000, professional=2,500,
// business=5,000) is intentionally NOT applied here; it will be set post-migration
// via Admin configuration (platformSettings/default).
//
// Tiers map to production per lib/platform/pricing/tierMap.ts:
//   engine free   ← production starter      (FREE,   100)
//   engine starter← production growth        (₹999,  1,000)
//   engine business ← production professional (₹2,499, 5,000)
//   engine enterprise ← production enterprise (₹4,999, ∞ → null)
//   engine professional = NET-NEW roadmap tier, NO production counterpart (see below).
//
// Prices are WHOLE RUPEES (production paise ÷ 100 — see units.ts). Production carries
// a single license price, so regularPrice == offerPrice here (no phantom discount).
// Nothing consumes these yet (pricingEngineEnabled = false).

import type { PlatformSettings, PricingTierId, TierDefinition } from './types'
import { DEFAULT_COMMERCIAL_MODEL } from './commercial'

/** Current defaults schema version. Bump when the DEFAULTS shape/values change. */
export const PLATFORM_SETTINGS_VERSION = 1

// Registration limits (null = unlimited) + one-time license prices (₹ regular/offer).
const TIER_DEFAULTS: Record<PricingTierId, TierDefinition> = {
  free: {                                     // ← production starter (FREE, 100)
    id: 'free', label: 'Free',
    registrationLimit: 100,
    pricing: { regularPrice: 0, offerPrice: 0 },
  },
  starter: {                                  // ← production growth (₹999, 1,000)
    id: 'starter', label: 'Starter',
    registrationLimit: 1000,
    pricing: { regularPrice: 999, offerPrice: 999 },
  },
  professional: {
    // NET-NEW roadmap tier — NO production counterpart; no stored event maps here
    // (tierMap.ts). Held as an INERT placeholder mirroring Business (production
    // Professional) so it is a valid, production-derived value rather than the future
    // 2,500 target. Admin sets its real value post-migration.
    id: 'professional', label: 'Professional',
    registrationLimit: 5000,
    pricing: { regularPrice: 2499, offerPrice: 2499 },
  },
  business: {                                 // ← production professional (₹2,499, 5,000)
    id: 'business', label: 'Business',
    registrationLimit: 5000,
    pricing: { regularPrice: 2499, offerPrice: 2499 },
  },
  enterprise: {                               // ← production enterprise (₹4,999, ∞)
    id: 'enterprise', label: 'Enterprise',
    registrationLimit: null,   // Unlimited
    pricing: { regularPrice: 4999, offerPrice: 4999 },
  },
}

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  metadata: {
    version:   PLATFORM_SETTINGS_VERSION,
    updatedAt: null,
    updatedBy: null,
  },
  licensing: {
    tiers: TIER_DEFAULTS,
  },
  pricing: {
    platformFeeAmount:  2,    // ₹2 fixed (NOT a percent)
    platformGstPercent: 18,
  },
  gateway: {
    provider:          'razorpay',
    gatewayPercent:    2.2,
    gatewayGstPercent: 18,
    convenienceFee:    1,
  },
  // RD-PRICING-02A: the DEFAULT commercial model MIRRORS production (organizer bears
  // both fees, platform GST on, gateway GST off, no convenience) — i.e. the live
  // `organizer_pays` model. See commercial.ts.
  commercial: DEFAULT_COMMERCIAL_MODEL,
  features: {
    pricingEngineEnabled: false,
  },
}

/** A deep, JSON-safe clone of the defaults — callers mutate the copy, never the SoT. */
export function cloneDefaultPlatformSettings(): PlatformSettings {
  return JSON.parse(JSON.stringify(DEFAULT_PLATFORM_SETTINGS)) as PlatformSettings
}
