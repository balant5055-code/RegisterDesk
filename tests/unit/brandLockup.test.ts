// The public RegisterDesk identity: one mark, one name, one tagline.
//
// ═══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════
// public/logo/RegisterDesk-Logo.svg used to be a horizontal lockup with the wordmark drawn
// INTO the artwork (658×127). It was replaced in place by the mark alone. Every surface that
// scaled the old file to a wordmark's proportions was therefore rendering a small icon
// letterboxed inside a wide empty box — the brand NAME had silently disappeared from the
// public site. The name and tagline are text now, and these tests pin that they cannot drift,
// be reworded, or go missing again.
//
// ═══ AND WHAT IT PINS ABOUT THE ASSET ════════════════════════════════════════
// The mark then broke a second time, differently: the components pointed at a derived
// `-optimized.webp` that is not in public/ (404), and simply repointing them at the .svg is
// not a fix either, because /_next/image rejects SVG (400). Both failure modes look identical
// on screen — a broken-image icon — so both are pinned below, along with the security reason
// the platform-wide SVG switch is not the remedy.
//
// BrandLockup renders here for real; the navbars and footers that consume it are client
// components with hooks and motion, so their half is pinned as a source contract — which is
// the stronger assertion anyway: it catches a lockup added behind a branch no fixture reaches.

import { describe, it, expect } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { BrandLockup, BRAND_NAME, BRAND_TAGLINE } from '@/components/marketing/BrandLockup'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

/**
 * Source with comments stripped.
 *
 * Necessary because several of these files DOCUMENT the very thing being asserted absent — the
 * old 658×127 box, the raw asset path, the word aria-label. A raw substring check would fail
 * on the explanation rather than on the code.
 */
const code = (p: string) =>
  read(p).split('\n').filter(l => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')
const render = (props: Parameters<typeof BrandLockup>[0] = {}) =>
  renderToStaticMarkup(createElement(BrandLockup, props))

/**
 * The ONE asset the browser fetches. The source SVG in public/ is the canonical brand mark and
 * is what every surface loads directly.
 */
const CANONICAL_MARK = '/logo/RegisterDesk-Logo.svg'

/**
 * A raster derivative that the brand components used to point at. It is NOT in public/, so the
 * reference 404'd and every surface drew a broken-image icon beside the wordmark. These
 * assertions are what stop it — or any other invented derivative — being wired back in.
 */
const LEGACY_MARK = '/logo/RegisterDesk-Logo-optimized.webp'

/** Both components that draw the RegisterDesk mark on a public/product surface. */
const BRAND_COMPONENTS = [
  'components/marketing/BrandLockup.tsx',
  'components/marketing/MarketingLogo.tsx',
]

/** Every public surface that must show the canonical identity. */
const PUBLIC_SURFACES = [
  // MarketingNavbar / MobileDrawer / MarketingFooter were retired with the legacy chrome.
  //
  // HomeFooter is NOT in this list any more, and that is a decision rather than an
  // oversight: its opening band — lockup, product sentence and organizer door — was
  // removed on request, so the footer draws no lockup. It still spells the product, from
  // BRAND_NAME, as the closing signature; the surfaces below are the ones that render the
  // full mark-plus-name-plus-tagline lockup.
  'components/discovery/home/HomeNavbar.tsx',
  'app/(auth)/welcome/page.tsx',
]

// ═══ 1 · The canonical content ═══════════════════════════════════════════════

describe('the brand strings are exact, and written in exactly one place', () => {
  it('the tagline is verbatim', () => {
    expect(BRAND_TAGLINE).toBe('POWERING EVENTS. SIMPLIFYING OPERATIONS.')
    expect(BRAND_NAME).toBe('RegisterDesk')
  })

  it('renders the name and the tagline', () => {
    const html = render()
    expect(html).toContain('RegisterDesk')
    expect(html).toContain('POWERING EVENTS. SIMPLIFYING OPERATIONS.')
  })

  it('no public surface spells the tagline itself', () => {
    // Duplicating it in six files is how two slightly different taglines get shipped.
    for (const f of PUBLIC_SURFACES) {
      expect(read(f), f).not.toContain('POWERING EVENTS')
      expect(read(f), f).not.toContain('SIMPLIFYING OPERATIONS')
    }
  })
})

// ═══ 2 · The spatial relationship ════════════════════════════════════════════

describe('mark left, name above tagline', () => {
  it('the mark is the canonical SVG, before the text, served without the optimizer', () => {
    const html = render()
    // Emitted verbatim. `unoptimized` keeps the element off /_next/image, which is the whole
    // point: that endpoint answers 400 for SVG unless images.dangerouslyAllowSVG is set, and
    // a 400 here is a broken-image icon in the navbar.
    expect(html).toContain(`src="${CANONICAL_MARK}"`)
    expect(html).not.toContain('/_next/image')
    expect(html).not.toContain(LEGACY_MARK)
    // Icon first in DOM order — it is drawn to the LEFT of the text.
    expect(html.indexOf(CANONICAL_MARK)).toBeLessThan(html.indexOf('RegisterDesk<'))
  })

  it('the declared box IS the source viewBox, read from the file rather than retyped', () => {
    // The declared box reserves space before the image loads, so the lockup does not jump
    // mid-load, and it is what `w-auto` resolves the drawn width against. Parsing the real
    // viewBox instead of hardcoding numbers is what makes this survive an artwork swap: change
    // the file and this test tells you the component still claims the old geometry.
    const head = read('public/logo/RegisterDesk-Logo.svg').slice(0, 1200)
    const vb = head.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/)
    expect(vb, 'source SVG must declare a viewBox').not.toBeNull()
    const [, w, h] = vb!

    const src = code('components/marketing/BrandLockup.tsx')
    expect(src).toContain(`const ICON_W = ${w}`)
    expect(src).toContain(`const ICON_H = ${h}`)

    const html = render()
    expect(html).toContain(`width="${w}"`)
    expect(html).toContain(`height="${h}"`)
  })

  it('every component that draws the mark opts out of the optimizer', () => {
    // The regression this pins: repointing `src` at the .svg WITHOUT this is not a fix — the
    // request becomes /_next/image?url=…svg, which 400s, and the broken image stays.
    for (const f of BRAND_COMPONENTS) {
      expect(code(f), f).toContain('unoptimized')
    }
  })

  it('SVG is not enabled platform-wide to make the logo work', () => {
    // images.remotePatterns admits organiser-supplied hosts, so dangerouslyAllowSVG would let
    // an uploaded SVG — an active document — be served from our own origin. The per-image
    // opt-out above exists precisely so this switch stays off.
    expect(read('next.config.ts')).not.toContain('dangerouslyAllowSVG')
  })

  it('the name comes before the tagline, never beside or above it', () => {
    const html = render()
    expect(html.indexOf('RegisterDesk<')).toBeLessThan(html.indexOf('POWERING EVENTS'))
    // A column, so the tagline sits UNDER the name rather than next to it.
    expect(html).toContain('flex-col')
  })

  it('the artwork is used untouched — no recolour, filter, gradient or shadow on it', () => {
    const src = code('components/marketing/BrandLockup.tsx')
    for (const banned of ['drop-shadow', 'shadow-', 'blur', 'invert', 'grayscale', 'saturate', 'bg-gradient', 'filter:']) {
      expect(src, banned).not.toContain(banned)
    }
  })

  it('introduces no hardcoded colours', () => {
    const src = code('components/marketing/BrandLockup.tsx')
      .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(src).not.toMatch(/\b(rgba?|hsla?)\(/)
    // Semantic tokens only.
    expect(src).toContain('text-foreground')
    expect(src).toContain('text-muted-foreground')
  })
})

// ═══ 3 · Consistent proportions across sizes ═════════════════════════════════

describe('one identity at three scales', () => {
  const sizes = ['sm', 'md', 'lg'] as const

  it('every size renders the same three parts', () => {
    for (const size of sizes) {
      const html = render({ size })
      expect(html, size).toContain(CANONICAL_MARK)
      expect(html, size).toContain('RegisterDesk')
      expect(html, size).toContain('POWERING EVENTS. SIMPLIFYING OPERATIONS.')
    }
  })

  it('the wordmark stays inside the intended range and the tagline stays readable', () => {
    const src = code('components/marketing/BrandLockup.tsx')
    const names = [...src.matchAll(/name:\s*'text-\[(\d+(?:\.\d+)?)px\][^']*?(?:text-\[(\d+(?:\.\d+)?)px\])?'/g)]
    expect(names.length).toBe(3)
    for (const m of names) {
      for (const px of [m[1], m[2]].filter(Boolean)) {
        expect(Number(px), `wordmark ${px}px`).toBeGreaterThanOrEqual(16)
        expect(Number(px), `wordmark ${px}px`).toBeLessThanOrEqual(24)
      }
    }
    const tags = [...src.matchAll(/tag:\s*'text-\[(\d+(?:\.\d+)?)px\][^']*?(?:text-\[(\d+(?:\.\d+)?)px\])?/g)]
    expect(tags.length).toBe(3)
    for (const m of tags) {
      for (const px of [m[1], m[2]].filter(Boolean)) {
        // Never smaller than 6.5px — below that it is texture, not language.
        expect(Number(px), `tagline ${px}px`).toBeGreaterThanOrEqual(6.5)
        expect(Number(px), `tagline ${px}px`).toBeLessThanOrEqual(9)
      }
    }
  })

  it('the tagline never wraps or is hidden to make room', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const html = render({ size })
      expect(html, size).toContain('whitespace-nowrap')
      expect(html, size).not.toContain('sr-only')
      expect(html, size).not.toMatch(/hidden\s+(sm|md|lg):(inline|block|flex)/)
    }
  })
})

// ═══ 4 · Routing and accessibility ═══════════════════════════════════════════

describe('the lockup is one link to / named RegisterDesk', () => {
  it('links to the homepage', () => {
    expect(render()).toContain('href="/"')
  })

  it('the mark is decorative, so the brand is not announced twice', () => {
    const html = render()
    expect(html).toContain('alt=""')
    expect(html).toContain('aria-hidden="true"')
  })

  it('carries no aria-label that would override the visible wordmark', () => {
    // An aria-label here would silently replace "RegisterDesk" as the accessible name.
    expect(code('components/marketing/BrandLockup.tsx')).not.toContain('aria-label')
  })

  it('the tagline is excluded from the accessible name', () => {
    const html = render()
    // Strip every aria-hidden subtree the way the accessibility tree does.
    const visible = html
      // The mark first — a void element, so it has no subtree to remove. Removing it before
      // the span pass is what stops the span regex running from the <img> to the wordmark's
      // own closing tag and swallowing the name.
      .replace(/<img\b[^>]*aria-hidden="true"[^>]*>/g, '')
      // Then the tagline's span together with its contents.
      .replace(/<span\b[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    expect(visible).toBe('RegisterDesk')
  })
})

// ═══ 5 · Migration is complete, and stops at the right boundary ══════════════

describe('every public surface uses the lockup; protected surfaces are untouched', () => {
  it('every public surface that shows the identity renders BrandLockup', () => {
    for (const f of PUBLIC_SURFACES) {
      const src = read(f)
      expect(src, f).toContain('<BrandLockup')
      expect(src, f).toContain("from '@/components/marketing/BrandLockup'")
    }
  })

  it('no public surface still renders the mark-only MarketingLogo', () => {
    for (const f of PUBLIC_SURFACES) {
      expect(read(f), f).not.toContain('<MarketingLogo')
    }
  })

  it('no public surface reaches past the component to the raw asset', () => {
    // One component owns the asset path; a second <img src="/logo/…"> is a second identity.
    for (const f of PUBLIC_SURFACES) {
      expect(code(f), f).not.toContain('/logo/RegisterDesk-Logo')
    }
  })

  it('the event checkout bar carries the full lockup, but still no public chrome', () => {
    // app/events/[slug]/** was out of scope for the public branding pass and the checkout
    // bar stayed on the mark-only component. Changed deliberately on 2026-09-23 (owner
    // request: the checkout header must show the RegisterDesk name, not a bare mark). The
    // checkout stays a FOCUSED surface: the lockup, never the public navbar or footer.
    const src = read('app/events/[slug]/register/RegistrationUI.tsx')
    expect(src).toContain('<BrandLockup')
    expect(src).not.toContain('<MarketingLogo')
    // Comment-stripped: the file's prose explains WHY it avoids those names.
    expect(code('app/events/[slug]/register/RegistrationUI.tsx')).not.toMatch(/HomeNavbar|HomeFooter|MarketingNavbar|MarketingFooter/)
  })

  it('MarketingLogo declares the asset\'s real intrinsic box', () => {
    const src = code('components/marketing/MarketingLogo.tsx')
    expect(src).toContain('width={1254}')
    expect(src).toContain('height={1254}')
    expect(src).toContain(CANONICAL_MARK)
    expect(src).not.toContain('658')
  })

  it('EVERY surface that draws the mark points at the canonical SVG and nothing else', () => {
    // One asset, one path. The dashboard sidebar is included because it drew the same broken
    // reference as the public chrome — the bug was never confined to marketing.
    for (const f of [...BRAND_COMPONENTS, 'components/dashboard/Sidebar.tsx']) {
      expect(code(f), f).toContain(CANONICAL_MARK)
      expect(code(f), f).not.toContain(LEGACY_MARK)
    }
  })

  it('no invented derivative of the mark is referenced anywhere', () => {
    // The previous reference was to a file that did not exist. Nothing under /logo/ may be
    // named by the components except the one asset that is actually on disk.
    for (const f of [...BRAND_COMPONENTS, 'components/dashboard/Sidebar.tsx']) {
      const refs = [...code(f).matchAll(/['"](\/logo\/[^'"]+)['"]/g)].map(m => m[1])
      // 2026-09-25 (owner): ONE derivative is allowed — the canonical mark with its white
      // ground removed and trimmed (RegisterDesk-Mark.png), used only on photography
      // (tone='media'), where the white square read as a tile. Same pixels, no redraw.
      for (const r of refs) expect([CANONICAL_MARK, '/logo/RegisterDesk-Mark.png'], `${f} references ${r}`).toContain(r)
    }
  })

  it('the canonical asset is on disk and is a real SVG', () => {
    const p = resolve(process.cwd(), `public${CANONICAL_MARK}`)
    expect(statSync(p).isFile()).toBe(true)
    const head = read(`public${CANONICAL_MARK}`).slice(0, 1200)
    expect(head).toContain('<svg')
    expect(head).toMatch(/viewBox="0 0 [\d.]+ [\d.]+"/)
    // An active document served from our own origin: it must carry no script and no external
    // reference. The embedded raster is a data: URI and is fine; a remote href is not.
    const full = read(`public${CANONICAL_MARK}`)
    expect(full).not.toContain('<script')
    expect(full).not.toMatch(/href="(?!data:|#)[a-z]+:/i)
    expect(full).not.toMatch(/file:\/\//)
  })

  it('the mark does not grow past its already-large payload', () => {
    // A ratchet, not a ceiling. The canonical SVG is an Inkscape autotrace over an embedded
    // PNG: ~3.94 MB on disk, ~1.48 MB brotli, and it is `priority` in the navbar. That cost is
    // accepted deliberately — the SVG is the brand source of truth — but it must not silently
    // get worse. A re-export that tightens it will fail here too, which is the prompt to lower
    // this number.
    const bytes = statSync(resolve(process.cwd(), `public${CANONICAL_MARK}`)).size
    expect(bytes).toBeLessThanOrEqual(4_000_000)
    expect(bytes).toBeGreaterThan(1_000)   // a truncated or empty file must fail too
  })

  it('favicon and app-icon configuration is untouched by the brand mark', () => {
    // The new asset is the website mark, not a square app icon; app/layout.tsx must keep
    // pointing at the dedicated /favicon assets.
    const layout = read('app/layout.tsx')
    expect(layout).toContain('/favicon/apple-touch-icon.png')
    expect(layout).toContain('/favicon/site.webmanifest')
    expect(layout).not.toContain('RegisterDesk-Logo.svg')
  })

  it('the asset is the mark, not the old wordmark lockup', () => {
    // The original file drew the wordmark INTO the artwork at 658×127, a 5.18:1 letterbox.
    // Anything near that ratio means the wordmark is back in the image and is now being drawn
    // twice — once as pixels, once as the text beside it.
    const head = read(`public${CANONICAL_MARK}`).slice(0, 1200)
    const [, w, h] = head.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!
    expect(Number(w) / Number(h)).toBeLessThan(2)
  })
})
