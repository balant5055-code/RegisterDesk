// ─── The public shell is ONE shell ───────────────────────────────────────────
//
// The site used to carry two of them. `/` rendered HomeShell (HomeNavbar + HomeFooter);
// every marketing and legal page rendered MarketingPageLayout's own composition
// (MarketingNavbar + MarketingFooter). The two HEADERS agreed, because both read the
// PRIMARY_NAV registry — but the two FOOTERS did not: HomeFooter derives four groups from
// PRIMARY_NAV, while MarketingFooter reads FOOTER_COLUMNS, a separate registry holding nine
// destinations. Walking from `/` to `/about` silently dropped Platform, Solutions, Causes,
// Resources and Results out of the footer, and nothing failed when it happened.
//
// ═══ WHAT THESE TESTS PIN ════════════════════════════════════════════════════
// Not "MarketingPageLayout contains the right JSX" — that is one file and easy to read.
// They pin the property that made the drift possible in the first place: how many public
// navbars and footers each ROUTE ends up mounting, resolved through the real import graph.
// A page that hand-mounts its own chrome (which /causes did) fails these, wherever it is.
//
// ═══ THE EVENT EXPERIENCE HAS SINCE MOVED TOO ════════════════════════════════
// This file was written when EventPageShell and EventUtilityLayout deliberately kept
// MarketingNavbar + MarketingFooter, and two blocks pinned that they had NOT moved. The
// public chrome unification then moved them on purpose — one chrome for every eligible
// public route — and those blocks now pin the new contract: every event and utility route
// resolves to HomeNavbar + HomeFooter, and the legacy pair is reachable from nowhere.
// The pair is NOT deleted here; the last block records that retirement is its own phase.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

// MarketingNavbar is a client island that highlights the active menu from the path. Every
// other test here reads source text; this one mock is what lets the last block render the
// shell for real and COUNT its landmarks.
vi.mock('next/navigation', () => ({ usePathname: () => '/tickets/probe' }))

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const norm = (p: string) => p.split('\\').join('/')

/** Comments describe the OLD shell all over this repo; assertions must read code only. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

// ─── The import graph, resolved the way the bundler resolves it ──────────────

const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

function resolveModule(spec: string, fromFile: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = resolvePath(ROOT, spec.slice(2))
  else if (spec.startsWith('.')) base = resolvePath(dirname(fromFile), spec)
  else return null
  for (const e of EXTS) {
    const p = base + e
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

/**
 * Every module a page pulls in, transitively. Cycles are handled by the visited set, and a
 * bare specifier (react, next/link, lucide-react) resolves to null and is skipped — none of
 * them can mount site chrome.
 */
function moduleGraph(entry: string): Set<string> {
  const seen = new Set<string>()
  const stack = [resolvePath(ROOT, entry)]
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    const src = code(readFileSync(f, 'utf8'))
    const re = /from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const target = resolveModule(m[1] ?? m[2], f)
      if (target) stack.push(target)
    }
  }
  return new Set([...seen].map(norm))
}

/** The four components that render site chrome, by the file that defines each. */
const CHROME = {
  homeNavbar:      'components/discovery/home/HomeNavbar.tsx',
  homeFooter:      'components/discovery/home/HomeFooter.tsx',
  marketingNavbar: 'components/marketing/navigation/MarketingNavbar.tsx',
  marketingFooter: 'components/marketing/footer/MarketingFooter.tsx',
} as const

type ChromeKey = keyof typeof CHROME

function chromeOf(entry: string): Record<ChromeKey, boolean> {
  const graph = moduleGraph(entry)
  const has = (rel: string) => graph.has(norm(resolvePath(ROOT, rel)))
  return {
    homeNavbar:      has(CHROME.homeNavbar),
    homeFooter:      has(CHROME.homeFooter),
    marketingNavbar: has(CHROME.marketingNavbar),
    marketingFooter: has(CHROME.marketingFooter),
  }
}

const MOUNTABLE = [
  'HomeNavbar', 'HomeFooter', 'MarketingNavbar', 'MarketingFooter',
  'HomeShell', 'MarketingPageLayout',
] as const

/**
 * What a file MOUNTS itself, as opposed to what its dependencies mount: `<HomeNavbar` in
 * the JSX, not `import { HomeNavbar }`.
 */
function mountsIn(file: string): string[] {
  const src = code(read(file))
  return MOUNTABLE.filter(name => new RegExp('<' + name + '[\\s/>]').test(src))
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('the shared public layout delegates to the canonical shell', () => {
  const LAYOUT = 'components/marketing/layout/MarketingPageLayout.tsx'
  const src = code(read(LAYOUT))

  it('renders HomeShell', () => {
    expect(src).toContain("from '@/components/discovery/home/HomeShell'")
    expect(src).toMatch(/<HomeShell>\s*\{children\}\s*<\/HomeShell>/)
  })

  it('no longer mounts MarketingNavbar', () => {
    expect(src).not.toContain('MarketingNavbar')
    expect(mountsIn(LAYOUT)).not.toContain('MarketingNavbar')
  })

  it('no longer mounts MarketingFooter', () => {
    expect(src).not.toContain('MarketingFooter')
    expect(mountsIn(LAYOUT)).not.toContain('MarketingFooter')
  })

  it('delegates rather than re-composing the shell', () => {
    // The failure this guards against is a COPY of HomeShell's composition landing here —
    // which is how the site ended up with two shells the first time. If this file ever
    // declares its own <main>, or its own min-h-screen canvas, that has happened again.
    expect(src).not.toContain('<main')
    expect(src).not.toContain('min-h-screen')
    expect(mountsIn(LAYOUT)).toEqual(['HomeShell'])
  })

  it('leaves the ONE <main id="main-content"> to HomeShell', () => {
    expect(code(read('components/discovery/home/HomeShell.tsx'))).toContain('id="main-content"')
    // Exactly one landmark in the chain: a nested second one is invalid, breaks skip links,
    // and is the specific hazard of wrapping one shell inside another.
    expect(src.match(/id="main-content"/g) ?? []).toHaveLength(0)
  })
})

describe('/causes carries no chrome of its own', () => {
  const PAGE = 'app/causes/page.tsx'
  const src = code(read(PAGE))

  it('mounts the shared layout instead of a navbar and a footer', () => {
    expect(mountsIn(PAGE)).toEqual(['MarketingPageLayout'])
  })

  it('no longer imports the chrome components directly', () => {
    expect(src).not.toContain('MarketingNavbar')
    expect(src).not.toContain('MarketingFooter')
  })

  it('kept its content', () => {
    // The mounts came out; nothing else did.
    expect(src).toContain('Discover Causes')
    expect(src).toContain('Fundraising Campaigns')
    expect(src).toContain('<CausesClient')
    expect(src).toContain('listCampaigns')
    expect(src).toContain('export const revalidate = 60')
    // The self-canonical this phase added is still here, but it is no longer a literal
    // `alternates:` block: Phase 8D moved the page onto the shared buildMetadata helper,
    // which emits the canonical (and the og:image this page was missing) from one place.
    // Asserting the token would now pin the hand-rolled form the helper replaced, so the
    // assertion moves to the thing that produces it.
    expect(src).toMatch(/buildMetadata\(\{[\s\S]*?path:\s*'\/causes'/)
  })

  it('dropped the hand-rolled canvas rather than nesting it inside the shell', () => {
    // A leftover `min-h-screen bg-background` wrapper inside the shell is a second canvas,
    // and it is exactly what a careless conversion leaves behind.
    expect(src).not.toContain('min-h-screen')
  })
})

describe('every representative public route mounts exactly one navbar and one footer', () => {
  // Route → the file the App Router serves. These are the pages named in the migration
  // brief, and between them they cover the three ways a page reaches the shell: directly,
  // through SolutionPage and through LegalPage.
  const ROUTES: Record<string, string> = {
    '/about':            'app/about/page.tsx',
    '/contact':          'app/contact/page.tsx',
    '/pricing':          'app/pricing/page.tsx',
    // '/platform' and '/platform/api' were here, covering the PlatformPage route into the
    // shell. The whole public Platform section is retired and every one of its routes is
    // deleted, so SolutionPage is now the only config-driven way in.
    '/solutions/sports': 'app/solutions/sports/page.tsx',
    // '/resources' was here. The route is retired: its grid read a PRIMARY_NAV group that
    // never existed so it rendered empty, and nothing linked to it but its own CTA.
    '/security':         'app/security/page.tsx',
    '/support':          'app/support/page.tsx',
    '/privacy':          'app/privacy/page.tsx',
    '/terms':            'app/terms/page.tsx',
    '/causes':           'app/causes/page.tsx',
  }

  for (const [route, file] of Object.entries(ROUTES)) {
    it(route + ' → HomeNavbar + HomeFooter, and nothing else', () => {
      const c = chromeOf(file)
      expect(c.homeNavbar, route + ' must reach HomeNavbar').toBe(true)
      expect(c.homeFooter, route + ' must reach HomeFooter').toBe(true)
      // Reaching MarketingNavbar/MarketingFooter at all would mean a second header or a
      // second footer is in the tree — the duplicate-chrome bug this phase removed.
      expect(c.marketingNavbar, route + ' must not reach MarketingNavbar').toBe(false)
      expect(c.marketingFooter, route + ' must not reach MarketingFooter').toBe(false)
    })
  }

  it('the landing page is unchanged and still the same shell', () => {
    expect(chromeOf('app/page.tsx')).toEqual({
      homeNavbar: true, homeFooter: true, marketingNavbar: false, marketingFooter: false,
    })
    expect(mountsIn('app/page.tsx')).toContain('HomeShell')
  })

  it('no public page mounts chrome directly any more', () => {
    // The general rule, not a list: chrome is mounted by a shell, never by a page.
    for (const file of Object.values(ROUTES)) {
      const mounts = mountsIn(file)
      expect(mounts, file).not.toContain('HomeNavbar')
      expect(mounts, file).not.toContain('HomeFooter')
      expect(mounts, file).not.toContain('MarketingNavbar')
      expect(mounts, file).not.toContain('MarketingFooter')
    }
  })
})

describe('the event and attendee utility routes are on the canonical chrome', () => {
  // These four hang off ONE event or ONE ticket, and they are reached from a confirmation
  // email, a wallet pass or a QR code on a printed certificate. They used to keep the
  // EVENT chrome (MarketingNavbar + MarketingFooter) through EventUtilityLayout, because
  // the event experience had not moved. The public chrome unification moved it: someone
  // who scans a certificate lands on the same website they reach from the homepage.
  //
  // The seam survives — the four routes still import EventUtilityLayout, not HomeShell —
  // so the category can grow something HomeShell does not give it without touching the
  // marketing pages. What changes is what the seam resolves to.
  const UTILITY: Record<string, string> = {
    '/events/[slug]/certificates':    'app/events/[slug]/certificates/page.tsx',
    '/events/[slug]/download-ticket': 'app/events/[slug]/download-ticket/page.tsx',
    '/events/[slug]/register/success':'app/events/[slug]/register/success/page.tsx',
    '/tickets/[registrationId]':      'app/tickets/[registrationId]/page.tsx',
  }

  for (const [route, file] of Object.entries(UTILITY)) {
    it(route + ' → HomeNavbar + HomeFooter, through the utility seam', () => {
      const c = chromeOf(file)
      expect(c.homeNavbar, route + ' must reach HomeNavbar').toBe(true)
      expect(c.homeFooter, route + ' must reach HomeFooter').toBe(true)
      // Reaching the legacy pair at all would mean a second header or a second footer.
      expect(c.marketingNavbar, route + ' must not reach MarketingNavbar').toBe(false)
      expect(c.marketingFooter, route + ' must not reach MarketingFooter').toBe(false)
      // Through the seam, never hand-rolled — the failure this guards is a page copying a
      // composition back into itself.
      expect(code(read(file))).toContain('<EventUtilityLayout>')
      expect(mountsIn(file), route).toEqual([])
    })
  }

  it('EventUtilityLayout is a pure delegation to HomeShell', () => {
    const src = code(read('components/marketing/layout/EventUtilityLayout.tsx'))
    expect(src).toMatch(/<HomeShell>\s*\{children\}\s*<\/HomeShell>/)
    // It USED to own a navbar, a <main id="main-content"> and a footer. HomeShell owns all
    // three now; a copy here would nest a second landmark inside the first.
    expect(src).not.toMatch(/<(?:Home|Marketing)Navbar\b|<(?:Home|Marketing)Footer\b|<main\b|<SkipToContent/)
  })

  it('RENDERS exactly one header, one footer and one main landmark', async () => {
    // Two of the four routes can be checked against a running server; the other two
    // (register/success, /tickets/[id]) call notFound() before the shell when there is no
    // real registration to show, and no test may invent one. So the shell itself is
    // rendered here — it is the same component, taking children and nothing else.
    const { EventUtilityLayout } = await import('@/components/marketing/layout/EventUtilityLayout')
    const html = renderToStaticMarkup(
      createElement(EventUtilityLayout, null, createElement('p', null, 'PAGE CONTENT')),
    )
    expect(html.match(/<header[\s>]/g) ?? []).toHaveLength(1)
    expect(html.match(/<footer[\s>]/g) ?? []).toHaveLength(1)
    expect(html.match(/id="main-content"/g) ?? []).toHaveLength(1)
    expect(html.match(/href="#main-content"/g) ?? []).toHaveLength(1)
    expect(html).toContain('PAGE CONTENT')
  })

  it('is not a second public marketing shell', () => {
    // Only the four utility routes may use it. A marketing page appearing here means the
    // site has drifted back to two public shells.
    const consumers = Object.values(UTILITY)
    for (const file of ['app/about/page.tsx', 'app/pricing/page.tsx', 'app/causes/page.tsx', 'app/page.tsx']) {
      expect(code(read(file)), file).not.toContain('EventUtilityLayout')
    }
    expect(consumers).toHaveLength(4)
  })
})

describe('the event experience is on the canonical chrome', () => {
  const SHELL = 'components/event-templates/shared/ui/EventPageShell.tsx'

  it('EventPageShell mounts HomeShell in every variant and nothing else', () => {
    const src = code(read(SHELL))
    expect(mountsIn(SHELL)).toEqual(['HomeShell'])
    // Three variants, three return branches, each on the canonical shell. The count is
    // the point: a stale branch still composing its own chrome is how one event type ends
    // up on a different website from the other seven.
    expect(src.match(/<HomeShell>/g) ?? []).toHaveLength(2)
    expect(src.match(/<\/HomeShell>/g) ?? []).toHaveLength(2)
    expect(src).not.toMatch(/<main\b|<footer\b|<SkipToContent/)
    // The 'page-layout' breadcrumb bar is CONTENT, not chrome, and it survives.
    expect(src).toContain('<Breadcrumbs items={buildEventBreadcrumbs(eventType, title)} />')
  })

  it('an event detail page resolves to HomeNavbar + HomeFooter and never the legacy pair', () => {
    const c = chromeOf('app/events/[slug]/page.tsx')
    expect(c.homeNavbar).toBe(true)
    expect(c.homeFooter).toBe(true)
    expect(c.marketingNavbar).toBe(false)
    expect(c.marketingFooter).toBe(false)
  })

  it('no source file mounts MarketingNavbar or MarketingFooter any more', () => {
    // Reachability, not a grep for the word: comments all over the repo still describe the
    // old shell. This walks every page and component and asks what each MOUNTS. The pair
    // is now unreachable from every route, which is the precondition for retiring it — a
    // decision this test records but does not take (see the next block).
    // A filesystem walk, not `git ls-files`: an untracked file is exactly the one a
    // migration in progress would miss.
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = resolvePath(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (name.endsWith('.tsx')) files.push(norm(p).slice(norm(ROOT).length + 1))
      }
    }
    for (const top of ['app', 'components', 'features', 'lib']) walk(resolvePath(ROOT, top))
    expect(files.length).toBeGreaterThan(100)
    const offenders = files.filter(f => {
      if (f === CHROME.marketingNavbar || f === CHROME.marketingFooter) return false
      const m = mountsIn(f)
      return m.includes('MarketingNavbar') || m.includes('MarketingFooter')
    })
    expect(offenders).toEqual([])
  }, 30_000)   // a whole-tree read; seconds alone, longer under full-suite contention

  it('MarketingNavbar and MarketingFooter are RETIRED — the files are gone, the registry stays', () => {
    // Phase 1 left them unreachable but present. The retirement audit then resolved every
    // import from every production entry and proved the whole cone dead — the pair, the
    // mega-menu, the mobile drawer, NavAtoms, the five footer parts and MarketingLayout —
    // so it was deleted. content/marketing/footer.ts is NOT part of that cone: HomeFooter
    // reads FOOTER_LEGAL and FOOTER_BRAND from it, so it stays, and this pins both halves.
    for (const f of [
      CHROME.marketingNavbar,
      CHROME.marketingFooter,
      'components/marketing/navigation/MegaMenu.tsx',
      'components/marketing/navigation/MobileDrawer.tsx',
      'components/marketing/navigation/NavAtoms.tsx',
      'components/marketing/layout/MarketingLayout.tsx',
    ]) {
      expect(existsSync(resolvePath(ROOT, f)), f + ' has come back').toBe(false)
    }
    expect(existsSync(resolvePath(ROOT, 'components/marketing/navigation'))).toBe(false)
    expect(existsSync(resolvePath(ROOT, 'components/marketing/footer'))).toBe(false)
    expect(existsSync(resolvePath(ROOT, 'content/marketing/footer.ts'))).toBe(true)
    expect(code(read('components/discovery/home/HomeFooter.tsx'))).toContain("from '@/content/marketing/footer'")
  })
})

describe('surfaces outside the public site keep their own shells', () => {
  it('the auth screens still carry the auth chrome', () => {
    // AuthScreen composes AuthShell + AuthFooter, and each page mounts its own heading
    // because the title changes per step. Both halves must stay auth-only.
    const screen = code(read('components/auth/AuthScreen.tsx'))
    expect(screen).toContain('AuthShell')
    expect(screen).toContain('AuthFooter')

    // /admin/login still mounts AuthHeader. /login no longer does: it was redesigned onto
    // its own AuthSplitLayout with an inline eyebrow/headline block, so AuthHeader is not
    // the chrome it uses any more. What this test is really guarding — that an auth route
    // never reaches for the PUBLIC shell — is asserted for both below and is unaffected.
    // /admin/login followed on 2026-09-23 (owner request): one centred column with its own
    // <main>, the shared LoginForm, and no AuthHeader. Same guard as /login: no public shell.
    const admin = code(read('app/(admin-auth)/admin/login/page.tsx'))
    expect(admin).toContain('LoginForm')
    expect(admin).toContain('<main')
    expect(code(read('app/(auth)/login/page.tsx'))).toContain('AuthSplitLayout')
    for (const src of [screen, code(read('app/(auth)/login/page.tsx')), admin]) {
      expect(src).not.toContain('HomeShell')
      expect(src).not.toContain('HomeNavbar')
      expect(src).not.toContain('MarketingPageLayout')
    }
  })

  it('the dashboard layout still mounts DashboardHeader', () => {
    const src = code(read('app/(dashboard)/layout.tsx'))
    expect(src).toContain('DashboardHeader')
    expect(src).not.toContain('HomeShell')
    expect(src).not.toContain('HomeNavbar')
  })

  it('no protected surface picked up the public shell', () => {
    for (const f of [
      'app/(dashboard)/layout.tsx',
      'app/attendee/layout.tsx',
      'app/ops/layout.tsx',
      'app/staff/layout.tsx',
      'app/(auth)/layout.tsx',
    ]) {
      const src = code(read(f))
      expect(src, f).not.toContain('MarketingPageLayout')
      expect(src, f).not.toContain('HomeShell')
    }
  })
})

describe('/events is still the compatibility redirect', () => {
  const src = code(read('app/events/page.tsx'))

  it('redirects to the landing page, carrying any query with it', () => {
    // `/events?type=sports` is what the event breadcrumb links to, and `type` is a
    // documented alias in lib/discovery/urlState.ts. A redirect that dropped the query
    // landed every breadcrumb on the unfiltered homepage.
    expect(src).toContain("import { redirect } from 'next/navigation'")
    expect(src).toContain("redirect(query ? `/?${query}` : '/')")
    expect(src).toContain('await searchParams')
  })

  it('answers 307 and not 308', () => {
    // permanentRedirect() is cached hard by browsers and intermediaries; if /events is ever
    // given a page again, everyone who saw a 308 would keep skipping it.
    expect(src).not.toContain('permanentRedirect')
  })

  it('renders no chrome of its own', () => {
    expect(mountsIn('app/events/page.tsx')).toEqual([])
  })
})
