// RD-PRICING-01D — Pricing Engine · effective-configuration API. SERVER-ONLY.
//
// THE only surface business modules (registration / publish / edit / admin approval,
// and later payments) may consume. Business modules must NEVER manually merge
// configuration, index the tier catalog, know the tier map, touch Firestore, or
// convert ₹↔paise — all of that is encapsulated here.
//
// Override precedence (RD-PRICING-01D), resolved PER FIELD, independently:
//   Admin Event Override → Organizer Event Override → Global Platform Settings →
//   Production Defaults.
//
// Feature-flag contract (Phase 6):
//   pricingEngineEnabled === false → ENGINE DORMANT. Every value resolves to today's
//     production baseline (getLicenseCatalog for the limit); overrides + global are
//     IGNORED; every source is 'default'. Behavior is byte-for-byte identical to today.
//   pricingEngineEnabled === true  → the full per-field hierarchy above applies.
//
// Limits are PRODUCTION shape (Infinity = unlimited); money is PAISE (via units.ts).

import { getLicenseCatalog } from '@/lib/licensing/resolveCatalog'
import { UNLIMITED, isEventLicenseTier, type EventLicenseTier } from '@/lib/licensing/eventLicense'
import { resolvePlatformPricing, getStoredPlatformSettingsRaw } from './resolver'
import { cloneDefaultPlatformSettings } from './defaults'
import { mapProductionTierToEngine, resolveTierForProductionLicense } from './tierMap'
import { rupeesToPaise } from './units'
import type {
  ConfigurationSource,
  TracedValue,
  RegistrationLimit,
  EffectiveLicense,
  EffectivePlatformFee,
  EffectiveGatewayCharges,
  EffectivePlatformConfiguration,
  PricingEventView,
} from './types'

// ─── Per-field precedence primitive ───────────────────────────────────────────────
//
// Resolve ONE field through the chain. `undefined` at a level means "not set here"
// (fall through); an explicit value — including `null` for a limit — binds. `null`
// vs `undefined` is why overrides use optional fields, not sentinels.

function pick<T>(
  admin:         T | undefined,
  organizer:     T | undefined,
  global:        T,
  globalPresent: boolean,
  fallback:      T,
): TracedValue<T> {
  if (admin     !== undefined) return { value: admin,     source: 'adminOverride' }
  if (organizer !== undefined) return { value: organizer, source: 'organizerOverride' }
  if (globalPresent)           return { value: global,    source: 'global' }
  return { value: fallback, source: 'default' }
}

const paise = (t: TracedValue<number>): TracedValue<number> =>
  ({ value: rupeesToPaise(t.value), source: t.source })

/** Registration limit in production shape (null → Infinity), preserving the source. */
const prodLimit = (t: TracedValue<RegistrationLimit>): TracedValue<number> =>
  ({ value: t.value === null ? UNLIMITED : t.value, source: t.source })

// ─── Raw-doc presence probes (global vs default) ──────────────────────────────────

function section(raw: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const s = raw?.[key]
  return s && typeof s === 'object' ? s as Record<string, unknown> : null
}

function fieldPresent(raw: Record<string, unknown> | null, sectionKey: string, field: string): boolean {
  return section(raw, sectionKey)?.[field] !== undefined
}

function tierLimitPresent(raw: Record<string, unknown> | null, engineTier: string): boolean {
  const tiers = section(section(raw, 'licensing'), 'tiers')
  const tier  = tiers && typeof tiers[engineTier] === 'object' ? tiers[engineTier] as Record<string, unknown> : null
  return tier?.registrationLimit !== undefined
}

function tierPricePresent(raw: Record<string, unknown> | null, engineTier: string): boolean {
  const tiers   = section(section(raw, 'licensing'), 'tiers')
  const tier    = tiers && typeof tiers[engineTier] === 'object' ? tiers[engineTier] as Record<string, unknown> : null
  const pricing = tier && typeof tier.pricing === 'object' ? tier.pricing as Record<string, unknown> : null
  return pricing?.offerPrice !== undefined
}

// The platform fee was renamed platformFeePercent → platformFeeAmount (01B.1); a
// legacy doc counts as an explicit global for the trace either way.
function platformFeePresent(raw: Record<string, unknown> | null): boolean {
  const p = section(raw, 'pricing')
  return p?.platformFeeAmount !== undefined || p?.platformFeePercent !== undefined
}

// ─── Helpers ───────────────────────────────────────────────────────────────────────

function readTier(event: PricingEventView): EventLicenseTier {
  const t = event.license?.tier
  return isEventLicenseTier(t) ? t : 'starter'
}

/** Flag-OFF baseline: production values, overrides+global ignored, all 'default'. */
async function dormantConfiguration(tier: EventLicenseTier): Promise<EffectivePlatformConfiguration> {
  const cat = (await getLicenseCatalog())[tier]
  const d   = cloneDefaultPlatformSettings()
  const D: ConfigurationSource = 'default'
  return {
    registrationLimit:    { value: cat.limits.maxRegistrations, source: D },
    platformFeePaise:     { value: rupeesToPaise(d.pricing.platformFeeAmount), source: D },
    platformGstPercent:   { value: d.pricing.platformGstPercent, source: D },
    gatewayPercent:       { value: d.gateway.gatewayPercent, source: D },
    gatewayGstPercent:    { value: d.gateway.gatewayGstPercent, source: D },
    convenienceFeePaise:  { value: rupeesToPaise(d.gateway.convenienceFee), source: D },
    license: {
      tier,
      maxRegistrations:  { value: cat.limits.maxRegistrations, source: D },
      licensePricePaise: { value: cat.licensePricePaise, source: D },
    },
    pricingEngineEnabled: false,
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────────

/**
 * Resolve the COMPLETE effective configuration for an event, every field traced to
 * its source. This is the one merge point — all the field helpers below derive from
 * it, so business modules never merge configuration themselves.
 */
export async function resolveEffectivePlatformConfiguration(
  event: PricingEventView,
): Promise<EffectivePlatformConfiguration> {
  const settings = await resolvePlatformPricing()
  const tier     = readTier(event)

  if (!settings.features.pricingEngineEnabled) return dormantConfiguration(tier)

  const raw        = await getStoredPlatformSettingsRaw()
  const defaults   = cloneDefaultPlatformSettings()
  const admin      = event.adminOverride     ?? undefined
  const organizer  = event.organizerOverride ?? undefined
  const engineTier = mapProductionTierToEngine(tier)

  const globalTier  = resolveTierForProductionLicense(settings, tier)
  const defaultTier = defaults.licensing.tiers[engineTier]

  // registration limit — effective cap (admin → organizer → global → default).
  const registrationLimit = prodLimit(pick<RegistrationLimit>(
    admin?.registrationLimit, organizer?.registrationLimit,
    globalTier.registrationLimit, tierLimitPresent(raw, engineTier), defaultTier.registrationLimit,
  ))

  // platform fee / gst — organizer may NOT override (undefined at that level).
  const platformFeePaise = paise(pick<number>(
    admin?.platformFeeAmount, undefined,
    settings.pricing.platformFeeAmount, platformFeePresent(raw), defaults.pricing.platformFeeAmount,
  ))
  const platformGstPercent = pick<number>(
    admin?.platformGstPercent, undefined,
    settings.pricing.platformGstPercent, fieldPresent(raw, 'pricing', 'platformGstPercent'), defaults.pricing.platformGstPercent,
  )

  // gateway — organizer may NOT override percent/gst; MAY override convenience fee.
  const gatewayPercent = pick<number>(
    admin?.gatewayPercent, undefined,
    settings.gateway.gatewayPercent, fieldPresent(raw, 'gateway', 'gatewayPercent'), defaults.gateway.gatewayPercent,
  )
  const gatewayGstPercent = pick<number>(
    admin?.gatewayGstPercent, undefined,
    settings.gateway.gatewayGstPercent, fieldPresent(raw, 'gateway', 'gatewayGstPercent'), defaults.gateway.gatewayGstPercent,
  )
  const convenienceFeePaise = paise(pick<number>(
    admin?.convenienceFee, organizer?.convenienceFee,
    settings.gateway.convenienceFee, fieldPresent(raw, 'gateway', 'convenienceFee'), defaults.gateway.convenienceFee,
  ))

  // license — the licensed ceiling (NO organizer downward override applied).
  const license: EffectiveLicense = {
    tier,
    maxRegistrations: prodLimit(pick<RegistrationLimit>(
      undefined, undefined, globalTier.registrationLimit, tierLimitPresent(raw, engineTier), defaultTier.registrationLimit,
    )),
    licensePricePaise: paise(pick<number>(
      undefined, undefined, globalTier.pricing.offerPrice, tierPricePresent(raw, engineTier), defaultTier.pricing.offerPrice,
    )),
  }

  return {
    registrationLimit,
    platformFeePaise,
    platformGstPercent,
    gatewayPercent,
    gatewayGstPercent,
    convenienceFeePaise,
    license,
    pricingEngineEnabled: true,
  }
}

/**
 * Effective registration limit for an event, PRODUCTION shape (Infinity = unlimited).
 * Drop-in for the former tier→limit lookup; now honors the full override hierarchy.
 */
export async function resolveEffectiveRegistrationLimit(event: PricingEventView): Promise<number> {
  return (await resolveEffectivePlatformConfiguration(event)).registrationLimit.value
}

/** Effective platform fee (PAISE) + GST for an event. */
export async function resolveEffectivePlatformFee(event: PricingEventView): Promise<EffectivePlatformFee> {
  const c = await resolveEffectivePlatformConfiguration(event)
  return { platformFeePaise: c.platformFeePaise.value, platformGstPercent: c.platformGstPercent.value }
}

/** Effective gateway charges for an event (convenience fee in PAISE). */
export async function resolveEffectiveGatewayCharges(event: PricingEventView): Promise<EffectiveGatewayCharges> {
  const c = await resolveEffectivePlatformConfiguration(event)
  return {
    gatewayPercent:      c.gatewayPercent.value,
    gatewayGstPercent:   c.gatewayGstPercent.value,
    convenienceFeePaise: c.convenienceFeePaise.value,
  }
}

/** Effective license (licensed ceiling) for an event. */
export async function resolveEffectiveLicense(event: PricingEventView): Promise<EffectiveLicense> {
  return (await resolveEffectivePlatformConfiguration(event)).license
}
