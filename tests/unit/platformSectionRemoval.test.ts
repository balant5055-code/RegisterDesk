// ─── The public Platform section is removed ──────────────────────────────────
//
// An IA decision, not a cleanup: RegisterDesk's public site no longer has a Platform
// navigation entry or public /platform pages. Eleven routes were deleted — the overview,
// nine capability pages, and the /platform/security redirect that had been consolidating
// into /security.
//
// ═══ WHAT THESE TESTS ARE ACTUALLY GUARDING ══════════════════════════════════
// Not "the files are gone" — that is one `rm` and hard to get wrong. The failure mode is a
// SURVIVING REFERENCE: a nav entry, a footer column, a sitemap row, a support link or a
// route constant still naming a URL that now 404s. Each of those is a dead public link, and
// each lives in a different file from the pages themselves.
//
// The second failure mode is over-deletion. "Platform" is a common word in this codebase —
// the admin shell has a Platform Monitor, the fee engine charges a platform fee, and four
// section components built for these pages are composed by /about, /security, /support and
// every /solutions/* page. Those must survive, so they are asserted here too.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { PRIMARY_NAV } from '@/content/marketing/navigation'
import { ORGANIZER_TOPICS, ATTENDEE_TOPICS } from '@/content/marketing/support'
import { FAQ_ITEMS } from '@/content/marketing/faq'
import { FOOTER_COLUMNS } from '@/content/marketing/footer'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const exists = (p: string) => existsSync(resolvePath(ROOT, p))
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** A reference to the retired PUBLIC namespace — not to '/admin/platform-monitor'. */
const PUBLIC_PLATFORM_HREF = /['"`]\/platform(['"`/])/

// ═══ 1. THE ROUTES ═══════════════════════════════════════════════════════════

describe('every public Platform route is gone', () => {
  it('the whole app/platform tree no longer exists', () => {
    expect(exists('app/platform')).toBe(false)
  })

  it('names each retired route explicitly, so the list cannot quietly shrink', () => {
    for (const r of ['', '/api', '/certificates', '/check-in', '/crm', '/finance',
                     '/identifiers', '/participants', '/payments', '/registration', '/security']) {
      expect(exists('app/platform' + r + '/page.tsx'), '/platform' + r + ' still exists').toBe(false)
    }
  })

  it('no redirect was left behind in its place', () => {
    // /platform/security was a 307 to /security. Keeping one redirect alive inside a
    // namespace that otherwise 404s would be an inconsistent public contract; the brief's
    // rule is that removed Platform URLs resolve to 404.
    expect(exists('app/platform/security')).toBe(false)
    expect(code(read('app/sitemap.ts'))).not.toMatch(PUBLIC_PLATFORM_HREF)
  })
})

// ═══ 2. NAVIGATION AND FOOTER ════════════════════════════════════════════════

describe('no public navigation points at the retired section', () => {
  it('PRIMARY_NAV carries no platform menu', () => {
    expect(PRIMARY_NAV.map(m => m.id)).not.toContain('platform')
  })

  it('and produces no /platform destination at any depth', () => {
    const hrefs = PRIMARY_NAV.flatMap(m => [
      ...(m.href ? [m.href] : []),
      ...(m.featured ? [m.featured.href] : []),
      ...(m.groups ?? []).flatMap(g => g.items).map(i => i.href),
    ])
    expect(hrefs.filter(h => h === '/platform' || h.startsWith('/platform/'))).toEqual([])
  })

  it('the navbar allow-list no longer resolves a platform entry', () => {
    const src = code(read('components/discovery/home/HomeNavbar.tsx'))
    expect(src).not.toMatch(/id: 'platform'/)
    expect(src).not.toMatch(PUBLIC_PLATFORM_HREF)
  })

  it('and still lists exactly the four registry entries the header is meant to show', () => {
    const src = code(read('components/discovery/home/HomeNavbar.tsx'))
    for (const id of ['events', 'causes', 'pricing', 'contact']) {
      expect(src, id + ' missing from the header').toContain(`id: '${id}'`)
    }
  })

  it('the footer builds no Platform column', () => {
    const src = code(read('components/discovery/home/HomeFooter.tsx'))
    expect(src).not.toContain("fromNav('platform'")
    expect(src).not.toMatch(PUBLIC_PLATFORM_HREF)
    // Rebalanced rather than left with a gap where the column stood. Since the 2026-09-23
    // ledger pass the index is exactly three ledger lines — Discover, Solutions, Company.
    expect((src.match(/<IndexRow /g) ?? []).length).toBe(3)
  })
})

// ═══ 3. PUBLIC CONTENT ═══════════════════════════════════════════════════════

describe('no public content links into the retired section', () => {
  it('no support topic offers a /platform link', () => {
    for (const t of [...ORGANIZER_TOPICS, ...ATTENDEE_TOPICS]) {
      for (const l of t.links) {
        expect(l.href, t.id + ' links to a retired page').not.toMatch(/^\/platform/)
      }
    }
  })

  it('a support topic that lost every link renders no empty list', () => {
    // Four topics were left with none. An unguarded <ul> still carries its top margin.
    const emptied = [...ORGANIZER_TOPICS, ...ATTENDEE_TOPICS].filter(t => t.links.length === 0)
    expect(emptied.length).toBeGreaterThan(0)
    expect(code(read('app/support/page.tsx'))).toContain('topic.links.length > 0')
  })

  it('no FAQ answer deep-links into it', () => {
    for (const f of FAQ_ITEMS) {
      if (f.href) expect(f.href, f.question).not.toMatch(/^\/platform/)
    }
  })

  it('the FAQ kept its questions — only the hrefs went', () => {
    // The answers were never untrue; they simply pointed at pages that no longer exist.
    expect(FAQ_ITEMS.length).toBeGreaterThan(15)
    expect(FAQ_ITEMS.every(f => f.question.trim() && f.answer.trim())).toBe(true)
  })

  it('no marketing or public source file still writes a /platform URL', () => {
    const dirs = ['content/marketing', 'components/discovery/home', 'components/marketing']
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(resolvePath(ROOT, dir), { withFileTypes: true })) {
        const p = dir + '/' + e.name
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && PUBLIC_PLATFORM_HREF.test(code(read(p)))) offenders.push(p)
      }
    }
    dirs.forEach(walk)
    expect(offenders).toEqual([])
  })

  it('the breadcrumb no longer treats /platform as a linkable index', () => {
    expect(code(read('components/marketing/MarketingBreadcrumb.tsx'))).not.toContain("'/platform'")
  })

  it('the OTHER footer registry has no orphaned Platform column either', () => {
    // MarketingFooter (the event/campaign shell) reads FOOTER_COLUMNS, a different registry
    // from HomeFooter's. Its first column was navColumn('platform'), and navColumn falls
    // back rather than failing: with the menu gone it would have rendered a column headed
    // 'platform' — lower-cased, because the title falls back to the menu ID — holding only
    // the Pricing link that had been appended to it. Nothing in the source says "/platform",
    // so a URL sweep could not have found this.
    for (const c of FOOTER_COLUMNS) {
      expect(c.id, 'a platform column survives in FOOTER_COLUMNS').not.toBe('platform')
      expect(c.links.length, c.id + ' renders an empty footer column').toBeGreaterThan(0)
      // A heading that equals a lower-case menu id is the fallback firing.
      expect(c.title, c.id + ' fell back to its raw id as a heading').toMatch(/^[A-Z]/)
      for (const l of c.links) expect(l.href).not.toMatch(/^\/platform/)
    }
  })

  it('and Pricing survived the column it used to hang off', () => {
    const hrefs = FOOTER_COLUMNS.flatMap(c => c.links.map(l => l.href))
    expect(hrefs, 'Pricing was lost with the Platform column').toContain('/pricing')
  })
})

// ═══ 4. WHAT MUST SURVIVE ════════════════════════════════════════════════════

describe('the removal did not take the shared parts with it', () => {
  it('the four section components other public pages compose with are intact', () => {
    // /about and /security build their whole page from these; /support uses PlatformSection.
    for (const c of ['PlatformHero', 'PlatformSection', 'CapabilityGrid', 'PlatformCTA']) {
      expect(exists('components/marketing/platform/' + c + '.tsx'), c + ' was deleted').toBe(true)
      expect(code(read('components/marketing/platform/index.ts'))).toContain(c)
    }
  })

  it('and so are the two the Solutions pages compose with', () => {
    // SolutionPage imports these through the barrel, on a MULTI-LINE import — which is
    // exactly why an import-line grep missed them during the audit and TypeScript caught it.
    for (const c of ['ProductShowcase', 'UseCases']) {
      expect(exists('components/marketing/platform/' + c + '.tsx'), c + ' was deleted').toBe(true)
    }
    const solution = code(read('components/marketing/solutions/SolutionPage.tsx'))
    expect(solution).toContain('ProductShowcase')
    expect(solution).toContain('UseCases')
  })

  it('the shared types survive, because /security and the solution configs use them', () => {
    expect(exists('lib/marketing/platform/types.ts')).toBe(true)
    expect(code(read('app/security/page.tsx'))).toContain('PlatformCapabilityItem')
    expect(code(read('content/marketing/solution-pages.ts'))).toContain('lib/marketing/platform/types')
  })

  it('Solutions is untouched — it was audited separately and is independent', () => {
    for (const s of ['sports', 'conferences', 'schools', 'corporate', 'fundraisers']) {
      expect(exists('app/solutions/' + s + '/page.tsx'), s + ' was removed').toBe(true)
    }
    expect(PRIMARY_NAV.map(m => m.id)).toContain('solutions')
  })

  it('the other public routes are all still there', () => {
    for (const p of ['app/page.tsx', 'app/causes/page.tsx', 'app/pricing/page.tsx',
                     'app/contact/page.tsx', 'app/about/page.tsx', 'app/security/page.tsx',
                     'app/support/page.tsx', 'app/results/page.tsx', 'app/events/page.tsx']) {
      expect(exists(p), p + ' was removed').toBe(true)
    }
  })

  it('/events still redirects to / — the compatibility contract is untouched', () => {
    // A bare /events is exactly `/`; a /events?… request now carries its query to `/?…`
    // (the discovery page's own filter contract), which the breadcrumb relied on.
    const src = code(read('app/events/page.tsx'))
    expect(src).toContain("redirect(query ? `/?${query}` : '/')")
    expect(src).not.toContain('permanentRedirect')
  })

  it('protected surfaces that merely use the WORD platform are preserved', () => {
    // The admin Platform Monitor, and the fee engine's platform fee. Neither is public IA.
    expect(code(read('config/navigation.ts'))).toContain('/admin/platform-monitor')
    expect(exists('app/(admin)/admin/platform-monitor/page.tsx')).toBe(true)
    expect(code(read('lib/fees/types.ts'))).toMatch(/platform/i)
  })

  it('no public route table still names the deleted section', () => {
    const src = code(read('config/navigation.ts'))
    expect(src).not.toMatch(PUBLIC_PLATFORM_HREF)
    expect(src).not.toContain('FOR_ORGANIZERS')
  })
})
