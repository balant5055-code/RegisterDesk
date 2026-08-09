// RD-PHOTO-07 — the live-preview state machine.
//
// This is the truth table from the sprint brief, encoded. It exists because the predicate it
// tests caused a defect that survived four attempted fixes: the condition was `preview`
// alone, so an event with photos but no artwork rendered a full-width aspect box (measured
// at 1093px) to preview nothing. Every earlier fix chased page height instead of the boolean.
//
// PURE — no React, no DOM, no browser needed.

import { describe, it, expect } from 'vitest'
import {
  PLACEHOLDER_MESSAGE, canRenderLivePreview, previewPlaceholderReason,
  type LivePreviewFacts,
} from '@/features/photo-branding/utils/livePreview'

const facts = (over: Partial<LivePreviewFacts> = {}): LivePreviewFacts => ({
  hasPhoto: false, hasOverlay: false, brandingEnabled: false, hasPlacement: false, ...over,
})

/** Placement is derived from the overlay, so it is present exactly when the overlay is. */
const real = (photo: boolean, overlay: boolean, enabled: boolean): LivePreviewFacts =>
  facts({ hasPhoto: photo, hasOverlay: overlay, brandingEnabled: enabled, hasPlacement: overlay })

describe('the brief\'s six required states', () => {
  it('1 · no photo, no overlay → placeholder', () => {
    expect(canRenderLivePreview(real(false, false, false))).toBe(false)
  })

  it('2 · photo, no overlay → placeholder', () => {
    expect(canRenderLivePreview(real(true, false, false))).toBe(false)
  })

  it('3 · photo + overlay, branding DISABLED → placeholder', () => {
    // The regression that made `preview && overlay` insufficient: a disabled overlay is not
    // drawn, so the box would render empty exactly as before.
    expect(canRenderLivePreview(real(true, true, false))).toBe(false)
  })

  it('4 · photo + overlay, branding ENABLED → live preview', () => {
    expect(canRenderLivePreview(real(true, true, true))).toBe(true)
  })

  it('5 · no photo, overlay, enabled → placeholder', () => {
    expect(canRenderLivePreview(real(false, true, true))).toBe(false)
  })

  it('6 · no photo, overlay, disabled → placeholder', () => {
    expect(canRenderLivePreview(real(false, true, false))).toBe(false)
  })
})

describe('canRenderLivePreview', () => {
  it('is true for EXACTLY ONE of all 16 input combinations', () => {
    const all: boolean[] = []
    for (const hasPhoto of [true, false]) {
      for (const hasOverlay of [true, false]) {
        for (const brandingEnabled of [true, false]) {
          for (const hasPlacement of [true, false]) {
            all.push(canRenderLivePreview({ hasPhoto, hasOverlay, brandingEnabled, hasPlacement }))
          }
        }
      }
    }
    expect(all.filter(Boolean)).toHaveLength(1)
  })

  it('requires every single input — dropping any one flips it to false', () => {
    const allTrue = facts({
      hasPhoto: true, hasOverlay: true, brandingEnabled: true, hasPlacement: true,
    })
    expect(canRenderLivePreview(allTrue)).toBe(true)
    for (const key of Object.keys(allTrue) as (keyof LivePreviewFacts)[]) {
      expect(canRenderLivePreview({ ...allTrue, [key]: false })).toBe(false)
    }
  })

  it('never renders a preview without artwork to draw', () => {
    // The original defect, stated as an invariant.
    for (const hasPhoto of [true, false]) {
      for (const brandingEnabled of [true, false]) {
        expect(canRenderLivePreview(facts({
          hasPhoto, brandingEnabled, hasOverlay: false, hasPlacement: false,
        }))).toBe(false)
      }
    }
  })
})

describe('previewPlaceholderReason', () => {
  it('maps each state to the message the brief specifies', () => {
    expect(PLACEHOLDER_MESSAGE[previewPlaceholderReason(real(false, false, false))])
      .toBe('Upload a transparent PNG, then import photos.')
    expect(PLACEHOLDER_MESSAGE[previewPlaceholderReason(real(true, false, false))])
      .toBe('Upload a transparent PNG below to see it applied to your photos.')
    expect(PLACEHOLDER_MESSAGE[previewPlaceholderReason(real(true, true, false))])
      .toBe('Enable branding to preview the overlay.')
    expect(PLACEHOLDER_MESSAGE[previewPlaceholderReason(real(false, true, true))])
      .toBe('Import photos for this event to see it applied to a real photograph.')
  })

  it('reports DISABLED ahead of "import some photos"', () => {
    // Artwork uploaded, switched off, nothing imported. "Enable branding" is the fact the
    // organizer can act on; the other message would hide it.
    expect(previewPlaceholderReason(real(false, true, false))).toBe('disabled')
  })

  it('has a message for every reason, with no empty strings', () => {
    for (const [reason, message] of Object.entries(PLACEHOLDER_MESSAGE)) {
      expect(message.length, reason).toBeGreaterThan(10)
    }
  })

  it('is never consulted when a live preview can render', () => {
    // The two functions partition the space: exactly one of them applies to any input.
    for (const hasPhoto of [true, false]) {
      for (const hasOverlay of [true, false]) {
        for (const brandingEnabled of [true, false]) {
          const f = real(hasPhoto, hasOverlay, brandingEnabled)
          if (canRenderLivePreview(f)) continue
          expect(PLACEHOLDER_MESSAGE[previewPlaceholderReason(f)]).toBeTruthy()
        }
      }
    }
  })
})
