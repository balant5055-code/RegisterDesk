// RD-MEDIA-08 — the three-level limit hierarchy.
//
// `mergeMediaLayers` is the whole sprint in one function: event → plan → global, resolved
// PER FIELD. It is kept pure and separate from the Firestore reads so the precedence rule
// can be proven rather than traced.

import { describe, it, expect } from 'vitest'
// From the PURE module: importing the resolver would boot the Admin SDK.
import { mergeMediaLayers } from '@/lib/config/mediaLimitLayers'
import { BUSINESS_CONFIG_DEFAULTS, CONFIG_SECTION_REGISTRY } from '@/lib/config/businessConfig'
import type { MediaOverridableConfig, MediaStudioConfig } from '@/lib/config/businessConfig'

const GLOBAL: MediaStudioConfig = BUSINESS_CONFIG_DEFAULTS.mediaStudio

const merge = (
  plan: Partial<MediaOverridableConfig> = {},
  event: Partial<MediaOverridableConfig> = {},
  tier: 'free' | 'business' | null = null,
) => mergeMediaLayers(GLOBAL, plan, event, tier)

// ═══════════════ Precedence ═══════════════

describe('event → plan → global', () => {
  it('an event override beats the plan AND the global default', () => {
    const r = merge({ maxPhotosPerEvent: 3_000 }, { maxPhotosPerEvent: 10_000 }, 'business')
    expect(r.maxPhotosPerEvent).toBe(10_000)
    expect(r.source.maxPhotosPerEvent).toBe('event')
  })

  it('a plan limit beats the global default', () => {
    const r = merge({ maxPhotosPerEvent: 3_000 }, {}, 'business')
    expect(r.maxPhotosPerEvent).toBe(3_000)
    expect(r.source.maxPhotosPerEvent).toBe('plan')
  })

  it('the global default applies when neither overrides', () => {
    const r = merge()
    expect(r.maxPhotosPerEvent).toBe(GLOBAL.maxPhotosPerEvent)
    expect(r.source.maxPhotosPerEvent).toBe('global')
  })
})

// ═══════════════ Per FIELD, not per layer ═══════════════

describe('resolution is per field', () => {
  it('an event that overrides ONE value still inherits the rest', () => {
    // The failure this prevents: a layer-at-a-time fallback would reset every value the
    // event did not restate, silently handing it the platform defaults.
    const r = merge(
      { maxPhotosPerEvent: 3_000, maxGalleriesPerEvent: 40 },
      { maxPhotosPerEvent: 10_000 },
      'business',
    )
    expect(r.maxPhotosPerEvent).toBe(10_000)      // event
    expect(r.source.maxPhotosPerEvent).toBe('event')
    expect(r.maxGalleriesPerEvent).toBe(40)       // plan — NOT reset
    expect(r.source.maxGalleriesPerEvent).toBe('plan')
    expect(r.maxUploadBatchSize).toBe(GLOBAL.maxUploadBatchSize)   // global
    expect(r.source.maxUploadBatchSize).toBe('global')
  })

  it('reports a source for every overridable field', () => {
    const r = merge()
    for (const key of Object.keys(r.source) as (keyof MediaOverridableConfig)[]) {
      expect(['event', 'plan', 'global'], key).toContain(r.source[key])
    }
    expect(Object.keys(r.source)).toHaveLength(12)
  })
})

// ═══════════════ null is a value, not an absence ═══════════════

describe('unlimited', () => {
  it('an event may override a finite plan limit with null (unlimited)', () => {
    // `null` means unlimited and MUST win. A falsiness check instead of an
    // `undefined` check would silently discard it and re-apply the plan's cap.
    const r = merge({ maxPhotosPerEvent: 50 }, { maxPhotosPerEvent: null }, 'free')
    expect(r.maxPhotosPerEvent).toBeNull()
    expect(r.source.maxPhotosPerEvent).toBe('event')
  })

  it('a plan may be unlimited while the global default is finite', () => {
    const r = merge({ maxPhotosPerEvent: null }, {}, 'business')
    expect(r.maxPhotosPerEvent).toBeNull()
    expect(r.source.maxPhotosPerEvent).toBe('plan')
  })
})

// ═══════════════ Booleans ═══════════════

describe('boolean settings', () => {
  it('false overrides true — it is a value, not an absence', () => {
    const r = merge({}, { publicGalleryEnabled: false })
    expect(r.publicGalleryEnabled).toBe(false)
    expect(r.source.publicGalleryEnabled).toBe('event')
  })

  it('an absent boolean inherits rather than defaulting to false', () => {
    expect(merge().publicGalleryEnabled).toBe(GLOBAL.publicGalleryEnabled)
  })
})

// ═══════════════ The shipped defaults ═══════════════

describe('default plan values', () => {
  it('matches the approved table', () => {
    const tiers = GLOBAL.tierLimits
    expect(tiers.free?.maxPhotosPerEvent).toBe(50)
    expect(tiers.starter?.maxPhotosPerEvent).toBe(500)
    expect(tiers.professional?.maxPhotosPerEvent).toBe(2_000)
    expect(tiers.business?.maxPhotosPerEvent).toBe(3_000)
    expect(tiers.enterprise?.maxPhotosPerEvent).toBe(5_000)
  })

  it('lists every V2 tier explicitly, so no tier silently inherits', () => {
    expect(Object.keys(GLOBAL.tierLimits).sort())
      .toEqual(['business', 'enterprise', 'free', 'professional', 'starter'])
  })

  it('carries the constants it replaced, so registering the section changed no behaviour', () => {
    expect(GLOBAL.maxUploadFileSizeBytes).toBe(50 * 1024 * 1024)  // platform-storage policy
    expect(GLOBAL.maxUploadBatchSize).toBe(2_000)                 // duplicate-scan cap
    expect(GLOBAL.maxGalleriesPerEvent).toBe(200)                 // gallery list cap
    expect(GLOBAL.maxAlbumsPerGallery).toBe(200)                  // album list cap
    expect(GLOBAL.defaultCompressionProfileId).toBe('balanced')   // DEFAULT_MEDIA_SETTINGS
    expect(GLOBAL.defaultVisibility).toBe('PUBLIC')
  })

  it('tier deltas carry ONLY what differs — everything else inherits', () => {
    // A tier that restated every field would freeze it: raising a global limit would then
    // not reach any tier.
    for (const delta of Object.values(GLOBAL.tierLimits)) {
      expect(Object.keys(delta ?? {})).toEqual(['maxPhotosPerEvent'])
    }
  })
})

// ═══════════════ The tier is reported ═══════════════

describe('provenance', () => {
  it('reports the tier the plan layer was read from', () => {
    expect(merge({}, {}, 'business').tier).toBe('business')
  })

  it('reports null when no licence tier could be resolved', () => {
    // A V1-tier licence, or none at all. Everything then resolves to global — the
    // conservative direction, since global is the baseline rather than a paid allowance.
    const r = merge({}, {}, null)
    expect(r.tier).toBeNull()
    expect(r.source.maxPhotosPerEvent).toBe('global')
  })
})

// ═══════════════ RD-MS-CLOSURE-01 · the keys that were inert ═══════════════
//
// Four `MediaDefaultsConfig` keys resolved correctly through this function and were then
// ignored by the import client, which hardcoded them. These prove the RESOLVER half — that a
// plan or event really can move them — so a regression shows up here rather than as a
// storage bill nobody can explain.

describe('the rendition and compression defaults resolve like every other key', () => {
  it('a PLAN can turn off the full-size rendition without touching the global', () => {
    // The storage-cost lever: off for Free, on for Enterprise.
    const r = merge({ keepOriginal: false }, {}, 'free')
    expect(r.keepOriginal).toBe(false)
    expect(r.source.keepOriginal).toBe('plan')
    expect(GLOBAL.keepOriginal).toBe(true)      // the global is untouched
  })

  it('an EVENT beats a plan for the compression profile', () => {
    const r = merge({ defaultCompressionProfileId: 'efficient' }, { defaultCompressionProfileId: 'balanced' })
    expect(r.defaultCompressionProfileId).toBe('balanced')
    expect(r.source.defaultCompressionProfileId).toBe('event')
  })

  it('FALSE is a real value, not "unset"', () => {
    // The bug this guards: a layer-at-a-time merge, or a falsiness test, would drop these
    // and hand back the global `true` — silently re-enabling a rendition a plan turned off.
    for (const key of ['keepOriginal', 'generateMedium', 'generateThumbnail'] as const) {
      const r = merge({}, { [key]: false })
      expect(r[key]).toBe(false)
      expect(r.source[key]).toBe('event')
    }
  })

  it('defaultVisibility resolves per event — the split brain that made it inert', () => {
    // `uploads/complete` read this from the mediaSettings document instead of from here, so
    // an event set to SIGNED_URL still published every photo PUBLIC.
    const r = merge({}, { defaultVisibility: 'SIGNED_URL' })
    expect(r.defaultVisibility).toBe('SIGNED_URL')
    expect(r.source.defaultVisibility).toBe('event')
  })

  it('publicGalleryEnabled resolves per event — the switch with no consumer', () => {
    // One event taken down without darkening the platform.
    const r = merge({}, { publicGalleryEnabled: false })
    expect(r.publicGalleryEnabled).toBe(false)
    expect(r.source.publicGalleryEnabled).toBe('event')
  })
})

// ═══════════════ RD-MS-CLOSURE-01 · per-tier deltas are validated ═══════════
//
// The tier table now accepts booleans as well as numbers, so the validator had to learn
// them. Without this a hand-edited `"false"` — the STRING a JSON payload would carry —
// would store, resolve as truthy, and keep generating a rendition the tier was configured
// not to store. Silent, and expensive.

describe('validateMediaStudio · per-tier deltas', () => {
  const validate = (tierLimits: Record<string, Record<string, unknown>>) =>
    CONFIG_SECTION_REGISTRY.mediaStudio.validate({ ...GLOBAL, tierLimits })

  it('accepts a real boolean delta', () => {
    expect(validate({ free: { keepOriginal: false } }).valid).toBe(true)
  })

  it('REFUSES the string "false", which is what a hand-edited payload carries', () => {
    const r = validate({ free: { keepOriginal: 'false' } })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toContain('keepOriginal must be true or false')
  })

  it('refuses a number where a boolean belongs', () => {
    expect(validate({ starter: { generateMedium: 1 } }).valid).toBe(false)
  })

  it('accepts an absent key — that is INHERIT, not a value', () => {
    expect(validate({ free: { maxPhotosPerEvent: 100 } }).valid).toBe(true)
  })

  it('validates defaultVisibility per tier against the real union', () => {
    expect(validate({ business: { defaultVisibility: 'SIGNED_URL' } }).valid).toBe(true)
    expect(validate({ business: { defaultVisibility: 'PRIVATE' } }).valid).toBe(false)
  })

  it('still refuses a negative numeric cap', () => {
    expect(validate({ free: { maxUploadBatchSize: -1 } }).valid).toBe(false)
  })
})
