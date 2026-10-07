// ─── Phase 8D: public SEO + accessibility invariants ────────────────────────
//
// Three defects, all structural rather than cosmetic, and all three cheap to reintroduce
// because nothing in the type system objects:
//
//   1. NO SKIP LINK anywhere on the public site. Every public shell already rendered
//      `<main id="main-content">`, and the only <a href="#main-content"> in the repo was in
//      the organizer dashboard. A keyboard visitor tabbed the whole masthead — wordmark, up
//      to seven nav items with dropdowns, the organizer CTA — before reaching the page, on
//      every navigation.
//   2. /verify/certificate/[id] had ZERO HEADINGS. The page is reached by scanning a QR code
//      on a printed certificate, often by a registrar or a recruiter; the verdict the whole
//      page exists to deliver ("Certificate is Valid") was a <p>, so heading navigation found
//      nothing at all.
//   3. /causes and /results HAND-ROLLED their metadata and were the only two public pages
//      with no og:image or twitter:image — every share of them rendered as a bare text link —
//      while /unsubscribe was indexable and, having no description of its own, inherited the
//      root layout's.
//
// These tests read source text on purpose. The shells are Server Components composing other
// Server Components (HomeNavbar, MarketingFooter) that reach for Firestore and next/headers,
// so rendering them in vitest would boot firebase-admin. What matters here is structural
// anyway — DOM ORDER of the skip link, the count of <main> landmarks, which builder the
// metadata comes from — and that is exactly what the source states.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { buildMetadata, SITE } from '@/lib/marketing/seo'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
/** Source with comments removed — every prose block above would otherwise match. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** The ONE shell that wraps a PUBLIC page. The dashboard shell is out of scope: it has
 *  had a skip link all along, and it rings --primary, correct for organizer surfaces. */
const CANONICAL_SHELL = 'components/discovery/home/HomeShell.tsx'

/** Shells that USED to own chrome and now delegate to the canonical one. They survive as
 *  named seams for their route categories — see each file's header — and the property
 *  worth pinning is the inverse of the one above: they must own no skip link, no navbar,
 *  no <main> and no footer, because a second of any of those is a duplicate landmark. */
const DELEGATING_SHELLS = [
  'components/marketing/layout/EventUtilityLayout.tsx',
  'components/event-templates/shared/ui/EventPageShell.tsx',
  'components/marketing/layout/MarketingPageLayout.tsx',
] as const

const SKIP_LINK = 'components/marketing/SkipToContent.tsx'
const CERT_PAGE = 'app/verify/certificate/[certificateId]/page.tsx'

// ═══ 1. THE SKIP LINK ════════════════════════════════════════════════════════

describe('the skip link', () => {
  it('is defined exactly once in the public tree', () => {
    // A second copy is where token drift starts, and on a page whose shells nest it would
    // double the first tab stop.
    const src = code(read(SKIP_LINK))
    expect((src.match(/href="#main-content"/g) ?? []).length).toBe(1)
  })

  it('is invisible until focused, so no visual design changes', () => {
    const src = code(read(SKIP_LINK))
    expect(src).toContain('sr-only')
    expect(src).toContain('focus:not-sr-only')
  })

  it('rings --action, the PUBLIC accent, never --primary', () => {
    // The two-accent split: --primary is organizer/admin magenta. Copying the dashboard's
    // skip link verbatim would have leaked it onto every public page.
    const src = code(read(SKIP_LINK))
    expect(src).toContain('ring-action')
    expect(src).not.toMatch(/ring-primary|--primary/)
  })

  it('uses tokens only — no hardcoded colour', () => {
    expect(code(read(SKIP_LINK))).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/)
  })

  it('is mounted by the canonical public shell', () => {
    expect(code(read(CANONICAL_SHELL)), 'the canonical shell has no skip link')
      .toContain('<SkipToContent />')
  })

  it('is mounted by NOTHING else — the delegating shells add no second one', () => {
    // Before the chrome unification each of these composed its own navbar, <main> and
    // footer, so each needed its own skip link. They now render HomeShell, and a skip
    // link here would be a second first-tab-stop pointing at the same target.
    for (const f of DELEGATING_SHELLS) {
      expect(code(read(f)), f + ' mounts its own skip link').not.toContain('<SkipToContent')
    }
  })

  it('is the FIRST tab stop — it precedes the navbar in the shell', () => {
    // The whole point. Rendered after the header it would skip nothing.
    const src   = code(read(CANONICAL_SHELL))
    const skips = [...src.matchAll(/<SkipToContent \/>/g)].map(m => m.index as number)
    const navs  = [...src.matchAll(/<(?:Home|Marketing)Navbar\b/g)].map(m => m.index as number)
    expect(navs.length, 'the canonical shell renders no navbar').toBeGreaterThan(0)
    expect(skips.length, 'fewer skip links than navbars').toBe(navs.length)
    navs.forEach((nav, i) => {
      expect(skips[i], 'skip link ' + (i + 1) + ' is not before its navbar').toBeLessThan(nav)
    })
  })
})

// ═══ 2. THE <main> LANDMARK ══════════════════════════════════════════════════

describe('the main landmark', () => {
  it('the canonical shell renders exactly one named <main>', () => {
    const src   = code(read(CANONICAL_SHELL))
    const mains = (src.match(/<main\b/g) ?? []).length
    const ids   = (src.match(/<main[^>]*id="main-content"/g) ?? []).length
    expect(mains, 'the canonical shell has an unnamed <main>').toBe(ids)
    expect(ids, 'the canonical shell renders more than one landmark').toBe(1)
  })

  it('no delegating shell declares a landmark of its own', () => {
    // EventPageShell has three variants and each returns its own tree; before this phase
    // each branch carried its own navbar, <main> and footer, which is exactly how a page
    // ends up with two main landmarks and an ambiguous skip-link target.
    for (const f of DELEGATING_SHELLS) {
      const src = code(read(f))
      expect(src, f + ' declares its own <main>').not.toMatch(/<main\b/)
      expect(src, f + ' declares its own footer').not.toMatch(/<footer\b|<(?:Home|Marketing)Footer\b/)
      expect(src, f + ' declares its own navbar').not.toMatch(/<(?:Home|Marketing)Navbar\b/)
    }
  })

  it('the shell contributes exactly one banner, whatever the page nests inside it', () => {
    // A <header> INSIDE <main> is not a second banner: HTML-AAM maps header to banner only
    // when it is not a descendant of article, aside, main, nav or section. Verified in the
    // accessibility tree of a production build, not inferred — /results has two <header>
    // ELEMENTS (the masthead plus ResultsHeader's page-title block) and exactly ONE banner
    // landmark. So the invariant worth pinning is the shell's, not a ban on the tag: the
    // banner comes from HomeNavbar, and the shell adds none of its own.
    expect(code(read('components/discovery/home/HomeShell.tsx'))).not.toMatch(/<header\b/)
    expect((code(read('components/discovery/home/HomeNavbar.tsx')).match(/<header\b/g) ?? []).length).toBe(1)
    // The pages migrated in this phase declare no chrome at all, so they cannot add one.
    for (const f of ['app/causes/page.tsx', 'app/results/page.tsx', CERT_PAGE]) {
      expect(code(read(f)), f + ' declares its own chrome').not.toMatch(/<header\b|<footer\b/)
    }
  })

  it('a page that composes a shell does not declare a <main> of its own', () => {
    // The certificate page renders HomeShell directly, so a <main> here would nest.
    for (const f of [CERT_PAGE, 'app/causes/page.tsx', 'app/results/page.tsx']) {
      expect(code(read(f)), f + ' declares a nested <main>').not.toMatch(/<main\b/)
    }
  })
})

// ═══ 3. CERTIFICATE VERIFICATION HEADINGS ════════════════════════════════════

describe('certificate verification is navigable by heading', () => {
  it('has exactly one h1', () => {
    const src = code(read(CERT_PAGE))
    expect((src.match(/<h1\b/g) ?? []).length).toBe(1)
    expect(src).toMatch(/<h1[^>]*>Certificate Verification<\/h1>/)
  })

  it('renders the verdict as an h2, not a paragraph', () => {
    // "Certificate is Valid" / "Certificate Revoked" is the one thing the page exists to say.
    const src = code(read(CERT_PAGE))
    expect(src).toMatch(/<h2[^>]*>\{title\}<\/h2>/)
  })

  it('stays out of the index', () => {
    // A certificate id in search results would be a privacy regression, not an SEO win.
    expect(code(read(CERT_PAGE))).toMatch(/robots:\s*\{\s*index:\s*false/)
  })
})

// ═══ 4. PAGE METADATA ════════════════════════════════════════════════════════

/** Public pages that must share with a preview image. */
const SOCIAL_PAGES = [
  'app/page.tsx', 'app/about/page.tsx', 'app/contact/page.tsx', 'app/pricing/page.tsx',
  'app/security/page.tsx', 'app/support/page.tsx',
  'app/causes/page.tsx', 'app/results/page.tsx',
  'app/solutions/sports/page.tsx', 'app/solutions/conferences/page.tsx',
  'app/solutions/corporate/page.tsx', 'app/solutions/fundraisers/page.tsx',
  'app/solutions/schools/page.tsx',
  'app/privacy/page.tsx', 'app/terms/page.tsx', 'app/refund-policy/page.tsx',
  'app/cookie-policy/page.tsx',
] as const

describe('the shared metadata builder', () => {
  it('always attaches the OG image to BOTH og and twitter', () => {
    const m = buildMetadata({ title: 'T', description: 'D', path: '/x' })
    expect(m.openGraph?.images).toBeTruthy()
    expect(m.twitter?.images).toBeTruthy()
  })

  it('builds an absolute self-canonical', () => {
    const m = buildMetadata({ title: 'T', description: 'D', path: '/causes' })
    expect(m.alternates?.canonical).toBe(SITE.baseUrl.replace(/\/$/, '') + '/causes')
  })

  it('points at an asset the root layout can resolve', () => {
    // metadataBase lives once, in app/layout.tsx. A page-local copy is a second source of
    // truth for the site's own origin.
    expect(SITE.ogImage.url.startsWith('/') || SITE.ogImage.url.startsWith('http')).toBe(true)
    expect(code(read('app/layout.tsx'))).toContain('metadataBase')
  })
})

describe('every shareable public page goes through it', () => {
  it('no page hand-rolls its metadata', () => {
    // /causes and /results did, and were the only two with no preview image — the exact
    // failure a hand-rolled block produces, since nothing requires `images`.
    for (const f of SOCIAL_PAGES) {
      expect(code(read(f)), f + ' does not use the shared builder')
        .toMatch(/build(?:Platform)?Metadata\(/)
    }
  })

  it('no page re-declares metadataBase', () => {
    for (const f of SOCIAL_PAGES) {
      expect(code(read(f)), f + ' re-declares metadataBase').not.toContain('metadataBase')
    }
  })

  it('/causes and /results keep the extras they had before', () => {
    // The correction must not have cost anything: /causes had a distinct social description
    // and /results a keyword list.
    const causes = code(read('app/causes/page.tsx'))
    expect(causes).toContain('CAUSES_SOCIAL_DESCRIPTION')
    expect(causes).toMatch(/openGraph:[\s\S]{0,120}description: CAUSES_SOCIAL_DESCRIPTION/)
    expect(causes).toMatch(/twitter:[\s\S]{0,120}description: CAUSES_SOCIAL_DESCRIPTION/)
    expect(code(read('app/results/page.tsx'))).toMatch(/keywords: \[[\s\S]*?'race results'/)
  })
})

describe('transactional pages stay out of the index', () => {
  it('/unsubscribe is noindex', () => {
    // Reached only from a signed link in an email. It was indexable AND had no description
    // of its own, so it inherited the root layout's — a duplicate meta description shared
    // with unrelated routes. robots.txt already disallowed the path; this closes the other
    // door, where a crawler follows a shared link directly.
    expect(code(read('app/unsubscribe/page.tsx')))
      .toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/)
  })

  it('the attendee utility pages stay noindex', () => {
    for (const f of [
      'app/tickets/[registrationId]/page.tsx',
      'app/events/[slug]/download-ticket/page.tsx',
      'app/events/[slug]/certificates/page.tsx',
    ]) {
      expect(code(read(f)), f).toMatch(/index:\s*false/)
    }
  })
})
