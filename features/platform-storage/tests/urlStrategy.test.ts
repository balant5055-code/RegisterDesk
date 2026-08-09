// RD-MEDIA-07 — how an object's URL is produced.
//
// This decision is why a correctly uploaded, correctly stored, correctly counted photo
// rendered as a placeholder on two separate surfaces: `resolveUrl` maps PUBLIC → the durable
// public URL, that URL needs `R2_PUBLIC_URL`, and `R2_PUBLIC_URL` is optional by design.
//
// The regression block below is the bug.

import { describe, it, expect } from 'vitest'
import {
  isDegradedPublicUrl, resolveUrlStrategy,
} from '@/features/platform-storage/utils/urlStrategy'
import type { StorageVisibility } from '@/features/platform-storage/types'

const ALL: StorageVisibility[] = ['PUBLIC', 'PRIVATE', 'SIGNED_URL']

// ═══════════════ The regression ═══════════════

describe('a PUBLIC object on a bucket with no public domain', () => {
  it('is SIGNED, not refused', () => {
    // Before this, `resolveUrl` threw NOT_CONFIGURED, both media surfaces caught it, and
    // every caller got null: `thumbnailUrl: null` on upload, "No preview" in the organizer
    // browser, a placeholder in the public gallery. The photo was fine in all three.
    expect(resolveUrlStrategy('PUBLIC', false)).toBe('signed')
  })

  it('is reported as degraded, so the cause is visible', () => {
    expect(isDegradedPublicUrl('PUBLIC', false)).toBe(true)
  })

  it('still prefers the durable URL when the bucket HAS a public domain', () => {
    // Signing is the fallback, not the new default: a signed URL cannot be cached by a CDN,
    // and a gallery is dozens of tiles per pageview.
    expect(resolveUrlStrategy('PUBLIC', true)).toBe('public')
    expect(isDegradedPublicUrl('PUBLIC', true)).toBe(false)
  })
})

// ═══════════════ The gated cases are untouched ═══════════════

describe('gated visibility is never widened by the fallback', () => {
  it('SIGNED_URL is always signed, even when a public domain exists', () => {
    // Serving a gated object from a durable public URL would silently un-gate it.
    expect(resolveUrlStrategy('SIGNED_URL', true)).toBe('signed')
    expect(resolveUrlStrategy('SIGNED_URL', false)).toBe('signed')
  })

  it('PRIVATE has no URL, however the bucket is configured', () => {
    expect(resolveUrlStrategy('PRIVATE', true)).toBe('none')
    expect(resolveUrlStrategy('PRIVATE', false)).toBe('none')
  })

  it('only PUBLIC is ever degraded', () => {
    for (const visibility of ALL) {
      if (visibility === 'PUBLIC') continue
      expect(isDegradedPublicUrl(visibility, false), visibility).toBe(false)
    }
  })
})

// ═══════════════ Total ═══════════════

describe('the strategy is total', () => {
  it('every visibility resolves to a strategy, in both configurations', () => {
    for (const visibility of ALL) {
      for (const hasPublic of [true, false]) {
        expect(['public', 'signed', 'none']).toContain(resolveUrlStrategy(visibility, hasPublic))
      }
    }
  })

  it('never returns "public" for anything but a PUBLIC object', () => {
    for (const visibility of ALL) {
      for (const hasPublic of [true, false]) {
        if (resolveUrlStrategy(visibility, hasPublic) === 'public') {
          expect(visibility).toBe('PUBLIC')
        }
      }
    }
  })

  it('never returns "none" for anything but a PRIVATE object', () => {
    for (const visibility of ALL) {
      for (const hasPublic of [true, false]) {
        if (resolveUrlStrategy(visibility, hasPublic) === 'none') {
          expect(visibility).toBe('PRIVATE')
        }
      }
    }
  })
})
