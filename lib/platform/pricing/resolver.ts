// RD-PRICING-01B — Platform Pricing Engine · resolver (SERVER-ONLY).
//
// resolvePlatformPricing(): the ONE runtime read. Resolution order:
//   Firestore platformSettings/default  →  code defaults (defaults.ts)
//
// Always returns a complete, VALIDATED PlatformSettings — a missing doc, a read
// error, or invalid/partial stored data all fall back to the code defaults, so the
// engine can never resolve to undefined or an invalid value. NOTHING consumes this
// yet (RD-PRICING-01C).

import { adminDb } from '@/lib/firebase/admin'
import { cloneDefaultPlatformSettings, DEFAULT_PLATFORM_SETTINGS } from './defaults'
import { validatePlatformSettings } from './validation'
import {
  PRICING_TIER_IDS,
  type PlatformSettings,
  type PricingTierId,
  type TierDefinition,
} from './types'

export const PLATFORM_SETTINGS_COLLECTION = 'platformSettings'
export const PLATFORM_SETTINGS_DOC = 'default'

export const platformSettingsRef = () =>
  adminDb.collection(PLATFORM_SETTINGS_COLLECTION).doc(PLATFORM_SETTINGS_DOC)

// ─── Deep-merge stored (possibly partial) data onto the code defaults ────────────
// Read stored fields defensively (they may be absent/legacy) and overlay them onto
// a fresh default clone. Unknown/absent fields keep the default. Type guards keep
// this `any`-free.

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const boolOr = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback

const payer = (v: unknown, fallback: 'organizer' | 'attendee'): 'organizer' | 'attendee' =>
  v === 'organizer' || v === 'attendee' ? v : fallback

function mergeTier(base: TierDefinition, stored: unknown): TierDefinition {
  const s = (stored ?? {}) as Record<string, unknown>
  const p = (s.pricing ?? {}) as Record<string, unknown>
  const limit = s.registrationLimit
  return {
    id:    base.id,
    label: typeof s.label === 'string' ? s.label : base.label,
    registrationLimit:
      limit === null ? null
      : typeof limit === 'number' && Number.isFinite(limit) ? limit
      : base.registrationLimit,
    pricing: {
      regularPrice: num(p.regularPrice, base.pricing.regularPrice),
      offerPrice:   num(p.offerPrice,   base.pricing.offerPrice),
    },
  }
}

function mergeOntoDefaults(stored: Record<string, unknown>): PlatformSettings {
  const base = cloneDefaultPlatformSettings()

  const meta      = (stored.metadata  ?? {}) as Record<string, unknown>
  const licensing = (stored.licensing ?? {}) as Record<string, unknown>
  const storedTiers = (licensing.tiers ?? {}) as Record<string, unknown>
  const pricing    = (stored.pricing    ?? {}) as Record<string, unknown>
  const gateway    = (stored.gateway    ?? {}) as Record<string, unknown>
  const commercial = (stored.commercial ?? {}) as Record<string, unknown>
  const features   = (stored.features   ?? {}) as Record<string, unknown>

  const tiers = {} as Record<PricingTierId, TierDefinition>
  for (const id of PRICING_TIER_IDS) tiers[id] = mergeTier(base.licensing.tiers[id], storedTiers[id])

  return {
    metadata: {
      version:   num(meta.version, base.metadata.version),
      updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : base.metadata.updatedAt,
      updatedBy: typeof meta.updatedBy === 'string' ? meta.updatedBy : base.metadata.updatedBy,
    },
    licensing: { tiers },
    pricing: {
      // Backward-compat (RD-PRICING-01B.1): a doc written under the pre-correction
      // schema stored `platformFeePercent`. Auto-map its value into the renamed
      // `platformFeeAmount` at resolution — no manual migration needed.
      platformFeeAmount:  num(pricing.platformFeeAmount ?? pricing.platformFeePercent, base.pricing.platformFeeAmount),
      platformGstPercent: num(pricing.platformGstPercent, base.pricing.platformGstPercent),
    },
    gateway: {
      provider:          gateway.provider === 'razorpay' ? 'razorpay' : base.gateway.provider,
      gatewayPercent:    num(gateway.gatewayPercent,    base.gateway.gatewayPercent),
      gatewayGstPercent: num(gateway.gatewayGstPercent, base.gateway.gatewayGstPercent),
      convenienceFee:    num(gateway.convenienceFee,    base.gateway.convenienceFee),
    },
    commercial: {
      platformFeePaidBy:     payer(commercial.platformFeePaidBy, base.commercial.platformFeePaidBy),
      gatewayFeePaidBy:      payer(commercial.gatewayFeePaidBy,  base.commercial.gatewayFeePaidBy),
      convenienceFeeEnabled: boolOr(commercial.convenienceFeeEnabled, base.commercial.convenienceFeeEnabled),
      gatewayGstEnabled:     boolOr(commercial.gatewayGstEnabled,     base.commercial.gatewayGstEnabled),
      platformGstEnabled:    boolOr(commercial.platformGstEnabled,    base.commercial.platformGstEnabled),
    },
    features: {
      pricingEngineEnabled: boolOr(features.pricingEngineEnabled, base.features.pricingEngineEnabled),
    },
  }
}

/**
 * Resolve the effective platform pricing settings. Firestore overlaid on code
 * defaults; falls back to defaults on missing doc / read error / invalid data.
 */
export async function resolvePlatformPricing(): Promise<PlatformSettings> {
  try {
    const snap = await platformSettingsRef().get()
    if (!snap.exists) return cloneDefaultPlatformSettings()

    const merged = mergeOntoDefaults((snap.data() ?? {}) as Record<string, unknown>)
    const check  = validatePlatformSettings(merged)
    if (!check.ok) {
      console.warn('[platform-pricing] stored settings invalid — using code defaults:', check.errors)
      return cloneDefaultPlatformSettings()
    }
    return merged
  } catch (err) {
    console.error('[platform-pricing] resolve failed — using code defaults:', err)
    return cloneDefaultPlatformSettings()
  }
}

/**
 * The RAW stored `platformSettings/default` document data, or null when the doc is
 * absent / unreadable. Unlike `resolvePlatformPricing()` (which merges onto defaults
 * and loses provenance), this preserves exactly which fields the admin explicitly set
 * — the effective-config trace (RD-PRICING-01D) uses it to tell `global` from
 * `default`. Never throws.
 */
export async function getStoredPlatformSettingsRaw(): Promise<Record<string, unknown> | null> {
  try {
    const snap = await platformSettingsRef().get()
    return snap.exists ? ((snap.data() ?? null) as Record<string, unknown> | null) : null
  } catch (err) {
    console.error('[platform-pricing] raw read failed:', err)
    return null
  }
}

export { DEFAULT_PLATFORM_SETTINGS }
