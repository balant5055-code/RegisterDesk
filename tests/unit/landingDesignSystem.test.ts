// The public landing page's design system.
//
// ═══ WHAT THIS PASS FIXED ════════════════════════════════════════════════════
// The landing components were already almost entirely on semantic tokens — no arbitrary
// font sizes anywhere, one font family, weights confined to normal/medium/semibold/bold.
// The inconsistency was ONE thing, and it was upstream of the components: `--primary` is
// magenta (#e5277e), so every `bg-primary` / `ring-primary` / `text-primary-text` on the
// landing page painted the retired brand colour.
//
// The public accent is now indigo → violet, defined ONCE as --action / --action-end and
// composed into --action-gradient. `--primary` is deliberately left alone: the organizer
// and admin products run on it, and retiring it there is a far larger decision than this
// pass. So there are two accents in the codebase on purpose, and these tests pin which
// surfaces may use which.
//
// The colour change is also an accessibility fix. Measured on white:
//   #4F46E5  6.29:1     #7C3AED  5.70:1     #e5277e  4.27:1  ← under the 4.5 floor

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (p: string) =>
  read(p).split('\n').filter(l => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

const TOKENS = 'styles/tokens.css'
const GLOBALS = 'app/globals.css'
const LANDING_DIR = 'components/discovery/home'
const landingFiles = readdirSync(resolve(process.cwd(), LANDING_DIR))
  .filter(f => f.endsWith('.tsx'))
  .map(f => `${LANDING_DIR}/${f}`)

// ═══ 1 · One canonical gradient ══════════════════════════════════════════════

describe('the brand gradient has exactly one definition', () => {
  it('is composed from the two accent stops, not re-typed hex', () => {
    const src = read(TOKENS)
    expect(src).toContain('--action:            #4F46E5')
    expect(src).toContain('--action-end:        #7C3AED')
    expect(src).toContain('--action-gradient:   linear-gradient(135deg, var(--action) 0%, var(--action-end) 100%)')
  })

  it('nothing else in the repo re-types the gradient literal', () => {
    // The whole point of a canonical token: a second copy drifts the moment one is edited.
    const hits: string[] = []
    for (const f of [...landingFiles, GLOBALS, 'components/marketing/BrandLockup.tsx']) {
      const src = code(f)
      if (/#4[fF]46[eE]5/.test(src) || /#7[cC]3[aA][eE][dD]/.test(src)) hits.push(f)
    }
    // Only tokens.css may hold the literals, and it is not in the list above.
    expect(hits).toEqual([])
  })

  it('the light and dark themes both define the ramp, so it never half-applies', () => {
    const src = read(TOKENS)
    expect((src.match(/--action-gradient:/g) ?? []).length).toBe(2)
    expect((src.match(/--action-end:/g) ?? []).length).toBe(2)
  })

  it('is applied through one utility that only references the token', () => {
    const g = read(GLOBALS)
    expect(g).toContain('.rd-brand-gradient')
    expect(g).toMatch(/\.rd-brand-gradient\s*\{\s*background-image:\s*var\(--action-gradient\);\s*\}/)
    expect(g).toContain('--color-action-end:        var(--action-end)')
  })
})

// ═══ 2 · The retired magenta is gone from the landing ════════════════════════

describe('no landing surface uses the retired magenta brand', () => {
  const MAGENTA_CLASSES = [
    'bg-primary', 'ring-primary', 'border-primary', 'text-primary-text',
    'from-primary', 'to-primary', 'via-primary',
  ]

  it('no landing component references a --primary-derived colour', () => {
    for (const f of landingFiles) {
      const src = code(f)
      for (const c of MAGENTA_CLASSES) {
        expect(src, `${f} uses ${c}`).not.toContain(c)
      }
      expect(src, `${f} reaches --primary through an arbitrary value`).not.toContain('var(--primary')
    }
  })

  it('the shared discovery helpers are clean too', () => {
    const src = code('components/discovery/lib/format.ts')
    expect(src).not.toContain('bg-primary')
    expect(src).toContain('bg-action')
  })

  it('--primary is the logo indigo for the organizer and admin products', () => {
    // Retiring magenta product-wide was a separate decision with a much larger blast
    // radius — taken by the owner on 2026-09-29, in tokens.css, the one right place.
    expect(read(TOKENS)).toContain('--primary:          #4F46E5')
  })
})

// ═══ 3 · The primary CTA ═════════════════════════════════════════════════════

describe('the landing primary CTA', () => {
  const SEARCH = `${LANDING_DIR}/HomeSearch.tsx`

  it('carries the canonical gradient', () => {
    const src = code(SEARCH)
    expect(src).toContain('rd-brand-gradient')
    expect(src).toContain('text-action-foreground')
  })

  it('is carried by exactly ONE thing on the landing page, and it is the CTA', () => {
    // The gradient is an accent, not the design. RD-HERO-03 gave the hero's emphasised
    // phrase back to type — an italic in the warm accent — because gradient text over a
    // photograph competes with the photograph. That leaves the search button alone, which
    // is what an accent should be. A SECOND use is enumerated here, not counted, so
    // adding one is a decision rather than a drift.
    const users = landingFiles.filter(f => code(f).includes('rd-brand-gradient'))
    expect(users).toEqual([SEARCH])
  })

  it('the hero emphasis is ONE phrase, named by the copy, and it is type not gradient', () => {
    const src = code(`${LANDING_DIR}/HeroCopy.tsx`)
    expect(src).toContain('italic text-hero-accent-rule')
    expect(src).toContain('{emphasis}')
    // Which word it is belongs to the copy, so a renderer heuristic can never pick it.
    expect(src).toContain('emphasis={slide.headlineEmphasis}')
  })

  it('every slide names an emphasis that actually occurs in its accent line', () => {
    // A phrase that is not a substring renders solid — safe, but silently drops the
    // treatment. This is the check that keeps a copy edit from doing that unnoticed.
    const slides = read(`${LANDING_DIR}/heroSlides.ts`)
    const accents = [...slides.matchAll(/headlineAccent: '([^']+)',\s*\n\s*headlineEmphasis: '([^']+)'/g)]
    expect(accents.length).toBe(3)
    for (const [, accent, emphasis] of accents) {
      expect(accent, `"${emphasis}" is not in "${accent}"`).toContain(emphasis)
      // And it must be a PART of the line, never the whole of it.
      expect(emphasis.length).toBeLessThan(accent.length)
    }
  })

  it('is defined once and worn by both the phone and the desktop submit', () => {
    // Two buttons, one appearance. They differ only in shape and label — the phone gets a
    // 40px square beside the query, desktop the full "Search Events". If the gradient were
    // written twice they would drift, so it is a single const both compose.
    const src = code(SEARCH)
    expect(src).toContain('const CTA = cn(')
    expect((src.match(/rd-brand-gradient/g) ?? [])).toHaveLength(1)
    expect((src.match(/type="submit"/g) ?? [])).toHaveLength(2)
  })

  it('is a restrained rectangle — no stadium, no glow, no shadow', () => {
    // The whole search bar moved to the 8-14px band in this pass. A capsule CTA would put
    // the loudest element on the page back into the shape language the pass retired.
    const src = code(SEARCH)
    // The shared appearance, plus every line that composes it — nothing else in the file,
    // so the clear-search icon button's legitimate circle cannot mask a regression here.
    const cta = [
      src.slice(src.indexOf('const CTA = cn('), src.indexOf('export function HomeSearch')),
      ...src.split(/\r?\n/).filter(l => l.includes('cn(CTA,')),
      src.slice(src.lastIndexOf('CTA,'), src.indexOf('Search Events')),
    ].join('\n')
    expect(cta).toContain('rounded-lg')   // 12px, desktop
    expect(cta).toContain('rounded-md')   // 8px, the 40px phone square
    expect(cta).toContain('h-11')         // 44px, down from 52
    expect(cta).toContain('font-semibold')
    expect(cta).not.toContain('rounded-full')
    expect(cta).not.toContain('shadow-[')
    expect(cta).not.toContain('blur')
  })
})

// ═══ 3b · Search · Browse · Upcoming — the compact discovery region ══════════
//
// One rule ran through this pass: `rounded-full` is for things that are genuinely circular,
// and nothing else. It had become the default shape of the region — the search fields, the
// browse row, the card's category chip, the active-filter chips — which is what made a
// product interface read as a row of pills.
//
// The controls are on the semantic radius tokens now (--radius-md 8px, --radius-lg 12px,
// --radius-xl 16px for the bar itself). Exactly one `rounded-full` survives, on the 24px
// clear-search icon button, where a rectangle would read as a stray box.

describe('the discovery region is not built out of pills', () => {
  const REGION = [
    `${LANDING_DIR}/HomeSearch.tsx`,
    `${LANDING_DIR}/BrowseShortcuts.tsx`,
    `${LANDING_DIR}/UpcomingEvents.tsx`,
    `${LANDING_DIR}/UpcomingEventCard.tsx`,
  ]

  it('uses rounded-full exactly once, and only for a circular icon button', () => {
    const lines = REGION.flatMap(f => code(f).split(/\r?\n/).map(l => [f, l] as const))
      .filter(([, l]) => l.includes('rounded-full'))
    expect(lines.map(([f]) => f)).toEqual([`${LANDING_DIR}/HomeSearch.tsx`])
    expect(lines[0][1]).toContain('size-6')
  })

  it('the search bar and its controls sit in the 8-14px radius band', () => {
    const src = code(`${LANDING_DIR}/HomeSearch.tsx`)
    expect(src).toContain('rounded-xl border border-border/70 bg-card p-1.5')  // the bar
    expect(src).not.toContain('rounded-2xl')
  })

  it('the secondary filters are quieter than the query field', () => {
    // The query is the only control with a fill; the three filters are transparent until
    // hovered. Equal weight across all four is what made the old row read as a form.
    const trigger = code('components/marketing/discovery/DiscoveryPopover.tsx')
    expect(trigger).toContain('rounded-md')
    expect(trigger).toContain("active || open ? 'bg-action/[0.06]' : 'hover:bg-muted/50'")
    expect(trigger).not.toContain('h-[52px]')
  })

  it('Browse is typography and a rule, not a chip strip', () => {
    const src = code(`${LANDING_DIR}/BrowseShortcuts.tsx`)
    expect(src).not.toContain('bg-muted/60')     // the old pill fill
    // 2026-09-23: one row as a SLIDER (owner). The scroll lives in BrowseRail, and it is
    // announced — arrow buttons and an edge fade appear only where more lies beyond.
    expect(src).toContain('<BrowseRail>')
    expect(src).toContain('whitespace-nowrap')
    const rail = code(`${LANDING_DIR}/BrowseRail.tsx`)
    expect(rail).toContain('overflow-x-auto')
    expect(rail).toContain('snap-x snap-mandatory')
    expect(rail).toContain("aria-label={side === 'prev' ? 'Previous categories' : 'More categories'}")
    expect(src).toContain('decoration-action/70')
  })

  it('Upcoming is a grid, not a horizontal rail', () => {
    const src = code(`${LANDING_DIR}/UpcomingEvents.tsx`)
    expect(src).toContain('grid-cols-1 sm:grid-cols-2 lg:grid-cols-4')
    expect(src).not.toContain('snap-x')
    expect(src).not.toContain('overflow-x-auto')
  })

  it('the card is a row on a phone and a card from sm — one DOM, not two', () => {
    const src = code(`${LANDING_DIR}/UpcomingEventCard.tsx`)
    expect(src).toContain('flex-row sm:flex-col')
    // A second markup path would mean the two shapes could disagree about content.
    expect((src.match(/<article/g) ?? [])).toHaveLength(1)
    expect((src.match(/<h3/g) ?? [])).toHaveLength(1)
  })

  it('the card states its date and category as type, not as boxes', () => {
    const src = code(`${LANDING_DIR}/UpcomingEventCard.tsx`)
    expect(src).toContain("join(' · ')")
    expect(src).not.toContain('rounded-full bg-muted')  // the old category chip
  })
})

// ═══ 4 · Typography and colour hygiene ═══════════════════════════════════════

describe('the landing type and colour system', () => {
  it('uses the type scale, never an arbitrary pixel size', () => {
    for (const f of landingFiles) {
      const m = code(f).match(/text-\[\d+(\.\d+)?px\]/g)
      expect(m, `${f} hardcodes a font size: ${m?.join(', ')}`).toBeNull()
    }
  })

  it('keeps weights inside the approved set', () => {
    // 400 body · 500 controls · 600 labels and buttons · 700 headings. Nothing heavier —
    // 800/900 is what makes a landing page shout rather than speak.
    for (const f of landingFiles) {
      for (const w of ['font-extrabold', 'font-black', 'font-thin', 'font-extralight']) {
        expect(code(f), `${f} uses ${w}`).not.toContain(w)
      }
    }
  })

  it('introduces no hardcoded colours', () => {
    for (const f of landingFiles) {
      const src = code(f)
      expect(src, `${f} has a hex literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src, `${f} has an rgb()/hsl() literal`).not.toMatch(/\b(rgba?|hsla?)\(/)
      expect(src, `${f} has an arbitrary colour utility`).not.toMatch(/(bg|text|border|ring)-\[#/)
    }
  })

  it('does not reach for a second font family', () => {
    for (const f of landingFiles) {
      for (const bad of ['Playfair', 'Montserrat', 'font-serif', 'font-mono']) {
        expect(code(f), `${f} uses ${bad}`).not.toContain(bad)
      }
    }
  })
})

// ═══ 5 · The public footer ═══════════════════════════════════════════════════
//
// This block used to read components/marketing/footer/* — MarketingFooter, FooterWordmark
// and FooterBackdrop — the footer that /pricing, /causes and /contact once mounted. Every
// decorative layer in it had been sampled from the PREVIOUS logo (--brand-violet #6204e3 →
// --brand-pink #f61e7d), and these assertions were what moved it onto the action ramp.
//
// That footer is now RETIRED: the public chrome unification put every eligible public
// route on HomeShell, the retirement audit proved the whole components/marketing/footer
// cone unreachable from any production entry, and the directory was deleted. The public
// footer is HomeFooter, so the SAME properties are pinned on it — no previous-logo
// palette, no retired magenta utility, no chromatic hex, no new stadium control — and the
// ramp's own definition in tokens.css is pinned exactly as before.
//
// --brand-* is still defined and still correct for what it NAMES — the old wordmark's own
// colours. It is simply no longer what RegisterDesk looks like, so nothing public may
// reach for it.

describe('the public footer is on the current brand', () => {
  const FOOTER = 'components/discovery/home/HomeFooter.tsx'

  it('the retired marketing footer directory is gone, and nothing production imports it', () => {
    expect(existsSync(resolve(process.cwd(), 'components/marketing/footer'))).toBe(false)
    for (const f of ['components/discovery/home/HomeShell.tsx', 'components/marketing/layout/MarketingPageLayout.tsx',
                     'components/marketing/layout/EventUtilityLayout.tsx', 'components/event-templates/shared/ui/EventPageShell.tsx']) {
      expect(code(f), `${f} still reaches for the retired footer`).not.toContain('marketing/footer/')
    }
  })

  it('does not reach for the previous logo palette', () => {
    const src = code(FOOTER)
    expect(src, 'uses --brand-pink').not.toContain('--brand-pink')
    expect(src, 'uses --brand-violet').not.toContain('--brand-violet')
  })

  it('does not use the retired magenta accent', () => {
    expect(code(FOOTER), 'still has a -primary colour utility')
      .not.toMatch(/\b(?:text|ring|border|bg)-primary\b/)
  })

  it('types no gradient of its own — the ramp has one definition', () => {
    // FooterWordmark used to carry linear-gradient(96deg, …) inline — a second opinion
    // about the brand. The canonical footer may only reference the utility or the token.
    expect(code(FOOTER)).not.toContain('linear-gradient')
  })

  it('the footer canvas token is on the ramp too', () => {
    const tokens = read(TOKENS)
    const block = tokens.slice(tokens.indexOf('--footer-gradient:'), tokens.indexOf('--footer-gradient:') + 340)
    expect(block).toContain('var(--action-rgb)')
    expect(block).toContain('var(--action-end-rgb)')
    expect(block).not.toContain('--brand-pink-rgb')
  })

  it('the rgb triplets exist in both themes and match the hex stops', () => {
    const tokens = read(TOKENS)
    expect((tokens.match(/--action-rgb:/g) ?? [])).toHaveLength(2)
    expect((tokens.match(/--action-end-rgb:/g) ?? [])).toHaveLength(2)
    // Light theme: 79 70 229 = #4F46E5, 124 58 237 = #7C3AED.
    expect(tokens).toMatch(/--action-rgb:\s+79\s+70 229/)
    expect(tokens).toMatch(/--action-end-rgb:\s+124\s+58 237/)
  })

  it('introduces no hardcoded BRAND colours', () => {
    // Achromatic values are exempt on purpose (a mask needs an opaque colour to mean
    // "keep this"; #000/#fff carry no brand meaning). Every CHROMATIC hex is a failure.
    const CHROMATIC = /#(?!(?:000|fff|000000|ffffff)\b)[0-9a-fA-F]{3,8}\b/i
    const hit = code(FOOTER).match(CHROMATIC)
    expect(hit, `HomeFooter has a chromatic hex literal: ${hit?.[0]}`).toBeNull()
  })

  it('adds no stadium radius to a control', () => {
    // `rounded-full` is allowed only where it draws a circle or a small count badge —
    // never on an interactive element. The allowed lines are enumerated, not the utility.
    const allowed = /rd-orb-|bg-muted px-1\.5|size-\d/
    const offenders = code(FOOTER).split('\n')
      .filter(l => l.includes('rounded-full') && !allowed.test(l))
    expect(offenders, 'HomeFooter put rounded-full on something new').toEqual([])
  })
})


// ═══ 6 · The public marketing pages ══════════════════════════════════════════
//
// /platform, /pricing, /contact and /causes are built almost entirely out of
// components/marketing/**, which is imported by NO dashboard or admin route (verified) —
// so it is public surface even though it is shared between public pages. Every retired
// `-primary` colour utility in it, and the hand-rolled coral→magenta gradients in
// Eyebrow / HeroContent / HeroAnimatedBackground / IndiaMap, went to the action ramp.
//
// Two things deliberately did NOT move, and both are pinned below:
//
//   • components/ui/button.tsx — the PRODUCT's button. Its `primary` variant is
//     `bg-primary` and organizer/admin still run on it. Marketing composes it through
//     `marketingButton()` and names the public accent after it instead.
//   • the macOS traffic-light dots and the discovery category tints — not RegisterDesk
//     branding at all, so a brand migration must leave them exactly where they are.

const walkTsx = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) walkTsx(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

const MARKETING_FILES = walkTsx('components/marketing')
const MARKETING_PAGES = [
  'app/pricing/page.tsx',
  'app/contact/page.tsx', 'app/causes/page.tsx', 'app/causes/CausesClient.tsx',
]

describe('the public marketing surface is on the current brand', () => {
  const PUBLIC = [...MARKETING_FILES, ...MARKETING_PAGES, 'lib/marketing/theme.ts', 'lib/marketing/cta.ts']

  // Colour utilities only. The bare word "primary" is fine — it appears in prose and in
  // identifiers like `primary.variant`, and banning it would be banning a word.
  const RETIRED_UTIL =
    /\b(?:text|bg|border|ring|from|via|to|fill|stroke|decoration|outline|divide|accent|caret|shadow)-primary\b/

  it('no public marketing file uses a retired -primary colour utility', () => {
    const offenders = PUBLIC.filter(f => RETIRED_UTIL.test(code(f)))
    expect(offenders, `still on the retired accent: ${offenders.join(', ')}`).toEqual([])
  })

  it('no public marketing file reaches the retired ramp through a var()', () => {
    // --primary, --primary-from, --primary-to, --primary-gradient, --primary-rgb.
    const offenders = PUBLIC.filter(f => /var\(--primary/.test(code(f)))
    expect(offenders, `still reads a --primary-* token: ${offenders.join(', ')}`).toEqual([])
  })

  it('no public marketing file reaches the PREVIOUS logo palette either', () => {
    const offenders = PUBLIC.filter(f => /var\(--brand-(pink|violet)/.test(code(f)))
    expect(offenders).toEqual([])
  })

  it('no public marketing file types a retired brand hex', () => {
    const RETIRED_HEX = /#(?:e5277e|fb5a6a|ea4858|bf1868|6204e3|f61e7d)\b/i
    const offenders = PUBLIC.filter(f => RETIRED_HEX.test(code(f)))
    expect(offenders).toEqual([])
  })

  it('nor the new brand hex — the ramp is reached by token, never re-typed', () => {
    const offenders = PUBLIC.filter(f => /#4[fF]46[eE]5|#7[cC]3[aA][eE][dD]/.test(code(f)))
    expect(offenders).toEqual([])
  })
})

// ═══ 7 · The public CTA, and the product button it is composed from ══════════

describe('the marketing CTA', () => {
  const THEME = 'lib/marketing/theme.ts'

  it('goes through marketingButton, never buttonVariants directly', () => {
    // A direct call silently renders the PRODUCT's magenta on a public page — which is
    // exactly what this pass fixed, on 15 CTAs across four pages plus the navbar.
    const files = [...MARKETING_FILES, ...MARKETING_PAGES]
    const offenders = files.filter(f => code(f).includes('buttonVariants('))
    expect(offenders, `calls the product button directly: ${offenders.join(', ')}`).toEqual([])
  })

  it('marketingButton names the action ramp and overrides all four colour groups', () => {
    const src = code(THEME)
    expect(src).toContain('bg-action hover:bg-action-hover')
    expect(src).toContain('focus-visible:ring-action')
    expect(src).toContain('shadow-[0_2px_12px_rgb(var(--action-rgb)_/_0.28)]')
    expect(src).toContain('hover:shadow-[0_4px_20px_rgb(var(--action-rgb)_/_0.42)]')
  })

  it('the PRODUCT button is left on --primary, unforked', () => {
    // Organizer and admin run on it. If this ever fails, the migration was applied in
    // the wrong place and every dashboard CTA just changed colour.
    const src = code('components/ui/button.tsx')
    expect(src).toContain('bg-primary text-white')
    expect(src).toContain("backgroundImage: 'var(--primary-gradient)'")
  })

  it('the contact form overrides the product gradient caller-side', () => {
    // The shared Button spreads the caller's style LAST, which is the only reason this
    // works without touching the shared component.
    const src = code('components/marketing/contact/ContactInquiryForm.tsx')
    expect(src).toContain("style={{ backgroundImage: 'var(--action-gradient)' }}")
  })
})

// ═══ 8 · What a brand migration must NOT touch ═══════════════════════════════

describe('non-brand colour survives the migration', () => {
  it('the discovery category tints are untouched', () => {
    // rose/pink here mean "this kind of event", not "RegisterDesk". They are semantic.
    const src = read('components/marketing/discovery/discoveryTaxonomy.ts')
    expect(src).toMatch(/rose|pink/)
  })

  it('the macOS traffic lights are still rose/amber/emerald', () => {
    // This used to check two frames. BrowserFrame was the old marketing homepage's, and it
    // went with that homepage — the contract did not: rose/amber/emerald are a macOS window
    // chrome, not RegisterDesk's brand, and a colour sweep must still leave them alone.
    // ScreenshotFrame is the live frame, so the rule is asserted where it can still break.
    const f = 'components/marketing/screenshots/ScreenshotFrame.tsx'
    const src = code(f)
    expect(src, f).toContain('bg-rose-300')
    expect(src, f).toContain('bg-amber-300')
    expect(src, f).toContain('bg-emerald-300')
  })

  it('--primary is still defined, and still has its ramp', () => {
    const src = read(TOKENS)
    expect(src).toContain('--primary:          #4F46E5')   // 2026-09-29: magenta → logo indigo (owner)
    expect(src).toContain('--primary-gradient:')
  })

  it('the hero caption accent is on the action ramp, not the old logo violet', () => {
    // The one thing in the hero this pass was allowed to change: --hero-violet pointed
    // at --brand-violet, the PREVIOUS logo's colour.
    const src = read(TOKENS)
    expect(src).toContain('--hero-violet:    var(--action-end)')
    expect(src).not.toContain('--hero-violet:    var(--brand-violet)')
  })

  it('the hero\'s own colour roles are the hero tokens, not raw values', () => {
    // A colour migration that reached into the hero with a hex would be a redesign.
    // heroGeometry.test.ts owns the composition; this pins that every colour the hero
    // names is a token.
    for (const f of ['HeroCopy.tsx', 'HeroBackdrop.tsx']) {
      const src = code(`${LANDING_DIR}/${f}`)
      expect(src, `${f}: raw hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src, `${f}: raw rgb()/hsl() literal`).not.toMatch(/\b(rgba?|hsla?)\(/)
    }
    expect(code(`${LANDING_DIR}/HeroBackdrop.tsx`)).toContain('hero-ink')
    expect(code(`${LANDING_DIR}/HeroCopy.tsx`)).toContain('hero-accent-rule')
  })
})

// ═══ 9 · The application shell ═══════════════════════════════════════════════
//
// `themeColor` in the root viewport export is the browser/OS chrome colour — Android's
// toolbar, the iOS PWA status bar, the desktop tab strip. It sat on the retired magenta
// long after every pixel the browser draws INSIDE the page had moved, because it is not
// a CSS colour at all: it becomes <meta name="theme-color">, read before any stylesheet
// exists. So it is the one place a brand hex is written by hand, and the one place a
// token cannot be used — which is exactly why it needs a test.

describe('the application shell chrome', () => {
  const LAYOUT = 'app/layout.tsx'

  it('the browser theme colour is the action accent, not the retired magenta', () => {
    const src = code(LAYOUT)
    expect(src).toContain("themeColor: '#4F46E5'")
    expect(src, 'the retired magenta is still in the shell').not.toContain('#e5277e')
  })

  it('it stays a solid colour — theme-color cannot take a gradient', () => {
    const src = code(LAYOUT)
    const line = src.split('\n').find(l => l.includes('themeColor')) ?? ''
    expect(line).not.toContain('gradient')
    expect(line).not.toContain('var(')
    // One hex, nothing else.
    expect(line.match(/#[0-9a-fA-F]{3,8}/g)).toHaveLength(1)
  })

  it('the literal it hardcodes is the SAME value as --action', () => {
    // The comment above it promises this. A token move that forgot the shell would
    // leave the chrome on the old colour with nothing to catch it.
    const tokens = read(TOKENS)
    const action = tokens.slice(tokens.indexOf('--action:')).match(/#[0-9A-Fa-f]{6}/)?.[0]
    expect(code(LAYOUT).toLowerCase()).toContain(String(action).toLowerCase())
  })
})

// ═══ 10 · The orphaned logo-pink token ═══════════════════════════════════════

describe('the previous logo palette', () => {
  it('--brand-pink is removed — its last consumer went to the action ramp', () => {
    const src = read(TOKENS)
    expect(src).not.toMatch(/--brand-pink:/)
    expect(src).not.toMatch(/--brand-pink-rgb:/)
  })

  it('nothing anywhere still reads it', () => {
    // A token deleted while something still var()s it fails silently — the property
    // just drops and the element renders with no colour at all.
    const roots = ['app', 'components', 'features', 'lib', 'styles']
    const walkAll = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) walkAll(p, out)
        else if (/\.(tsx?|css)$/.test(e.name)) out.push(p)
      }
      return out
    }
    const offenders = roots.flatMap(r => walkAll(r)).filter(f => /var\(--brand-pink/.test(read(f)))
    expect(offenders, `still reads the deleted token: ${offenders.join(', ')}`).toEqual([])
  }, 30_000)   // a whole-tree read; seconds alone, longer under full-suite contention

  it('the tokens that DO still have consumers are untouched', () => {
    // --brand-navy tints the hero canvas; --brand-violet the size-chart surfaces;
    // --primary and its ramp drive the whole organizer and admin product.
    const src = read(TOKENS)
    for (const t of ['--brand-navy:', '--brand-violet:', '--brand-navy-rgb:', '--brand-violet-rgb:',
                     '--primary:', '--primary-from:', '--primary-to:', '--primary-gradient:']) {
      expect(src, `${t} was removed and should not have been`).toContain(t)
    }
  })
})
