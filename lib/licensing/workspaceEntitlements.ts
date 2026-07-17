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
import { getEffectiveLicenseDefinition } from './resolveCatalog'
import {
  EVENT_LICENSE_TIERS,
  DEFAULT_EVENT_LICENSE_TIER,
  isEventLicenseTier,
  isUnlimited,
  type EventLicenseTier,
  type EventLicenseFeature,
  type EventLicenseLimitKey,
  type EventLicenseDefinition,
} from './eventLicense'

export type WorkspaceEntitlementSource = 'event_license' | 'admin_override' | 'fallback'

export interface WorkspaceEntitlements {
  uid:              string
  effectiveTier:    EventLicenseTier
  source:           WorkspaceEntitlementSource
  definition:       EventLicenseDefinition
  features:         Record<EventLicenseFeature, boolean>
  limits:           Record<EventLicenseLimitKey, number>
  activeEventCount: number                 // # active licensed events feeding this result
}

const tierRank = (t: EventLicenseTier): number => EVENT_LICENSE_TIERS.indexOf(t)

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
 * Highest ACTIVE event-license tier across the organizer's events, plus the count
 * of active licensed events. Reads eventLicenses where organizerUid == uid and
 * filters status === 'active' in memory (single-field index only — no composite).
 */
async function readHighestActiveLicense(uid: string): Promise<{ tier: EventLicenseTier | null; count: number }> {
  try {
    const qs = await adminDb.collection(EVENT_LICENSES_COLLECTION)
      .where('organizerUid', '==', uid)
      .limit(1000)
      .get()
    let highest: EventLicenseTier | null = null
    let count = 0
    for (const d of qs.docs) {
      const data = d.data() as { tier?: unknown; status?: unknown; admin?: { lifecycle?: unknown } }
      if (data.status !== 'active') continue
      // RD-LIC-ADMIN-01: an admin-suspended/cancelled license no longer feeds the
      // workspace's effective entitlements (applies immediately, no redeploy).
      if (data.admin?.lifecycle === 'suspended' || data.admin?.lifecycle === 'cancelled') continue
      if (!isEventLicenseTier(data.tier)) continue
      count++
      if (highest === null || tierRank(data.tier) > tierRank(highest)) highest = data.tier
    }
    return { tier: highest, count }
  } catch {
    return { tier: null, count: 0 }   // fail safe: most-restrictive
  }
}

/**
 * Resolve the workspace's effective entitlements. Effective tier = the higher of
 * the highest active event license and any admin override; falls back to the
 * most-restrictive tier (Starter) when the workspace has no active license.
 */
export async function getWorkspaceEntitlements(uid: string): Promise<WorkspaceEntitlements> {
  const [override, active] = await Promise.all([readAdminOverrideTier(uid), readHighestActiveLicense(uid)])

  let effectiveTier: EventLicenseTier
  let source: WorkspaceEntitlementSource
  if (override !== null && (active.tier === null || tierRank(override) >= tierRank(active.tier))) {
    effectiveTier = override
    source        = 'admin_override'
  } else if (active.tier !== null) {
    effectiveTier = active.tier
    source        = 'event_license'
  } else {
    effectiveTier = DEFAULT_EVENT_LICENSE_TIER
    source        = 'fallback'
  }

  const definition = await getEffectiveLicenseDefinition(effectiveTier)
  return {
    uid,
    effectiveTier,
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

export interface FeatureCheck { ok: boolean; status: number; error: string; tier: EventLicenseTier }

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

export interface LimitCheck { ok: boolean; status: number; error: string; limit: number; tier: EventLicenseTier }

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
