// The Recently Completed archive card, as RENDERED OUTPUT.
//
// ═══ WHAT THIS CARD REPLACED ═════════════════════════════════════════════════
// `UpcomingEventCard variant="completed"` — a shopping card with the price swapped for the
// word "Completed". It led with a banner selling an event nobody can join, and offered no
// way to reach what the event left behind.
//
// ═══ THE RULE THESE TESTS EXIST FOR ══════════════════════════════════════════
// Both extra destinations 404 when their data is absent:
//
//   /results/<slug>          getEventResults → null → notFound()
//   /events/<slug>/gallery   resolvePublicEvent → null → notFound()
//
// Measured against the development database, the one real completed event
// (noyyal-marathon-2026) returns 404 for results and an empty gallery. So "render the link
// only when the destination is proven" is not defensive coding here — it is the common case,
// and a card that guessed would ship a dead link on the only completed event that exists.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { CompletedEventCard } from '@/components/discovery/home/CompletedEventCard'
import { detailsHref, detailsOnly } from '@/lib/discovery/completedDestinations'
import type { CompletedEventDestinations } from '@/lib/discovery/completedDestinations'
import type { PublicEventCard } from '@/lib/firebase/firestore/publicEvents'

const event = (over: Partial<PublicEventCard> = {}): PublicEventCard => ({
  id: 'noyyal', slug: 'noyyal-marathon-2026', name: 'Noyyal Marathon 2026',
  tagline: 'A river-side run through Tiruppur.',
  startDate: '2026-08-22', endDate: '2026-08-22', startTime: null,
  city: 'Tiruppur', state: 'Tamil Nadu', venueType: 'physical', eventType: 'sports',
  bannerUrl: 'https://firebasestorage.googleapis.com/v0/b/rd/o/banner.jpg', logoUrl: null,
  isFreeEvent: false, minPrice: 50000,
  totalCapacity: null, totalCount: 5, organizerName: null, organizerLogo: null,
  approvalMode: 'auto', publishedAt: null,
  ...over,
})

const render = (e: PublicEventCard, d?: CompletedEventDestinations) =>
  renderToStaticMarkup(createElement(CompletedEventCard, { event: e, destinations: d }))

const ALL: CompletedEventDestinations = {
  details:      '/events/noyyal-marathon-2026',
  results:      '/results/noyyal-marathon-2026',
  photos:       '/events/noyyal-marathon-2026/gallery',
  certificates: '/events/noyyal-marathon-2026/certificates',
}

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1])

// ═══ 1 · The card says what it is ════════════════════════════════════════════

describe('the completed card states the event', () => {
  it('renders the title, the completed status, the date, the location and the category', () => {
    const html = render(event(), ALL)
    expect(html).toContain('Noyyal Marathon 2026')
    expect(html).toContain('Completed')
    expect(html).toContain('22 Aug')          // shortDate of the real end date
    expect(html).toContain('Tiruppur, Tamil Nadu')
    expect(html).toContain('Sports &amp; Runs')
  })

  it('shows the organizer’s own description, and nothing when there is none', () => {
    expect(render(event(), ALL)).toContain('A river-side run through Tiruppur.')
    // No placeholder, no generated blurb, no "no description" line.
    const bare = render(event({ tagline: '' }), ALL)
    expect(bare).not.toContain('A river-side run')
    expect(bare.toLowerCase()).not.toContain('no description')
  })

  it('dates the card from the day it FINISHED, not the day it started', () => {
    const html = render(event({ startDate: '2026-08-20', endDate: '2026-08-22' }), ALL)
    expect(html).toContain('22 Aug')
    expect(html).not.toContain('20 Aug')
  })

  it('invents no metric of any kind', () => {
    // bannerUrl null so the CDN path cannot be mistaken for a leaked figure.
    const html = render(event({ totalCount: 137, minPrice: 50000, bannerUrl: null }), ALL)
    // "photo" is deliberately absent from this list: the card carries a "Images" LINK, which
    // is a destination, not a metric. The count-shaped assertion for it is in §2.
    for (const w of ['137', '₹50,000', 'attendee', 'finisher', 'rating', 'popular', 'views']) {
      expect(html.toLowerCase(), `leaked "${w}"`).not.toContain(w.toLowerCase())
    }
  })
})

// ═══ 2 · The banner is the EVENT; it is not a gallery preview ════════════════
//
// An earlier revision removed the banner on the reasoning that "photos are a destination,
// not content". That conflated the event's own image with a link to its gallery, and left
// the archive section with no visual memory in it. The banner is the card's anchor; what
// must stay out is anything that turns the card into a preview OF the gallery.

describe('the card leads with the event banner', () => {
  it('renders the event’s own banner when it has one', () => {
    const html = render(event({ bannerUrl: 'https://firebasestorage.googleapis.com/v0/b/rd/o/banner.jpg' }), ALL)
    expect(html).toContain('<img')
    expect(html).toContain('banner.jpg')
    expect(html).toContain('aspect-video')
    // Decorative: the title beside it already names the event.
    expect(html).toMatch(/<img[^>]*alt=""/)
  })

  it('falls back to a tint carrying the event’s OWN mark — never a stand-in photograph', () => {
    // No logo either: a monogram cut from the event's own name — derived, never invented.
    const bare = render(event({ bannerUrl: null, logoUrl: null }), ALL)
    expect(bare).not.toContain('<img')
    expect(bare).toContain('aspect-video')          // the slot is still reserved
    expect(bare).toContain('from-action/[0.14]')    // a tint, not an invented image
    const initials = event().name.split(/\s+/).slice(0, 2).map(w => w[0]!.toUpperCase()).join('')
    expect(bare).toContain('>' + initials + '<')
    // The event's logo when it has one — its own asset on the same host guard, not a stock photograph.
    const logo = render(event({ bannerUrl: null, logoUrl: 'https://firebasestorage.googleapis.com/v0/b/rd/o/logo.png' }), ALL)
    expect(logo).toContain('logo.png')
    expect(logo).not.toContain('>' + initials + '<')
    expect(logo).not.toContain('unsplash')
  })

  it('shows ONE image — no strip, no grid, no gallery preview', () => {
    const html = render(event(), ALL)
    expect((html.match(/<img/g) ?? [])).toHaveLength(1)
  })

  it('renders no photo count or overlay statistic', () => {
    // Measured on VISIBLE TEXT. The raw markup legitimately contains a "+" — Tailwind's
    // `nth-child(n+3)` divider rule — and a class name is not a statistic.
    const text = render(event(), ALL).replace(/<[^>]+>/g, ' ')
    expect(text).not.toMatch(/\d+\s*photos?/i)
    expect(text).not.toContain('+')
  })

  it('does not wrap the banner in a link — no third anchor to the same place', () => {
    const html = render(event(), ALL)
    const before = html.slice(0, html.indexOf('<img'))
    // Every anchor opened before the image is already closed.
    expect((before.match(/<a\b/g) ?? []).length).toBe((before.match(/<\/a>/g) ?? []).length)
  })
})

// ═══ 3 · Every link is real, and the unavailable ones are absent ═════════════

describe('the card links only where the destination exists', () => {
  it('offers all four when all four are proven', () => {
    const html = render(event(), ALL)
    // Five anchors, in DOM order: the title, then the four actions. The title and the details
    // action share a destination on purpose — one is the event's name, the other is the
    // explicit way out of the card.
    expect(hrefs(html)).toEqual([
      '/events/noyyal-marathon-2026',
      '/events/noyyal-marathon-2026/gallery',
      '/results/noyyal-marathon-2026',
      '/events/noyyal-marathon-2026/certificates',
      '/events/noyyal-marathon-2026',
    ])
    expect(html).toContain('Images')
    expect(html).toContain('Results')
    expect(html).toContain('Certificates')
    expect(html).toContain('Event details for Noyyal Marathon 2026')
  })

  it('omits Certificates when the event has issued none', () => {
    // The Certificate Center 404s only on an unknown slug, so it would OPEN for any event —
    // but it opens a lookup form, and a lookup against an event with no certificates answers
    // "nothing found" only after the attendee has typed their email or bib. Hiding it is the
    // graceful handling; a link to a form that cannot match is not.
    const html = render(event(), { ...ALL, certificates: null })
    expect(html).not.toContain('Certificates')
    expect(hrefs(html).some(h => h.endsWith('/certificates'))).toBe(false)
  })

  it('never types a certificate URL of its own', () => {
    // The href comes from the resolver, which builds it from the slug. A literal here would
    // be a guessed route.
    const src = readFileSync(resolve(process.cwd(), 'components/discovery/home/CompletedEventCard.tsx'), 'utf8')
    expect(src).not.toContain('/certificates')
    expect(src).toContain('dest.certificates')
  })

  it('omits Results entirely when the event has none — never a fallback link', () => {
    // The real case today. Falling back to the detail page would put two links labelled
    // differently on the same destination, which is worse than one honest omission.
    const html = render(event(), { ...ALL, results: null })
    expect(html).not.toContain('Results')
    expect(hrefs(html)).not.toContain('/results/noyyal-marathon-2026')
  })

  it('omits Images entirely when the gallery holds nothing public', () => {
    const html = render(event(), { ...ALL, photos: null })
    expect(html).not.toContain('Images')
    expect(hrefs(html).some(h => h.endsWith('/gallery'))).toBe(false)
  })

  it('falls back to details ALONE when nothing was resolved', () => {
    // Both the explicit "nothing available" case and the prop being omitted entirely.
    for (const html of [render(event(), detailsOnly('noyyal-marathon-2026')), render(event())]) {
      expect(hrefs(html)).toEqual(['/events/noyyal-marathon-2026', '/events/noyyal-marathon-2026'])
      expect(html).toContain('Event details for Noyyal Marathon 2026')
      expect(html).not.toContain('Results')
      expect(html).not.toContain('Images')
    }
  })

  it('never points anywhere generic', () => {
    for (const d of [ALL, { ...ALL, results: null }, { ...ALL, photos: null }, detailsOnly('x')]) {
      for (const h of hrefs(render(event(), d))) {
        expect(h, 'generic destination').not.toBe('/')
        expect(h, 'listing route').not.toBe('/events')
        expect(h, 'relative or empty href').toMatch(/^\/(events|results)\//)
      }
    }
  })

  it('uses the event’s own slug in every href', () => {
    const html = render(event({ slug: 'another-event' }), {
      details: detailsHref('another-event'),
      results: '/results/another-event',
      photos:  '/events/another-event/gallery',
    })
    for (const h of hrefs(html)) expect(h).toContain('another-event')
    expect(html).not.toContain('noyyal')
  })
})

// ═══ 4 · Markup and accessibility ════════════════════════════════════════════

describe('the card is valid, reachable markup', () => {
  it('nests no anchor inside another anchor', () => {
    // The whole card is deliberately NOT one link. An <a> inside an <a> is invalid and
    // browsers recover from it unpredictably.
    const html = render(event(), ALL)
    const opens = [...html.matchAll(/<a\b|<\/a>/g)].map(m => m[0])
    let depth = 0
    for (const t of opens) {
      if (t === '</a>') depth--
      else { depth++; expect(depth, 'nested anchor').toBeLessThanOrEqual(1) }
    }
    expect(depth).toBe(0)
  })

  it('gives every link an accessible name and a visible focus ring', () => {
    const html = render(event(), ALL)
    // Every anchor contains text; none is an icon with no label.
    for (const a of html.match(/<a[^>]*>.*?<\/a>/gs) ?? []) {
      expect(a.replace(/<[^>]+>/g, '').trim().length, `unnamed link: ${a.slice(0, 80)}`).toBeGreaterThan(0)
      expect(a, 'no focus ring').toContain('focus-visible:ring-2')
    }
  })

  it('names the action group after the event, so it is not just "navigation"', () => {
    expect(render(event(), ALL)).toContain('aria-label="Links for Noyyal Marathon 2026"')
  })

  it('keeps every link above the 24px minimum target size', () => {
    const html = render(event(), ALL)
    // The actions are 32px by height; the title is a block link with its own padding,
    // because a single-line title measured 21px in the browser without it.
    for (const a of html.match(/<a[^>]*class="[^"]*inline-flex[^"]*"/g) ?? []) {
      expect(a).toContain('h-8')
    }
    expect(html).toContain('line-clamp-2 rounded-sm py-0.5')
  })
})

// ═══ 5 · The design language the pass was asked to hold ══════════════════════

describe('the card stays in the restrained design system', () => {
  const html = render(event(), ALL)

  it('uses no capsule, no shadow, no glow, and no brand gradient', () => {
    expect(html).not.toContain('rounded-full')
    expect(html).not.toContain('shadow')
    expect(html).not.toContain('blur')
    expect(html).not.toContain('rd-brand-gradient')
  })

  it('the only gradient is the no-banner tint, at 14%', () => {
    // A gradient across the card would make the archive louder than Upcoming Events. The one
    // permitted use is the empty image slot, where it stands in for a photograph that does
    // not exist — and it is a wash, not a statement.
    const tint = render(event({ bannerUrl: null }), ALL)
    const gradients = tint.match(/bg-gradient-[a-z-]+/g) ?? []
    expect(gradients).toEqual(['bg-gradient-to-br'])
    expect(tint).toContain('from-action/[0.14]')
    // And with a real banner there is no gradient at all.
    expect(html).not.toContain('bg-gradient')
  })

  it('keeps the restrained radius and the shared card surface', () => {
    expect(html).toContain('rounded-lg')
    expect(html).toContain('border border-border/70 bg-card')
    expect(html).not.toContain('rounded-2xl')
  })

  it('states Completed as type with a hairline, not as a badge', () => {
    expect(html).toContain('uppercase')
    expect(html).toContain('h-px w-3 shrink-0 bg-action')
    // The lifecycle accent the platform already uses for this state.
    expect(html).toContain('text-accent-people-fg')
  })

  it('introduces no hardcoded colour', () => {
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(html).not.toMatch(/\b(rgba?|hsla?)\(/)
  })
})

// ═══ 6 · The action row fits on one line ═════════════════════════════════════
//
// Measured in the browser: the narrowest column this row occupies is 256px — a 320px phone,
// and the 4-up desktop grid at 1440, which lands within a pixel of it. With the label
// "Event details" the row was 280px and wrapped the last action onto its own line at BOTH.
// These pin the fix so a longer label cannot silently reintroduce the wrap.

describe('the action row', () => {
  it('uses the short visible label, with the full wording as the accessible name', () => {
    const html = render(event(), ALL)
    expect(html).toContain('>Details<')
    expect(html).toContain('aria-label="Event details for Noyyal Marathon 2026"')
    // The visible text is contained in the accessible name (WCAG 2.5.3 Label in Name) —
    // case-insensitively, which is what voice control matches on.
    expect('Event details for Noyyal Marathon 2026'.toLowerCase()).toContain('details')
  })

  it('names every action after its event, so four cards are distinguishable', () => {
    const html = render(event(), ALL)
    expect(html).toContain('aria-label="View photos from Noyyal Marathon 2026"')
    expect(html).toContain('aria-label="View results for Noyyal Marathon 2026"')
    expect(html).toContain('aria-label="Event details for Noyyal Marathon 2026"')
  })

  it('shows one noun per action, because the cell is 72px at its narrowest', () => {
    // Four equal cells of the 289px four-up desktop card leave 72px each. "View Photos" does
    // not fit that at any honest size, so the visible word is the noun and the full phrase
    // lives in the accessible name.
    const nav = render(event(), ALL)
    const labels = [...nav.matchAll(/<span class="min-w-0 max-w-full truncate[^"]*">([^<]+)<\/span>/g)].map(m => m[1])
    expect(labels).toEqual(['Images', 'Results', 'Certificates', 'Details'])
    // Measured in the browser: "Certificates" is 74px at the 13px token and 62px at 11px.
    // A cell needs the label plus 8px of padding, so only the 11px token clears 72px.
    expect(nav).toContain('text-fs-2xs')
  })

  it('stacks the mark above the word, which is what makes 72px fit', () => {
    // Icon beside label would need the two widths summed. Stacked, a cell needs only
    // max(icon, label) — 62px for the longest label, inside a 72px track.
    const html = render(event(), ALL)
    for (const a of html.match(/<a[^>]*class="[^"]*group\/act[^"]*"/g) ?? []) {
      expect(a).toContain('flex-col')
      expect(a).toContain('items-center')
    }
  })

  it('gives every action cell a real target, not just its text', () => {
    // The whole cell is the link, so the tap area is the visible block: 52px, well past the
    // 32px minimum. `flex-1` is gone because the cells are grid tracks, not flex children.
    const html = render(event(), ALL)
    const cells = html.match(/<a[^>]*class="[^"]*group\/act[^"]*"/g) ?? []
    expect(cells).toHaveLength(4)
    for (const a of cells) expect(a).toContain('min-h-[3.25rem]')
  })

  it('gives all four cells a mark, including Details', () => {
    // Details' mark IS the arrow. A document icon plus a trailing arrow would give one link
    // two symbols, and it would leave that cell a row shorter than the two beside it.
    const html = render(event(), ALL)
    const nav = html.slice(html.indexOf('<nav'))
    expect((nav.match(/<svg/g) ?? [])).toHaveLength(4)
  })
})

// ═══ 7 · The one-row rail, and the compaction it paid for ════════════════════
//
// The card was 289×490 at desktop, of which 120px was a 2×2 rail. Folding the rail to one
// row is most of the reduction to ~450px. These pin the layout table's arithmetic so a
// future label or type change cannot silently reintroduce the second row — or, worse, keep
// one row and clip a word.

describe('the action rail is a single row wherever it fits', () => {
  const railOf = (html: string) => {
    const start = html.indexOf('<nav')
    return html.slice(start, html.indexOf('</nav>', start))
  }
  // Tailwind's arbitrary variants contain `&` and `>`, which the renderer escapes inside the
  // attribute. Decode them back so the assertions can read as the class names actually written.
  const navClass = (html: string) =>
    (html.slice(html.indexOf('<nav')).match(/class="([^"]*)"/)?.[1] ?? '')
      .replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<')

  it('gives four actions four tracks, and folds ONLY across the 3-up tablet band', () => {
    // 289px / 4 = 72px a cell at desktop, which the 11px label clears. At 768 the card is
    // 227px and a cell would be 57px — the one width where four cannot fit.
    const cls = navClass(render(event(), ALL))
    expect(cls).toContain('grid-cols-4')
    expect(cls).toContain('md:grid-cols-2')
    expect(cls).toContain('lg:grid-cols-4')
  })

  it('sizes the rail to the number of destinations that actually exist', () => {
    // Three actions fit one row even on the 227px tablet card (75px a cell), so there is no
    // fold and no half-width cell left over.
    const three = navClass(render(event(), { ...ALL, certificates: undefined }))
    expect(three).toContain('grid-cols-3')
    expect(three).not.toContain('md:grid-cols-2')

    const one = navClass(render(event(), detailsOnly('noyyal-marathon-2026')))
    expect(one).toContain('grid-cols-1')
  })

  it('never leaves a half-width cell — the old odd-count workaround is gone', () => {
    for (const d of [ALL, { ...ALL, results: undefined }, { ...ALL, photos: undefined, results: undefined }]) {
      expect(railOf(render(event(), d))).not.toContain('col-span-2')
    }
  })

  it('rules between cells, and moves the rule when the rail folds', () => {
    // A vertical hairline between neighbours; where the third cell starts a row it drops
    // that rule and the bottom pair takes a horizontal one instead.
    const cls = navClass(render(event(), ALL))
    expect(cls).toContain('[&>a+a]:border-l')
    expect(cls).toContain('md:[&>a:nth-child(3)]:border-l-0')
    expect(cls).toContain('md:[&>a:nth-child(n+3)]:border-t')
    expect(cls).toContain('lg:[&>a:nth-child(n+3)]:border-t-0')
  })
})

describe('the card sizes itself from its content', () => {
  it('declares no fixed or minimum height of its own', () => {
    const html = render(event(), ALL)
    const article = html.slice(0, html.indexOf('>') + 1)
    expect(article).not.toMatch(/\bh-\[|\bmin-h-\[(?!3\.25rem)/)
    // The only min-height on the card is the action cell's touch target.
    const mins = html.match(/min-h-\[[^\]]+\]/g) ?? []
    expect([...new Set(mins)]).toEqual(['min-h-[3.25rem]'])
  })

  it('collapses the description row entirely when the event has none', () => {
    // Not an empty paragraph holding a line of height — the element is absent.
    const without = render(event({ tagline: null }), ALL)
    expect(without).not.toContain('line-clamp-2 text-fs-sm')
    const withIt = render(event(), ALL)
    expect(withIt).toContain('A river-side run through Tiruppur.')
  })

  it('keeps the title the loudest text on the card', () => {
    // 18px title against the 13px metadata and the 11px overlines. The step is what makes
    // the hierarchy read; the previous 15px sat too close to the body copy.
    const html = render(event(), ALL)
    const h3 = html.slice(html.indexOf('<h3'), html.indexOf('</h3>'))
    expect(h3).toContain('text-fs-lg')
    expect(h3).toContain('line-clamp-2')
    // And the category above it must not compete.
    // The category moved from a body overline to the type line ABOVE the card (2026-09-23),
    // where it carries its registry icon; it is still small-caps type, quieter than the title.
    expect(html).toMatch(/truncate text-fs-2xs font-semibold uppercase[^"]*text-hero-ink">Sports &amp; Runs</)
  })
})
