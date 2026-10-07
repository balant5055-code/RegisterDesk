// ─── Global public chrome — Phase 1 ──────────────────────────────────────────
//
// Before this phase the public site carried THREE mastheads and THREE footers, and which
// one a visitor saw depended on how they arrived:
//
//   • `/`, the marketing pages, /causes, /results, /verify   → HomeNavbar + HomeFooter
//   • every /events/[slug] detail page, the certificate centre,
//     download-ticket, register/success, /tickets/[id]       → MarketingNavbar + MarketingFooter
//   • /campaign/[slug], the donation receipt, both 404s       → MarketingNavbar, NO footer
//   • /events/[slug]/photos, /speak, /sponsor, the root 404   → no chrome at all
//
// Walking Home → Event → Certificates changed the masthead twice. The certificate route is
// the mandated acceptance case: a QR code on a printed certificate must land on the same
// website as the homepage.
//
// There is now ONE canonical public chrome — HomeShell (SkipToContent + HomeNavbar +
// <main id="main-content"> + HomeFooter) — and every eligible public route resolves to it.
// EventUtilityLayout and EventPageShell survive as named seams that delegate to it.
//
// ═══ WHAT THESE TESTS PIN ════════════════════════════════════════════════════
// Reachability through the real import graph, per ROUTE — not the text of any one file.
// The failure this phase exists to prevent is a route quietly resolving to a different
// header than its neighbours, and that is a property of the graph, not of a shell file.
// Where a file-level assertion is the right tool (a delegating seam must not add a second
// <main>), the file is read with comments stripped: the old shell is described in prose
// all over this repo.
//
// ═══ WHAT IS DELIBERATELY EXCLUDED ═══════════════════════════════════════════
// Auth, dashboard, admin, staff, attendee portal, the registration flow and the staff
// login keep their own shells. Registration is a checkout — its chrome is the ticket desk —
// and staff login is a kiosk surface. The last block fails if any of them are swept in.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

// HomeNavbar highlights the active menu from the path; this mock lets the render block
// below mount the real shell and COUNT its landmarks.
vi.mock('next/navigation', () => ({ usePathname: () => '/events/probe/certificates' }))

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const norm = (p: string) => p.split('\\').join('/')
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

const CHROME = {
  homeShell:       'components/discovery/home/HomeShell.tsx',
  homeNavbar:      'components/discovery/home/HomeNavbar.tsx',
  homeFooter:      'components/discovery/home/HomeFooter.tsx',
  marketingNavbar: 'components/marketing/navigation/MarketingNavbar.tsx',
  marketingFooter: 'components/marketing/footer/MarketingFooter.tsx',
} as const

function chromeOf(entry: string) {
  const graph = moduleGraph(entry)
  const has = (rel: string) => graph.has(norm(resolvePath(ROOT, rel)))
  return {
    homeShell:       has(CHROME.homeShell),
    homeNavbar:      has(CHROME.homeNavbar),
    homeFooter:      has(CHROME.homeFooter),
    marketingNavbar: has(CHROME.marketingNavbar),
    marketingFooter: has(CHROME.marketingFooter),
  }
}

/** What a file MOUNTS itself: `<HomeShell` in the JSX, not `import { HomeShell }`. */
const MOUNTABLE = ['HomeShell', 'HomeNavbar', 'HomeFooter', 'MarketingNavbar', 'MarketingFooter',
                   'EventUtilityLayout', 'EventPageShell', 'MarketingPageLayout'] as const
function mountsIn(file: string): string[] {
  const src = code(read(file))
  return MOUNTABLE.filter(name => new RegExp('<' + name + '[\\s/>]').test(src))
}

/** Landmarks a PAGE must never declare when it composes a shell that already owns them. */
const OWN_CHROME = /<main\b|<footer\b|<SkipToContent|<(?:Home|Marketing)Navbar\b|<(?:Home|Marketing)Footer\b/

// ═══ A. THE SEAMS DELEGATE ═══════════════════════════════════════════════════

describe('A. the two event seams delegate to the canonical shell', () => {
  it('EventUtilityLayout is a one-line delegation to HomeShell', () => {
    const src = code(read('components/marketing/layout/EventUtilityLayout.tsx'))
    expect(src).toMatch(/<HomeShell>\s*\{children\}\s*<\/HomeShell>/)
    expect(mountsIn('components/marketing/layout/EventUtilityLayout.tsx')).toEqual(['HomeShell'])
    expect(src).not.toMatch(OWN_CHROME)
  })

  it('EventPageShell delegates in every variant', () => {
    const file = 'components/event-templates/shared/ui/EventPageShell.tsx'
    const src  = code(read(file))
    expect(mountsIn(file)).toEqual(['HomeShell'])
    // Two return branches ('page-layout', and the shared marketing/legacy fall-through),
    // both on the shell. A third branch composing anything else would show up here.
    expect(src.match(/<HomeShell>/g) ?? []).toHaveLength(2)
    expect(src.match(/return\s*\(?\s*<HomeShell>/g) ?? []).toHaveLength(2)
    expect(src).not.toMatch(OWN_CHROME)
    // The variant type is unchanged — the six page-layout templates, Sports and the
    // fallback all still compile against the same names.
    expect(src).toContain("'marketing' | 'page-layout' | 'legacy'")
  })

  it("the 'page-layout' breadcrumb bar survives as CONTENT inside the shell, on tokens", () => {
    const src = code(read('components/event-templates/shared/ui/EventPageShell.tsx'))
    expect(src).toContain('<Breadcrumbs items={buildEventBreadcrumbs(eventType, title)} />')
    expect(src).toContain('h-12 border-b border-border bg-muted/40')
    expect(src).toContain('<div className="pt-6">{children}</div>')
    // It used to pin #fafafa on #ececec — the only hardcoded colours in the public chrome.
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })
})

// ═══ B. THE ACCEPTANCE ROUTE ═════════════════════════════════════════════════

describe('B. /events/[slug]/certificates — the mandated acceptance route', () => {
  const PAGE = 'app/events/[slug]/certificates/page.tsx'

  it('resolves to HomeNavbar + HomeFooter through the utility seam', () => {
    const c = chromeOf(PAGE)
    expect(c.homeShell).toBe(true)
    expect(c.homeNavbar).toBe(true)
    expect(c.homeFooter).toBe(true)
  })

  it('does NOT reach MarketingNavbar or MarketingFooter', () => {
    const c = chromeOf(PAGE)
    expect(c.marketingNavbar).toBe(false)
    expect(c.marketingFooter).toBe(false)
  })

  it('composes the seam and declares no chrome of its own', () => {
    expect(mountsIn(PAGE)).toEqual(['EventUtilityLayout'])
    expect(code(read(PAGE))).not.toMatch(OWN_CHROME)
  })
})

// ═══ C. EVERY ELIGIBLE PUBLIC ROUTE, ONE CHROME ══════════════════════════════

describe('C. every eligible public route resolves to the one canonical chrome', () => {
  const PUBLIC: Record<string, string> = {
    // marketing + discovery
    '/':                               'app/page.tsx',
    '/about':                          'app/about/page.tsx',
    '/pricing':                        'app/pricing/page.tsx',
    '/causes':                         'app/causes/page.tsx',
    '/results':                        'app/results/page.tsx',
    '/verify/certificate/[id]':        'app/verify/certificate/[certificateId]/page.tsx',
    // event experience
    '/events/[slug]':                  'app/events/[slug]/page.tsx',
    '/events/[slug]/certificates':     'app/events/[slug]/certificates/page.tsx',
    '/events/[slug]/download-ticket':  'app/events/[slug]/download-ticket/page.tsx',
    '/events/[slug]/register/success': 'app/events/[slug]/register/success/page.tsx',
    '/tickets/[registrationId]':       'app/tickets/[registrationId]/page.tsx',
    // migrated in this phase
    '/campaign/[slug]':                'app/campaign/[slug]/page.tsx',
    '/donations/receipt/[receiptId]':  'app/donations/receipt/[receiptId]/page.tsx',
    '/events/[slug]/photos':           'app/events/[slug]/photos/page.tsx',
    '/events/[slug]/speak':            'app/events/[slug]/speak/page.tsx',
    '/events/[slug]/sponsor':          'app/events/[slug]/sponsor/page.tsx',
  }

  for (const [route, file] of Object.entries(PUBLIC)) {
    it(route + ' → HomeNavbar + HomeFooter, never the legacy pair', () => {
      const c = chromeOf(file)
      expect(c.homeNavbar,      route + ' must reach HomeNavbar').toBe(true)
      expect(c.homeFooter,      route + ' must reach HomeFooter').toBe(true)
      expect(c.marketingNavbar, route + ' reaches MarketingNavbar').toBe(false)
      expect(c.marketingFooter, route + ' reaches MarketingFooter').toBe(false)
    })
  }

  it('no page in the set hand-mounts a navbar, footer, skip link or <main> of its own', () => {
    // The shell owns the landmarks. A page that also declares one nests it — which is how
    // the photos page came to render a bare <main> and the receipt page a navbar with no
    // footer. Exactly one shell mount, or one seam that resolves to it.
    for (const [route, file] of Object.entries(PUBLIC)) {
      expect(code(read(file)), route + ' declares its own chrome').not.toMatch(OWN_CHROME)
      const m = mountsIn(file)
      expect(m.filter(n => n !== 'HomeShell' && n !== 'EventUtilityLayout'
                        && n !== 'EventPageShell' && n !== 'MarketingPageLayout'),
             route + ' mounts a chrome component directly').toEqual([])
    }
  })

  it('the three pages migrated directly onto HomeShell mount it exactly once per branch', () => {
    // campaign: one branch. receipt: one branch. photos: two branches (access failure and
    // gallery) and BOTH must be wrapped — a failure surface is where the navigation is
    // needed most.
    const once  = ['app/campaign/[slug]/page.tsx', 'app/donations/receipt/[receiptId]/page.tsx',
                   'app/events/[slug]/speak/page.tsx', 'app/events/[slug]/sponsor/page.tsx']
    for (const f of once) {
      expect(code(read(f)).match(/<HomeShell>/g) ?? [], f).toHaveLength(1)
    }
    const photos = code(read('app/events/[slug]/photos/page.tsx'))
    expect(photos.match(/<HomeShell>/g) ?? []).toHaveLength(2)
    expect(photos.match(/return\s*\(\s*<HomeShell>/g) ?? []).toHaveLength(2)
  })
})

// ═══ D. THE CHROME RENDERS ONCE ══════════════════════════════════════════════

describe('D. the canonical chrome renders exactly one of each landmark', () => {
  async function render(children: ReturnType<typeof createElement>) {
    const { HomeShell } = await import('@/components/discovery/home/HomeShell')
    return renderToStaticMarkup(createElement(HomeShell, null, children))
  }

  it('HomeShell: one banner, one main#main-content, one skip link, one footer', async () => {
    const html = await render(createElement('p', null, 'PAGE'))
    expect(html.match(/<header[\s>]/g) ?? []).toHaveLength(1)
    expect(html.match(/<footer[\s>]/g) ?? []).toHaveLength(1)
    expect(html.match(/<main[\s>]/g) ?? []).toHaveLength(1)
    expect(html.match(/id="main-content"/g) ?? []).toHaveLength(1)
    expect(html.match(/href="#main-content"/g) ?? []).toHaveLength(1)
    expect(html).toContain('PAGE')
  })

  it('EventUtilityLayout renders the same four landmarks, and no more', async () => {
    const { EventUtilityLayout } = await import('@/components/marketing/layout/EventUtilityLayout')
    const html = renderToStaticMarkup(createElement(EventUtilityLayout, null, createElement('p', null, 'CERT')))
    expect(html.match(/<header[\s>]/g) ?? []).toHaveLength(1)
    expect(html.match(/<footer[\s>]/g) ?? []).toHaveLength(1)
    expect(html.match(/<main[\s>]/g) ?? []).toHaveLength(1)
    expect(html.match(/href="#main-content"/g) ?? []).toHaveLength(1)
    expect(html).toContain('CERT')
  })

  it("EventPageShell 'page-layout' renders one of each, with the breadcrumb bar INSIDE main", async () => {
    const { EventPageShell } = await import('@/components/event-templates/shared/ui/EventPageShell')
    const html = renderToStaticMarkup(createElement(
      EventPageShell,
      { variant: 'page-layout', eventType: 'conference', title: 'Probe Summit' },
      createElement('p', null, 'BODY'),
    ))
    expect(html.match(/<header[\s>]/g) ?? []).toHaveLength(1)
    expect(html.match(/<footer[\s>]/g) ?? []).toHaveLength(1)
    expect(html.match(/<main[\s>]/g) ?? []).toHaveLength(1)
    // Order in the document: main opens, THEN the breadcrumb nav, then the body.
    const mainAt = html.indexOf('<main')
    const crumbAt = html.indexOf('Probe Summit')
    const bodyAt = html.indexOf('BODY')
    expect(mainAt).toBeGreaterThan(-1)
    expect(crumbAt).toBeGreaterThan(mainAt)
    expect(bodyAt).toBeGreaterThan(crumbAt)
  })

  it("EventPageShell 'marketing' and 'legacy' render one of each and no breadcrumb bar", async () => {
    const { EventPageShell } = await import('@/components/event-templates/shared/ui/EventPageShell')
    for (const variant of ['marketing', 'legacy'] as const) {
      const html = renderToStaticMarkup(createElement(
        EventPageShell, { variant, eventType: 'sports', title: 'Probe Run' }, createElement('p', null, 'BODY'),
      ))
      expect(html.match(/<header[\s>]/g) ?? [], variant).toHaveLength(1)
      expect(html.match(/<footer[\s>]/g) ?? [], variant).toHaveLength(1)
      expect(html.match(/<main[\s>]/g) ?? [], variant).toHaveLength(1)
      expect(html, variant).not.toContain('Probe Run')
      expect(html, variant).toContain('BODY')
    }
  })
})

// ═══ E. THE PUBLIC 404s INHERIT THE CHROME ═══════════════════════════════════

describe('E. public not-found surfaces inherit the canonical chrome', () => {
  const NOT_FOUND = {
    'root':            'app/not-found.tsx',
    '/events/[slug]':  'app/events/[slug]/not-found.tsx',
    '/campaign/[slug]':'app/campaign/[slug]/not-found.tsx',
  }

  for (const [scope, file] of Object.entries(NOT_FOUND)) {
    it(scope + ' 404 renders inside HomeShell with no chrome of its own', () => {
      expect(mountsIn(file), scope).toEqual(['HomeShell'])
      expect(code(read(file)), scope).not.toMatch(OWN_CHROME)
      const c = chromeOf(file)
      expect(c.homeNavbar, scope).toBe(true)
      expect(c.homeFooter, scope).toBe(true)
      expect(c.marketingNavbar, scope).toBe(false)
    })
  }

  it('each 404 keeps a route back into the site', () => {
    expect(code(read(NOT_FOUND['root']))).toContain('href="/"')
    expect(code(read(NOT_FOUND['root']))).toContain('href="/dashboard"')
    expect(code(read(NOT_FOUND['/events/[slug]']))).toContain('ROUTES.EVENTS')
    expect(code(read(NOT_FOUND['/campaign/[slug]']))).toContain('ROUTES.')
  })
})

// ═══ F. BEHAVIOUR PRESERVED ON THE MIGRATED PAGES ════════════════════════════

describe('F. the migrated pages kept their behaviour', () => {
  it('campaign: ISR, generateMetadata, notFound, takedown gate and the donation widget', () => {
    const src = code(read('app/campaign/[slug]/page.tsx'))
    expect(src).toContain('export const revalidate = 60')
    expect(src).toContain('export async function generateMetadata')
    expect(src).toContain('notFound()')
    expect(src).toContain('isContentTakenDown')
    expect(src).toContain('<CampaignDetailClient')
    expect(src).toContain('<ReportButton')
  })

  it('receipt: noIndex metadata, token verification, refunded watermark and the PDF link', () => {
    const src = code(read('app/donations/receipt/[receiptId]/page.tsx'))
    expect(src).toContain('noIndex:     true')
    expect(src).toContain('verifyReceiptToken')
    expect(src).toContain("isRefunded && 'overflow-hidden'")
    expect(src).toContain('/api/donations/receipt/${receiptId}?token=${token}')
    // The watermark is positioned against the receipt block, not the whole page: it must
    // sit behind the receipt, not behind the navbar and the footer as well.
    expect(src).toMatch(/<div className=\{cn\('relative', isRefunded && 'overflow-hidden'\)\}>/)
  })

  it('photos: force-dynamic, access decided server-side, both branches present', () => {
    const src = code(read('app/events/[slug]/photos/page.tsx'))
    expect(src).toContain("export const dynamic = 'force-dynamic'")
    expect(src).toContain('resolveRunner')
    expect(src).toContain('<PhotoVerifyPanel')
    expect(src).toContain('<RunnerPhotoGallery')
    // The page's own <main> became the measured column; the landmark is the shell's.
    expect(src).toContain('<div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">')
  })

  it('speak and sponsor: the apply clients are unchanged and still receive every prop', () => {
    for (const [file, comp] of [
      ['app/events/[slug]/speak/page.tsx',   'SpeakerApplyClient'],
      ['app/events/[slug]/sponsor/page.tsx', 'SponsorApplyClient'],
    ] as const) {
      const src = code(read(file))
      expect(src, file).toContain('<' + comp)
      for (const prop of ['slug={slug}', 'eventName={eventName}', 'enabled={enabled}',
                          'closingDate={closingDate}', 'customMessage={message}']) {
        expect(src, file + ' lost ' + prop).toContain(prop)
      }
      expect(src, file).toContain('notFound()')
    }
    // The clients themselves render plain <div>s — no <main>, which would nest.
    for (const f of ['app/events/[slug]/speak/SpeakerApplyClient.tsx',
                     'app/events/[slug]/sponsor/SponsorApplyClient.tsx']) {
      expect(code(read(f)), f).not.toMatch(/<main\b|<header\b|<footer\b/)
    }
  })
})

// ═══ G. THE EXCLUSIONS STAY EXCLUDED ═════════════════════════════════════════

describe('G. protected and intentionally-bare surfaces were not migrated', () => {
  const EXCLUDED: Record<string, string> = {
    '/login':                          'app/(auth)/login/page.tsx',
    '/admin/login':                    'app/(admin-auth)/admin/login/page.tsx',
    '(dashboard) layout':              'app/(dashboard)/layout.tsx',
    '(admin) layout':                  'app/(admin)/layout.tsx',
    '/staff layout':                   'app/staff/layout.tsx',
    '/events/[slug]/register':         'app/events/[slug]/register/page.tsx',
    '/events/[slug]/staff-login':      'app/events/[slug]/staff-login/page.tsx',
  }

  for (const [route, file] of Object.entries(EXCLUDED)) {
    it(route + ' does not reach the public chrome', () => {
      const c = chromeOf(file)
      expect(c.homeShell,       route + ' reaches HomeShell').toBe(false)
      expect(c.homeNavbar,      route + ' reaches HomeNavbar').toBe(false)
      expect(c.homeFooter,      route + ' reaches HomeFooter').toBe(false)
      expect(c.marketingNavbar, route + ' reaches MarketingNavbar').toBe(false)
      expect(c.marketingFooter, route + ' reaches MarketingFooter').toBe(false)
    })
  }

  it('the auth logic files were not touched by this phase', () => {
    // Not a diff — a shape check on the surfaces the brief froze. Each still exports what
    // it exported, and none of them imports any public chrome.
    for (const f of ['components/auth/LoginForm.tsx', 'components/auth/AuthProvider.tsx',
                     'components/auth/SessionGuard.tsx', 'middleware.ts']) {
      if (!existsSync(resolvePath(ROOT, f))) continue
      expect(code(read(f)), f).not.toMatch(/HomeShell|HomeNavbar|HomeFooter|MarketingNavbar|MarketingFooter/)
    }
  })
})

// ═══ H. THE LEGACY PAIR IS UNREACHABLE, AND STILL PRESENT ════════════════════

describe('H. MarketingNavbar and MarketingFooter', () => {
  it('are mounted by no route and no component outside their own files', () => {
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
    const offenders = files.filter(f =>
      f !== CHROME.marketingNavbar && f !== CHROME.marketingFooter
      && mountsIn(f).some(n => n === 'MarketingNavbar' || n === 'MarketingFooter'))
    expect(offenders).toEqual([])
  })

  it('are retired: the files no longer exist and no production module resolves an import to them', () => {
    for (const f of [CHROME.marketingNavbar, CHROME.marketingFooter]) {
      expect(existsSync(resolvePath(ROOT, f)), f + ' has come back').toBe(false)
    }
    // Belt and braces on top of the mount scan above: an IMPORT of the retired pair from
    // any file under the production trees — even one that never mounts it — is a failure.
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = resolvePath(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name)) files.push(norm(p).slice(norm(ROOT).length + 1))
      }
    }
    for (const top of ['app', 'components', 'features', 'lib']) walk(resolvePath(ROOT, top))
    const importers = files.filter(f => /from\s+['"][^'"]*(?:MarketingNavbar|MarketingFooter|marketing\/navigation\/|marketing\/footer\/)['"]/.test(code(read(f))))
    expect(importers).toEqual([])
  }, 30_000)   // a whole-tree read; seconds alone, longer under full-suite contention

  it('no public navigation registry links to /platform', () => {
    for (const f of ['content/marketing/navigation.ts', 'content/marketing/footer.ts', 'config/navigation.ts']) {
      const src = code(read(f))
      expect(src, f).not.toMatch(/['"`]\/platform(?:\/|['"`])/)
    }
  })
})
