// ─── Public event visual polish — Phase 4 ────────────────────────────────────
//
// The public event surface was measured at 1440 and 390 before any edit. What it showed
// was not a colour problem (Phase 2 settled that) but a composition one: a tagline set
// uppercase-bold-indigo at up to 32px fighting the title; a poster on a 24px radius and
// a 2xl shadow floating off the page; a timeline that zig-zagged across a centred rail
// and spent 1185px on eight short milestones; pill-shaped controls; a full-bleed
// gradient band on the gallery page. Each fix here is a class string. Nothing about
// data, structure, conditional rendering or copy changed, and this file pins both halves.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { CARD, CARD_HOVER, SECTION_PY, ICON_TILE } from '@/components/event-templates/shared/ui/framework'

const read = (p: string) => readFileSync(resolvePath(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const HERO     = 'components/event-templates/sports/editorial/SportsCover.tsx'
const GENERIC  = 'components/event-templates/shared/hero/EventHeroFramework.tsx'
const JOURNEY  = 'components/event-templates/shared/journey/JourneySection.tsx'
const CHOOSE   = 'components/event-templates/shared/registration/ChallengeSelectionSection.tsx'
const GALLERY  = 'features/public-gallery/components/GalleryHero.tsx'

describe('the shared surface language', () => {
  it('cards sit on the panel radius token with a hairline and no shadow', () => {
    expect(CARD).toContain('rounded-panel')
    expect(CARD).toContain('border border-border/60')
    expect(CARD).not.toMatch(/shadow|rounded-2xl|rounded-3xl/)
    expect(CARD_HOVER).not.toMatch(/shadow/)
    expect(ICON_TILE).toContain('rounded-surface')
  })

  it('section rhythm is tighter than it was, and still responsive', () => {
    expect(SECTION_PY).toBe('py-12 sm:py-14 lg:py-16')
  })
})

describe('the sports cover has one loud object', () => {
  // Phase 4 polished SportsHero; Phase 2A of the sports redesign replaced it with
  // sports/editorial/SportsCover. The invariants are the same — they are re-pointed, not
  // dropped: one extrabold object, a quiet deck, a set-in poster, ONE gradient action.
  const src = code(read(HERO))

  it('the title is the display face on the dark ground — nothing in the cover is bold', () => {
    expect(src).toContain('font-display')
    expect(src).toMatch(/text-\[clamp\([^)]*\)\] font-normal/)
    expect(src).not.toMatch(/font-extrabold|font-black|font-bold\b/)
    expect(src).not.toContain('--hero-tagline')
    expect(src).not.toMatch(/uppercase[^"']*text-action[^"']*\{tagline\}|text-action[^"']*uppercase[^"']*\{tagline\}/)
  })

  it('the poster is MOUNTED on a white mat over the ground, and never shadowed', () => {
    expect(src).not.toMatch(/rounded-3xl|rounded-2xl|shadow-2xl|shadow-xl|shadow-lg|shadow-md|shadow-sm|backdrop-blur|HeroBackground|HeroCardGlow/)
    // The mat is the on-media ink token, square-cornered — a mounted print, not a card.
    expect(src).toContain('block w-full bg-ink-on-media p-2.5')
    // The print itself is shown whole: in flow, at its own ratio.
    expect(src).toMatch(/h-auto[^"]*object-contain/)
    // object-cover appears exactly once — on the decorative, aria-hidden ground.
    expect((src.match(/object-cover/g) ?? [])).toHaveLength(1)
    expect(src).not.toMatch(/bg-card p-\d/)   // the old status panel
  })

  it('exactly one primary action in the cover, and it is the brand gradient', () => {
    const uses = src.replace(/^import[^\n]*$/gm, '').match(/BRAND_GRADIENT/g) ?? []
    expect(uses).toHaveLength(1)
    expect(src).not.toContain('rd-brand-gradient')
    expect(src).not.toMatch(/marketingButton\(\{ emphasis: 'gradient'/)   // the cover paints its own, once
  })

  it('still renders every piece of event data the hero did', () => {
    for (const t of ['{title}', '{tagline}', 'organizer!.name', 'shortDesc', 'formatDate(startDate)', 'venueTitle', 'leadRemaining', 'Add to Calendar', 'Share', 'statusWord', 'showTimer']) {
      expect(src, t).toContain(t)
    }
  })
})

describe('the generic hero (seven templates)', () => {
  const src = code(read(GENERIC))
  it('secondary actions are controls, not pills; the panel does not float', () => {
    expect(src).toContain("'inline-flex h-9 items-center gap-2 rounded-control border border-border/80 bg-card")
    // The CTA panel used to add shadow-lg on top of CARD. (The 'More actions' dropdown
    // keeps its elevation — a floating menu is the one thing that should cast one.)
    expect(src).toContain("<div className={cn(CARD, 'flex flex-col overflow-hidden')}>")
    expect(src).not.toMatch(/CARD, '[^']*shadow/)
  })
  it('status and category badges keep their pill shape — badges may be pills, controls may not', () => {
    expect(src).toMatch(/rounded-full px-3 py-1 text-fs-2xs font-bold/)
  })
})

describe('the journey is one editorial timeline', () => {
  const src = code(read(JOURNEY))

  it('one left rail at every width — no alternation, no centred rail', () => {
    expect(src).not.toMatch(/lg:col-start|lg:left-1\/2|lg:grid-cols-\[1fr_auto_1fr\]|lg:text-center/)
    expect(src).not.toMatch(/side:\s*'left'|isLeft/)
    expect(src).toContain('<div ref={trackRef} className="relative max-w-3xl">')
  })

  it('no glass, no lift, no ambient orbs', () => {
    expect(src).not.toMatch(/backdrop-blur|hoverLift|whileHover|radial-gradient/)
    expect(src).toContain('<SectionShell id="journey">')
  })

  it('the rail still fills on scroll and every milestone field still renders', () => {
    expect(src).toContain('useScroll')
    expect(src).toContain('style={{ scaleY: fill }}')
    for (const t of ['item.title', 'item.description', 'item.location', 'item.speaker', 'item.image', 'item.duration', 'item.important']) {
      expect(src, t).toContain(t)
    }
    expect(src).toContain('JOURNEY_TITLES[eventType')   // per-type titles untouched
  })
})

describe('controls are not pills', () => {
  it('the challenge selector is a segmented control', () => {
    expect(code(read(CHOOSE))).toContain("'shrink-0 rounded-control border px-5 py-2.5 text-fs-md font-bold outline-none',")
  })
})

describe('the gallery header', () => {
  const src = code(read(GALLERY))
  it('is editorial without a cover, a scrimmed photograph with one — never a gradient band', () => {
    expect(src).not.toContain('BRAND_GRADIENT')
    expect(src).toContain('bg-background')
    // 2026-09-24: the title is the shared PAGE_TITLE, whose ink is --hero-ink like every
    // other public title; over a photograph it still turns white.
    expect(src).toContain("onPhoto ? 'text-white' : 'text-hero-ink'")
    expect(src).toContain('bg-slate-950/70')   // the scrim over a real photograph stays
  })
})

describe('event-type flexibility is untouched by the polish', () => {
  it('TemplateRouter still dispatches every type', () => {
    const src = code(read('components/event-templates/TemplateRouter.tsx'))
    for (const t of ['community', 'conference', 'sports', 'workshop', 'exhibition', 'cultural', 'awards', 'meetup']) {
      expect(src, t).toContain("props.eventType === '" + t + "'")
    }
  })
})
