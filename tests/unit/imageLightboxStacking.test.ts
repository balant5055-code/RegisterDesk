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
    expect(HERO).toMatch(/className="relative isolate/)
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
