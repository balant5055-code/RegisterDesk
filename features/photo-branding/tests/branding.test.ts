// RD-PHOTO-01 — the artwork spec, validation rules and placement.
//
// These are the parts with no I/O: what the page promises, what the validator enforces, and
// where the overlay lands. Kept pure precisely so the guidance an organizer reads and the
// rule that rejects their file are provably the same thing.

import { describe, it, expect } from 'vitest'
import {
  ASPECT_TOLERANCE, BRANDING_STYLES, DEFAULT_STYLE, PLANNED_STYLES,
  formatBytes, formatDimensions, isBrandingStyle, recommendedAspect, safeArea, specFor,
} from '@/features/photo-branding/utils/artworkSpec'
import { validateOverlayMetrics, type OverlayMetrics } from '@/features/photo-branding/utils/validateOverlay'
import { placeOverlay, placementAsPercent } from '@/features/photo-branding/utils/placement'

const SPEC = specFor(DEFAULT_STYLE)

/** A file that satisfies every rule. Each test breaks exactly one thing. */
const good = (over: Partial<OverlayMetrics> = {}): OverlayMetrics => ({
  width:    SPEC.recommendedWidth,
  height:   SPEC.recommendedHeight,
  bytes:    400 * 1024,
  mimeType: 'image/png',
  hasAlpha: true,
  ...over,
})

const codes = (m: OverlayMetrics) =>
  validateOverlayMetrics(m, DEFAULT_STYLE).issues.map(i => i.code)

// ═══════════════ The spec the page publishes ═══════════════

describe('the published requirements', () => {
  it('are the numbers the brief specified', () => {
    expect(SPEC.recommendedWidth).toBe(2048)
    expect(SPEC.recommendedHeight).toBe(360)
    expect(SPEC.minWidth).toBe(1600)
    expect(SPEC.minHeight).toBe(280)
    expect(SPEC.maxWidth).toBe(4096)
    expect(SPEC.maxHeight).toBe(720)
    expect(SPEC.maxBytes).toBe(2 * 1024 * 1024)
    expect(SPEC.recommendedDpi).toBe(300)
  })

  it('places the banner inside the 18–20% band the guidance recommends', () => {
    expect(SPEC.heightRatio).toBeGreaterThanOrEqual(0.18)
    expect(SPEC.heightRatio).toBeLessThanOrEqual(0.20)
  })

  it('formats exactly as the page prints them', () => {
    expect(formatDimensions(2048, 360)).toBe('2,048 × 360 px')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2 MB')
  })
})

// ═══════════════ Validation ═══════════════

describe('validateOverlayMetrics', () => {
  it('accepts artwork that meets every rule', () => {
    expect(validateOverlayMetrics(good(), DEFAULT_STYLE).ok).toBe(true)
  })

  it('REJECTS a JPEG, because it cannot hold transparency', () => {
    expect(codes(good({ mimeType: 'image/jpeg' }))).toContain('not-png')
  })

  it('REJECTS a fully opaque PNG — it would cover the bottom of every photo', () => {
    // The check that matters most. A PNG exported with a white background passes every
    // other rule and ruins every download.
    expect(codes(good({ hasAlpha: false }))).toContain('not-transparent')
  })

  it('rejects a file over the size limit', () => {
    expect(codes(good({ bytes: SPEC.maxBytes + 1 }))).toContain('too-large')
    expect(codes(good({ bytes: SPEC.maxBytes }))).not.toContain('too-large')
  })

  it('rejects artwork below the minimum dimensions', () => {
    expect(codes(good({ width: SPEC.minWidth - 1, height: 280 }))).toContain('too-small')
    expect(codes(good({ width: 1600, height: SPEC.minHeight - 1 }))).toContain('too-small')
  })

  it('rejects artwork above the maximum dimensions', () => {
    expect(codes(good({ width: SPEC.maxWidth + 1, height: 720 }))).toContain('too-big-dimensions')
  })

  it('rejects a shape nothing like a banner', () => {
    // A square logo uploaded by mistake.
    expect(codes(good({ width: 2048, height: 2048 }))).toContain('wrong-aspect')
  })

  it('TOLERATES a reasonably different banner ratio', () => {
    // 2048×320 is 6.4:1 against a 5.69:1 target — a real design choice, not an error. The
    // banner is scaled to the photo's width, so it renders correctly either way.
    expect(codes(good({ width: 2048, height: 320 }))).not.toContain('wrong-aspect')
    expect(ASPECT_TOLERANCE).toBeGreaterThan(0.2)
  })

  it('reports EVERY failure at once, not just the first', () => {
    // An organizer re-exporting artwork should learn it is both a JPEG and too small in one
    // pass, rather than across three attempts.
    const issues = codes(good({ mimeType: 'image/jpeg', width: 100, height: 40, hasAlpha: false }))
    expect(issues).toContain('not-png')
    expect(issues).toContain('too-small')
    expect(issues).toContain('not-transparent')
    expect(issues.length).toBeGreaterThanOrEqual(3)
  })

  it('names the actual number in every message — never "invalid file"', () => {
    const { issues } = validateOverlayMetrics(good({ bytes: 5 * 1024 * 1024 }), DEFAULT_STYLE)
    expect(issues[0].message).toContain('5 MB')
    expect(issues[0].message).toContain('2 MB')
  })

  it('does not raise an aspect complaint for zero dimensions', () => {
    // Those are already reported as too-small; a second NaN-driven message would be noise.
    expect(codes(good({ width: 0, height: 0 }))).not.toContain('wrong-aspect')
  })
})

// ═══════════════ Placement ═══════════════

describe('placeOverlay', () => {
  const photo = { photoWidth: 3000, photoHeight: 2000 }

  it('spans the full width, flush to the bottom', () => {
    const box = placeOverlay({ style: DEFAULT_STYLE, ...photo, overlayWidth: 2048, overlayHeight: 360 })
    expect(box.x).toBe(0)
    expect(box.width).toBe(3000)
    expect(box.y + box.height).toBe(2000)
  })

  it("keeps the ARTWORK's aspect ratio when it fits inside the height cap", () => {
    // A wide banner (2048×250 → 8.2:1) lands at its natural height on a 3:2 photo:
    // 366px, comfortably under the 380px cap.
    const box = placeOverlay({ style: DEFAULT_STYLE, ...photo, overlayWidth: 2048, overlayHeight: 250 })
    expect(box.height).toBe(Math.round(3000 * (250 / 2048)))
    expect(box.height).toBeLessThanOrEqual(Math.round(2000 * SPEC.heightRatio))
  })

  it('the RECOMMENDED size hits the cap on a 3:2 photo — a real, documented tension', () => {
    // 2048×360 stretched to 3000px wide is naturally 527px = 26% of a 2000px-tall photo,
    // above the 18–20% band the guidance recommends. The cap wins, so the banner is scaled
    // to 19% and is therefore slightly compressed vertically.
    //
    // Both numbers come from the brief. Recording the consequence here rather than silently
    // squashing artwork: design nearer 2048×260 to avoid any compression at all.
    const natural = Math.round(3000 * (360 / 2048))
    const box = placeOverlay({ style: DEFAULT_STYLE, ...photo, overlayWidth: 2048, overlayHeight: 360 })
    expect(natural).toBeGreaterThan(box.height)
    expect(box.height).toBe(Math.round(2000 * SPEC.heightRatio))
  })

  it('CAPS an unusually tall banner so it cannot swallow the photograph', () => {
    const box = placeOverlay({ style: DEFAULT_STYLE, ...photo, overlayWidth: 1000, overlayHeight: 1000 })
    expect(box.height).toBe(Math.round(2000 * SPEC.heightRatio))
  })

  it('survives a zero-width overlay instead of dividing by it', () => {
    const box = placeOverlay({ style: DEFAULT_STYLE, ...photo, overlayWidth: 0, overlayHeight: 0 })
    expect(Number.isFinite(box.height)).toBe(true)
    expect(box.height).toBeGreaterThan(0)
  })

  it('the preview uses the SAME maths as the download', () => {
    const input = { style: DEFAULT_STYLE, ...photo, overlayWidth: 2048, overlayHeight: 360 }
    const box = placeOverlay(input)
    const pct = placementAsPercent(input)
    expect(pct.height).toBe(`${(box.height / photo.photoHeight) * 100}%`)
    expect(pct.width).toBe('100%')
    expect(pct.left).toBe('0%')
  })
})

// ═══════════════ Safe area ═══════════════

describe('safeArea', () => {
  it('insets evenly from every edge', () => {
    const area = safeArea(SPEC, 2048, 360)
    expect(area.x).toBe(Math.round(2048 * SPEC.safeAreaInset))
    expect(area.y).toBe(Math.round(360 * SPEC.safeAreaInset))
    expect(area.width).toBe(2048 - area.x * 2)
    expect(area.height).toBe(360 - area.y * 2)
  })

  it('never collapses to nothing on a tiny artboard', () => {
    const area = safeArea(SPEC, 10, 10)
    expect(area.width).toBeGreaterThan(0)
    expect(area.height).toBeGreaterThan(0)
  })
})

// ═══════════════ Future compatibility ═══════════════

describe('extensibility', () => {
  it('ships exactly one style today', () => {
    expect([...BRANDING_STYLES]).toEqual(['bottom-banner'])
    expect(DEFAULT_STYLE).toBe('bottom-banner')
  })

  it('names the planned styles WITHOUT implementing them', () => {
    // The extension point is explicit rather than implied. Each becomes a spec entry plus a
    // placement branch — no schema change, no new collection.
    expect([...PLANNED_STYLES]).toEqual([
      'full-frame', 'watermark', 'corner-logo', 'sponsor-strip', 'finisher-frame', 'vip',
    ])
    for (const planned of PLANNED_STYLES) {
      expect(isBrandingStyle(planned), planned).toBe(false)
    }
  })

  it('falls back to the shipped style rather than crashing on an unknown one', () => {
    // A stored document written by a future version must not break today's page.
    expect(specFor('full-frame' as never).style).toBe('bottom-banner')
  })

  it('is an allow-list', () => {
    for (const v of ['', 'BOTTOM-BANNER', null, undefined, 42, {}]) {
      expect(isBrandingStyle(v), String(v)).toBe(false)
    }
  })

  it('recommendedAspect is derived, never restated', () => {
    expect(recommendedAspect(SPEC)).toBeCloseTo(2048 / 360, 5)
  })
})
