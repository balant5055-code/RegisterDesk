// RD-MEDIA-08 · The limit hierarchy, as pure logic.
//
// PURE. No firebase-admin import — deliberately.
//
// The same discipline as `features/ai/utils/jobDoc.ts` and `media-studio/utils/bulkOps.ts`:
// importing the resolver boots the Admin SDK, and the precedence rule this whole sprint
// turns on has to be provable by test rather than traced through Firestore.

import type { EventLicenseTierV2 } from '@/lib/licensing/eventLicense'
import type { MediaOverridableConfig, MediaStudioConfig } from '@/lib/config/businessConfig'

/** Which layer supplied each effective value. Surfaced so the UI can explain a number. */
export type MediaLimitSource = 'event' | 'plan' | 'global'

export type MediaLimitProvenance = Record<keyof MediaOverridableConfig, MediaLimitSource>

export interface ResolvedMediaConfig extends MediaOverridableConfig {
  /** The licence tier the plan layer was read from, or null when none could be resolved. */
  tier: EventLicenseTierV2 | null
  /** Where each value came from. */
  source: MediaLimitProvenance
}

/**
 * MS-SETTINGS-01 · Keys an organizer may NEVER set for themselves.
 *
 * These are PLATFORM LIMITS — the ceilings the business sells and enforces. Before this
 * sprint they sat in one undifferentiated array with the organizer's own preferences, and
 * `PATCH /api/organizer/media-studio/overrides` accepted every one of them with no clamp:
 * an organizer could send `maxPhotosPerEvent: null` and give themselves unlimited storage.
 * The resolver ranks `event` above `plan`, so that value became the effective limit.
 *
 * Exported so the route's allow-list and this array cannot drift apart. A key added here is
 * refused by the API automatically; a key added only to the route would still be resolvable.
 */
export const PLATFORM_LIMIT_KEYS: readonly (keyof MediaOverridableConfig)[] = [
  'maxPhotosPerEvent', 'maxUploadBatchSize', 'maxUploadFileSizeBytes',
  'maxGalleriesPerEvent', 'maxAlbumsPerGallery', 'signedUrlExpirySeconds',
] as const

/**
 * Keys that describe the organizer's OWN product, not a platform ceiling.
 *
 * Compression quality, which renditions to keep, and whether a gallery is public are
 * decisions about the organizer's event — not limits the platform sells. They stay
 * organizer-writable; locking them would remove working functionality rather than close a
 * privilege gap.
 */
export const ORGANIZER_PREFERENCE_KEYS: readonly (keyof MediaOverridableConfig)[] = [
  'defaultCompressionProfileId', 'generateThumbnail', 'generateMedium', 'keepOriginal',
  'defaultVisibility', 'publicGalleryEnabled',
] as const

/**
 * Every key the RESOLVER understands.
 *
 * Unchanged in content and order-independent: an admin can still set any of these at the
 * global or plan layer, and an admin-granted event override still resolves. The split above
 * governs only what an ORGANIZER may write.
 */
const OVERRIDABLE_KEYS: (keyof MediaOverridableConfig)[] = [
  ...PLATFORM_LIMIT_KEYS, ...ORGANIZER_PREFERENCE_KEYS,
]

/**
 * Merges the three layers, field by field, recording which one won.
 *
 * PER FIELD is the whole point. A layer-at-a-time fallback — "if the event overrides
 * anything, use the event's object" — would silently reset every value the event did not
 * restate, handing it platform defaults instead of its plan's allowances.
 */
export function mergeMediaLayers(
  global: MediaStudioConfig,
  plan:   Partial<MediaOverridableConfig>,
  event:  Partial<MediaOverridableConfig>,
  tier:   EventLicenseTierV2 | null,
): ResolvedMediaConfig {
  const effective = {} as MediaOverridableConfig
  const source    = {} as MediaLimitProvenance

  for (const key of OVERRIDABLE_KEYS) {
    if (event[key] !== undefined) {
      // `undefined` means "not overridden". `null` is a REAL value for maxPhotosPerEvent
      // (unlimited) and `false` a real value for every boolean, which is why this tests
      // against undefined and never against falsiness.
      Object.assign(effective, { [key]: event[key] })
      source[key] = 'event'
    } else if (plan[key] !== undefined) {
      Object.assign(effective, { [key]: plan[key] })
      source[key] = 'plan'
    } else {
      Object.assign(effective, { [key]: global[key] })
      source[key] = 'global'
    }
  }

  return { ...effective, tier, source }
}

// ─── Enforcement helpers ──────────────────────────────────────────────────────

export type LimitVerdict =
  | { ok: true }
  | { ok: false; status: number; error: string }

/** `null` means unlimited — the only value that is never exceeded. */
export function checkCount(
  current: number, adding: number, limit: number | null, noun: string,
): LimitVerdict {
  if (limit === null) return { ok: true }
  if (current + adding <= limit) return { ok: true }
  return {
    ok: false, status: 409,
    error: `This event's plan allows ${limit.toLocaleString('en-IN')} ${noun}. `
      + `It already has ${current.toLocaleString('en-IN')}.`,
  }
}

export function checkSize(bytes: number, limit: number): LimitVerdict {
  if (bytes <= limit) return { ok: true }
  const mb = (limit / (1024 * 1024)).toFixed(0)
  return { ok: false, status: 413, error: `Each photo must be ${mb} MB or smaller.` }
}

export function checkBatch(count: number, limit: number): LimitVerdict {
  if (count <= limit) return { ok: true }
  return {
    ok: false, status: 413,
    error: `Send at most ${limit.toLocaleString('en-IN')} files per request.`,
  }
}
