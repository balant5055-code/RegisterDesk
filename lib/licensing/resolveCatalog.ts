// Server-only. Resolves the EFFECTIVE Event License catalog: the frozen code
// defaults in eventLicense.ts overlaid with any per-tier overrides from the
// Business Configuration Engine (licensing.tierOverrides). This is THE single
// runtime source for license definitions after RD-CONF-03.
//
// Resolution (per the config engine): runtime override → Firestore config →
// eventLicense.ts default. With NO stored config the override map is empty, so
// this returns the eventLicense.ts defaults byte-for-byte.

import { businessConfig } from '@/lib/config/businessConfigService'
import type { LicenseTierOverride, LicenseTierOverrideV2 } from '@/lib/config/businessConfig'
import {
  EVENT_LICENSE_TIERS,
  EVENT_LICENSE_TIERS_V2,
  LICENSE_VERSION_V2,
  CURRENT_LICENSE_VERSION,
  defaultLicenseTierForVersion,
  getEventLicenseDefinition,
  getEventLicenseDefinitionV2,
  isEventLicenseTier,
  isEventLicenseTierV2,
  UNLIMITED,
  type EventLicenseTier,
  type EventLicenseTierV2,
  type EventLicenseDefinition,
  type EventLicenseDefinitionV2,
  type VersionedLicenseDefinition,
  type LicenseVersion,
} from './eventLicense'

export type LicenseCatalog = Record<EventLicenseTier, EventLicenseDefinition>
export type LicenseCatalogV2 = Record<EventLicenseTierV2, EventLicenseDefinitionV2>

// A configured limit of `null` means "unlimited" (Firestore can't store Infinity);
// `undefined` means "inherit the default"; a number passes through.
const resolveLimit = (v: number | null | undefined, fallback: number): number =>
  v === undefined ? fallback : v === null ? UNLIMITED : v

/** Apply a per-tier override delta onto the code-default definition. Pure. */
export function applyLicenseOverride(base: EventLicenseDefinition, o?: LicenseTierOverride): EventLicenseDefinition {
  if (!o) return base
  return {
    ...base,
    name:                   o.name ?? base.name,
    licensePricePaise:      o.licensePricePaise ?? base.licensePricePaise,
    transactionFeePercent:  o.transactionFeePercent ?? base.transactionFeePercent,
    transactionFeeCapPaise: o.transactionFeeCapPaise ?? base.transactionFeeCapPaise,
    limits: {
      maxRegistrations:       resolveLimit(o.maxRegistrations,       base.limits.maxRegistrations),
      maxTeamMembers:         resolveLimit(o.maxTeamMembers,         base.limits.maxTeamMembers),
      maxBroadcastRecipients: resolveLimit(o.maxBroadcastRecipients, base.limits.maxBroadcastRecipients),
    },
    features:    { ...base.features, ...(o.features ?? {}) },
    featureList: o.featureList ?? base.featureList,
  }
}

/** The effective catalog for all tiers (config overrides merged onto defaults). */
export async function getLicenseCatalog(): Promise<LicenseCatalog> {
  const licensing = await businessConfig.getSection('licensing')
  const overrides = licensing.tierOverrides ?? {}
  const out = {} as LicenseCatalog
  for (const tier of EVENT_LICENSE_TIERS) {
    out[tier] = applyLicenseOverride(getEventLicenseDefinition(tier), overrides[tier])
  }
  return out
}

/** The effective definition for a single tier. */
export async function getEffectiveLicenseDefinition(tier: EventLicenseTier): Promise<EventLicenseDefinition> {
  const licensing = await businessConfig.getSection('licensing')
  return applyLicenseOverride(getEventLicenseDefinition(tier), (licensing.tierOverrides ?? {})[tier])
}

/** Tiers that are self-serve purchasable under the effective catalog (paid + not
 *  contact-sales). Derived, so it tracks price overrides automatically. */
export async function getEffectivePurchasableTiers(): Promise<EventLicenseTier[]> {
  const catalog = await getLicenseCatalog()
  return EVENT_LICENSE_TIERS.filter(t => !catalog[t].contactSales && catalog[t].licensePricePaise > 0)
}

/**
 * The registration cap assumed for a FREE event's fill / "nearly full" surfaces — the
 * CURRENT version's free tier `maxRegistrations` (config-resolved): V1 Starter (100) today,
 * V2 Free (200) after the cutover. NOT a hardcoded literal. Returns null when the free tier
 * is unlimited. Single source of truth for the free-event capacity heuristic across routes.
 */
export async function getFreeEventCapacity(): Promise<number | null> {
  const freeTier = defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION)
  const def = await getEffectiveDefinitionForVersion(freeTier, CURRENT_LICENSE_VERSION)
  const cap = def?.limits.maxRegistrations ?? UNLIMITED
  return Number.isFinite(cap) ? cap : null
}

// ─── RD-LICENSE-01B — V2 catalog resolution (additive, no cutover) ──────────────────
//
// The V2 catalog resolves EXACTLY like V1 (code defaults + config overrides), but off the
// V2 definitions table and the OPTIONAL `licensing.tierOverridesV2` layer. V1 resolution
// above is untouched. Nothing consumes these yet; CURRENT_LICENSE_VERSION stays 1.

/** Apply a per-tier V2 override delta onto a V2 code-default definition. Pure.
 *  Keeps `licensePricePaise` (the charged amount) in sync with the effective offer price. */
export function applyLicenseOverrideV2(base: EventLicenseDefinitionV2, o?: LicenseTierOverrideV2): EventLicenseDefinitionV2 {
  if (!o) return base
  const offer = o.offerPricePaise ?? o.licensePricePaise ?? base.offerPricePaise
  return {
    ...base,
    name:                   o.name ?? base.name,
    regularPricePaise:      o.regularPricePaise ?? base.regularPricePaise,
    offerPricePaise:        offer,
    licensePricePaise:      offer,   // charged price tracks the offer price
    transactionFeePercent:  o.transactionFeePercent ?? base.transactionFeePercent,
    transactionFeeCapPaise: o.transactionFeeCapPaise ?? base.transactionFeeCapPaise,
    limits: {
      maxRegistrations:       resolveLimit(o.maxRegistrations,       base.limits.maxRegistrations),
      maxTeamMembers:         resolveLimit(o.maxTeamMembers,         base.limits.maxTeamMembers),
      maxBroadcastRecipients: resolveLimit(o.maxBroadcastRecipients, base.limits.maxBroadcastRecipients),
    },
    features:    { ...base.features, ...(o.features ?? {}) },
    featureList: o.featureList ?? base.featureList,
  }
}

/** The effective V2 catalog (V2 code defaults + `tierOverridesV2` overrides). */
export async function getLicenseCatalogV2(): Promise<LicenseCatalogV2> {
  const licensing = await businessConfig.getSection('licensing')
  const overrides = licensing.tierOverridesV2 ?? {}
  const out = {} as LicenseCatalogV2
  for (const tier of EVENT_LICENSE_TIERS_V2) {
    out[tier] = applyLicenseOverrideV2(getEventLicenseDefinitionV2(tier), overrides[tier])
  }
  return out
}

/** The effective V2 definition for a single tier. */
export async function getEffectiveLicenseDefinitionV2(tier: EventLicenseTierV2): Promise<EventLicenseDefinitionV2> {
  const licensing = await businessConfig.getSection('licensing')
  return applyLicenseOverrideV2(getEventLicenseDefinitionV2(tier), (licensing.tierOverridesV2 ?? {})[tier])
}

/**
 * Version-aware effective resolution (config-overlaid), driven ONLY by `version`:
 *   version 1   → V1 effective catalog · version ≥ 2 → V2 effective catalog.
 * Returns null when `tier` is not valid for that version. This is the single accessor a
 * future consumer uses to resolve a STORED license by its stamped version.
 */
export async function getEffectiveDefinitionForVersion(
  tier: string,
  version: LicenseVersion,
): Promise<VersionedLicenseDefinition | null> {
  if (version >= LICENSE_VERSION_V2) {
    if (!isEventLicenseTierV2(tier)) return null
    return { version: LICENSE_VERSION_V2, ...(await getEffectiveLicenseDefinitionV2(tier)) }
  }
  if (!isEventLicenseTier(tier)) return null
  return { version: 1, ...(await getEffectiveLicenseDefinition(tier)) }
}
