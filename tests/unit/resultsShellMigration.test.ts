// ─── The public results surface joins the site ───────────────────────────────
//
// `/results` and its three children are PUBLIC discovery pages — a finisher opens one from
// a link an organizer sent, a stranger finds one through search — and they used to render
// no site header and no site footer at all. From a leaderboard there was no way back to
// RegisterDesk except the browser's back button, and no footer to say whose site it was.
//
// ═══ WHAT THESE TESTS PIN ════════════════════════════════════════════════════
// That the chrome arrives through ONE seam. ResultsShell is the only thing the four routes
// compose through, so it is the only file that may know about the shell — a route that
// mounts HomeNavbar, HomeFooter or its own <main> has broken the property, and it is that
// duplication, not the wrapper itself, that these tests exist to catch.
//
// ═══ AND THAT THE ACCENT IS THE PUBLIC ONE ═══════════════════════════════════
// RegisterDesk runs a two-accent split: --action (indigo → violet) is the public site,
// --primary (magenta) is the organizer and admin product. Results wore --primary on every
// eyebrow, link, focus ring and trophy chip while sitting on the public web. The last block
// keeps it on the public side of that split — and keeps --primary available to the product,
// which is a different surface and out of scope here.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

// MarketingNavbar and HomeNavbar are client islands that read the path; this is what lets
// the render block below mount the real shell and count its landmarks.
vi.mock('next/navigation', () => ({ usePathname: () => '/results' }))

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')

/** Assertions must read code, never the prose that explains it. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const CHROME = 'features/race-operations/components/public/ResultsChrome.tsx'

const ROUTES: Record<string, string> = {
  '/results':                                   'app/results/page.tsx',
  '/results/[eventSlug]':                       'app/results/[eventSlug]/page.tsx',
  '/results/[eventSlug]/[passSlug]':            'app/results/[eventSlug]/[passSlug]/page.tsx',
  '/results/[eventSlug]/[passSlug]/[bibNumber]':'app/results/[eventSlug]/[passSlug]/[bibNumber]/page.tsx',
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('ResultsShell delegates to the canonical public shell', () => {
  const src = code(read(CHROME))

  it('renders HomeShell', () => {
    expect(src).toContain("from '@/components/discovery/home/HomeShell'")
    expect(src).toMatch(/<HomeShell>[\s\S]*<\/HomeShell>/)
  })

  it('keeps only the results content well', () => {
    // The layout that is genuinely Results' own — the 5xl measure and its padding rhythm —
    // is unchanged. Everything else about the page frame now comes from the shell.
    expect(src).toContain('mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12')
  })

  it('dropped the canvas HomeShell already owns', () => {
    // `min-h-dvh bg-background` duplicated HomeShell's root. Leaving it would have been a
    // second full-height canvas inside the first — harmless to look at, and exactly the
    // kind of nesting that makes a later spacing bug impossible to trace.
    expect(src).not.toContain('min-h-dvh')
  })

  it('creates no second <main> landmark', () => {
    // HomeShell owns the one <main id="main-content">. A nested main is invalid HTML and
    // silently breaks the skip link, which is the specific hazard of wrapping shells.
    expect(src).not.toContain('<main')
    expect(src).not.toContain('id="main-content"')
    expect(code(read('components/discovery/home/HomeShell.tsx'))).toContain('id="main-content"')
  })

  it('mounts no navbar or footer of its own', () => {
    for (const name of ['HomeNavbar', 'HomeFooter', 'MarketingNavbar', 'MarketingFooter']) {
      expect(src, name).not.toContain('<' + name)
    }
  })
})

describe('all four results routes inherit the shell through that one seam', () => {
  for (const [route, file] of Object.entries(ROUTES)) {
    it(route + ' composes through ResultsShell and nothing else', () => {
      const src = code(read(file))
      expect(src).toContain('<ResultsShell>')
      // The failure this guards: a page reaching for the chrome directly, which is how a
      // surface ends up with two headers and how the seam stops being a seam.
      for (const name of ['HomeShell', 'HomeNavbar', 'HomeFooter', 'MarketingNavbar', 'MarketingFooter']) {
        expect(src, route + ' must not mount ' + name).not.toContain('<' + name)
      }
      expect(src, route + ' must not declare its own <main>').not.toContain('<main')
    })
  }

  it('ResultsShell is the only file that knows about the shell', () => {
    for (const file of Object.values(ROUTES)) {
      expect(code(read(file)), file).not.toContain('discovery/home/HomeShell')
    }
    expect(code(read(CHROME))).toContain('discovery/home/HomeShell')
  })
})

describe('the shell RENDERS one header, one footer and one main', () => {
  it('exactly one of each, with the results content inside', async () => {
    const { ResultsShell } = await import('@/features/race-operations/components/public/ResultsChrome')
    const html = renderToStaticMarkup(
      createElement(ResultsShell, null, createElement('p', null, 'LEADERBOARD')),
    )
    expect(html.match(/<footer[\s>]/g) ?? []).toHaveLength(1)
    expect(html.match(/id="main-content"/g) ?? []).toHaveLength(1)
    expect(html.match(/<main[\s>]/g) ?? []).toHaveLength(1)
    expect(html).toContain('LEADERBOARD')
    // The content well survives the swap.
    expect(html).toContain('max-w-5xl')
  })

  it('has exactly one BANNER landmark', () => {
    // Counting <header> tags alone is misleading: a <header> inside <main> carries no
    // landmark role at all (HTML-AAM — banner applies only outside main/article/aside/
    // section/nav), and ResultsHeader's is a page-title block scoped inside the content.
    // What must be unique is the banner, and that is HomeNavbar's.
    const shell = code(read('components/discovery/home/HomeShell.tsx'))
    expect(shell.match(/<header[\s>]/g) ?? []).toHaveLength(0)   // the bar lives in HomeNavbar
    const navbar = code(read('components/discovery/home/HomeNavbar.tsx'))
    expect(navbar.match(/<header[\s>]/g) ?? []).toHaveLength(1)
    // ResultsHeader keeps its sectioning <header>; it is inside <main>, so it adds no
    // second banner. This asserts it stayed put rather than being silently rewritten.
    expect(code(read(CHROME))).toContain('<header className="mb-6">')
  })
})

describe('results functionality is untouched', () => {
  it('every page keeps its data fetching, params and metadata', () => {
    const expectations: Record<string, string[]> = {
      'app/results/page.tsx': ['getRecentResults', 'groupRacesByEvent', 'export const metadata'],
      'app/results/[eventSlug]/page.tsx': ['notFound()', 'robots: { index: false, follow: true }', 'generateMetadata'],
      'app/results/[eventSlug]/[passSlug]/page.tsx': ['notFound()', 'LeaderboardTable', 'generateMetadata'],
      'app/results/[eventSlug]/[passSlug]/[bibNumber]/page.tsx': ['notFound()', 'generateMetadata'],
    }
    for (const [file, needles] of Object.entries(expectations)) {
      const src = read(file)
      for (const n of needles) expect(src, file + ' → ' + n).toContain(n)
    }
  })

  it('an unknown event still 404s rather than rendering an empty shell', () => {
    // The gate is notFound() BEFORE the shell, so a bogus slug produces a real 404 and not
    // a chrome-wrapped blank page. Adding a shell must not turn a 404 into a 200.
    for (const file of [
      'app/results/[eventSlug]/page.tsx',
      'app/results/[eventSlug]/[passSlug]/page.tsx',
      'app/results/[eventSlug]/[passSlug]/[bibNumber]/page.tsx',
    ]) {
      const src = code(read(file))
      const gate = src.indexOf('notFound()')
      const shell = src.indexOf('<ResultsShell>')
      expect(gate, file + ' must gate before it renders').toBeGreaterThan(-1)
      expect(gate, file + ' must call notFound() before the shell').toBeLessThan(shell)
    }
  })

  it('the leaderboard still scrolls inside its own container', () => {
    // The table is min-w-[560px]; it must scroll in its own box so the page body never
    // scrolls sideways at 320px. Wrapping the surface in a shell must not change that.
    const src = code(read(CHROME))
    expect(src).toContain('overflow-x-auto')
    expect(src).toContain('min-w-[560px]')
  })
})

describe('the public accent, and only on the public surface', () => {
  const FILES = [CHROME, ...Object.values(ROUTES)]

  it('no --primary anywhere on the results surface', () => {
    for (const f of FILES) {
      const src = code(read(f))
      expect(src, f + ' still uses the product accent').not.toMatch(/[\w-]*-primary[\w/[\].-]*/)
      expect(src, f).not.toContain('--primary')
    }
  })

  it('uses the canonical action tokens instead', () => {
    const chrome = code(read(CHROME))
    expect(chrome).toContain('text-action')
    expect(chrome).toContain('focus-visible:ring-action')
    // The race card's filled gradient tile was replaced by a bronze-outlined one in the
    // 2026-09-23 luxury pass (owner request). What this test guards is unchanged: the results
    // surface speaks the PUBLIC accent, never the product magenta.
    expect(chrome).not.toMatch(/\b(?:text|bg|border|ring)-primary\b|var\(--primary/)
  })

  it('--primary is still defined and still used by the product', () => {
    // The token is NOT retired — organizer and admin surfaces depend on it. This phase
    // moved one public surface off it, nothing more.
    expect(read('styles/tokens.css')).toContain('--primary')
    expect(existsSync(resolvePath(ROOT, 'app/(dashboard)/layout.tsx'))).toBe(true)
  })

  it('introduces no rounded-full and no hardcoded colour', () => {
    for (const f of FILES) {
      const src = code(read(f))
      expect(src, f).not.toContain('rounded-full')
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src, f).not.toMatch(/\brgba?\(/)
    }
  })
})

describe('nothing outside results moved', () => {
  // These two seams were pinned here as "still mount MarketingNavbar + MarketingFooter" —
  // the assertion was that the RESULTS migration had not reached them. They have since
  // been migrated by the public chrome unification, on purpose, and what this file still
  // owns is the narrower claim: neither of them reaches ResultsShell, which is results-only.
  it('EventPageShell delegates to the canonical public shell, not the results shell', () => {
    const src = code(read('components/event-templates/shared/ui/EventPageShell.tsx'))
    expect(src).toContain('<HomeShell>')
    expect(src).not.toContain('ResultsShell')
    expect(src).not.toContain('MarketingNavbar')
  })

  it('EventUtilityLayout delegates to the canonical public shell, not the results shell', () => {
    const src = code(read('components/marketing/layout/EventUtilityLayout.tsx'))
    expect(src).toMatch(/<HomeShell>\s*\{children\}\s*<\/HomeShell>/)
    expect(src).not.toContain('ResultsShell')
    expect(src).not.toContain('MarketingNavbar')
  })

  it('the marketing seam still delegates to HomeShell', () => {
    const src = code(read('components/marketing/layout/MarketingPageLayout.tsx'))
    expect(src).toMatch(/<HomeShell>\s*\{children\}\s*<\/HomeShell>/)
  })

  it('HomeShell itself was not redesigned', () => {
    const src = code(read('components/discovery/home/HomeShell.tsx'))
    expect(src).toContain('<HomeNavbar />')
    expect(src).toContain('<HomeFooter />')
    expect(src).toContain('id="main-content"')
    expect(src).toContain('pt-[var(--disc-nav-h)]')
  })
})
