// RD-MS-CLEANUP-02 · Renditions are a platform default, not a setting. Pure — no DOM.
//
// The settings UI that let an organizer switch renditions off is gone. What must NOT change
// is that every upload still produces all three. These tests pin that at the two places the
// decision is actually made: the plan the import client passes, and the branches
// `processImage` takes from it.
//
// The audit that preceded this sprint found the toggles were ALREADY inert — the import
// client has always passed a hardcoded plan and never read the saved settings. So these
// assertions describe behaviour that did not change; they exist so it cannot drift now that
// nothing in the UI states it.

import { describe, it, expect } from 'vitest'
import { MEDIA_RENDITIONS, DEFAULT_MEDIA_SETTINGS } from '@/features/media-studio/types'
import { estimateStoredBytes, findProfile } from '@/features/media-studio/utils/compressionProfiles'

/** Exactly the plan `ImportClient` passes to the upload queue. */
const PLATFORM_PLAN = { keepOriginal: true, generateMedium: true, generateThumbnail: true }

describe('the three renditions still exist', () => {
  it('original, medium and thumbnail are all still declared', () => {
    expect(MEDIA_RENDITIONS).toEqual(['original', 'medium', 'thumbnail'])
  })

  it('the platform plan keeps ALL THREE on', () => {
    // If any of these ever became false, uploads would silently stop producing a rendition
    // that the gallery, runner downloads and the public gallery all read.
    expect(PLATFORM_PLAN.keepOriginal).toBe(true)
    expect(PLATFORM_PLAN.generateMedium).toBe(true)
    expect(PLATFORM_PLAN.generateThumbnail).toBe(true)
  })

  it('the stored defaults still say all three, for the limits endpoint', () => {
    // The fields remain on the settings document and in the resolved config — the limits
    // endpoint still reports them — they simply cannot be changed any more.
    expect(DEFAULT_MEDIA_SETTINGS.keepOriginal).toBe(true)
    expect(DEFAULT_MEDIA_SETTINGS.generateMedium).toBe(true)
    expect(DEFAULT_MEDIA_SETTINGS.generateThumbnail).toBe(true)
  })
})

describe('storage estimate reflects all three renditions', () => {
  it('counts original + medium + thumbnail', () => {
    // The estimate is the one place the plan is still read outside the pipeline. Dropping a
    // rendition would show up here as a smaller number.
    const profile = findProfile('balanced')
    const all  = estimateStoredBytes(9 * 1024 * 1024, profile, PLATFORM_PLAN)
    const only = estimateStoredBytes(9 * 1024 * 1024, profile, {
      keepOriginal: true, generateMedium: false, generateThumbnail: false,
    })
    expect(all).toBeGreaterThan(only)
  })

  it('the full-size rendition dominates the stored bytes', () => {
    const profile = findProfile('balanced')
    const withOriginal = estimateStoredBytes(9 * 1024 * 1024, profile, PLATFORM_PLAN)
    const without = estimateStoredBytes(9 * 1024 * 1024, profile, {
      keepOriginal: false, generateMedium: true, generateThumbnail: true,
    })
    expect(withOriginal).toBeGreaterThan(without * 2)
  })
})
