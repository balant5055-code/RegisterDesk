// ─── One security page, and it tells the truth about what ships ──────────────
//
// RegisterDesk had two indexable security pages with a BYTE-IDENTICAL <title>, the same
// hero eyebrow, the same screenshot, the same closing CTA, and six of eight capability
// cards restating each other. /security is now the only one; /platform/security 307s to it.
//
// ═══ THE TRUST BUG THIS PHASE FIXED ══════════════════════════════════════════
// SECURITY_FUTURE — SSO, two-factor, SCIM, enterprise compliance, BYOK — carried
// `status: 'coming_soon'`, and the field died in the projection into
// PlatformCapabilityItem. CapabilityGrid never saw it, so five unbuilt features rendered as
// cards indistinguishable from the nine that exist, on the page whose whole job is being
// believable. The tests below pin the fix end to end: the field survives the projection,
// the renderer prints WORDS, and no roadmap item can read as shipped.
//
// ═══ WHAT THEY DELIBERATELY DO NOT PIN ═══════════════════════════════════════
// Copy. Marketing wording should be free to change. What is pinned is the property that
// broke: a capability may look available only when it IS available.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { CapabilityGrid } from '@/components/marketing/platform/CapabilityGrid'
import { SECURITY_CAPABILITIES, SECURITY_FUTURE } from '@/content/marketing/security'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const exists = (p: string) => existsSync(resolvePath(ROOT, p))
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const SECURITY_PAGE = 'app/security/page.tsx'

// ═══════════════════════════════════════════════════════════════════════════════

describe('roadmap items can never again read as shipped', () => {
  it('every SECURITY_FUTURE item still declares coming_soon in the registry', () => {
    expect(SECURITY_FUTURE.length).toBeGreaterThan(0)
    for (const f of SECURITY_FUTURE) {
      expect(f.status, f.title + ' must be marked coming_soon').toBe('coming_soon')
    }
    // The five that started this: none of them is implemented.
    expect(SECURITY_FUTURE.map(f => f.id).sort())
      .toEqual(['byok', 'compliance', 'mfa', 'scim', 'sso'])
  })

  it('the page projection FORWARDS the status instead of dropping it', () => {
    // The exact regression: toItems() mapped three fields and lost the fourth.
    const src = code(read(SECURITY_PAGE))
    expect(src).toContain('coming_soon')
    expect(src).toContain('r.status')
  })

  it('CapabilityGrid renders the WORDS "Coming soon", not just a colour', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityGrid, {
        items: [{ iconKey: 'lock', title: 'Single sign-on (SSO)', description: 'x', status: 'coming_soon' }],
      }),
    )
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    expect(text).toContain('Coming soon')
    // Colour alone would be invisible to a screen reader and to anyone who cannot
    // distinguish the hue — the two audiences most likely to be misled here.
    expect(text).toContain('Single sign-on (SSO)')
  })

  it('a shipped capability gets NO badge', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityGrid, {
        items: [{ iconKey: 'lock', title: 'Role-based access', description: 'x' }],
      }),
    )
    expect(html.replace(/<[^>]+>/g, ' ')).not.toContain('Coming soon')
    // 2026-09-23 luxury pass: a live capability's icon is bronze (the public site's
    // editorial accent) rather than --action; what matters is that it is NOT the muted one.
    expect(html).toContain('text-hero-accent-rule')
    expect(html).not.toContain('text-muted-foreground')
  })

  it('shipped and roadmap cards are visually distinguishable in the same grid', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityGrid, {
        items: [
          { iconKey: 'lock',     title: 'Role-based access',   description: 'shipped' },
          { iconKey: 'security', title: 'Two-factor',          description: 'planned', status: 'coming_soon' },
        ],
      }),
    )
    expect((html.match(/Coming soon/g) ?? [])).toHaveLength(1)
    expect(html).toContain('text-hero-accent-rule')   // shipped card keeps the (bronze) accent
    expect(html).toContain('text-muted-foreground')   // roadmap card is muted
  })

  it('status is optional, so the other nine platform pages are unaffected', () => {
    const t = read('lib/marketing/platform/types.ts')
    expect(t).toContain("status?: 'coming_soon'")
  })
})

describe('the shipped controls survived the consolidation', () => {
  it('every previously shipped control is still listed', () => {
    const ids = SECURITY_CAPABILITIES.map(c => c.id)
    for (const id of [
      'rbac', 'workspace-isolation', 'event-isolation', 'audit', 'secure-payments',
      'transaction-history', 'identifier-integrity', 'verified-email', 'data-ownership',
    ]) expect(ids, id + ' went missing').toContain(id)
  })

  it('all of them are marked available', () => {
    for (const c of SECURITY_CAPABILITIES) {
      expect(c.status, c.title).toBe('available')
    }
  })
})

describe('what was carried over from /platform/security, and what was not', () => {
  it('the replication claim is gone from everything a reader sees', () => {
    // "Managed, replicated cloud infrastructure" — managed is provable, replicated is not:
    // no locationId is declared in .firebaserc or firebase.json, so the multi-region vs
    // single-region question is unanswerable from this repository.
    //
    // Measured on the DATA and the RENDER, not on the source: the registry comment above
    // the replacement card says the word "replicated" while explaining why it is not
    // claimed, and a comment is not a claim.
    for (const c of [...SECURITY_CAPABILITIES, ...SECURITY_FUTURE]) {
      expect(`${c.title} ${c.description}`, c.id).not.toMatch(/replicated/i)
    }
    const html = renderToStaticMarkup(
      createElement(CapabilityGrid, {
        items: SECURITY_CAPABILITIES.map(c => ({ iconKey: c.iconKey, title: c.title, description: c.description })),
      }),
    )
    expect(html).not.toMatch(/replicated/i)
    expect(code(read(SECURITY_PAGE))).not.toMatch(/replicated/i)
  })

  it('the truthful half was kept, and it is verifiable', () => {
    const infra = SECURITY_CAPABILITIES.find(c => c.id === 'managed-infrastructure')
    expect(infra, 'the managed-infrastructure card should exist').toBeTruthy()
    expect(infra!.description).toMatch(/managed/i)
    // Provable where the claim points: the app runs on Firestore via firebase-admin.
    expect(read('lib/firebase/admin.ts')).toContain("from 'firebase-admin/firestore'")
  })

  it('the Privacy card was NOT duplicated', () => {
    // It restated workspace isolation + RBAC, both already here in more concrete terms.
    // Carrying it would have been parity for its own sake.
    const titles = SECURITY_CAPABILITIES.map(c => c.title)
    expect(titles).not.toContain('Privacy')
  })

  it('no capability is listed twice', () => {
    const ids = SECURITY_CAPABILITIES.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    const titles = SECURITY_CAPABILITIES.map(c => c.title.toLowerCase())
    expect(new Set(titles).size).toBe(titles.length)
  })
})

describe('/platform/security went with the whole Platform section', () => {
  it('the route is gone, not redirecting', () => {
    // It was a 307 to /security, added when the two security pages were consolidated. The
    // public Platform section has since been retired in full, so the namespace no longer
    // exists to redirect FROM — the URL 404s like every other /platform path.
    expect(exists('app/platform/security/page.tsx')).toBe(false)
    expect(exists('app/platform')).toBe(false)
  })

  it('its config stayed gone, and nothing imports it', () => {
    expect(exists('content/marketing/platform-security.ts')).toBe(false)
    expect(code(read('app/sitemap.ts'))).not.toContain('platform-security')
    expect(code(read('app/sitemap.ts'))).not.toContain('SECURITY_PAGE')
  })

  it('/security itself is untouched and still the canonical page', () => {
    // The consolidation's destination survives the removal; only the redirect to it went.
    expect(exists(SECURITY_PAGE)).toBe(true)
    expect(code(read(SECURITY_PAGE))).toContain('SECURITY_CAPABILITIES')
  })
})

describe('SEO after consolidation', () => {
  it('the sitemap lists /security and not /platform/security', () => {
    const sm = read('app/sitemap.ts')
    expect(sm).toContain("['/security',              0.4]")
    expect(code(sm)).not.toContain("'/platform/security'")
  })

  it('/security keeps its own canonical and stays indexable', () => {
    const src = code(read(SECURITY_PAGE))
    expect(src).toContain("path:        '/security'")
    expect(src).not.toContain('noindex')
    expect(code(read('app/robots.ts'))).not.toContain('/security')
  })

  it('/security does NOT inherit the product SoftwareApplication schema', () => {
    // softwareAppJsonLd() is a whole-product entity with a price-0 Offer keyed to the site
    // URL. It belongs on the /platform/* pages, not on a company trust page, and copying it
    // across purely to preserve parity would add a second product entity for nothing.
    const src = code(read(SECURITY_PAGE))
    expect(src).toContain('organizationJsonLd')
    expect(src).toContain('breadcrumbJsonLd')
    expect(src).not.toContain('softwareAppJsonLd')
  })

  it('the existing inbound links to /security are untouched', () => {
    expect(read('components/discovery/home/HomeFooter.tsx')).toContain("href: '/security'")
    expect(read('content/marketing/footer.ts')).toContain("href: '/security'")
    expect(read('content/marketing/faq.ts')).toContain("href: '/security'")
  })

  it('neither route was added to PRIMARY_NAV', () => {
    const nav = read('content/marketing/navigation.ts')
    expect(nav).not.toContain("'/security'")
    expect(nav).not.toContain("'/platform/security'")
  })
})
