// Effective per-event license resolution (RD-LIC-ADMIN-01) — PURE, client-safe.
//
// Overlays the admin console's per-event overrides (lifecycle / complimentary /
// price / limits / features) onto the config-effective tier definition. This is
// the single place that combines the three layers:
//
//   code default (eventLicense.ts) → config tierOverride (resolveCatalog)
//                                   → per-event admin overlay (this module)
//
// It performs NO I/O. Server callers pass the config-effective definition (from
// getLicenseCatalog / getEffectiveLicenseDefinition) as `base`.

import {
  UNLIMITED,
  type EventLicenseDefinition,
  type EventLicenseStatus,
  type EventLicenseLimitKey,
  type EventLicenseFeature,
} from './eventLicense'
import type { EventLicenseAdminOverlay, LicenseAdminLifecycle } from './schema'

export interface EffectiveEventLicense {
  lifecycle:            LicenseAdminLifecycle   // admin overlay lifecycle (default 'active')
  effectiveActive:      boolean                 // base status 'active' AND lifecycle 'active'
  complimentary:        boolean
  effectivePricePaise:  number                  // admin price override, else the paid amount
  definition:           EventLicenseDefinition  // tier definition with per-event overrides applied
}

// A stored limit override of `null` means "unlimited"; `undefined` inherits.
const resolveLimit = (v: number | null | undefined, fallback: number): number =>
  v === undefined ? fallback : v === null ? UNLIMITED : v

/**
 * Apply an event's admin overlay onto the (config-effective) tier definition and
 * the stored license status/amount. Absent overlay ⇒ identity (byte-for-byte the
 * pre-admin behaviour), so nothing changes for licenses that were never touched.
 */
export function resolveEffectiveEventLicense(
  base:            EventLicenseDefinition,
  baseStatus:      EventLicenseStatus,
  baseAmountPaise: number,
  overlay:         EventLicenseAdminOverlay | undefined,
): EffectiveEventLicense {
  if (!overlay) {
    return {
      lifecycle:           'active',
      effectiveActive:     baseStatus === 'active',
      complimentary:       false,
      effectivePricePaise: baseAmountPaise,
      definition:          base,
    }
  }

  const limitOverrides   = overlay.limitOverrides   ?? {}
  const featureOverrides = overlay.featureOverrides ?? {}

  const definition: EventLicenseDefinition = {
    ...base,
    licensePricePaise: overlay.pricePaiseOverride ?? base.licensePricePaise,
    limits: {
      maxRegistrations:       resolveLimit(limitOverrides.maxRegistrations,       base.limits.maxRegistrations),
      maxTeamMembers:         resolveLimit(limitOverrides.maxTeamMembers,         base.limits.maxTeamMembers),
      maxBroadcastRecipients: resolveLimit(limitOverrides.maxBroadcastRecipients, base.limits.maxBroadcastRecipients),
    },
    features: { ...base.features, ...featureOverrides },
  }

  return {
    lifecycle:           overlay.lifecycle,
    effectiveActive:     baseStatus === 'active' && overlay.lifecycle === 'active',
    complimentary:       overlay.complimentary === true,
    effectivePricePaise: overlay.pricePaiseOverride ?? baseAmountPaise,
    definition,
  }
}

// The keys an admin may override, for input validation.
export const OVERRIDABLE_LIMIT_KEYS: EventLicenseLimitKey[] =
  ['maxRegistrations', 'maxTeamMembers', 'maxBroadcastRecipients']

export const OVERRIDABLE_FEATURE_KEYS: EventLicenseFeature[] =
  ['offlineCheckin', 'teamAccess', 'apiAccess', 'whiteLabel', 'customDomain', 'advancedReports', 'prioritySupport']
