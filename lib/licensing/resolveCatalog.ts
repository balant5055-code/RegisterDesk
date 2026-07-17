// Server-only. Resolves the EFFECTIVE Event License catalog: the frozen code
// defaults in eventLicense.ts overlaid with any per-tier overrides from the
// Business Configuration Engine (licensing.tierOverrides). This is THE single
// runtime source for license definitions after RD-CONF-03.
//
// Resolution (per the config engine): runtime override → Firestore config →
// eventLicense.ts default. With NO stored config the override map is empty, so
// this returns the eventLicense.ts defaults byte-for-byte.

import { businessConfig } from '@/lib/config/businessConfigService'
import type { LicenseTierOverride } from '@/lib/config/businessConfig'
import {
  EVENT_LICENSE_TIERS,
  getEventLicenseDefinition,
  UNLIMITED,
  type EventLicenseTier,
  type EventLicenseDefinition,
} from './eventLicense'

export type LicenseCatalog = Record<EventLicenseTier, EventLicenseDefinition>

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
 * The registration cap assumed for a FREE event's fill / "nearly full" surfaces —
 * i.e. the effective Starter tier's `maxRegistrations` (config-resolved), NOT a
 * hardcoded literal. Returns null when Starter is configured unlimited (no cap).
 * Single source of truth for the free-event capacity heuristic across routes.
 */
export async function getFreeEventCapacity(): Promise<number | null> {
  const cap = (await getLicenseCatalog()).starter.limits.maxRegistrations
  return Number.isFinite(cap) ? cap : null
}
