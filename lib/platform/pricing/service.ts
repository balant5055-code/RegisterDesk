// RD-PRICING-01B — Platform Pricing Engine · service (SERVER-ONLY).
//
// Read/write the platformSettings/default singleton. The write path validates the
// FULL merged result before persisting and stamps metadata (version bump +
// updatedAt/updatedBy). Backs the admin API. NOTHING migrates existing data.

import { resolvePlatformPricing, platformSettingsRef } from './resolver'
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
  | { ok: true;  settings: PlatformSettings }
  | { ok: false; errors: string[] }

/**
 * Validate + persist a patch. Returns the new effective settings, or the validation
 * errors (nothing is written on failure). Stamps a fresh metadata block (revision
 * bump + updatedAt/updatedBy). `nowIso` is injected so the caller controls the
 * timestamp source.
 */
export async function updatePlatformSettings(
  patch:    PlatformSettingsPatch,
  adminUid: string,
  nowIso:   string,
): Promise<UpdateResult> {
  const current = await resolvePlatformPricing()
  const next    = applyPatch(current, patch)

  const check = validatePlatformSettings(next)
  if (!check.ok) return { ok: false, errors: check.errors }

  next.metadata = {
    version:   (current.metadata.version ?? 0) + 1,   // monotonic revision counter
    updatedAt: nowIso,
    updatedBy: adminUid,
  }

  // Full overwrite — `next` is a complete, validated object.
  await platformSettingsRef().set(next)
  return { ok: true, settings: next }
}
