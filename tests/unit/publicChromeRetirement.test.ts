// ─── Public chrome retirement — Phase 3 ──────────────────────────────────────
//
// Phase 1 put every eligible public route on HomeShell and left MarketingNavbar and
// MarketingFooter in the tree, unreachable but present, because retiring them needed its
// own audit. Phase 3 ran that audit: every `@/` and relative import from every production
// entry (page / layout / not-found / error / route / sitemap / robots, plus middleware)
// was resolved the way the bundler resolves it, and the whole cone came back dead —
//
//   components/marketing/navigation/  MarketingNavbar, MegaMenu, MobileDrawer, NavAtoms
//   components/marketing/footer/      MarketingFooter, ~Column, ~Bottom, ~Link, ~Social,
//                                     FooterWordmark, FooterBackdrop
//   components/marketing/layout/MarketingLayout.tsx
//   styles/heroSwiper.css
//
// An earlier grep had counted "other consumers" for MegaMenu, MobileDrawer, FooterWordmark
// and FooterBackdrop; resolved, those were comments, each other, and the ADMIN layout's
// own local `MobileDrawer` function — a name collision, not an import. This file re-runs
// that audit on every test run, so the retirement is proven, not remembered.
//
// ═══ WHAT STAYS, AND WHY ═════════════════════════════════════════════════════
// content/marketing/footer.ts is LIVE — HomeFooter reads FOOTER_LEGAL and FOOTER_BRAND —
// and BrandLockup is shared by the canonical chrome and the auth pages. Neither is part of
// the retired cone and both are pinned present below.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'

const ROOT = process.cwd()
const norm = (p: string) => p.split('\\').join('/')
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function walk(dir: string, out: string[] = []): string[] {
  const abs = resolvePath(ROOT, dir)
  if (!existsSync(abs)) return out
  for (const name of readdirSync(abs)) {
    const rel = dir + '/' + name
    if (statSync(resolvePath(ROOT, rel)).isDirectory()) { if (name !== 'node_modules') walk(rel, out) }
    else if (/\.(tsx?|css)$/.test(name)) out.push(norm(rel))
  }
  return out
}

// ─── The import graph, resolved the way the bundler resolves it ──────────────

const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.css']
function resolveModule(spec: string, fromRel: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = resolvePath(ROOT, spec.slice(2))
  else if (spec.startsWith('.')) base = resolvePath(ROOT, dirname(fromRel), spec)
  else return null
  for (const e of EXTS) {
    const p = base + e
    if (existsSync(p) && statSync(p).isFile()) return norm(p).slice(norm(ROOT).length + 1)
  }
  return null
}
function importsOf(rel: string): string[] {
  const src = SRC.get(rel) ?? code(read(rel))
  const re = /(?:from\s+|import\s+|import\(\s*|@import\s+)['"]([^'"]+)['"]/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) { const t = resolveModule(m[1]!, rel); if (t) out.push(t) }
  return out
}

const ALL = [...walk('app'), ...walk('components'), ...walk('lib'), ...walk('features'), ...walk('styles'), ...walk('content'), ...walk('config')]
/** Comment-stripped source of every file, read once — the audit asks the tree 13 questions. */
const SRC = new Map<string, string>(ALL.map(f => [f, code(read(f))]))
const ENTRIES = [
  ...ALL.filter(f => /^app\/.*(?:^|\/)(?:page|layout|not-found|error|global-error|template|loading|default|route|sitemap|robots|opengraph-image|icon)\.tsx?$/.test(f)),
  ...['middleware.ts', 'instrumentation.ts'].filter(f => existsSync(resolvePath(ROOT, f))),
]
const REACHABLE = (() => {
  const seen = new Set<string>()
  const stack = [...ENTRIES]
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    for (const d of importsOf(f)) stack.push(d)
  }
  return seen
})()

const RETIRED = [
  'components/marketing/navigation/MarketingNavbar.tsx',
  'components/marketing/navigation/MegaMenu.tsx',
  'components/marketing/navigation/MobileDrawer.tsx',
  'components/marketing/navigation/NavAtoms.tsx',
  'components/marketing/footer/MarketingFooter.tsx',
  'components/marketing/footer/MarketingFooterColumn.tsx',
  'components/marketing/footer/MarketingFooterBottom.tsx',
  'components/marketing/footer/MarketingFooterLink.tsx',
  'components/marketing/footer/MarketingFooterSocial.tsx',
  'components/marketing/footer/FooterWordmark.tsx',
  'components/marketing/footer/FooterBackdrop.tsx',
  'components/marketing/layout/MarketingLayout.tsx',
  'styles/heroSwiper.css',
]

// ═══ 1–2. NO PRODUCTION CONSUMERS, AND THE FILES ARE GONE ════════════════════

describe('1–2. MarketingNavbar and MarketingFooter have no production consumers', () => {
  it('the audit is real: hundreds of entries, thousands of reachable modules', () => {
    expect(ENTRIES.length).toBeGreaterThan(400)
    expect(REACHABLE.size).toBeGreaterThan(1500)
    expect(REACHABLE.has('components/discovery/home/HomeShell.tsx')).toBe(true)
  })

  for (const f of RETIRED) {
    it(f + ' — deleted, and resolved by no production import', () => {
      expect(existsSync(resolvePath(ROOT, f)), f + ' has come back').toBe(false)
      expect(REACHABLE.has(f)).toBe(false)
      // No surviving module even NAMES it in an import, resolved or not.
      const re = new RegExp("from\\s+['\"][^'\"]*" + f.split('/').pop()!.replace(/\.\w+$/, '') + "['\"]")
      const naming = ALL.filter(g => re.test(SRC.get(g)!))
      expect(naming, 'still imported by').toEqual([])
    }, 30_000)
  }

  it('the two retired directories are gone', () => {
    expect(existsSync(resolvePath(ROOT, 'components/marketing/navigation'))).toBe(false)
    expect(existsSync(resolvePath(ROOT, 'components/marketing/footer'))).toBe(false)
  })

  it('what the cone shared with the canonical chrome survives, and is live', () => {
    for (const f of ['content/marketing/footer.ts', 'components/marketing/BrandLockup.tsx', 'components/marketing/SkipToContent.tsx']) {
      expect(existsSync(resolvePath(ROOT, f)), f).toBe(true)
      expect(REACHABLE.has(f), f + ' is not reachable from any production entry').toBe(true)
    }
  })
})

// ═══ 3–4. THE CANONICAL SHELL, AND EVERY ELIGIBLE ROUTE ══════════════════════

describe('3–4. HomeShell is the one public shell and every eligible public route resolves to it', () => {
  const SHELL = 'components/discovery/home/HomeShell.tsx'
  const NAVBAR = 'components/discovery/home/HomeNavbar.tsx'
  const FOOTER = 'components/discovery/home/HomeFooter.tsx'

  it('HomeShell composes exactly SkipToContent → HomeNavbar → main#main-content → HomeFooter', () => {
    const src = code(read(SHELL))
    const order = ['<SkipToContent />', '<HomeNavbar />', '<main id="main-content"', '<HomeFooter />'].map(t => src.indexOf(t))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(src.match(/<main\b/g) ?? []).toHaveLength(1)
  })

  it('HomeNavbar renders the one <header>; HomeFooter the one <footer>', () => {
    expect((code(read(NAVBAR)).match(/<header\b/g) ?? [])).toHaveLength(1)
    expect((code(read(FOOTER)).match(/<footer\b/g) ?? [])).toHaveLength(1)
    expect(code(read(SHELL))).not.toMatch(/<header\b|<footer\b/)
  })

  const PUBLIC: Record<string, string> = {
    '/':                               'app/page.tsx',
    '/about':                          'app/about/page.tsx',
    '/pricing':                        'app/pricing/page.tsx',
    '/contact':                        'app/contact/page.tsx',
    '/security':                       'app/security/page.tsx',
    '/support':                        'app/support/page.tsx',
    '/causes':                         'app/causes/page.tsx',
    '/results':                        'app/results/page.tsx',
    '/verify/certificate/[id]':        'app/verify/certificate/[certificateId]/page.tsx',
    '/events/[slug]':                  'app/events/[slug]/page.tsx',
    '/events/[slug]/certificates':     'app/events/[slug]/certificates/page.tsx',
    '/events/[slug]/photos':           'app/events/[slug]/photos/page.tsx',
    '/events/[slug]/speak':            'app/events/[slug]/speak/page.tsx',
    '/events/[slug]/sponsor':          'app/events/[slug]/sponsor/page.tsx',
    '/events/[slug]/download-ticket':  'app/events/[slug]/download-ticket/page.tsx',
    '/events/[slug]/register/success': 'app/events/[slug]/register/success/page.tsx',
    '/tickets/[registrationId]':       'app/tickets/[registrationId]/page.tsx',
    '/campaign/[slug]':                'app/campaign/[slug]/page.tsx',
    '/donations/receipt/[receiptId]':  'app/donations/receipt/[receiptId]/page.tsx',
    'root 404':                        'app/not-found.tsx',
    'event 404':                       'app/events/[slug]/not-found.tsx',
    'campaign 404':                    'app/campaign/[slug]/not-found.tsx',
  }

  function graphOf(entry: string): Set<string> {
    const seen = new Set<string>()
    const stack = [entry]
    while (stack.length) { const f = stack.pop()!; if (seen.has(f)) continue; seen.add(f); for (const d of importsOf(f)) stack.push(d) }
    return seen
  }

  for (const [route, file] of Object.entries(PUBLIC)) {
    it(route + ' → HomeShell + HomeNavbar + HomeFooter, and nothing retired', () => {
      if (!existsSync(resolvePath(ROOT, file))) return   // /results and /support are optional routes in some trees
      const g = graphOf(file)
      expect(g.has(SHELL), route + ' does not reach HomeShell').toBe(true)
      expect(g.has(NAVBAR), route).toBe(true)
      expect(g.has(FOOTER), route).toBe(true)
      for (const r of RETIRED) expect(g.has(r), route + ' reaches ' + r).toBe(false)
    })
  }
})

// ═══ 6. PROTECTED SURFACES KEEP --primary ════════════════════════════════════

describe('6. the protected product keeps --primary and reaches no public chrome', () => {
  const PROTECTED: Record<string, string> = {
    '/login':                     'app/(auth)/login/page.tsx',
    '/admin/login':               'app/(admin-auth)/admin/login/page.tsx',
    '(admin) layout':             'app/(admin)/layout.tsx',
    '(dashboard) layout':         'app/(dashboard)/layout.tsx',
    '/events/[slug]/register':    'app/events/[slug]/register/page.tsx',
    '/events/[slug]/staff-login': 'app/events/[slug]/staff-login/page.tsx',
    '/staff layout':              'app/staff/layout.tsx',
    '/attendee':                  'app/attendee/layout.tsx',
  }
  for (const [route, file] of Object.entries(PROTECTED)) {
    it(route + ' does not reach the public shell', () => {
      if (!existsSync(resolvePath(ROOT, file))) return
      const seen = new Set<string>(); const stack = [file]
      while (stack.length) { const f = stack.pop()!; if (seen.has(f)) continue; seen.add(f); for (const d of importsOf(f)) stack.push(d) }
      expect(seen.has('components/discovery/home/HomeShell.tsx'), route).toBe(false)
      expect(seen.has('components/discovery/home/HomeNavbar.tsx'), route).toBe(false)
      expect(seen.has('components/discovery/home/HomeFooter.tsx'), route).toBe(false)
    })
  }

  it('the product accent is still defined, still painted by the product button, still used', () => {
    expect(read('styles/tokens.css')).toMatch(/--primary:\s+#4F46E5/i)   // 2026-09-29: magenta → logo indigo (owner)
    expect(read('styles/tokens.css')).toMatch(/--primary-gradient:\s+linear-gradient/)
    expect(code(read('components/ui/button.tsx'))).toContain("'bg-primary text-white font-semibold rounded-lg '")
    const users = [...walk('app/(dashboard)'), ...walk('app/(admin)'), ...walk('components/dashboard'), ...walk('components/admin'), ...walk('app/events/[slug]/register')]
      .filter(f => /(?<![\w-])(?:[a-z-]+:)*(?:text|bg|border|ring)-primary(?![\w-])|var\(--primary/.test(code(read(f))))
    expect(users.length, 'protected surfaces lost their --primary usage').toBeGreaterThan(20)
    // And none of them picked up the public event skin by accident.
    expect(users.filter(f => code(read(f)).includes("emphasis: 'gradient'"))).toEqual([])
  })
})

// ═══ 7. THE VENUE CARD NO LONGER CLIPS ═══════════════════════════════════════

describe('7. VenueShowcase lets a long venue name wrap instead of widening the column', () => {
  const src = code(read('components/event-templates/shared/venue/VenueShowcase.tsx'))

  it('the right-hand grid column may shrink below its content (min-w-0)', () => {
    // A grid item's min-width is `auto` — the widest unbreakable token becomes the
    // column's floor. "Mangalam(Near…" (real venue data) set it at 412px on a 343px
    // track, and the section's overflow-hidden clipped the card and its CTA.
    expect(src).toContain('<div className="flex min-w-0 flex-col gap-4 lg:col-span-5">')
  })

  it('the venue name and the address may break inside a word', () => {
    expect(src).toContain("<h3 className={cn(TYPE.cardTitleLg, 'break-words')}>{name}</h3>")
    expect(src).toContain('<span className="min-w-0 break-words">')
    expect(src).toMatch(/<address className=\{cn\('flex min-w-0 items-start/)
  })

  it('the venue data itself is untouched — the fix is layout, not content', () => {
    expect(src).not.toMatch(/\.replace\(|\.slice\(|truncate|line-clamp/)
    expect(src).toContain('{name}')
  })
})
