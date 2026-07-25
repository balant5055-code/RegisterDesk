// Workspace entitlements — server-only. THE single source of truth for
// "what can this organizer's workspace do?", derived entirely from the Event
// License model (lib/licensing/eventLicense.ts). This REPLACES the removed
// subscription entitlement engine (formerly lib/billing/entitlements.ts + plans.ts).
//
// An organizer's workspace entitlements come from their HIGHEST ACTIVE event
// license. An optional admin override tier (users/{uid}.entitlementOverrideTier)
// is a support/comp lever that can only RAISE the effective tier — never lower it.
//
// `uid` is always the WORKSPACE OWNER (the plan owner / organizerUid). Resolve it
// with resolveWorkspaceUid / authorizeWorkspace before calling these helpers.

import { adminDb } from '@/lib/firebase/admin'
import { EVENT_LICENSES_COLLECTION } from './schema'
import { getLicenseCatalog, getLicenseCatalogV2, type LicenseCatalog, type LicenseCatalogV2 } from './resolveCatalog'
import { pickVersionedDefinition } from './licenseCatalogShared'
import {
  DEFAULT_EVENT_LICENSE_TIER,
  isEventLicenseTier,
  isValidTierForVersion,
  isUnlimited,
  type EventLicenseTier,
  type AnyEventLicenseTier,
  type LicenseVersion,
  type EventLicenseFeature,
  type EventLicenseLimitKey,
  type EventLicenseDefinition,
} from './eventLicense'

export type WorkspaceEntitlementSource = 'event_license' | 'admin_override' | 'fallback'

export interface WorkspaceEntitlements {
  uid:              string
  effectiveTier:    AnyEventLicenseTier   // may be a V1 OR V2 tier (whichever the license is stamped with)
  effectiveVersion: LicenseVersion        // schema version of the effective license (drives fee/def resolution)
  source:           WorkspaceEntitlementSource
  definition:       EventLicenseDefinition
  features:         Record<EventLicenseFeature, boolean>
  limits:           Record<EventLicenseLimitKey, number>
  activeEventCount: number                 // # active licensed events feeding this result
}

/**
 * RD-LICENSE-GA-01 — cross-version "highest active license" rank. Ranks by resolved
 * registration LIMIT (unlimited = highest). This is the ONE ranking strategy for both
 * vocabularies: for a V1-only workspace it is byte-for-byte identical to the legacy
 * `EVENT_LICENSE_TIERS.indexOf` order, because V1 limits are strictly monotonic with tier
 * rank (starter 100 < growth 1,000 < professional 5,000 < enterprise ∞); for V2 it orders
 * Free 200 < Starter 1,000 < Professional 2,500 < Business 5,000 < Enterprise ∞. Ties
 * (only possible ACROSS versions, e.g. V1 growth 1,000 vs V2 starter 1,000) break by the
 * higher license price. Never infers from the tier name.
 */
function limitRank(def: EventLicenseDefinition): number {
  const m = def.limits.maxRegistrations
  return isUnlimited(m) ? Number.MAX_SAFE_INTEGER : m
}

/**
 * Admin comp/override tier. Stored at users/{uid}.entitlementOverrideTier; only a
 * valid EventLicenseTier is honoured. It can only RAISE the effective tier.
 */
async function readAdminOverrideTier(uid: string): Promise<EventLicenseTier | null> {
  try {
    const snap = await adminDb.doc(`users/${uid}`).get()
    const v = snap.exists ? (snap.data() as { entitlementOverrideTier?: unknown }).entitlementOverrideTier : undefined
    return isEventLicenseTier(v) ? v : null
  } catch {
    return null   // fail safe: no override
  }
}

/**
 * Highest ACTIVE event-license across the organizer's events (by resolved registration
 * limit — see limitRank), plus its stored `version` and the count of active licensed
 * events. Reads eventLicenses where organizerUid == uid and filters status === 'active'
 * in memory (single-field index only — no composite). RD-LICENSE-GA-01: version-aware —
 * a license is kept when its tier is valid FOR ITS STORED VERSION (V1 or V2), so a V2
 * license is NEVER silently dropped, and it is resolved against the correct catalog.
 */
async function readHighestActiveLicense(
  uid: string, v1: LicenseCatalog, v2: LicenseCatalogV2,
): Promise<{ tier: AnyEventLicenseTier | null; version: LicenseVersion; count: number }> {
  try {
    const qs = await adminDb.collection(EVENT_LICENSES_COLLECTION)
      .where('organizerUid', '==', uid)
      .limit(1000)
      .get()
    let best: { tier: AnyEventLicenseTier; version: LicenseVersion; limit: number; price: number } | null = null
    let count = 0
    for (const d of qs.docs) {
      const data = d.data() as { tier?: unknown; status?: unknown; version?: unknown; admin?: { lifecycle?: unknown } }
      if (data.status !== 'active') continue
      // RD-LIC-ADMIN-01: an admin-suspended/cancelled license no longer feeds the
      // workspace's effective entitlements (applies immediately, no redeploy).
      if (data.admin?.lifecycle === 'suspended' || data.admin?.lifecycle === 'cancelled') continue
      const version: LicenseVersion = typeof data.version === 'number' && data.version >= 1 ? data.version : 1
      if (!isValidTierForVersion(data.tier, version)) continue   // version-driven (was V1-only)
      count++
      const def   = pickVersionedDefinition(v1, v2, data.tier, version)
      const limit = limitRank(def)
      const price = def.licensePricePaise
      if (best === null || limit > best.limit || (limit === best.limit && price > best.price)) {
        best = { tier: data.tier, version, limit, price }
      }
    }
    return best ? { tier: best.tier, version: best.version, count } : { tier: null, version: 1, count }
  } catch {
    return { tier: null, version: 1, count: 0 }   // fail safe: most-restrictive
  }
}

/**
 * Resolve the workspace's effective entitlements. Effective license = the higher (by
 * registration limit) of the highest active event license and any admin override; falls
 * back to the most-restrictive tier (Starter) when the workspace has no active license.
 * Version-aware: the effective definition is resolved against the catalog for the effective
 * license's stored version, so V1 and V2 licenses both resolve correctly.
 */
export async function getWorkspaceEntitlements(uid: string): Promise<WorkspaceEntitlements> {
  const [v1, v2] = await Promise.all([getLicenseCatalog(), getLicenseCatalogV2()])
  const [override, active] = await Promise.all([readAdminOverrideTier(uid), readHighestActiveLicense(uid, v1, v2)])

  // The admin override tier is a V1 tier (users/{uid}.entitlementOverrideTier), version 1.
  const overrideDef = override !== null ? pickVersionedDefinition(v1, v2, override, 1) : null
  const activeDef   = active.tier !== null ? pickVersionedDefinition(v1, v2, active.tier, active.version) : null

  let effectiveTier:    AnyEventLicenseTier
  let effectiveVersion: LicenseVersion
  let source:           WorkspaceEntitlementSource
  if (override !== null && overrideDef !== null && (activeDef === null || limitRank(overrideDef) >= limitRank(activeDef))) {
    effectiveTier = override; effectiveVersion = 1; source = 'admin_override'
  } else if (active.tier !== null) {
    effectiveTier = active.tier; effectiveVersion = active.version; source = 'event_license'
  } else {
    effectiveTier = DEFAULT_EVENT_LICENSE_TIER; effectiveVersion = 1; source = 'fallback'
  }

  const definition = pickVersionedDefinition(v1, v2, effectiveTier, effectiveVersion)
  return {
    uid,
    effectiveTier,
    effectiveVersion,
    source,
    definition,
    features:         definition.features,
    limits:           definition.limits,
    activeEventCount: active.count,
  }
}

// ─── Gates ──────────────────────────────────────────────────────────────────────
//
// Drop-in replacements for the removed subscription primitives (requireFeature /
// requireLimit). Same result shape; the tier is now an EventLicenseTier.

export interface FeatureCheck { ok: boolean; status: number; error: string; tier: AnyEventLicenseTier }

/**
 * Gate a boolean feature. Returns 402 (Payment Required) when the workspace's
 * effective license lacks it — the single enforcement primitive for feature flags.
 */
export async function requireFeature(uid: string, feature: EventLicenseFeature): Promise<FeatureCheck> {
  const ent = await getWorkspaceEntitlements(uid)
  if (ent.features[feature]) return { ok: true, status: 200, error: '', tier: ent.effectiveTier }
  return {
    ok: false, status: 402, tier: ent.effectiveTier,
    error: `Your ${ent.definition.name} license does not include ${feature}. Upgrade your event license to unlock it.`,
  }
}

export interface LimitCheck { ok: boolean; status: number; error: string; limit: number; tier: AnyEventLicenseTier }

/**
 * Resolve a numeric limit, optionally checking a requested total against it.
 *   requireLimit(uid, 'maxBroadcastRecipients')        → { limit }
 *   requireLimit(uid, 'maxBroadcastRecipients', 12000) → { ok: 12000 <= limit }
 * Returns 402 when the requested amount exceeds the effective license's limit.
 */
export async function requireLimit(uid: string, type: EventLicenseLimitKey, requestedTotal?: number): Promise<LimitCheck> {
  const ent   = await getWorkspaceEntitlements(uid)
  const limit = ent.limits[type]
  if (requestedTotal === undefined || requestedTotal <= limit) {
    return { ok: true, status: 200, error: '', limit, tier: ent.effectiveTier }
  }
  const shown = isUnlimited(limit) ? 'unlimited' : limit.toLocaleString('en-IN')
  return {
    ok: false, status: 402, limit, tier: ent.effectiveTier,
    error: `Your ${ent.definition.name} license allows up to ${shown} for ${type}. Upgrade your event license for more.`,
  }
}
