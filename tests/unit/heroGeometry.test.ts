// RD-HERO-03 · the landing hero's structural contract.
//
// The hero is ONE photograph at a time, edge to edge, with the statement set over it.
// These tests pin the STRUCTURE that makes that safe — not the pixel counts a browser
// reports, which change with every copy edit:
//
//   1 · the full-bleed stage reaches the browser edge WITHOUT a negative margin or 100vw
//   2 · the photographs stay on the server; only the index crosses the client boundary
//   3 · nothing is clipped, and no second owner exists for any one number
//   4 · the copy states nothing countable and invents no event
//   5 · every motion is inert under prefers-reduced-motion
//
// The previous hero (a two-column stage with a three-panel collage) was pinned here too.
// Its tests were removed with it rather than adapted: they asserted a 350px row height,
// a 47/53 grid and a per-panel clip path, none of which exist any more.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildHeroSlots } from '@/components/discovery/home/HeroBackdrop'
import { HERO_SLIDES, HERO_AUTOPLAY_MS } from '@/components/discovery/home/heroSlides'
import type { PublicEventCard } from '@/lib/firebase/firestore/publicEvents'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (p: string) =>
  read(p).split('\n').filter(l => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

const DIR = 'components/discovery/home'
const HERO     = `${DIR}/HomeHero.tsx`
const STAGE    = `${DIR}/HeroStage.tsx`
const COPY     = `${DIR}/HeroCopy.tsx`
const BACKDROP = `${DIR}/HeroBackdrop.tsx`
const CSS      = 'app/globals.css'
const TOKENS   = 'styles/tokens.css'

// ═══ 1 · The stage is full-bleed by STRUCTURE ════════════════════════════════

describe('the photograph reaches the browser edge, and cannot run past it', () => {
  it('the stage is simply the section\'s own width', () => {
    const src = code(STAGE)
    expect(src).toContain('relative isolate w-full')
  })

  it('no negative margin, no 100vw, no transform trick anywhere in the hero', () => {
    // Every full-bleed hack that has caused a horizontal scrollbar on this page before.
    // The ONE negative margin allowed is the capsule's vertical overlap, which is -mt-*.
    for (const f of [STAGE, BACKDROP, COPY]) {
      const src = code(f)
      // `sizes="100vw"` is next/image telling the browser how wide the photograph will
      // render — it sets no layout. Only a WIDTH of 100vw is the hack.
      expect(src, `${f}: 100vw width`).not.toMatch(/(?:w-\[?|width:\s*)100vw/)
      expect(src, `${f}: negative margin`).not.toMatch(/-m[xlrtb]?-/)
    }
    const hero = code(HERO)
    expect(hero).not.toContain('100vw')
    const negatives = [...hero.matchAll(/-m([xlrtb]?)-/g)].map(m => m[1])
    expect(new Set(negatives), 'only the capsule\'s vertical overlap').toEqual(new Set(['t']))
  })

  it('the copy and the capsule share the page container, so their left edges agree', () => {
    expect(code(STAGE)).toContain('container.page')
    expect(code(HERO)).toContain('container.page')
  })

  it('the stage height has a floor and a ceiling, and is svh so a phone toolbar cannot resize it', () => {
    const src = code(STAGE)
    expect(src).toMatch(/min-h-\[[\d.]+rem\]/)
    expect(src).toContain('svh')
    expect(src).toMatch(/h-\[min\(/)
  })

  it('the phone ceiling equals its floor, so the space above the eyebrow cannot grow', () => {
    // The copy is bottom-anchored: every pixel the stage has beyond the copy becomes
    // empty photograph ABOVE it. On a phone the copy is as tall as it will ever be, so
    // a ceiling above the floor buys nothing and shows as a gap — 98-122px of one, when
    // the ceiling was 26rem against a 23rem floor. MEASURED at 320/360/375/390/430/540.
    const src = code(STAGE)
    const base = src.match(/'min-h-\[([\d.]+)rem\] h-\[min\([\d.]+svh,([\d.]+)rem\)\]/)
    expect(base, 'the base height pair').not.toBeNull()
    expect(base![1]).toBe(base![2])

    // A phone at 420px and up sets the description one line shorter, which reopened the
    // gap; it gets its own, lower pair rather than waiting 220px for `sm`.
    const step = src.match(/min-\[420px\]:min-h-\[([\d.]+)rem\] min-\[420px\]:h-\[min\([\d.]+svh,([\d.]+)rem\)\]/)
    expect(step, 'the 420px step').not.toBeNull()
    expect(step![1]).toBe(step![2])
    expect(Number(step![1])).toBeLessThan(Number(base![1]))
  })
})

// ═══ 2 · The photographs never enter the client bundle ═══════════════════════

describe('the pictures stay on the server; only the index crosses', () => {
  it('the backdrop is a server component — no client directive, no state', () => {
    const src = read(BACKDROP)
    expect(src).not.toContain("'use client'")
    expect(src).not.toContain('useState')
  })

  it('the stage takes the backdrop as a ReactNode prop, never renders it itself', () => {
    const src = code(STAGE)
    expect(src).toContain('backdrop: ReactNode')
    expect(src).toContain('{backdrop}')
    expect(src, 'importing it would pull next/image across the boundary')
      .not.toContain('HeroBackdrop')
  })

  it('which photograph is showing is published as a data attribute and resolved in CSS', () => {
    expect(code(STAGE)).toContain('data-active={index}')
    expect(code(BACKDROP)).toContain('data-hero-backdrop={i}')
    const css = read(CSS)
    expect(css).toContain("[data-hero-stage][data-active='0'] [data-hero-backdrop='0']")
  })

  it('every slide has a backdrop rule — a fourth slide without one would show nothing', () => {
    const css = read(CSS)
    for (let i = 0; i < HERO_SLIDES.length; i++) {
      expect(css, `slide ${i} has no crossfade rule`)
        .toContain(`[data-hero-stage][data-active='${i}'] [data-hero-backdrop='${i}']`)
    }
  })

  it('the first photograph is the LCP candidate and is the only eager one', () => {
    const src = code(BACKDROP)
    expect(src).toContain('priority={i === 0}')
    expect(src).toContain("loading={i === 0 ? 'eager' : 'lazy'}")
  })
})

// ═══ 3 · One owner per number ════════════════════════════════════════════════

describe('the dwell is one number, and the three things it drives read it', () => {
  it('the token and the JS fallback agree', () => {
    const token = read(TOKENS).match(/--hero-autoplay:\s*(\d+)ms/)?.[1]
    expect(token, '--hero-autoplay is missing').toBeDefined()
    expect(Number(token)).toBe(HERO_AUTOPLAY_MS)
  })

  it('the timer reads the token at runtime rather than trusting the constant', () => {
    expect(code(STAGE)).toContain("getPropertyValue('--hero-autoplay')")
  })

  it('the progress line and the photograph\'s drift are driven by that same token', () => {
    const css = read(CSS)
    expect(css).toContain('animation: rdHeroProgress var(--hero-autoplay) linear forwards')
    expect(css).toContain('rdHeroBackdropDrift calc(var(--hero-autoplay)')
  })

  it('pausing stops the timer and both animations together', () => {
    expect(code(STAGE)).toContain("data-paused={paused ? 'true' : 'false'}")
    const css = read(CSS)
    expect(css).toContain("[data-hero-stage][data-paused='true'] .rd-hero-progress")
    expect(css).toContain("[data-hero-stage][data-paused='true'] [data-hero-backdrop] > img")
  })
})

describe('nothing is clipped to make a number true', () => {
  it('no element that carries TEXT hides its overflow', () => {
    // Two elements clip, and both are pictures rather than words: the backdrop crops the
    // photograph to the stage (that is what object-cover means), and the progress track
    // clips the hairline that animates across it. A third would be a headline being cut
    // to make a height true, which is the failure this pins.
    expect(code(STAGE), 'the stage').not.toContain('overflow-hidden')
    expect(code(BACKDROP)).toContain('overflow-hidden')
    const clips = (code(COPY).match(/overflow-hidden/g) ?? [])
    expect(clips, 'only the progress track may clip in the copy').toHaveLength(1)
    const line = code(COPY).split('\n').find(l => l.includes('overflow-hidden'))!
    expect(line).toContain('h-px')
  })

  it('the copy column sets no height of its own', () => {
    const src = code(COPY)
    expect(src).not.toMatch(/\bh-\[\d/)
    expect(src).not.toMatch(/max-h-\[/)
  })
})

// ═══ 4 · The hero states nothing countable, and invents no event ═════════════

describe('the hero claims nothing it cannot source', () => {
  const blob = JSON.stringify(HERO_SLIDES).toLowerCase()

  it('no count, no rating, no testimonial, no customer name', () => {
    for (const w of ['thousand', 'million', 'trusted by', 'rated', 'award-winning', '%', 'customers', 'testimonial']) {
      expect(blob, `slide copy contains "${w}"`).not.toContain(w)
    }
    expect(blob).not.toMatch(/\b\d{2,}\b/)
  })

  it('the stage shows CURATED photography only — never a live event\x27s banner', () => {
    const slots = buildHeroSlots()
    expect(slots).toHaveLength(HERO_SLIDES.length)
    expect(slots.every(s => s.event === null)).toBe(true)
    expect(slots.every(s => s.src.startsWith('https://images.unsplash.com/'))).toBe(true)
    // Nothing in the backdrop reads event data any more: no banner, no slug, no credit.
    const src = code(BACKDROP)
    expect(src).not.toMatch(/bannerUrl|PublicEventCard|publicEvents|HeroFeaturedCredit/)
  })

  it('the hero credits no event, because it shows none', () => {
    const hero = code('components/discovery/home/HomeHero.tsx')
    expect(hero).not.toContain('HeroFeaturedCredit')
    expect(hero).toContain('credits={HERO_SLIDES.map(() => null)}')
  })


  it('the curated photographs are not the ones the login carousel uses', () => {
    const ids = (p: string) => [...read(p).matchAll(/photo-[0-9a-z-]+/g)].map(m => m[0])
    const shared = ids(BACKDROP).filter(i => ids('components/auth/authCarouselSlides.ts').includes(i))
    expect(shared, 'the same photograph on the landing page and on sign-in').toEqual([])
  })
})

// ═══ 5 · Emphasis, and one headline ══════════════════════════════════════════

describe('the statement', () => {
  it('exactly one h1 on the page — the headline', () => {
    expect((code(COPY).match(/<motion\.h1/g) ?? [])).toHaveLength(1)
    for (const f of [HERO, STAGE, BACKDROP]) {
      expect(code(f), f).not.toMatch(/<h1/)
    }
  })

  it('the headline is set in the display face, at real scale', () => {
    const src = code(COPY)
    expect(src).toContain('font-display')
    expect(src).toMatch(/text-\[clamp\(/)
    // the size class must PRECEDE the leading class or tailwind-merge drops the leading
    const h = src.slice(src.indexOf('font-display'), src.indexOf('text-balance'))
    expect(h.indexOf('text-[clamp')).toBeLessThan(h.indexOf('leading-['))
  })

  it('emphasis is an italic in the warm accent — not gradient text over a photograph', () => {
    const src = code(COPY)
    expect(src).toContain('italic text-hero-accent-rule')
    expect(src, 'gradient text on a photograph competes with the picture')
      .not.toContain('rd-brand-gradient')
  })

  it('which phrase carries it is a copy decision, never a renderer heuristic', () => {
    expect(code(COPY)).toContain('emphasis={slide.headlineEmphasis}')
    for (const s of HERO_SLIDES) {
      expect(s.headlineAccent, `"${s.headlineEmphasis}" is not in "${s.headlineAccent}"`)
        .toContain(s.headlineEmphasis)
      expect(s.headlineEmphasis.length).toBeLessThan(s.headlineAccent.length)
    }
  })

  it('the headline is two explicit lines, so the break cannot move between slides', () => {
    expect(code(COPY)).toContain('<span className="block">{slide.headlineLead}</span>')
    for (const s of HERO_SLIDES) {
      expect(s.headlineLead.length, s.id).toBeGreaterThan(0)
      expect(s.headlineAccent.length, s.id).toBeGreaterThan(0)
    }
  })

  it('the type over the photograph uses the on-media ink role, never bare white', () => {
    const src = code(COPY)
    expect(src).toContain('text-ink-on-media')
    expect(src, 'bare text-white does not survive a theme audit').not.toMatch(/\btext-white\b/)
  })
})

// ═══ 6 · Accessibility and reduced motion ════════════════════════════════════

describe('the carousel contract', () => {
  it('announces itself as a carousel and labels both controls', () => {
    const stage = code(STAGE)
    expect(stage).toContain('aria-roledescription="carousel"')
    expect(stage).toContain('aria-label=')
    const copy = code(COPY)
    expect(copy).toContain('aria-label="Previous"')
    expect(copy).toContain('aria-label="Next"')
  })

  it('the changing copy is announced, once', () => {
    expect((code(COPY).match(/aria-live="polite"/g) ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('left and right step through the slides while focus is inside the hero', () => {
    const src = code(STAGE)
    expect(src).toContain("e.key === 'ArrowLeft'")
    expect(src).toContain("e.key === 'ArrowRight'")
  })

  it('hover and focus both pause it', () => {
    const src = code(STAGE)
    for (const h of ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur']) expect(src).toContain(h)
  })

  it('the TIMER itself is switched off under prefers-reduced-motion, not just the animation', () => {
    const src = code(STAGE)
    expect(src).toContain("matchMedia('(prefers-reduced-motion: reduce)')")
    expect(src).toContain('if (paused || reduce) return')
    // and a listener keeps it live if the OS setting changes with the tab open
    expect(src).toContain("mq.addEventListener('change', sync)")
  })

  it('every hero animation is inert in the reduced-motion block', () => {
    const css = read(CSS)
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {', css.indexOf('RD-HERO-03')))
    expect(block).toContain('.rd-hero-progress { animation: none')
    expect(block).toContain('[data-hero-backdrop] { transition: none')
    expect(block).toContain('[data-hero-backdrop] > img { animation: none')
  })
})

// ═══ 7 · The capsule's overlap is deliberate, and vertical ═══════════════════

describe('the search capsule crosses the photograph\'s lower edge', () => {
  it('by a negative TOP margin on its own wrapper', () => {
    expect(code(HERO)).toMatch(/-mt-\d+/)
  })

  it('and sits above the stage, on an opaque surface', () => {
    const src = code(HERO)
    expect(src).toContain('z-[4]')
    // the capsule's own surface is bg-card (HomeSearch) — the hero adds only the lift
    expect(src).toContain('shadow-')
  })

  it('the search island itself is untouched — same URL state, same fallback', () => {
    const src = code(HERO)
    expect(src).toContain('<HomeSearch cityCounts={cityCounts} stateCounts={stateCounts} />')
    expect(src).toContain('<ActiveFilterChips />')
    expect(src).toContain('SEARCH_CAPSULE_MIN_H')
  })
})
