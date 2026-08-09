// RD-MEDIA-08 · THE single source for every Media Studio limit. Server-only.
//
// ═══ THE HIERARCHY ════════════════════════════════════════════════════════════
//
//     Event override            mediaSettings/{organizerUid}.eventLimitOverrides[eventId]
//            ↓
//     Licence (plan) limit      businessConfig.mediaStudio.tierLimits[tier]
//            ↓
//     Global platform default   businessConfig.mediaStudio
//
// Highest wins, PER FIELD. The merge itself is pure and lives in `mediaLimitLayers.ts`;
// this file is the I/O that feeds it.
// ══════════════════════════════════════════════════════════════════════════════
//
// ─── What this deliberately does NOT do ──────────────────────────────────────
// It never WRITES a licence, never defines a tier, and never changes the licensing model.
// It READS the tier off `eventLicenses/{eventSlug}` and looks it up. Media limits live in
// their own config section precisely so changing a photo cap is not an edit to the frozen
// licence catalog.
//
// Every consumer — upload, gallery creation, album creation, duplicate scan, the organizer
// limits panel — calls `resolveMediaConfig`. No route, page or repository may hardcode a
// media limit; docs/RD-MEDIA-08-limits.md lists the ones this replaced.

import { adminDb } from '@/lib/firebase/admin'
import { businessConfig } from '@/lib/config/businessConfigService'
import { isEventLicenseTierV2, type EventLicenseTierV2 } from '@/lib/licensing/eventLicense'
import { EVENT_LICENSES_COLLECTION } from '@/lib/licensing/schema'
import { mergeMediaLayers, type ResolvedMediaConfig } from '@/lib/config/mediaLimitLayers'
import type { MediaOverridableConfig, MediaStudioConfig } from '@/lib/config/businessConfig'

// Re-exported so a consumer needs ONE import for the resolver and its vocabulary.
export { checkBatch, checkCount, checkSize, mergeMediaLayers } from '@/lib/config/mediaLimitLayers'
export type {
  LimitVerdict, MediaLimitProvenance, MediaLimitSource, ResolvedMediaConfig,
} from '@/lib/config/mediaLimitLayers'

export interface MediaResolutionContext {
  organizerUid: string
  /** Draft/event id — the key an event override is stored under. */
  eventId?:     string
  /** Public slug — the key `eventLicenses` is stored under. */
  eventSlug?:   string
}

/**
 * The licence tier attached to an event.
 *
 * Returns null rather than guessing when there is no licence, the document is a V1-tier
 * record, or the read fails. A null tier resolves to the GLOBAL layer — the conservative
 * direction, since global defaults are the platform's baseline rather than a paid tier's
 * allowance.
 */
export async function resolveEventTier(eventSlug: string): Promise<EventLicenseTierV2 | null> {
  if (!eventSlug) return null
  try {
    const snap = await adminDb.collection(EVENT_LICENSES_COLLECTION).doc(eventSlug).get()
    if (!snap.exists) return null
    const tier = snap.get('tier') as unknown
    // A V1 tier ('growth') is not a V2 key. Historical licences therefore fall back to
    // global rather than being mapped by a guess about which V2 tier they resemble.
    return isEventLicenseTierV2(tier) ? tier : null
  } catch {
    return null
  }
}

/**
 * The event's own override map, read from the EXISTING per-workspace settings document.
 *
 * Stored there rather than in a new collection for a specific reason: the upload path
 * already reads `mediaSettings/{organizerUid}`, so an event override costs it no additional
 * document read.
 */
async function readEventOverride(
  organizerUid: string, eventId: string | undefined,
): Promise<Partial<MediaOverridableConfig>> {
  if (!eventId) return {}
  try {
    const snap = await adminDb.collection('mediaSettings').doc(organizerUid).get()
    if (!snap.exists) return {}
    const overrides = snap.get('eventLimitOverrides') as
      Record<string, Partial<MediaOverridableConfig>> | undefined
    return overrides?.[eventId] ?? {}
  } catch {
    return {}
  }
}

/**
 * THE resolver. Every Media Studio limit decision goes through this.
 *
 * Total: it never throws. A missing licence, an unreadable settings document or a config
 * read failure all degrade to the global defaults — refusing an upload because a
 * configuration lookup failed is worse than applying the platform baseline.
 */
export async function resolveMediaConfig(
  context: MediaResolutionContext,
): Promise<ResolvedMediaConfig> {
  const global = await businessConfig.getSection('mediaStudio')

  const [tier, event] = await Promise.all([
    context.eventSlug ? resolveEventTier(context.eventSlug) : Promise.resolve(null),
    readEventOverride(context.organizerUid, context.eventId),
  ])

  const plan = tier ? (global.tierLimits?.[tier] ?? {}) : {}

  return mergeMediaLayers(global, plan, event, tier)
}

/** The global layer alone — for surfaces with no event in hand (the admin panel, defaults). */
export async function getGlobalMediaConfig(): Promise<MediaStudioConfig> {
  return businessConfig.getSection('mediaStudio')
}
