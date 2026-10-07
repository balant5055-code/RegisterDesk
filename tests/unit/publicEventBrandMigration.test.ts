// ─── Public event brand migration — Phase 2 ──────────────────────────────────
//
// The public chrome moved to the indigo → violet action ramp in Phase 1. Inside it, the
// EVENT experience was still painted with the product's magenta: `text-primary` on 55
// files, `bg-primary` (which globals.css overrides to the coral → magenta gradient) on
// every "Register" button, `var(--primary-gradient)` on 15 hero and card surfaces, and
// three hardcoded `#f7f8fa` grounds. A visitor saw an indigo masthead over a pink page.
//
// ═══ THE RULE THIS FILE ENFORCES ═════════════════════════════════════════════
// --primary is NOT retired. It is the organizer/admin/product accent and stays exactly
// where it was. The public EVENT surface — the routes under /events/[slug] (except the
// registration checkout and the staff kiosk), /tickets/[id], the public 404s, and every
// event-template component — draws only on the public action tokens.
//
// Two scans, in opposite directions:
//   • the PUBLIC scope must contain no legacy brand colour;
//   • the PROTECTED surface must still contain --primary, unchanged.
// Both read source with comments stripped, because the old ramp is described in prose
// all over the tree and a comment is not a colour.
//
// ═══ WHAT IS DELIBERATELY NOT A LEGACY COLOUR ════════════════════════════════
// `rose-*` and `pink-*` utilities survive in a few named places, and each is listed in
// TOLERATED below with the reason. They are not the RegisterDesk brand: a "Sold out"
// badge is red-as-warning; the Instagram hover is Instagram's colour; the cultural
// template rotates six festival hues across lineup cards and rose is one of them.
// Widening this list is a design decision, not a test fix.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { marketingButton } from '@/lib/marketing/theme'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(resolvePath(ROOT, p), 'utf8')
const norm = (p: string) => p.split('\\').join('/')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(resolvePath(ROOT, dir))) {
    const rel = dir + '/' + name
    if (statSync(resolvePath(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (/\.tsx?$/.test(name)) out.push(norm(rel))
  }
  return out
}

// ─── The public event scope ──────────────────────────────────────────────────

const EXCLUDED = [
  'app/events/[slug]/register/',      // the checkout — its own "ticket desk" chrome
  'app/events/[slug]/staff-login/',   // a kiosk surface
]

const PUBLIC_SCOPE = [
  ...walk('app/events/[slug]').filter(f => !EXCLUDED.some(x => f.startsWith(x))),
  ...walk('app/tickets'),
  ...walk('components/event-templates'),
  ...walk('features/runner-photos/components'),
  ...walk('features/public-gallery/components'),
  'app/not-found.tsx',
  'app/campaign/[slug]/not-found.tsx',
  'components/report/ReportButton.tsx',
  // Phase 3 widened the sweep to the rest of the public surface: the fundraising page and
  // its donate flow, the donation receipt, the public race results, and /unsubscribe.
  ...walk('app/campaign'),
  ...walk('app/donations'),
  ...walk('features/race-operations/components/public'),
  'app/unsubscribe/page.tsx',
]

/** Legacy brand colour, in every form it took in the tree. */
const LEGACY = [
  /#e5277e/i, /#f61e7d/i, /#fb5a6a/i, /#bf1868/i, /#f7f8fa/i,
  /--brand-pink/, /--primary-gradient/, /--primary-from/, /--primary-to\b/, /--primary-rgb/,
  /var\(--primary\)/, /var\(--color-primary\)/,
  // Tailwind utilities on the product colour, with any variant prefix or opacity.
  /(?<![\w-])(?:[a-z-]+:)*(?:text|bg|border|ring|shadow|from|to|via|fill|stroke|outline|decoration|caret|divide|placeholder)-primary(?![\w-])/,
  /(?<![\w-])(?:[a-z-]+:)*(?:text|bg|border|ring)-primary-(?:hover|foreground)(?![\w-])/,
  // The product button's primary variant, which is bg-primary underneath.
  /buttonVariants\(\s*\{\s*variant:\s*'primary'/,
]

/** rose-/pink- utilities that are NOT the brand. File → the reason they stay. */
const TOLERATED: Record<string, RegExp> = {
  'components/event-templates/shared/registration/AvailabilityBadge.tsx': /Sold Out/,          // red-as-warning
  'components/event-templates/shared/people/OrganizerSection.tsx':        /Instagram/,          // Instagram's colour
  'components/event-templates/community/CommunityVenue.tsx':              /MapPin/,             // map-pin red
  'components/event-templates/community/CommunityProblemSection.tsx':     /text-rose-500/,      // "the problem" — urgency
  'components/event-templates/community/CommunityEventJourney.tsx':       /keynote:/,           // session-type palette
  'components/event-templates/exhibition/ExhibitionCategories.tsx':       /bg-rose-50/,         // category palette rotation
  'components/event-templates/cultural/CulturalExperienceZones.tsx':      /from-amber-500/,     // six-hue festival palette
  'components/event-templates/cultural/CulturalHighlights.tsx':           /from-amber|from-violet/,
  'components/event-templates/cultural/CulturalLineup.tsx':               /bg-violet|bg-amber/,
  'components/event-templates/cultural/CulturalPerformers.tsx':           /from-violet|from-amber|from-teal/,
  'components/event-templates/cultural/CulturalSchedule.tsx':             /bg-violet|bg-amber/,
  'components/event-templates/cultural/CulturalTickets.tsx':              /from-amber-400 via-rose-400 to-violet-500/,
  'components/event-templates/cultural/CulturalHero.tsx':                 /from-violet-950/,    // the dark festival ground
  'components/event-templates/cultural/CulturalOrganizer.tsx':            /from-violet-600 to-rose-600/,
}

// ═══ 1. THE PRIMARY ACTION ═══════════════════════════════════════════════════

describe('1. the public event primary action is the canonical action system', () => {
  it('marketingButton has a gradient emphasis that drops bg-primary and wears rd-brand-gradient', () => {
    const cls = marketingButton({ emphasis: 'gradient', variant: 'primary', size: 'sm' })
    expect(cls).toContain('rd-brand-gradient')
    expect(cls).toContain('bg-transparent')
    expect(cls).toContain('text-action-foreground')
    expect(cls).toContain('focus-visible:ring-action')
    // twMerge must have removed the product fill AND the product shadow, not stacked them.
    expect(cls).not.toMatch(/(?<![\w-])bg-primary(?![\w-])/)
    expect(cls).not.toContain('--primary-rgb')
    expect(cls).not.toContain('ring-primary')
  })

  it('the solid emphasis is unchanged for the marketing pages that already use it', () => {
    const cls = marketingButton({ variant: 'primary' })
    expect(cls).toContain('bg-action')
    expect(cls).not.toContain('rd-brand-gradient')
    expect(cls).not.toMatch(/(?<![\w-])bg-primary(?![\w-])/)
  })

  it('every former buttonVariants(primary) site in the event experience now goes through marketingButton', () => {
    const SITES = [
      'app/events/[slug]/certificates/CertificateCenterClient.tsx',
      'components/event-templates/fallback/EventDetailClient.tsx',
      'components/event-templates/shared/registration/StickyMobileCTA.tsx',
      'components/event-templates/shared/registration/StickyRegistrationCard.tsx',
      'components/event-templates/shared/registration/TicketSection.tsx',
      'components/event-templates/shared/registration/TicketsPreviewBar.tsx',
      'components/event-templates/shared/venue/VenueSection.tsx',
    ]
    for (const f of SITES) {
      const src = code(read(f))
      expect(src, f).toContain("marketingButton({ emphasis: 'gradient', variant: 'primary'")
      expect(src, f).not.toMatch(/\bbuttonVariants\b/)
    }
  })

  it('the event hero CTA and the hero poster fallback paint --action-gradient', () => {
    const src = code(read('components/event-templates/shared/hero/EventHeroFramework.tsx'))
    expect(src.match(/var\(--action-gradient\)/g) ?? []).toHaveLength(2)
    expect(src).not.toContain('--primary')
  })

  it('there is exactly ONE gradient definition on the public event surface', () => {
    // framework.tsx's BRAND_GRADIENT is the utility, not a second image string.
    expect(code(read('components/event-templates/shared/ui/framework.tsx')))
      .toContain("export const BRAND_GRADIENT = 'rd-brand-gradient'")
    for (const f of PUBLIC_SCOPE) {
      expect(code(read(f)), f + ' re-types the gradient').not.toMatch(/linear-gradient\([^)]*#(?:4f46e5|7c3aed|e5277e|fb5a6a)/i)
    }
  })
})

// ═══ 2. NO LEGACY COLOUR IN THE PUBLIC SCOPE ═════════════════════════════════

describe('2. the public event scope carries no legacy brand colour', () => {
  it('covers the whole surface', () => {
    expect(PUBLIC_SCOPE.length).toBeGreaterThan(140)
    expect(PUBLIC_SCOPE).toContain('components/event-templates/shared/hero/EventHeroFramework.tsx')
    expect(PUBLIC_SCOPE).toContain('app/events/[slug]/certificates/CertificateCenterClient.tsx')
    expect(PUBLIC_SCOPE).not.toContain('app/events/[slug]/register/page.tsx')
    expect(PUBLIC_SCOPE).not.toContain('app/events/[slug]/staff-login/page.tsx')
  })

  for (const f of PUBLIC_SCOPE) {
    it(f, () => {
      const src = code(read(f))
      for (const re of LEGACY) {
        const m = src.match(re)
        expect(m, f + ' still carries ' + (m?.[0] ?? '')).toBeNull()
      }
      const rosy = src.match(/(?<![\w-])(?:[a-z-]+:)*(?:text|bg|border|ring|from|to|via|fill)-(?:rose|pink)-\d+(?![\w-])/)
      if (rosy) {
        const why = TOLERATED[f]
        expect(why, f + ' uses ' + rosy[0] + ' and is not on the tolerated list').toBeDefined()
        expect(src, f + ' no longer matches its tolerated reason').toMatch(why!)
      }
    })
  }

  it('the hero ambient layers are GONE from globals.css, and nothing there paints the old ramp', () => {
    // Phase 2 moved the orbs/mesh/card-glow onto the action ramp; the sports redesign
    // (Phase 2A) then retired SportsHero and HeroBackground, their only consumer, and the
    // block with them. What survives to pin is the absence — no ambient layer at all, on
    // either ramp — and the two swiper bullets, which are still public-event-only.
    const css = read('app/globals.css')
    expect(css).not.toMatch(/rd-hero-orb|rd-hero-mesh|rd-hero-noise|rd-hero-cardglow|rdHeroDrift|rdHeroGlow/)
    expect(css).not.toContain('--primary-from-rgb')
    expect(css.match(/background-color: var\(--action\) !important;/g) ?? []).toHaveLength(2)
    expect(css).not.toContain('background-color: var(--primary) !important;')
  })
})

// ═══ 3. THE PROTECTED SURFACE IS UNTOUCHED ═══════════════════════════════════

describe('3. protected product / organizer / admin surfaces keep --primary', () => {
  it('the token is still defined and the product button still paints it', () => {
    expect(read('styles/tokens.css')).toMatch(/--primary:\s+#4F46E5/i)   // 2026-09-29: magenta → logo indigo (owner)
    expect(read('styles/tokens.css')).toMatch(/--primary-gradient:\s+linear-gradient/)
    const button = code(read('components/ui/button.tsx'))
    expect(button).toContain("'bg-primary text-white font-semibold rounded-lg '")
    expect(button).toContain('focus-visible:ring-primary')
    expect(button).toContain("backgroundImage: 'var(--primary-gradient)'")
    // The globals override that makes bg-primary a gradient is the product's, and stays.
    expect(read('app/globals.css')).toContain('.bg-primary {\n  background-image: var(--primary-gradient);')
  })

  it('shared primitives with dashboard consumers keep their product default', () => {
    // TextLink is used by five dashboard tabs; the two public callers override it.
    expect(code(read('components/ui/TextLink.tsx'))).toContain('text-primary')
    for (const f of ['app/events/[slug]/speak/SpeakerApplyClient.tsx', 'app/events/[slug]/sponsor/SponsorApplyClient.tsx']) {
      expect(code(read(f)), f).toMatch(/<TextLink [^>]*className="text-action"/)
    }
  })

  it('organizer, admin and auth surfaces still reference --primary and were not repainted', () => {
    const PROTECTED = [
      'app/(dashboard)/layout.tsx',
      'components/dashboard',
      'app/(admin)',
      'components/admin',
      'components/auth',
      'app/events/[slug]/register',
    ].filter(p => existsSync(resolvePath(ROOT, p)))
    // Owner decision 2026-09-23: /register moved to the public theme. The invite screen
    // uses the public emphasis directly; the rest of the route keeps its `*-primary`
    // utilities, which register/layout.tsx REMAPS to --action (pinned in the next test).
    const PUBLIC_THEMED = new Set([
      'app/events/[slug]/register/InviteGate.tsx',
      'app/events/[slug]/register/success/SuccessClient.tsx',
    ])
    let hits = 0
    const actionGradientLeaks: string[] = []
    for (const p of PROTECTED) {
      const files = statSync(resolvePath(ROOT, p)).isDirectory() ? walk(p) : [p]
      for (const f of files) {
        const src = code(read(f))
        if (/(?<![\w-])(?:[a-z-]+:)*(?:text|bg|border|ring)-primary(?![\w-])|var\(--primary/.test(src)) hits++
        // Nothing here should have picked up the EVENT emphasis by accident.
        if (src.includes("emphasis: 'gradient'") && !PUBLIC_THEMED.has(f)) actionGradientLeaks.push(f)
      }
    }
    expect(hits, 'protected surfaces lost their --primary usage').toBeGreaterThan(20)
    expect(actionGradientLeaks).toEqual([])
  })

  it('/register wears the PUBLIC accent through a scoped token remap (owner decision)', () => {
    // The whole checkout moved from the product magenta to the public indigo → violet on
    // 2026-09-23. It is done by remapping the product tokens for this route only, keyed on
    // a marker so it can never leak once the route unmounts (React keeps hoisted styles).
    const layout = read('app/events/[slug]/register/layout.tsx')
    expect(layout).toContain('body:has([data-rd-register-theme])')
    expect(layout).toContain('data-rd-register-theme')
    for (const token of ['--primary:var(--action)', '--primary-rgb:var(--action-rgb)', '--primary-gradient:var(--action-gradient)']) {
      expect(layout, token).toContain(token)
    }
    // Scoped: the product token keeps its own definition everywhere else (logo indigo
    // since the 2026-09-29 owner decision; it was magenta).
    expect(read('styles/tokens.css')).toMatch(/--primary:\s+#4F46E5/i)
  })
})

// ═══ 4. CERTIFICATE + 5. 404 ═════════════════════════════════════════════════

describe('4. the certificate centre', () => {
  it('uses the gradient action for both submit buttons and the muted ground, and kept its behaviour', () => {
    const client = code(read('app/events/[slug]/certificates/CertificateCenterClient.tsx'))
    expect(client.match(/marketingButton\(\{ emphasis: 'gradient', variant: 'primary', size: 'lg' \}\)/g) ?? []).toHaveLength(2)
    const page = code(read('app/events/[slug]/certificates/page.tsx'))
    expect(page).toContain('min-h-[60vh] bg-muted')
    expect(page).not.toContain('#f7f8fa')
    expect(page).toContain('robots: { index: false, follow: false }')
    expect(page).toContain('<EventUtilityLayout>')
  })

  it('download-ticket and the ticket page share the same ground; the ticket notches match it', () => {
    expect(code(read('app/events/[slug]/download-ticket/page.tsx'))).toContain('min-h-[60vh] bg-muted')
    const ticket = code(read('app/tickets/[registrationId]/page.tsx'))
    expect(ticket).toContain('h-full bg-muted font-sans print:bg-white')
    expect(ticket.match(/rounded-full bg-muted" \/>/g) ?? []).toHaveLength(2)
  })
})

describe('5. the public 404 surfaces', () => {
  for (const f of ['app/not-found.tsx', 'app/events/[slug]/not-found.tsx', 'app/campaign/[slug]/not-found.tsx']) {
    it(f + ' uses the solid public action and keeps its chrome and routes', () => {
      const src = code(read(f))
      expect(src).toContain("marketingButton({ variant: 'primary' })")
      if (f !== 'app/campaign/[slug]/not-found.tsx') expect(src).toContain("marketingButton({ variant: 'outline' })")
      expect(src).not.toMatch(/\bbuttonVariants\b/)
      expect(src).toContain('<HomeShell>')
    })
  }
})

// ═══ 6. EVENT-TYPE GATING ════════════════════════════════════════════════════

describe('6. event-type conditional rendering is unchanged', () => {
  it('TemplateRouter still dispatches every supported type, sports split by subtype', () => {
    const src = code(read('components/event-templates/TemplateRouter.tsx'))
    for (const t of ['community', 'conference', 'sports', 'workshop', 'exhibition', 'cultural', 'awards', 'meetup']) {
      expect(src, t).toMatch(new RegExp("props\\.eventType === '" + t + "'"))
    }
    expect(src).toContain('<SportsTemplate')
    expect(src).toContain('<TeamSportsTemplate')
    expect(src).not.toMatch(/action|primary/)   // it routes; it paints nothing
  })

  it('no template lost an event-type gate or gained sports vocabulary', () => {
    // Every `eventType ===` / `eventType !==` comparison in the templates is a gate; the
    // migration changed colour classes only, so the gate count cannot move. Pinned as a
    // floor rather than an exact number so a template can grow a gate without editing this.
    const gates = walk('components/event-templates')
      .map(f => (code(read(f)).match(/eventType\s*[!=]==\s*'/g) ?? []).length)
      .reduce((a, b) => a + b, 0)
    expect(gates).toBeGreaterThanOrEqual(6)
    // The generic seams must not have been renamed toward one sport.
    // (framework.tsx is excluded: its benefit-icon dictionary legitimately lists 'bib'
    // beside 'meal', 'seat' and 'stall' — keys for every event type, not a rename.)
    for (const f of ['components/event-templates/shared/registration/TicketSection.tsx',
                     'components/event-templates/shared/hero/EventHeroFramework.tsx']) {
      expect(code(read(f)), f).not.toMatch(/\b(?:marathon|runner|bib)\b/i)
    }
  })
})

// ═══ 7. SSR — THE NON-SPORTS TEMPLATES, RENDERED ═════════════════════════════
//
// Only a sports event is seeded, so the runtime computed-style scan could cover one
// template. The other seven are proven here the way a browser would see them: rendered to
// HTML with a synthetic pass list, then the EMITTED class names are inspected — not the
// source. A `bg-primary` reaching the DOM from any prop, helper or conditional would show
// up here even if the source scan above had a blind spot.

describe('7. SSR — every non-sports ticket surface emits the action system and no legacy class', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { createElement } = await import('react')

  const passes = [
    { id: 'p1', name: 'General Admission', description: 'Access to all sessions.', price: 149900, quantity: 200, unlimited: false, status: 'active' as const, benefits: ['meal', 'certificate'] },
    { id: 'p2', name: 'Student', description: 'Valid ID required.', price: 49900, quantity: null, unlimited: true, status: 'active' as const, featured: true },
    { id: 'p3', name: 'Sold-out tier', description: '', price: 999900, quantity: 10, unlimited: false, status: 'active' as const },
  ]
  const availability = {
    p1: { status: 'available' as const, remaining: 120 },
    p2: { status: 'low' as const, remaining: 4 },
    p3: { status: 'sold_out' as const, remaining: 0 },
  }
  const props = { passes, isFreeEvent: false, slug: 'probe-event-2026', availability, registrationOpen: true, closedMessage: 'Registration is closed.' }

  // The fourth column says whether the surface CARRIES the brand at all. Workshop,
  // exhibition, awards and cultural paint their CTAs in ink / gold / their own festival
  // palette and never wore the magenta — they are asserted clean, not asserted indigo.
  // Turning them purple would be a redesign the brief forbids.
  const SURFACES: Array<[string, string, string, boolean]> = [
    ['conference', '@/components/event-templates/conference/ConferenceTickets',   'ConferenceTickets',     true],
    ['workshop',   '@/components/event-templates/workshop/WorkshopEnrollment',     'WorkshopEnrollment',    false],
    ['exhibition', '@/components/event-templates/exhibition/ExhibitionPasses',     'ExhibitionPasses',      false],
    ['awards',     '@/components/event-templates/awards/AwardsTickets',            'AwardsTickets',         false],
    ['cultural',   '@/components/event-templates/cultural/CulturalTickets',        'CulturalTickets',       false],
    ['community',  '@/components/event-templates/community/CommunityRegistration', 'CommunityRegistration', true],
    ['generic',    '@/components/event-templates/shared/registration/TicketSection', 'TicketSection',       true],
  ]

  const LEGACY_CLASS = /(?<![\w-])(?:[a-z-]+:)*(?:text|bg|border|ring|shadow|from|to|via)-primary(?![\w-])|--primary|#e5277e|#fb5a6a/i

  for (const [type, mod, name, branded] of SURFACES) {
    it(type + ' → ' + name, async () => {
      const m = await import(mod) as Record<string, (p: typeof props) => ReturnType<typeof createElement>>
      const html = renderToStaticMarkup(createElement(m[name]!, props))
      expect(html.length, 'rendered nothing').toBeGreaterThan(500)
      expect(html).toContain('General Admission')
      expect(html, type + ' emitted a legacy class').not.toMatch(LEGACY_CLASS)
      // Something on the surface is painted with the action system — a CTA, an accent
      // line or the pass-count eyebrow — so the assertion above is not vacuous.
      if (branded) expect(html, type + ' emitted no action class at all').toMatch(/text-action|bg-action|rd-brand-gradient|from-action|--action-gradient/)
      // Registration stays data-driven: the sold-out tier still reads as sold out.
      expect(html).toMatch(/Sold Out|sold out/i)
    })
  }
})
