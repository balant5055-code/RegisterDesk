// Pure client-safe helpers for the EFFECTIVE Event License catalog: the catalog
// type, the code-default catalog, and revive logic (API `null` limit → Infinity).
// No hooks, no fetch — so both the shared BusinessConfigProvider and the
// useLicenseCatalog hook can use these without an import cycle.

import {
  EVENT_LICENSE_TIERS,
  getEventLicenseDefinition,
  UNLIMITED,
  type EventLicenseTier,
  type EventLicenseDefinition,
} from './eventLicense'

export type LicenseCatalog = Record<EventLicenseTier, EventLicenseDefinition>

/** Code-default catalog — synchronous, always available. */
export function defaultLicenseCatalog(): LicenseCatalog {
  const out = {} as LicenseCatalog
  for (const t of EVENT_LICENSE_TIERS) out[t] = getEventLicenseDefinition(t)
  return out
}

type EventLicenseFeatureKey = keyof EventLicenseDefinition['features']

// Limits arrive from the API as number | null (null = unlimited).
const reviveLimit = (v: unknown, fallback: number): number =>
  v === null ? UNLIMITED : (typeof v === 'number' ? v : fallback)

function reviveDefinition(tier: EventLicenseTier, raw: unknown): EventLicenseDefinition {
  const base = getEventLicenseDefinition(tier)
  if (typeof raw !== 'object' || raw === null) return base
  const r   = raw as Record<string, unknown>
  const lim = (r.limits && typeof r.limits === 'object' ? r.limits : {}) as Record<string, unknown>
  return {
    ...base,
    name:                   typeof r.name === 'string' ? r.name : base.name,
    licensePricePaise:      typeof r.licensePricePaise === 'number' ? r.licensePricePaise : base.licensePricePaise,
    contactSales:           typeof r.contactSales === 'boolean' ? r.contactSales : base.contactSales,
    transactionFeePercent:  typeof r.transactionFeePercent === 'number' ? r.transactionFeePercent : base.transactionFeePercent,
    transactionFeeCapPaise: typeof r.transactionFeeCapPaise === 'number' ? r.transactionFeeCapPaise : base.transactionFeeCapPaise,
    limits: {
      maxRegistrations:       reviveLimit(lim.maxRegistrations,       base.limits.maxRegistrations),
      maxTeamMembers:         reviveLimit(lim.maxTeamMembers,         base.limits.maxTeamMembers),
      maxBroadcastRecipients: reviveLimit(lim.maxBroadcastRecipients, base.limits.maxBroadcastRecipients),
    },
    features:    { ...base.features, ...(r.features && typeof r.features === 'object' && !Array.isArray(r.features) ? r.features as Record<EventLicenseFeatureKey, boolean> : {}) },
    featureList: Array.isArray(r.featureList) && r.featureList.every(s => typeof s === 'string') ? r.featureList as string[] : base.featureList,
  }
}

/** Rebuild a full catalog from the API payload, falling back per-tier to defaults. */
export function reviveCatalog(rawCatalog: unknown): LicenseCatalog {
  const out = defaultLicenseCatalog()
  if (rawCatalog && typeof rawCatalog === 'object') {
    for (const t of EVENT_LICENSE_TIERS) out[t] = reviveDefinition(t, (rawCatalog as Record<string, unknown>)[t])
  }
  return out
}
