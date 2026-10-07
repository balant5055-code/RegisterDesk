// RD-PRICING-01B — Platform Pricing Engine · service (SERVER-ONLY).
//
// Read/write the platformSettings/default singleton. The write path validates the
// FULL merged result before persisting and stamps metadata (version bump +
// updatedAt/updatedBy). Backs the admin API. NOTHING migrates existing data.

import { FieldValue } from 'firebase-admin/firestore'
import { resolvePlatformPricing, resolveStoredPlatformSettings, platformSettingsRef } from './resolver'
import { validatePlatformSettings } from './validation'
import {
  PRICING_TIER_IDS,
  type PlatformSettings,
  type PlatformSettingsPatch,
} from './types'

const deepClone = (s: PlatformSettings): PlatformSettings =>
  JSON.parse(JSON.stringify(s)) as PlatformSettings

/** The effective settings (Firestore overlaid on code defaults). */
export function getPlatformSettings(): Promise<PlatformSettings> {
  return resolvePlatformPricing()
}

/** Apply a deep-partial patch onto a settings object (pure; metadata untouched). */
function applyPatch(cur: PlatformSettings, patch: PlatformSettingsPatch): PlatformSettings {
  const next = deepClone(cur)

  if (patch.pricing) {
    if (patch.pricing.platformFeeAmount  !== undefined) next.pricing.platformFeeAmount  = patch.pricing.platformFeeAmount
    if (patch.pricing.platformGstPercent !== undefined) next.pricing.platformGstPercent = patch.pricing.platformGstPercent
  }
  if (patch.gateway) {
    if (patch.gateway.provider          !== undefined) next.gateway.provider          = patch.gateway.provider
    if (patch.gateway.gatewayPercent    !== undefined) next.gateway.gatewayPercent    = patch.gateway.gatewayPercent
    if (patch.gateway.gatewayGstPercent !== undefined) next.gateway.gatewayGstPercent = patch.gateway.gatewayGstPercent
    if (patch.gateway.convenienceFee    !== undefined) next.gateway.convenienceFee    = patch.gateway.convenienceFee
  }
  if (patch.commercial) {
    if (patch.commercial.platformFeePaidBy     !== undefined) next.commercial.platformFeePaidBy     = patch.commercial.platformFeePaidBy
    if (patch.commercial.gatewayFeePaidBy      !== undefined) next.commercial.gatewayFeePaidBy      = patch.commercial.gatewayFeePaidBy
    if (patch.commercial.convenienceFeeEnabled !== undefined) next.commercial.convenienceFeeEnabled = patch.commercial.convenienceFeeEnabled
    if (patch.commercial.gatewayGstEnabled     !== undefined) next.commercial.gatewayGstEnabled     = patch.commercial.gatewayGstEnabled
    if (patch.commercial.platformGstEnabled    !== undefined) next.commercial.platformGstEnabled    = patch.commercial.platformGstEnabled
  }
  if (patch.features) {
    if (patch.features.pricingEngineEnabled !== undefined) next.features.pricingEngineEnabled = patch.features.pricingEngineEnabled
  }
  if (patch.licensing?.tiers) {
    for (const id of PRICING_TIER_IDS) {
      const tp = patch.licensing.tiers[id]
      if (!tp) continue
      const t = next.licensing.tiers[id]
      if (tp.label             !== undefined) t.label             = tp.label
      if (tp.registrationLimit !== undefined) t.registrationLimit = tp.registrationLimit
      if (tp.pricing) {
        if (tp.pricing.regularPrice !== undefined) t.pricing.regularPrice = tp.pricing.regularPrice
        if (tp.pricing.offerPrice   !== undefined) t.pricing.offerPrice   = tp.pricing.offerPrice
      }
    }
  }
  return next
}

export type UpdateResult =
  | { ok: true;  settings: PlatformSettings; changed: string[] }
  | { ok: false; errors: string[] }

/** RD-PHASE4-S2 — the leaf paths whose values differ (metadata excluded). Pure. */
export function changedSettingPaths(a: unknown, b: unknown, prefix = ''): string[] {
  const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (isMap(a) && isMap(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !(prefix === '' && k === 'metadata')).sort()
    return keys.flatMap(k => changedSettingPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k))
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix]
}
const valueAt = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)

/**
 * Validate + persist a patch. Returns the new effective settings, or the validation
 * errors (nothing is written on failure). Stamps a fresh metadata block (revision
 * bump + updatedAt/updatedBy). `nowIso` is injected so the caller controls the
 * timestamp source.
 *
 * RD-PHASE4-S2 — ONE TRANSACTION: the document is re-read inside it and the patch is applied to that
 * FRESH state (only the requested fields change), so concurrent updates to different keys both
 * survive and a concurrent update to the same key is serialized (the loser re-runs). The audit row —
 * actor, changed setting paths, their previous and new values, the reason, a server timestamp — is
 * written in the SAME transaction under the new revision's id: no change without its audit, and a
 * failed audit write leaves the settings untouched. A patch that changes nothing writes nothing.
 */
export async function updatePlatformSettings(
  patch:    PlatformSettingsPatch,
  adminUid: string,
  nowIso:   string,
  audit: { collection: string; reason: string; data?: Record<string, unknown> },
): Promise<UpdateResult> {
  const ref = platformSettingsRef()
  return ref.firestore.runTransaction<UpdateResult>(async txn => {
    const snap    = await txn.get(ref)
    const current = resolveStoredPlatformSettings(snap.exists ? (snap.data() ?? {}) as Record<string, unknown> : null)
    const next    = applyPatch(current, patch)

    const check = validatePlatformSettings(next)
    if (!check.ok) return { ok: false, errors: check.errors }

    const changed = changedSettingPaths(current, next)
    if (changed.length === 0) return { ok: true, settings: current, changed }

    next.metadata = {
      version:   (current.metadata.version ?? 0) + 1,   // monotonic revision counter
      updatedAt: nowIso,
      updatedBy: adminUid,
    }

    // Full overwrite of a document DERIVED FROM THE FRESH READ in this transaction (not a stale copy).
    txn.set(ref, next)
    txn.set(ref.firestore.collection(audit.collection).doc(`platform_settings_v${next.metadata.version}`), {
      ...(audit.data ?? {}),
      adminUid, action: 'platform_settings.updated', entityType: 'platform_settings', entityId: 'default',
      metadata: {
        version: next.metadata.version,
        reason:  audit.reason,
        fields:  changed,
        before:  Object.fromEntries(changed.map(p => [p, valueAt(current, p) ?? null])),
        after:   Object.fromEntries(changed.map(p => [p, valueAt(next, p) ?? null])),
      },
      createdAt: FieldValue.serverTimestamp(),
    })
    return { ok: true, settings: next, changed }
  })
}
