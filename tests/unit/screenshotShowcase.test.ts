// ─── A media region with no media is not a media region ─────────────────────
//
// All 15 product screenshots are `status: 'pending'` with `imagePath: null`, and no capture
// exists on disk. ScreenshotFrame handled that correctly — it returns null rather than
// shipping a fake skeleton. The consumers around it did not.
//
// ═══ THE BUG ═════════════════════════════════════════════════════════════════
// `getScreenshot(id)` returns a TRUTHY registry entry for a pending screenshot, so every
// consumer read that as "there is an image here" and committed to a layout for one. Each
// then wrapped the null frame in a `relative` container holding an `absolute -top-8 bottom-0`
// decorative backdrop. With the frame gone the container collapsed to 0px — but an absolute
// child anchored `-top-8 bottom-0` against a 0px parent still paints. Measured in a
// production build: 35 orphan overlays across 17 pages, 24–40px tall, up to 1088px wide.
//
// Three severities, all from one cause:
//   • dashboard_preview — eyebrow, heading and subtitle promising a preview, with a 40px
//     tinted bar as the ENTIRE section body.
//   • product_showcase two-up — a 564x32 lavender bar floating in an otherwise empty right
//     column, reading as a card that had failed to load.
//   • hero backdrops — visually imperceptible, but the same orphaned artefact.
//
// ═══ WHAT THESE TESTS PIN ════════════════════════════════════════════════════
// The rule, not the pixels: ask `hasScreenshot` BEFORE laying out for an image. They also
// pin the thing that must never come back — a fabricated screenshot or placeholder shipped
// to fill the space.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { SCREENSHOTS, getScreenshot, hasScreenshot } from '@/content/marketing/screenshots'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * Every component that lays out around a screenshot.
 *
 * Three more were here — PlatformScreenshot, UiGallery and sections/PlatformHero — and all
 * three were deleted with the public Platform section: each was reachable only through
 * PlatformPage or /platform itself. The two that remain outlived it because /about,
 * /security and the /solutions/* pages compose with them.
 */
const CONSUMERS = [
  'components/marketing/platform/ProductShowcase.tsx',
  'components/marketing/platform/PlatformHero.tsx',
] as const

// ═══════════════════════════════════════════════════════════════════════════════

describe('the availability predicate', () => {
  it('is false for a pending entry, even though the entry exists', () => {
    // The exact trap: getScreenshot is truthy, hasScreenshot is not.
    const pending = SCREENSHOTS.find(s => s.status === 'pending')!
    expect(getScreenshot(pending.id)).toBeTruthy()
    expect(hasScreenshot(pending.id)).toBe(false)
  })

  it('is false for an unknown id and for no id', () => {
    expect(hasScreenshot('no-such-screenshot')).toBe(false)
    expect(hasScreenshot(undefined)).toBe(false)
    expect(hasScreenshot(null)).toBe(false)
  })

  it('requires BOTH an available status and a real path', () => {
    // A future entry flipped to 'available' but still imagePath: null must not count.
    const src = code(read('content/marketing/screenshots.ts'))
    expect(src).toContain("status === 'available'")
    expect(src).toContain('!!shot.imagePath')
  })
})

describe('no consumer lays out for an image it does not have', () => {
  it('every consumer asks hasScreenshot, not just getScreenshot', () => {
    for (const f of CONSUMERS) {
      expect(code(read(f)), f + ' must gate on hasScreenshot').toContain('hasScreenshot')
    }
  })

  // "a section that is ENTIRELY media is skipped, heading and all" was asserted against
  // PlatformPage, which composed the dashboard_preview and ui_gallery sections. That
  // renderer and both sections went with the public Platform section, so there is no longer
  // a media-only section anywhere on the public site to skip.

  it('the showcase drops its media COLUMN rather than leaving it empty', () => {
    const src = code(read('components/marketing/platform/ProductShowcase.tsx'))
    // Highlights survive without a capture; they just stop being half of a two-up.
    expect(src).toMatch(/if \(!media\)/)
    // 2026-09-23 luxury pass: without a capture the highlights become one centred row
    // (up to three across, hairlines between) instead of a narrow max-w-3xl list.
    expect(src).toContain("'sm:grid-cols-3'")
    // And with neither, the whole thing renders nothing.
    expect(src).toMatch(/if \(!media && !hasHighlights\) return null/)
  })

  it('the showcase renders nothing at all when it has neither media nor highlights', () => {
    // This replaces the same assertion against PlatformScreenshot and UiGallery, both of
    // which were deleted with the Platform section. ProductShowcase is now the only
    // component that can find itself with no media to lay out.
    const src = code(read('components/marketing/platform/ProductShowcase.tsx'))
    expect(src).toMatch(/if \(!media && !hasHighlights\) return null/)
  })

  it('every decorative backdrop is inside a guarded branch', () => {
    // The backdrop is what actually painted. It may only exist where a frame will render.
    for (const f of CONSUMERS) {
      const src = code(read(f))
      const overlays = (src.match(/rounded-\[2\.5rem\]/g) ?? []).length
      if (overlays === 0) continue
      // Each file that draws a backdrop must also gate on availability.
      expect(src, f + ' draws a backdrop without gating').toContain('hasScreenshot')
    }
  })
})

describe('nothing fabricated is shipped in place of a screenshot', () => {
  it('ScreenshotFrame still renders nothing rather than a skeleton', () => {
    const src = code(read('components/marketing/screenshots/ScreenshotFrame.tsx'))
    expect(src).toMatch(/if \(!available \|\| !screenshot\) return null/)
    expect(src).not.toMatch(/animate-pulse/)
  })

  it('no consumer invents placeholder or mock product UI', () => {
    for (const f of [...CONSUMERS, 'components/marketing/screenshots/ScreenshotFrame.tsx']) {
      const src = code(read(f))
      expect(src, f).not.toMatch(/animate-pulse|placeholder\.|mock|dummy|lorem/i)
    }
  })

  it('the registry still declares real captures only', () => {
    // Every entry is either a genuine image or honestly pending — never an illustration.
    for (const s of SCREENSHOTS) {
      if (s.status === 'available') expect(s.imagePath, s.id).toBeTruthy()
      else expect(s.imagePath, s.id).toBeNull()
    }
  })

  it('every screenshot carries alt text for the day it lands', () => {
    // ScreenshotFrame renders next/image with `alt={screenshot.alt}`; an entry without one
    // would ship an unlabelled image the moment its status flips.
    for (const s of SCREENSHOTS) {
      expect(s.alt?.trim(), s.id + ' has no alt text').toBeTruthy()
    }
  })
})
