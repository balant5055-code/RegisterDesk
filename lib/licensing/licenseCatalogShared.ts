// Pure client-safe helpers for the EFFECTIVE Event License catalog: the catalog
// type, the code-default catalog, and revive logic (API `null` limit → Infinity).
// No hooks, no fetch — so both the shared BusinessConfigProvider and the
// useLicenseCatalog hook can use these without an import cycle.

import {
  EVENT_LICENSE_TIERS,
  EVENT_LICENSE_TIERS_V2,
  PURCHASABLE_LICENSE_TIERS,
  PURCHASABLE_LICENSE_TIERS_V2,
  LICENSE_VERSION_V2,
  getEventLicenseDefinition,
  getEventLicenseDefinitionV2,
  isEventLicenseTier,
  isEventLicenseTierV2,
  nextEventLicenseTier,
  nextEventLicenseTierV2,
  UNLIMITED,
  type EventLicenseTier,
  type EventLicenseTierV2,
  type AnyEventLicenseTier,
  type EventLicenseDefinition,
  type EventLicenseDefinitionV2,
  type EventLicenseFeature,
  type LicenseVersion,
} from './eventLicense'

export type LicenseCatalog = Record<EventLicenseTier, EventLicenseDefinition>
export type LicenseCatalogV2 = Record<EventLicenseTierV2, EventLicenseDefinitionV2>

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

// ─── RD-LICENSE-01B Phase 3A — V2 catalog (client-safe, additive) ───────────────────
//
// The V2 catalog + its revive, plus a normalized VIEW that carries everything a consumer
// needs to render a tier (version, registrationLimit, regular/offer/charged price,
// features, purchasable, display order). These are ADDITIVE — the V1 helpers above are
// unchanged, and no consumer reads these yet (Phase 3B/3C wire the UI).

/** Code-default V2 catalog — synchronous, always available. */
export function defaultLicenseCatalogV2(): LicenseCatalogV2 {
  const out = {} as LicenseCatalogV2
  for (const t of EVENT_LICENSE_TIERS_V2) out[t] = getEventLicenseDefinitionV2(t)
  return out
}

type EventLicenseFeatureKeyV2 = keyof EventLicenseDefinitionV2['features']

function reviveDefinitionV2(tier: EventLicenseTierV2, raw: unknown): EventLicenseDefinitionV2 {
  const base = getEventLicenseDefinitionV2(tier)
  if (typeof raw !== 'object' || raw === null) return base
  const r   = raw as Record<string, unknown>
  const lim = (r.limits && typeof r.limits === 'object' ? r.limits : {}) as Record<string, unknown>
  const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb)
  return {
    ...base,
    name:                   typeof r.name === 'string' ? r.name : base.name,
    licensePricePaise:      num(r.licensePricePaise, base.licensePricePaise),
    regularPricePaise:      num(r.regularPricePaise, base.regularPricePaise),
    offerPricePaise:        num(r.offerPricePaise,   base.offerPricePaise),
    contactSales:           typeof r.contactSales === 'boolean' ? r.contactSales : base.contactSales,
    transactionFeePercent:  num(r.transactionFeePercent,  base.transactionFeePercent),
    transactionFeeCapPaise: num(r.transactionFeeCapPaise, base.transactionFeeCapPaise),
    limits: {
      maxRegistrations:       reviveLimit(lim.maxRegistrations,       base.limits.maxRegistrations),
      maxTeamMembers:         reviveLimit(lim.maxTeamMembers,         base.limits.maxTeamMembers),
      maxBroadcastRecipients: reviveLimit(lim.maxBroadcastRecipients, base.limits.maxBroadcastRecipients),
    },
    features:    { ...base.features, ...(r.features && typeof r.features === 'object' && !Array.isArray(r.features) ? r.features as Record<EventLicenseFeatureKeyV2, boolean> : {}) },
    featureList: Array.isArray(r.featureList) && r.featureList.every(s => typeof s === 'string') ? r.featureList as string[] : base.featureList,
  }
}

/** Rebuild the full V2 catalog from the API payload, per-tier falling back to defaults. */
export function reviveCatalogV2(rawCatalog: unknown): LicenseCatalogV2 {
  const out = defaultLicenseCatalogV2()
  if (rawCatalog && typeof rawCatalog === 'object') {
    for (const t of EVENT_LICENSE_TIERS_V2) out[t] = reviveDefinitionV2(t, (rawCatalog as Record<string, unknown>)[t])
  }
  return out
}

/** A normalized, display-ready catalog entry — the shape a tier card/row consumes. */
export interface LicenseCatalogEntryView {
  version:                LicenseVersion
  tier:                   AnyEventLicenseTier   // V1 or V2 tier id, depending on the view's version
  name:                   string
  registrationLimit:      number   // Infinity = unlimited (render via isUnlimited)
  regularPricePaise:      number
  offerPricePaise:        number
  licensePricePaise:      number   // charged price (=== offerPricePaise)
  contactSales:           boolean
  transactionFeePercent:  number
  features:               Record<EventLicenseFeature, boolean>
  featureList:            string[]
  purchasable:            boolean
  order:                  number
}

// ─── RD-LICENSE-01B Phase 3C — version-aware DISPLAY resolver (owned licenses) ──────
//
// Organizer/admin screens display OWNED licenses, each stamped with the schema `version`
// it was issued under (all V1 today; V2 after cutover). This resolves a license's display
// fields driven ONLY by its stored version — a V1 tier (e.g. 'growth') against the V1
// catalog, a V2 tier against the V2 catalog — so historical licenses NEVER crash against
// a catalog that lacks their tier. Pure; needs both catalogs (from the provider).

/** Normalized display fields for ONE owned license, resolved by its stored version. */
export interface LicenseDisplayEntry {
  version:           LicenseVersion
  tier:              string
  name:              string
  registrationLimit: number   // Infinity = unlimited
  licensePricePaise: number   // charged price
  regularPricePaise: number   // === licensePricePaise on V1 (no discount)
  offerPricePaise:   number
  nextTier:          string | null   // next tier id (same version) for upgrade CTAs
  nextTierName:      string | null
}

/**
 * The FULL version-appropriate tier definition for a stored license, for callers that feed
 * it to `resolveEffectiveEventLicense` (the admin overlay). Returns the V1 def for a version-1
 * license and the V2 def (which also carries regular/offer) for a version-2 license; a safe
 * V1 Starter fallback for a tier invalid for its version. The `tier` FIELD on the returned
 * object may be a V2 id — callers must display the resolved tier id separately, not `def.tier`.
 */
export function pickVersionedDefinition(
  v1: LicenseCatalog, v2: LicenseCatalogV2, tier: string, version: LicenseVersion,
): EventLicenseDefinition {
  if (version >= LICENSE_VERSION_V2 && isEventLicenseTierV2(tier)) return v2[tier] as unknown as EventLicenseDefinition
  if (version < LICENSE_VERSION_V2 && isEventLicenseTier(tier)) return v1[tier]
  return v1.starter
}

/**
 * Resolve an owned license's display entry, driven ONLY by `version`. Falls back to the
 * V1 Starter entry only when the tier is invalid for its version (corrupt/legacy data) —
 * it never silently resolves against the wrong version's catalog.
 */
export function resolveLicenseEntryForVersion(
  v1: LicenseCatalog, v2: LicenseCatalogV2, tier: string, version: LicenseVersion,
): LicenseDisplayEntry {
  if (version >= LICENSE_VERSION_V2 && isEventLicenseTierV2(tier)) {
    const d = v2[tier]
    const next = nextEventLicenseTierV2(tier)
    return {
      version, tier, name: d.name, registrationLimit: d.limits.maxRegistrations,
      licensePricePaise: d.licensePricePaise, regularPricePaise: d.regularPricePaise, offerPricePaise: d.offerPricePaise,
      nextTier: next, nextTierName: next ? v2[next].name : null,
    }
  }
  if (version < LICENSE_VERSION_V2 && isEventLicenseTier(tier)) {
    const d = v1[tier]
    const next = nextEventLicenseTier(tier)
    return {
      version: 1, tier, name: d.name, registrationLimit: d.limits.maxRegistrations,
      licensePricePaise: d.licensePricePaise, regularPricePaise: d.licensePricePaise, offerPricePaise: d.licensePricePaise,
      nextTier: next, nextTierName: next ? v1[next].name : null,
    }
  }
  const d = v1.starter
  return {
    version: 1, tier: 'starter', name: d.name, registrationLimit: d.limits.maxRegistrations,
    licensePricePaise: d.licensePricePaise, regularPricePaise: d.licensePricePaise, offerPricePaise: d.licensePricePaise,
    nextTier: null, nextTierName: null,
  }
}

/**
 * Build the ordered, display-ready view of a V2 catalog — one entry per tier in catalog
 * order, each carrying version, limit, regular/offer/charged price, features, whether it
 * is self-serve purchasable, and its display order. Pure; this is what Phase 3B renders.
 */
/**
 * RD-LICENSE-GA-03 — the CURRENT-version catalog view, for WRITE-COUPLED surfaces (the
 * event-builder license selector, admin grant/upgrade dialogs). It returns the view for
 * `currentVersion` so the tiers offered ALWAYS match the version the write layer validates
 * against: V1 today (starter/growth/professional/enterprise, regular===offer, no discount),
 * V2 after the Wave-4 cutover (free/starter/professional/business/enterprise with the
 * regular/offer split). Never renders V2 tiers while writes are V1 (which would break
 * purchases). Pure.
 */
export function buildCurrentLicenseCatalogView(
  v1: LicenseCatalog, v2: LicenseCatalogV2, currentVersion: LicenseVersion,
): LicenseCatalogEntryView[] {
  if (currentVersion >= LICENSE_VERSION_V2) return buildLicenseCatalogView(v2)
  const purchasable = new Set<string>(PURCHASABLE_LICENSE_TIERS as readonly string[])
  return EVENT_LICENSE_TIERS.map((tier, order) => {
    const d = v1[tier]
    return {
      version:               1 as LicenseVersion,
      tier,
      name:                  d.name,
      registrationLimit:     d.limits.maxRegistrations,
      regularPricePaise:     d.licensePricePaise,   // V1 has no discount → regular === offer
      offerPricePaise:       d.licensePricePaise,
      licensePricePaise:     d.licensePricePaise,
      contactSales:          d.contactSales,
      transactionFeePercent: d.transactionFeePercent,
      features:              d.features,
      featureList:           d.featureList,
      purchasable:           purchasable.has(tier),
      order,
    }
  })
}

export function buildLicenseCatalogView(catalog: LicenseCatalogV2): LicenseCatalogEntryView[] {
  return EVENT_LICENSE_TIERS_V2.map((tier, order) => {
    const d = catalog[tier]
    return {
      version:               LICENSE_VERSION_V2,
      tier,
      name:                  d.name,
      registrationLimit:     d.limits.maxRegistrations,
      regularPricePaise:     d.regularPricePaise,
      offerPricePaise:       d.offerPricePaise,
      licensePricePaise:     d.licensePricePaise,
      contactSales:          d.contactSales,
      transactionFeePercent: d.transactionFeePercent,
      features:              d.features,
      featureList:           d.featureList,
      purchasable:           (PURCHASABLE_LICENSE_TIERS_V2 as EventLicenseTierV2[]).includes(tier),
      order,
    }
  })
}
