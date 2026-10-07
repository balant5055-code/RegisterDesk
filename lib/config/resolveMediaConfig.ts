// RD-MEDIA-08 · THE single source for every Media Studio limit. Server-only.
//
// ═══ THE HIERARCHY ════════════════════════════════════════════════════════════
//
//     Event override            mediaSettings/{organizerUid}.eventLimitOverrides[eventId]
//            ↓
//     Global platform default   businessConfig.mediaStudio
//
// RD-LEGACY-01 — there is NO licence-tier ("plan") layer any more. RegisterDesk has no feature
// tiers: an event's photo COUNT is its paid photo capacity (photoCapacityGate, max 3,000), and
// every other media limit is the global default unless a Super Admin set an event override.
// Stored `mediaStudio.tierLimits` values are left in the document but are not read.
//
// Highest wins, PER FIELD. The merge itself is pure and lives in `mediaLimitLayers.ts`;
// this file is the I/O that feeds it.
// ══════════════════════════════════════════════════════════════════════════════
//
// Every consumer — upload, gallery creation, album creation, duplicate scan, the organizer
// limits panel — calls `resolveMediaConfig`. No route, page or repository may hardcode a
// media limit; docs/RD-MEDIA-08-limits.md lists the ones this replaced.

import { adminDb } from '@/lib/firebase/admin'
import { businessConfig } from '@/lib/config/businessConfigService'
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
  /** Public slug. Accepted for call-site compatibility; no limit depends on it (RD-LEGACY-01). */
  eventSlug?:   string
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

  const event = await readEventOverride(context.organizerUid, context.eventId)

  // No plan layer and no tier (RD-LEGACY-01): event override → global.
  return mergeMediaLayers(global, {}, event, null)
}

/** The global layer alone — for surfaces with no event in hand (the admin panel, defaults). */
export async function getGlobalMediaConfig(): Promise<MediaStudioConfig> {
  return businessConfig.getSection('mediaStudio')
}
