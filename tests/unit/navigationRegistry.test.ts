// ─── One registry, four surfaces ─────────────────────────────────────────────
//
// PRIMARY_NAV is the single source of truth for public destinations. Three surfaces derive
// from it — the HomeNavbar header, the HomeFooter index, and MarketingNavbar's mega-menu on
// the event experience — so ONE entry added here appears in three places at once, and a
// hand-added link anywhere else is a duplicate by construction.
//
// ═══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════
// It was written when /platform/api was an orphan — live, indexable, sitemap-submitted and
// reachable by clicking from nowhere — to pin that a nav entry exists ONCE and that every
// surface picks it up by DERIVING rather than by someone typing the URL into a component.
//
// The public Platform section has since been retired in full, which inverts the first half:
// what is pinned now is that no surface still names a destination under it. The second half
// is unchanged and is the one that rots quietly, so most of what follows still checks that
// consumers read the registry. A fourth surface, the /platform overview grid, went with the
// section.
//
// They deliberately do NOT assert the full list of destinations as a golden snapshot: nav
// copy should be free to change. What is pinned is structure — no duplicates, no orphans,
// no hardcoded hrefs in consumers, and every destination resolving to a real route.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { PRIMARY_NAV } from '@/content/marketing/navigation'
import type { NavMenu } from '@/lib/marketing/types'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const menu = (id: string): NavMenu => {
  const m = PRIMARY_NAV.find(x => x.id === id)
  if (!m) throw new Error('no such menu: ' + id)
  return m
}
const itemsOf = (m: NavMenu) => (m.groups ?? []).flatMap(g => g.items)

/** Every destination the registry can produce, including the featured overview links. */
const allHrefs = PRIMARY_NAV.flatMap(m => [
  ...(m.href ? [m.href] : []),
  ...(m.featured ? [m.featured.href] : []),
  ...itemsOf(m).map(i => i.href),
])

/** Does a path resolve to a real App Router page? */
function routeExists(href: string): boolean {
  const segs = href.split('/').filter(Boolean)
  if (segs.length === 0) return existsSync(resolvePath(ROOT, 'app/page.tsx'))
  return existsSync(resolvePath(ROOT, 'app/' + segs.join('/') + '/page.tsx'))
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('the public Platform section is gone', () => {
  it('carries no platform menu, at any level of the registry', () => {
    expect(PRIMARY_NAV.map(m => m.id)).not.toContain('platform')
    expect(PRIMARY_NAV.map(m => m.title)).not.toContain('Platform')
  })

  it('produces no destination under /platform, including the old overview', () => {
    expect(allHrefs.filter(h => h === '/platform' || h.startsWith('/platform/'))).toEqual([])
  })

  it('no route survives on disk', () => {
    // The whole namespace was removed: the overview, the nine capability pages, and the
    // /platform/security redirect that used to point at /security.
    expect(existsSync(resolvePath(ROOT, 'app/platform'))).toBe(false)
  })

  it('keeps Solutions, which was audited separately and is independent', () => {
    // Solutions has its own routes under app/solutions and is reached from the footer. It
    // shares the section COMPONENTS with the retired Platform pages, not the section itself.
    const solutions = menu('solutions')
    expect(itemsOf(solutions).length).toBe(5)
    for (const i of itemsOf(solutions)) expect(routeExists(i.href), i.href).toBe(true)
  })
})

describe('the registry as a whole stays honest', () => {
  it('every destination resolves to a real page', () => {
    // The V1 rule this registry was written under: nothing reachable from the nav 404s.
    for (const href of allHrefs) {
      expect(routeExists(href), href + ' is in the nav but has no page').toBe(true)
    }
  })

  it('no destination appears twice', () => {
    const dupes = allHrefs.filter((h, i) => allHrefs.indexOf(h) !== i)
    expect(dupes).toEqual([])
  })
})

describe('the public consumers still DERIVE from the registry', () => {
  // The failure this guards is a hand-typed href in a component, which is how one surface
  // silently stops matching the others.
  // MarketingNavbar, MegaMenu and MobileDrawer were retired with the legacy chrome. The
  // registry now has exactly two public consumers, which is the point of a registry.
  const CONSUMERS = [
    'components/discovery/home/HomeNavbar.tsx',
    'components/discovery/home/HomeFooter.tsx',
  ] as const

  it('each reads PRIMARY_NAV rather than typing destinations', () => {
    for (const f of CONSUMERS) {
      expect(code(read(f)), f).toContain('PRIMARY_NAV')
    }
  })

  it('none of them still names a /platform destination', () => {
    // This is the check that would have caught a nav entry left behind by the removal.
    for (const f of CONSUMERS) {
      expect(code(read(f)), f + ' still names a /platform route').not.toContain('/platform')
    }
  })

  it('the footer builds its columns from the registry, not a second list', () => {
    const src = code(read('components/discovery/home/HomeFooter.tsx'))
    expect(src).toContain("fromNav('solutions', 'Solutions')")
    expect(src).not.toContain("fromNav('platform'")
  })
})

describe('the SEO surface carries no retired Platform URL', () => {
  it('the sitemap lists none of them', () => {
    const sm = code(read('app/sitemap.ts'))
    expect(sm).not.toMatch(/'\/platform/)
  })

  it('robots does not need to disallow what does not exist', () => {
    expect(code(read('app/robots.ts'))).not.toContain('/platform')
  })

  it('the breadcrumb no longer treats /platform as a real index page', () => {
    expect(code(read('components/marketing/MarketingBreadcrumb.tsx'))).not.toContain("'/platform'")
  })

  it('no route table still names the deleted section', () => {
    // ROUTES.FOR_ORGANIZERS pointed at /platform and was read by a NAV_ITEMS array that
    // nothing imported. Both went with the section.
    //
    // The pattern targets the PUBLIC namespace only — a leading '/platform' followed by a
    // quote or a slash. ROUTES.ADMIN_PLATFORM_MONITOR ('/admin/platform-monitor') is
    // protected admin routing and must survive; matching the bare word would fail on it.
    const src = code(read('config/navigation.ts'))
    expect(src).not.toMatch(/['"]\/platform(['"/])/)
    expect(src).not.toContain('FOR_ORGANIZERS')
    // …and the admin route it must NOT have taken with it.
    expect(src).toContain('/admin/platform-monitor')
  })
})


describe('/resources is retired, and stays retired', () => {
  it('the route is gone', () => {
    expect(existsSync(resolvePath(ROOT, 'app/resources/page.tsx'))).toBe(false)
    expect(existsSync(resolvePath(ROOT, 'app/resources'))).toBe(false)
  })

  it('no registry, CTA or breadcrumb still points at it', () => {
    // It was never in PRIMARY_NAV — that was the bug: its own grid looked for a
    // `resources` menu that did not exist, so the page rendered an empty shelf.
    for (const f of [
      'content/marketing/navigation.ts',
      'content/marketing/footer.ts',
      'lib/marketing/cta.ts',
      'components/marketing/MarketingBreadcrumb.tsx',
      'app/sitemap.ts',
    ]) expect(code(read(f)), f).not.toContain('/resources')
  })

  it('the readDocs CTA went with it', () => {
    // Its only caller by the end was the retired page's own hero, pointing back at the
    // page you were already on. Re-add the key when a real destination exists.
    const cta = code(read('lib/marketing/cta.ts'))
    expect(cta).not.toContain('readDocs')
    // Every surviving CTA must still resolve to a real page or a ROUTES constant.
    for (const href of [...cta.matchAll(/href:\s*'(\/[^']*)'/g)].map(m => m[1])) {
      expect(routeExists(href), 'CTA target ' + href + ' has no page').toBe(true)
    }
  })
})

describe('the security registry carries no dead destinations', () => {
  it('no href field survives on security capabilities', () => {
    // Nothing rendered it, and six of its values pointed at routes that do not exist.
    const src = code(read('content/marketing/security.ts'))
    expect(src).not.toContain('href')
    expect(src).not.toContain('/roadmap')
    expect(src).not.toContain('/platform/communications')
    expect(code(read('lib/marketing/types.ts'))).not.toMatch(/SecurityCapabilityDef[\s\S]{0,400}?href:/)
  })

  it('and neither invented route was created to satisfy it', () => {
    expect(existsSync(resolvePath(ROOT, 'app/roadmap'))).toBe(false)
    expect(existsSync(resolvePath(ROOT, 'app/platform/communications'))).toBe(false)
  })

  it('only the two consumed exports remain', () => {
    const src = code(read('content/marketing/security.ts'))
    expect(src).toContain('SECURITY_CAPABILITIES')
    expect(src).toContain('SECURITY_FUTURE')
    for (const dead of [
      'SECURITY_TRUST_HEADING', 'SECURITY_TRUST_ITEMS', 'SECURITY_TRUST_STRIP',
      'SecurityTrustItem', 'SECURITY_ITEMS', 'SECURITY_HEADING', 'SECURITY_GROUPS',
    ]) expect(src, dead + ' should be gone').not.toContain(dead)
  })
})
