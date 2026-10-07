// The landing footer, as RENDERED OUTPUT.
//
// ═══ WHAT THIS FOOTER IS NOT ═════════════════════════════════════════════════
// It is not MarketingFooter. Since the public shell migration, THIS footer is the public
// one — MarketingPageLayout delegates to HomeShell, so every marketing and legal page
// renders it too. MarketingFooter now has a single consumer, EventPageShell, which puts it
// on every /events/[slug] and its registration flow. These tests assert the public footer's
// own contract; the event band is untouched and has its own coverage in landingDesignSystem.
//
// ═══ THE RULE MOST OF THESE PIN ══════════════════════════════════════════════
// Every destination is DERIVED from a registry — PRIMARY_NAV, FOOTER_LEGAL, getCta — and
// not one URL is typed in the component. A footer is where a hand-typed link goes to rot
// unnoticed, so the tests check the registries and the render agree.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { HomeFooter } from '@/components/discovery/home/HomeFooter'
import { PRIMARY_NAV } from '@/content/marketing/navigation'
import { FOOTER_LEGAL, FOOTER_SOCIAL, FOOTER_BRAND, NEWSLETTER_ENABLED } from '@/content/marketing/footer'
import { getCta } from '@/lib/marketing/cta'
import { BRAND_NAME, BRAND_TAGLINE } from '@/components/marketing/BrandLockup'

const SRC = 'components/discovery/home/HomeFooter.tsx'
const code = readFileSync(resolve(process.cwd(), SRC), 'utf8')
const html = renderToStaticMarkup(createElement(HomeFooter))
const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1])

// ═══ 1 · Identity ════════════════════════════════════════════════════════════

describe('the footer states the brand once, from the canonical source', () => {
  it('states the brand ONCE, as the closing signature — the opening lockup is gone', () => {
    // The opening band (lockup + FOOTER_BRAND.description + the organizer door) was removed
    // on request. The identity is carried by HomeNavbar at the top of every page and by the
    // signature at the foot of this one; the footer no longer draws the lockup at all, and
    // the tagline it contains must not reappear as typed text here.
    expect(code).not.toContain('<BrandLockup')
    expect(html).toContain(BRAND_NAME)
    expect(html).not.toContain(BRAND_TAGLINE)
  })

  it('the closing signature reuses the constant, never a typed string', () => {
    expect(code).toContain('{BRAND_NAME}')
    // The name is typed exactly ONCE in this file — the sr-only landmark heading, which has
    // to be a literal because it is the footer's accessible name. Everywhere else it is the
    // constant, so BrandLockup stays the single place the product is spelled.
    expect(code.match(/>RegisterDesk</g) ?? []).toHaveLength(1)
    expect(code).toContain('className="sr-only">RegisterDesk</h2>')
  })

  it('the signature is decorative, so the name is not announced a third time', () => {
    // sr-only heading + lockup already name the brand.
    const sig = html.slice(html.indexOf('select-none') - 200, html.indexOf('select-none') + 200)
    expect(sig).toContain('aria-hidden')
  })

  it('invents no claim of its own', () => {
    // The footer used to open with FOOTER_BRAND.description. That band is gone, so the
    // constant must no longer be rendered — and nothing may be typed here in its place.
    expect(html).not.toContain(FOOTER_BRAND.description)
    expect(code, 'the constant is no longer imported').not.toMatch(/^import[^\n]*FOOTER_BRAND/m)
    // VISIBLE TEXT only. Matching raw markup catches Tailwind's own class names, and
    // `leading-none` is not a marketing claim.
    const text = html.replace(/<[^>]+>/g, ' ').toLowerCase()
    for (const claim of ['#1', 'trusted by', 'million', 'thousands', 'award-winning', 'leading platform']) {
      expect(text, `fabricated claim: ${claim}`).not.toContain(claim)
    }
    // No metric of any kind: the only number a READER sees is the copyright year. Measured
    // on visible text, not markup — image dimensions and transition durations are not
    // statistics.
    const year = String(new Date().getFullYear())
    const shown = (text.match(/\d+/g) ?? []).filter(d => d !== year)
    expect(shown, `unsourced number on screen: ${shown.join(', ')}`).toEqual([])
  })
})

// ═══ 2 · Every destination is real, and derived ══════════════════════════════

describe('the footer links only where the registries point', () => {
  it('types no URL in the component', () => {
    // Every href must come from a registry expression, never a literal.
    const literals = [...code.matchAll(/href="(\/[^"]*)"/g)].map(m => m[1])
    expect(literals, `hard-coded hrefs: ${literals.join(', ')}`).toEqual([])
  })

  it('offers the four Discover destinations from PRIMARY_NAV', () => {
    for (const id of ['events', 'causes', 'pricing', 'contact']) {
      const menu = PRIMARY_NAV.find(m => m.id === id)
      const href = menu?.href ?? menu?.featured?.href
      expect(href, `${id} missing from the registry`).toBeTruthy()
      expect(hrefs, `${id} not rendered`).toContain(href)
    }
  })

  it('keeps /events pointing at /events — the 307 is the public contract', () => {
    // /events redirects to `/`. Repointing it at `/` here would quietly retire a live URL
    // that links, bookmarks and index entries already use.
    expect(hrefs).toContain('/events')
  })

  it('carries every Solutions destination the registry has', () => {
    // 'platform' was the other id here. The public Platform section is retired: its menu is
    // gone from PRIMARY_NAV and its pages are deleted, so a footer column for it would list
    // nine URLs that 404.
    for (const id of ['solutions']) {
      const menu = PRIMARY_NAV.find(m => m.id === id)
      const items = (menu?.groups ?? []).flatMap(g => g.items)
      expect(items.length).toBeGreaterThan(0)
      for (const item of items) expect(hrefs, `${item.title} missing`).toContain(item.href)
      if (menu?.featured) expect(hrefs).toContain(menu.featured.href)
    }
  })

  it('carries every legal link', () => {
    for (const l of FOOTER_LEGAL) expect(hrefs, `${l.label} missing`).toContain(l.href)
  })

  it('no longer repeats the organizer door — the navbar owns it', () => {
    // Removed on request with the rest of the opening band. `getCta('login')` is untouched
    // and HomeNavbar still renders it, so the destination is one click away at the top of
    // every page; this pins that the footer does not quietly grow a second copy.
    const cta = getCta('login')
    expect(hrefs).not.toContain(cta.href)
    expect(html).not.toContain('For organizers')
    expect(html).not.toContain('Create and manage your next event')
  })

  it('renders no empty, hash or off-site href', () => {
    for (const h of hrefs) {
      expect(h, 'empty or placeholder href').not.toBe('')
      expect(h, 'placeholder href').not.toBe('#')
      expect(h, `unexpected external href: ${h}`).toMatch(/^\//)
    }
  })
})

// ═══ 3 · Nothing fabricated ══════════════════════════════════════════════════

describe('the footer shows nothing it cannot source', () => {
  it('renders no social block, because no profile is verified', () => {
    expect(FOOTER_SOCIAL).toEqual([])
    for (const n of ['instagram', 'linkedin', 'twitter', 'facebook', 'youtube', 'x.com']) {
      expect(html.toLowerCase(), `fabricated social: ${n}`).not.toContain(n)
    }
  })

  it('renders no newsletter, because there is no backend to receive one', () => {
    expect(NEWSLETTER_ENABLED).toBe(false)
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
    expect(html.toLowerCase()).not.toContain('subscribe')
  })
})

// ═══ 4 · The design language ═════════════════════════════════════════════════

describe('the footer earns its weight from type, not decoration', () => {
  it('uses no capsule, card, shadow, blur or gradient panel', () => {
    expect(html).not.toContain('rounded-full')
    expect(html).not.toContain('shadow')
    expect(html).not.toContain('blur')
    expect(html).not.toContain('rd-brand-gradient')
    expect(html).not.toContain('bg-gradient')
  })

  it('introduces no hardcoded colour, retired or otherwise', () => {
    const src = code.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(src).not.toMatch(/\b(rgba?|hsla?)\(/)
    // The retired magenta ramp must not reach a public surface.
    expect(src).not.toMatch(/\b(text|bg|border|ring)-primary\b/)
  })

  it('uses the action token for its accents, and only as an accent', () => {
    // The token appears on the hover hairline under every link. (The 12px rule beside
    // "For organizers" went with the opening band.) EVERY occurrence must be a 1px line —
    // an action-coloured element with real height is a filled panel, which is the thing
    // being prevented.
    const els = html.match(/class="[^"]*bg-action[^"]*"/g) ?? []
    expect(els.length).toBeGreaterThan(0)
    for (const el of els) expect(el, `bg-action on a non-hairline: ${el.slice(0, 80)}`).toContain('h-px')
  })

  it('keeps the whole footer inside the shared container', () => {
    // A signature that escaped the container is the one way this composition overflows.
    expect(code).toContain('container.page')
    expect(html).not.toContain('w-screen')
    expect(html).not.toContain('100vw')
  })
})

// ═══ 5 · Structure and accessibility ═════════════════════════════════════════

describe('the footer is navigable', () => {
  it('is a landmark with an accessible name', () => {
    expect(html).toContain('<footer')
    expect(html).toContain('aria-labelledby="home-footer-heading"')
    expect(html).toContain('id="home-footer-heading"')
  })

  it('names its navigation region', () => {
    expect(html).toContain('aria-label="Site index"')
  })

  it('gives every link a visible focus ring', () => {
    for (const a of html.match(/<a[^>]*>/g) ?? []) {
      expect(a, `no focus ring: ${a.slice(0, 90)}`).toContain('focus-visible:ring-2')
    }
  })

  it('gives every link a non-empty accessible name', () => {
    for (const a of html.match(/<a[^>]*>.*?<\/a>/gs) ?? []) {
      const text = a.replace(/<[^>]+>/g, '').trim()
      expect(text.length, `unnamed link: ${a.slice(0, 90)}`).toBeGreaterThan(0)
    }
  })

  it('nests no anchor inside another', () => {
    const tags = [...html.matchAll(/<a\b|<\/a>/g)].map(m => m[0])
    let depth = 0
    for (const t of tags) {
      if (t === '</a>') depth--
      else { depth++; expect(depth, 'nested anchor').toBeLessThanOrEqual(1) }
    }
    expect(depth).toBe(0)
  })

  it('states the three index groups', () => {
    for (const g of ['Discover', 'Solutions', 'Company']) {
      expect(html, `missing group: ${g}`).toContain(`>${g}</h3>`)
    }
    expect(html, 'the Platform column is still rendered').not.toContain('>Platform</h3>')
    expect(html, 'a footer link still points into /platform').not.toContain('href="/platform')
  })
})

// ═══ 6 · The mobile footer is compact AND tappable ═══════════════════════════
//
// Measured before this pass: 1329px tall at 320px, with 26px links. Both were wrong in the
// same place — the gap BETWEEN the rows. Folding it into the rows made the pitch 32px
// instead of 36px and the target 32px instead of 26px at once, which is why the footer got
// shorter and easier to hit in one change rather than trading one against the other.
//
// Every mobile value is paired with an `lg:` counterpart holding the approved desktop's
// exact previous geometry. Measured: 825px at 1024 and 798px at 1280/1361/1440, unchanged
// to the pixel.

describe('the mobile footer', () => {
  const src = code.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

  it('gives every footer-owned link a 32px hit area below lg', () => {
    // The index links and the legal links — the organizer CTA was the third, and it went
    // with the opening band. Each states the mobile target and the desktop restore
    // together, so neither can be changed without the other.
    expect((src.match(/min-h-8 lg:min-h-0/g) ?? []).length).toBe(2)
  })

  it('absorbs the row gap into the row, rather than stacking padding on top of it', () => {
    // gap-y-0 on a phone with a 32px link = a 32px pitch. The desktop keeps 26px links and
    // its 10px gap.
    // 2026-09-23 ledger pass: links flow along a line, so the vertical gap is zero at
    // every width and the horizontal one opens on desktop.
    expect(src).toContain('flex flex-wrap items-baseline gap-x-5 gap-y-0 lg:gap-x-7')
  })

  it('hands the desktop back every value it had', () => {
    // Each pair is (mobile, desktop-restore). If a mobile value is retuned without its lg:
    // partner, the desktop moves — which is the one thing a mobile pass must not do.
    // The opening band's four restores went with the band itself.
    // 2026-09-23 compact pass: the desktop is now ONE row (signature | index) + baseline.
    // 2026-09-23 ledger pass: signature (3/12) beside a three-line ledger (9/12).
    for (const lg of [
      'lg:pb-7', 'lg:pt-10',            // the container
      'lg:grid-cols-12',                // signature + index share one row
      'lg:py-3.5',                      // each ledger line
      'lg:mt-5', 'lg:pt-1', 'lg:gap-8', // the baseline band
    ]) {
      expect(src, `missing desktop restore: ${lg}`).toContain(lg)
    }
  })

  it('keeps the phone footer COMPACT — every band states its mobile value', () => {
    // MEASURED at 390: 32 (pad) + 41 (wordmark) + 32 + 363 (index) + 32 + 85 (baseline)
    // + 28 (pad) = 614px, which is shorter than the 628px this footer was before it was
    // redesigned. Each value below is the mobile half of a pair whose lg: partner is
    // pinned above, so neither side can be retuned alone and the phone cannot re-inflate.
    // Ledger pass, MEASURED: 450px at 390 and 482px at 320 (was ~614 at 390).
    for (const m of [
      'pb-5 pt-7',          // the container
      'mt-3 block h-px',    // the wordmark's rule
      'grid gap-5',         // signature → ledger on a phone
      'grid gap-y-1 py-3',  // each ledger line: label above its links on a phone
      'mt-4 pt-1',          // ledger → baseline
      'gap-1',              // legal row → copyright
    ]) {
      expect(src, `missing mobile value: ${m}`).toContain(m)
    }
  })

  it('the index is a three-line LEDGER — label track beside the links from sm', () => {
    // 2026-09-23 ledger pass (owner: "mobile and other screens look bad"). Each group is
    // one ruled line; from sm the label takes a fixed track so every line's links start on
    // the same edge, and below sm the label sits above its links.
    expect(src).toContain('sm:grid-cols-[8.5rem_1fr] sm:items-baseline')
    expect(src).toContain('divide-y divide-border/50')
    expect((src.match(/<IndexRow /g) ?? []).length).toBe(3)
  })

  it('the signature and the index share ONE row on desktop (compact pass)', () => {
    // Stacking three centred bands measured ~800px at 1440; signature (4/12) beside the
    // index (8/12) removes a band and measured 389px.
    expect(src).toContain('lg:col-span-3')
    expect(src).toContain('aria-label="Site index" className="lg:col-span-9"')
  })

  it('removes no link and collapses nothing to get shorter', () => {
    // The count is DERIVED, not written down. It was hardcoded at 28, and adding one
    // registry entry (Developer API) broke a test that has nothing to do with navigation —
    // the number was standing in for the real invariant, which is that mobile wins height
    // from spacing and never by dropping a destination.
    //
    // Index destinations = every Platform and Solutions item plus their two overview links,
    // the four Discover entries and the four Company entries; then the legal row. The
    // organizer CTA and the lockup link were the other two and went with the opening band.
    const fromNav = (id: string) => {
      const m = PRIMARY_NAV.find(x => x.id === id)
      return (m?.groups ?? []).flatMap(g => g.items).length + (m?.featured ? 1 : 0)
    }
    const DISCOVER = 4, COMPANY = 4
    const expected =
      DISCOVER + COMPANY + fromNav('platform') + fromNav('solutions') + FOOTER_LEGAL.length
    expect((html.match(/<a\b/g) ?? [])).toHaveLength(expected)
    // No accordion, no drawer, no disclosure — height was won from spacing, not from hiding.
    for (const el of ['<details', '<summary', '<button', 'aria-expanded']) {
      expect(html, `content hidden behind ${el}`).not.toContain(el)
    }
  })

  it('keeps the wordmark at every width, and it is type rather than a watermark', () => {
    expect(html).toContain('select-none')
    // It is the page's display face in real ink — NOT the 64px grey watermark it replaced,
    // which set the name at clamp(…,8vw,4rem) in foreground/[0.14]: 600px of pale capitals
    // at 1440, the largest object in the footer and also the faintest. Asserted on the
    // RENDER so the old treatment cannot survive in a comment.
    expect(html).toContain('font-display text-fs-2xl font-light')
    expect(html).not.toContain('8vw')
    expect(html).not.toContain('text-foreground/[0.14]')
  })

  it('the signature and the index columns share one LEFT edge each (editorial row)', () => {
    // Owner request 2026-09-23 ("luxury, compact"): the centred stack became a row, and a
    // row reads left-to-right, so the signature and every column are left-aligned.
    expect(src).toContain('<div className="flex flex-col items-start lg:col-span-3 lg:pt-3.5">') // the signature
    // One ornament language, shared with the landing's mastheads: a warm hairline.
    expect(html).toContain('h-px w-10 bg-hero-accent-rule')
    expect((html.match(/bg-hero-accent-rule/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })

  it('the baseline is a SPLIT row, and neither half ever breaks a line', () => {
    // Copyright to the left edge, legal index to the right, on one line from `sm`. Below
    // that the pair cannot fit — measured ~540px needed against 288px at 320 — so the two
    // halves stack, each still unbroken, and the order swaps so the copyright leads on the
    // row. `whitespace-nowrap` on both halves and `flex-nowrap` on the list are what stop
    // a label breaking after "Refund"; the phone gap closes to 3.5 so the four labels fit
    // 288px on one line.
    expect(src).toContain('sm:flex-row sm:items-baseline sm:justify-between')
    expect(src).toContain('flex flex-nowrap items-baseline justify-center gap-x-3.5 sm:order-2 sm:gap-x-6')
    expect(src).toContain('order-2 whitespace-nowrap')          // the copyright, left from sm
    expect(src).toContain('sm:order-1')
    expect(src).toContain('whitespace-nowrap py-1 text-fs-xs')  // every legal label
  })
})
