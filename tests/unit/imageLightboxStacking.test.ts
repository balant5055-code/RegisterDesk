// ImageLightbox must escape page stacking contexts.
//
// THE BUG THIS PINS
// The viewer is `fixed inset-0 z-[120]`, and the marketing navbar is `fixed ... z-[100]`,
// so on paper the viewer wins. It did not, because z-index is only comparable WITHIN a
// shared stacking context. ImageLightbox was rendered in place, deep inside the page —
// and SportsHero's hero <section> carries `isolate` (`isolation: isolate`), whose only
// purpose is to open a new stacking context. The viewer's z-[120] was therefore ranked
// against that section's contents, while the navbar's z-[100] lived in the ROOT context
// and painted over the whole overlay — including the top bar that holds the close button,
// which is why the X was not reliably clickable.
//
// The fix is the escape hatch components/ui/Dialog already uses: portal to document.body.
// No z-index was raised; z-[120] simply became comparable to the navbar's z-[100].
//
// These are STRUCTURAL assertions. The behavioural half — open, close via X, Escape,
// backdrop, click-inside, scroll lock/unlock, repeated open/close — needs a real browser
// (this repo has no jsdom/testing-library, and playwright.config.ts declares itself
// "DEV TOOLING ONLY … not to run a functional test suite"). That half was verified in
// Chromium at 1280×720, 1440×900 and 390×844; see the audit report.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8')

const LIGHTBOX = read('components/event-templates/shared/ui/ImageLightbox.tsx')
const NAVBAR   = read('components/marketing/navigation/MarketingNavbar.tsx')
const DIALOG   = read('components/ui/Dialog.tsx')
const HERO     = read('components/event-templates/sports/SportsHero.tsx')

/** First `z-[N]` in a source file. */
function zIndexOf(src: string): number | null {
  const m = /z-\[(\d+)\]/.exec(src)
  return m ? Number(m[1]) : null
}

describe('ImageLightbox renders through a portal', () => {
  it('imports createPortal', () => {
    expect(LIGHTBOX).toMatch(/import\s*\{\s*createPortal\s*\}\s*from\s*'react-dom'/)
  })

  it('portals the overlay to document.body — this is the regression', () => {
    // Rendered in place, z-[120] is trapped inside whatever stacking context the call
    // site sits in. document.body puts it in the root context.
    expect(LIGHTBOX).toMatch(/return createPortal\(/)
    expect(LIGHTBOX).toMatch(/document\.body,\s*\)/)
  })

  it('is SSR-safe, the same way Dialog is', () => {
    expect(LIGHTBOX).toContain("typeof document === 'undefined'")
    expect(DIALOG).toContain("typeof document === 'undefined'")
  })

  it('reuses the project overlay pattern rather than inventing one', () => {
    // Dialog is the existing precedent: portal into document.body.
    expect(DIALOG).toMatch(/createPortal\([\s\S]*document\.body,\s*\)/)
  })
})

describe('stacking order is correct once the portal is in place', () => {
  it('the lightbox outranks the marketing navbar', () => {
    const lightbox = zIndexOf(LIGHTBOX)
    const navbar   = zIndexOf(NAVBAR)
    expect(lightbox, 'lightbox z-index').not.toBeNull()
    expect(navbar, 'navbar z-index').not.toBeNull()
    expect(lightbox!).toBeGreaterThan(navbar!)
  })

  it('keeps the ORIGINAL z-index — the fix was the portal, not a bigger number', () => {
    expect(zIndexOf(LIGHTBOX)).toBe(120)
    expect(zIndexOf(NAVBAR)).toBe(100)
  })
})

describe('the stacking context that caused this still exists', () => {
  it('the sports hero section is still isolated', () => {
    // Documents WHY the portal is required. If `isolate` is ever removed the portal is
    // still correct — but this records the original trap so it is not re-introduced by
    // someone "simplifying" the lightbox back to an in-place render.
    // Matches the `isolate` utility wherever it sits in the class list, rather than
    // requiring it to be the first token. The original regex was anchored to
    // `className="relative isolate`, so adding any earlier class — e.g. the
    // `sports-hero` scoping hook — failed the test without the stacking context
    // having changed at all. What matters is that `isolate` is still applied.
    expect(HERO).toMatch(/className="[^"]*\bisolate\b/)
  })
})

describe('close affordances are present', () => {
  it('has an accessible close button', () => {
    expect(LIGHTBOX).toMatch(/aria-label="Close"/)
    expect(LIGHTBOX).toMatch(/onClick=\{onClose\}/)
  })

  it('closes on Escape', () => {
    expect(LIGHTBOX).toMatch(/e\.key === 'Escape'/)
  })

  it('closes on backdrop click but not on clicks inside the dialog', () => {
    // Backdrop closes; the inner dialog stops propagation so a click on the poster stays open.
    expect(LIGHTBOX).toMatch(/onClick=\{e => e\.stopPropagation\(\)\}/)
  })

  it('locks body scroll while open and restores the previous value on close', () => {
    expect(LIGHTBOX).toMatch(/document\.body\.style\.overflow = 'hidden'/)
    expect(LIGHTBOX).toMatch(/document\.body\.style\.overflow = prevOverflow/)
  })

  it('removes its keydown listener on cleanup — no listener leak across open/close', () => {
    expect(LIGHTBOX).toMatch(/document\.addEventListener\('keydown', onKey\)/)
    expect(LIGHTBOX).toMatch(/document\.removeEventListener\('keydown', onKey\)/)
  })
})

// ─── The SAME defect in the attendee photo editor ─────────────────────────────
//
// ImageCropperModal is the full-screen crop/zoom/rotate editor opened from the public
// Certificate Center (/events/[slug]/certificates) and from organizer settings. It had the
// identical shape as the lightbox bug above: `fixed inset-0` with a z-index, rendered IN
// PLACE deep inside page content. Its `z-50` was ranked inside the Certificate Center's
// subtree, while MarketingNavbar's `z-[100]` sits in the ROOT stacking context — so the
// navbar painted across the top of the editor, over the Cancel control, and consumed
// viewport the editor was supposed to own.
//
// Same fix, same precedent: portal to document.body and adopt the z-[120] overlay tier the
// lightbox already established. The navbar itself is untouched.

const CROPPER = read('components/ui/ImageCropperModal.tsx')

/**
 * Comment-stripped source.
 *
 * `zIndexOf` returns the FIRST `z-[N]` in a file, and the cropper's comment explains the bug
 * by NAMING the navbar's z-[100] — so scanning raw source reads the prose, not the class.
 * The same applies to the "does not touch the navbar" check: the comment mentions
 * MarketingNavbar precisely because the fix deliberately leaves it alone.
 */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const CROPPER_CODE = code(CROPPER)

describe('ImageCropperModal escapes page stacking contexts', () => {
  it('imports createPortal', () => {
    expect(CROPPER).toMatch(/import\s*\{\s*createPortal\s*\}\s*from\s*'react-dom'/)
  })

  it('portals the overlay to document.body — this is the regression', () => {
    expect(CROPPER).toMatch(/return createPortal\(/)
    expect(CROPPER).toMatch(/document\.body,\s*\)/)
  })

  it('is SSR-safe, the same way Dialog and the lightbox are', () => {
    expect(CROPPER).toContain("typeof document === 'undefined'")
  })

  it('outranks the marketing navbar', () => {
    const cropper = zIndexOf(CROPPER_CODE)
    const navbar  = zIndexOf(NAVBAR)
    expect(cropper, 'cropper z-index').not.toBeNull()
    expect(cropper!).toBeGreaterThan(navbar!)
  })

  it('uses the EXISTING overlay tier rather than an arbitrary huge number', () => {
    // z-[120] is the tier ImageLightbox already established for full-viewport overlays.
    // A z-[9999] here would paper over the real problem and start a second convention.
    expect(zIndexOf(CROPPER_CODE)).toBe(120)
    expect(zIndexOf(CROPPER_CODE)).toBe(zIndexOf(code(LIGHTBOX)))
  })

  it('no longer relies on the trapped z-50', () => {
    expect(CROPPER).not.toMatch(/className="fixed inset-0 z-50/)
  })

  it('covers the whole viewport rather than offsetting around the navbar', () => {
    // The forbidden alternative: a hardcoded navbar height, a top offset, or a margin hack.
    expect(CROPPER).toMatch(/fixed inset-0/)
    expect(CROPPER).not.toMatch(/top-\[\d+px\]|mt-\[\d+px\]|pt-\[\d+px\]/)
  })
})

describe('the photo editor behaves as a modal', () => {
  it('locks body scroll while open and restores the PREVIOUS value on close', () => {
    // Restoring the previous value (not '') matters: the editor can be opened from inside
    // another overlay that already locked the page.
    expect(CROPPER).toMatch(/document\.body\.style\.overflow = 'hidden'/)
    expect(CROPPER).toMatch(/document\.body\.style\.overflow = prevOverflow/)
  })

  it('traps focus and marks itself as a modal', () => {
    expect(CROPPER).toMatch(/useFocusTrap/)
    expect(CROPPER).toMatch(/role="dialog"/)
    expect(CROPPER).toMatch(/aria-modal="true"/)
  })

  it('closes on Escape and removes its listener on cleanup', () => {
    expect(CROPPER).toMatch(/e\.key === 'Escape'/)
    expect(CROPPER).toMatch(/document\.removeEventListener\('keydown', onKey\)/)
  })

  it('does not hide or alter the navbar to get out of its way', () => {
    // The navbar must be restored untouched when the editor closes, so the editor may not
    // reach outside itself to suppress it.
    // Comment-stripped: the explanatory comment above the portal NAMES MarketingNavbar,
    // precisely to record that the fix leaves it alone. Scanning raw source would fail on
    // its own documentation.
    expect(CROPPER_CODE).not.toMatch(/MarketingNavbar|display:\s*'none'/)
  })
})

describe('the editor keeps every existing capability', () => {
  it('still exposes crop, zoom, rotation, reset, apply and cancel', () => {
    for (const token of ['setCrop', 'setZoom', 'setRotation', 'handleReset', 'handleApply', 'onCancel']) {
      expect(CROPPER, token).toContain(token)
    }
  })

  it('still renders at the configured output size — no quality change', () => {
    expect(CROPPER).toMatch(/getCroppedBlob\(imageSrc, croppedAreaPixels, rotation, config\.outputWidth, config\.outputHeight\)/)
  })

  it('still hands back a File plus an object URL, unchanged', () => {
    expect(CROPPER).toMatch(/new File\(\[blob\]/)
    expect(CROPPER).toMatch(/URL\.createObjectURL\(blob\)/)
    expect(CROPPER).toMatch(/onApply\(file, previewUrl\)/)
  })

  it('performs no upload or storage work itself — that stays with the caller', () => {
    for (const forbidden of ['fetch(', 'firebase', 'uploadBytes', 'generateSignedUrl', 'buildObjectKey', '/api/']) {
      expect(CROPPER_CODE, forbidden).not.toContain(forbidden)
    }
  })
})
