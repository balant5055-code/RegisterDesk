// MS-SETTINGS-01 · Platform limits are admin-only.
//
// Pure — asserts the KEY SPLIT that the lockdown rests on. The route imports
// `PLATFORM_LIMIT_KEYS` rather than restating it, so a key landing on the wrong side of this
// split silently changes who may write it. That is worth a test even though it looks trivial.
//
// The escalation this prevents was real and reachable: `PATCH /overrides` accepted
// `maxPhotosPerEvent: null` — unlimited — and the resolver ranks the event layer above plan
// and global, so the value became the limit actually enforced at upload.

import { describe, it, expect } from 'vitest'
import {
  ORGANIZER_PREFERENCE_KEYS, PLATFORM_LIMIT_KEYS, mergeMediaLayers,
} from '@/lib/config/mediaLimitLayers'
import type { MediaStudioConfig } from '@/lib/config/businessConfig'

describe('MS-SETTINGS-01 · key classification', () => {
  it('every ceiling the business sells is a PLATFORM limit', () => {
    expect([...PLATFORM_LIMIT_KEYS].sort()).toEqual([
      'maxAlbumsPerGallery', 'maxGalleriesPerEvent', 'maxPhotosPerEvent',
      'maxUploadBatchSize', 'maxUploadFileSizeBytes', 'signedUrlExpirySeconds',
    ])
  })

  it('preferences describe the organizer\'s own product, not a ceiling', () => {
    expect([...ORGANIZER_PREFERENCE_KEYS].sort()).toEqual([
      'defaultCompressionProfileId', 'defaultVisibility', 'generateMedium',
      'generateThumbnail', 'keepOriginal', 'publicGalleryEnabled',
    ])
  })

  it('the two sets are DISJOINT — a key cannot be both', () => {
    const overlap = PLATFORM_LIMIT_KEYS.filter(k => ORGANIZER_PREFERENCE_KEYS.includes(k))
    expect(overlap).toEqual([])
  })

  it('no key is left unclassified', () => {
    // Anything the resolver understands must be on exactly one side, or the route's
    // allow-list would have a hole it could not see.
    const classified = new Set([...PLATFORM_LIMIT_KEYS, ...ORGANIZER_PREFERENCE_KEYS])
    expect(classified.size).toBe(PLATFORM_LIMIT_KEYS.length + ORGANIZER_PREFERENCE_KEYS.length)
  })
})

describe('MS-SETTINGS-01 · the resolver is unchanged', () => {
  const global = {
    maxPhotosPerEvent: 500, maxUploadBatchSize: 20, maxUploadFileSizeBytes: 1000,
    maxGalleriesPerEvent: 5, maxAlbumsPerGallery: 10, signedUrlExpirySeconds: 900,
    defaultCompressionProfileId: 'balanced', generateThumbnail: true, generateMedium: true,
    keepOriginal: true, defaultVisibility: 'SIGNED_URL', publicGalleryEnabled: false,
  } as unknown as MediaStudioConfig

  it('still ranks event above plan above global', () => {
    // The lockdown governs who may WRITE the event layer. An admin-granted override must
    // still resolve exactly as before — that precedence is what MC/RD-MEDIA-08 built.
    const r = mergeMediaLayers(global, { maxPhotosPerEvent: 800 }, { maxPhotosPerEvent: 1200 }, 'business')
    expect(r.maxPhotosPerEvent).toBe(1200)
    expect(r.source.maxPhotosPerEvent).toBe('event')
  })

  it('falls back through plan to global per field', () => {
    const r = mergeMediaLayers(global, { maxPhotosPerEvent: 800 }, {}, 'business')
    expect(r.maxPhotosPerEvent).toBe(800)
    expect(r.source.maxPhotosPerEvent).toBe('plan')
    expect(r.maxGalleriesPerEvent).toBe(5)
    expect(r.source.maxGalleriesPerEvent).toBe('global')
  })

  it('null still means unlimited when an ADMIN sets it', () => {
    // Unlimited remains expressible — it is simply no longer expressible by the organizer.
    const r = mergeMediaLayers(global, {}, { maxPhotosPerEvent: null }, 'enterprise')
    expect(r.maxPhotosPerEvent).toBeNull()
    expect(r.source.maxPhotosPerEvent).toBe('event')
  })

  it('resolves every classified key', () => {
    const r = mergeMediaLayers(global, {}, {}, null)
    for (const key of [...PLATFORM_LIMIT_KEYS, ...ORGANIZER_PREFERENCE_KEYS]) {
      expect(r.source[key]).toBe('global')
    }
  })
})
