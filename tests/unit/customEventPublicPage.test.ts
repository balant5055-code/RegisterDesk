// RD-CUSTOM-PUBLIC-01 · Custom Event public page — every organizer-entered field, end to end.
//
// Each test starts from an events/{slug} DOCUMENT shaped like publish writes it, runs it through
// the ONE projection the public page and the Super Admin preview share (buildEventPageProps), and
// renders the real Custom template to HTML. So a field counts as "shown" only when it survives
// document → props → markup, not when it merely saves.
//
// Defects this pins (each was confirmed against the code before the fix):
//   1. the organizer's free-text event kind (Step 1 "Describe your event type") never reached the page
//   2. paid passes said "All prices include taxes" on events that ADD platform fees at checkout
//   3. Terms / Privacy / FAQ links from the Organizer tab were dropped
//   4. organizer social links were dropped (and the "Show social links" toggle ignored)
//   5. the event logo (Branding & Media) was dropped
//   6. the "From ₹…" headline counted hidden sold-out passes
//   7. the SEO "Social Share Image" was never used for link previews            (shared)
//   8. the meeting ID, passcode and a "reveal after registration" link were
//      serialised into the public page payload and the JSON-LD                  (shared)
//   9. the shared ticket section (fallback / composed templates) had defect 2    (shared)

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ReactNode } from 'react'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
vi.mock('next/navigation', () => ({ usePathname: () => '/events/launch-night', useRouter: () => ({ push: () => {} }) }))
// The framework is page chrome (navbar, footer, lifecycle banner) — not under test here.
vi.mock('@/components/event-templates/EventDetailsFramework', () => ({
  EventDetailsFramework: ({ children }: { children: ReactNode }) => children,
}))

import { buildEventPageProps, publicOnlineVenue, type EventPageData } from '@/lib/events/eventPageProps'
import { CustomTemplate } from '@/components/event-templates/custom/CustomTemplate'
import { TicketSection } from '@/components/event-templates/shared/registration/TicketSection'
import { StickyRegistrationCard } from '@/components/event-templates/shared/registration/StickyRegistrationCard'
import { TAX_INCLUSIVE_NOTE, FEES_ADDED_AT_CHECKOUT_NOTE, TAX_INCLUSIVE_NOTE_SHORT, FEES_ADDED_AT_CHECKOUT_NOTE_SHORT } from '@/lib/pricing/copy'
import type { PublishedEvent } from '@/lib/firebase/firestore/events'
import type { EventDetailProps } from '@/components/event-templates/types'

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ')

const ZOOM = 'https://zoom.us/j/123456789?pwd=SECRET'

type Over = { details?: Record<string, unknown>; pricing?: Record<string, unknown>; event?: Partial<PublishedEvent> }

/** A Custom Event document as publish writes it — every public field the organizer can enter. */
function customEvent(over: Over = {}, lifecycleStatus = 'published'): PublishedEvent {
  const details = {
    info: {
      name: 'Launch Night', tagline: 'An evening of firsts', shortDesc: 'A one-night product reveal.',
      fullDesc: 'Doors, drinks, then the reveal.\n\nStay for the founders’ Q&A.', language: 'en', dressCode: 'Smart casual',
    },
    media: {
      coverBanner: { source: 'url', value: 'https://cdn.example.invalid/poster.jpg' },
      logo:        { source: 'url', value: 'https://cdn.example.invalid/logo.png' },
      galleryImages: [{ source: 'url', value: 'https://cdn.example.invalid/g1.jpg' }],
      promoVideoUrl: 'https://youtu.be/dQw4w9WgXcQ',
    },
    schedule: {
      startDate: '2099-05-01', startTime: '18:30', endDate: '2099-05-01', endTime: '22:00', doorsOpenTime: '18:00',
      timezone: 'Asia/Kolkata', agenda: [{ id: 'a1', title: 'The reveal', startTime: '19:00', endTime: '19:30', date: '2099-05-01', order: 1 }],
    },
    venue: {
      type: 'hybrid',
      physical: { name: 'The Glasshouse', addressLine1: '12 Lake Road', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', country: 'India', mapsLink: '', instructions: 'Enter by the east gate.' },
      online:   { platform: 'zoom', platformCustomName: '', meetingUrl: ZOOM, meetingId: '123 456 789', passcode: 'SECRET', revealAfterRegistration: true, joinInstructions: 'Join 5 minutes early.' },
    },
    organizer: {
      name: 'Northwind Labs', email: 'hello@northwind.invalid', phone: '', website: 'https://northwind.invalid', logoUrl: '',
      social: { instagram: 'https://instagram.com/northwind', linkedin: 'https://linkedin.com/company/northwind', twitter: '', facebook: '', youtube: '', hashtags: [] },
    },
    support: {
      supportEmail: 'help@northwind.invalid', supportPhone: '+91 90000 00000', faqUrl: 'https://northwind.invalid/faq',
      termsUrl: 'https://northwind.invalid/terms', privacyPolicyUrl: 'https://northwind.invalid/privacy', refundPolicyUrl: 'https://northwind.invalid/refunds',
    },
    seo: { urlSlug: 'launch-night', metaTitle: '', metaDescription: '', shareImageUrl: 'https://cdn.example.invalid/share.jpg', keywords: [] },
    publicPage: {},
    typeDetails: null,
    ...over.details,
  }
  return {
    slug: 'launch-night', uid: 'org', draftId: 'd', eventType: 'custom', eventSubtype: null,
    customEventSubtype: 'Product Launch', visibility: 'public',
    pricing: {
      eventType: 'paid',
      passes: [
        { id: 'early', name: 'Early bird', description: '', price: 300, quantity: 10, unlimited: false, status: 'active', visibility: 'public', hideWhenSoldOut: true },
        { id: 'ga',    name: 'General',    description: 'Standing', price: 800, quantity: 100, unlimited: false, status: 'active', visibility: 'public' },
      ],
      ...over.pricing,
    },
    eventDetails: details,
    planType: 'paid_event', capacityPlan: 'unlimited' as never, totalCapacity: null,
    registrationForm: null, accessControl: null,
    lifecycleStatus: lifecycleStatus as never, publishedAt: null, updatedAt: null,
    ...over.event,
  } as PublishedEvent
}

const DATA: EventPageData = { counter: null, linkedCampaign: null, exhibitorDirectory: [] }
const propsOf = (ev: PublishedEvent, data: EventPageData = DATA) => buildEventPageProps(ev.slug, ev, data).props
const page = (p: EventDetailProps) => renderToStaticMarkup(createElement(CustomTemplate, p))

// ═══ The projection ══════════════════════════════════════════════════════════

describe('projection — document → template props', () => {
  it('carries the organizer’s free-text event kind; absent / blank stays absent', () => {
    expect(propsOf(customEvent()).customEventSubtype).toBe('Product Launch')
    expect(propsOf(customEvent({ event: { customEventSubtype: '   ' } })).customEventSubtype).toBeUndefined()
    expect(propsOf(customEvent({ event: { customEventSubtype: undefined } })).customEventSubtype).toBeUndefined()
  })

  it('never carries the meeting ID, passcode, or a link the organizer reveals only after registration', () => {
    const online = propsOf(customEvent()).online!
    expect(online).toMatchObject({ platform: 'zoom', joinInstructions: 'Join 5 minutes early.', revealAfterRegistration: true })
    expect(online.meetingUrl).toBe('')
    expect(online.meetingId).toBe('')
    expect(online.passcode).toBe('')
    expect(JSON.stringify(propsOf(customEvent()))).not.toMatch(/SECRET|123 456 789|zoom\.us/)
  })

  it('a link the organizer chose to show publicly is kept (ID and passcode still are not)', () => {
    expect(publicOnlineVenue({ platform: 'zoom', platformCustomName: '', meetingUrl: ZOOM, meetingId: '1', passcode: 'p', revealAfterRegistration: false, joinInstructions: '' }))
      .toMatchObject({ meetingUrl: ZOOM, meetingId: '', passcode: '' })
    expect(publicOnlineVenue(undefined)).toBeUndefined()
  })

  it('review-pending: closed on its own, identical to the published page in the admin preview', () => {
    const pending = customEvent({}, 'pending_review')
    expect(propsOf(pending).registrationOpen).toBe(false)
    const preview = buildEventPageProps(pending.slug, pending, DATA, { displayLifecycle: 'published' }).props
    expect(preview).toEqual(propsOf(customEvent()))
    expect(preview.customEventSubtype).toBe('Product Launch')
    expect(preview.online?.meetingUrl).toBe('')
  })
})

// ═══ The rendered Custom page — populated ════════════════════════════════════

describe('Custom template — every populated field renders', () => {
  const html = page(propsOf(customEvent()))
  const t    = text(html)

  it('identity: kicker = the organizer’s own event kind, title, tagline, lede, event logo, poster', () => {
    expect(t).toContain('Product Launch')
    expect(t).toContain('Launch Night')
    expect(t).toContain('An evening of firsts')
    expect(t).toContain('A one-night product reveal.')
    expect(html).toContain('src="https://cdn.example.invalid/logo.png"')
    expect(html).toContain('alt="Launch Night logo"')
    expect(html).toContain('src="https://cdn.example.invalid/poster.jpg"')
  })

  it('story, film, programme, venue (physical + online), gallery', () => {
    expect(t).toContain('Stay for the founders’ Q&A.')
    expect(html).toContain('youtube')                         // promo video embedded
    expect(t).toContain('The reveal')
    expect(t).toContain('The Glasshouse')
    expect(t).toContain('12 Lake Road')
    expect(t).toContain('Enter by the east gate.')
    expect(t).toContain('Online via Zoom')
    expect(t).toContain('The joining link is shared after you register.')
    expect(html).toContain('src="https://cdn.example.invalid/g1.jpg"')
  })

  it('the meeting link / ID / passcode appear nowhere in the markup', () => {
    expect(html).not.toMatch(/SECRET|123 456 789|zoom\.us/)
  })

  it('when / where card: date, times, doors open, hybrid venue', () => {
    expect(t).toMatch(/1 May 2099|May 1, 2099|01 May 2099/)
    expect(t).toMatch(/6:30\s*PM/i)
    expect(t).toMatch(/Doors open 6:00\s*PM/i)
    expect(t).toContain('In person & online')
  })

  it('organizer: name, contact, website and SOCIAL links', () => {
    expect(t).toContain('Northwind Labs')
    expect(html).toContain('href="mailto:help@northwind.invalid"')
    expect(html).toContain('href="https://northwind.invalid"')
    expect(html).toContain('href="https://instagram.com/northwind"')
    expect(html).toContain('href="https://linkedin.com/company/northwind"')
    expect(t).not.toContain('Twitter')                        // empty handle → no chip
  })

  it('essentials: language, dress code, timezone, refunds, TERMS, PRIVACY, FAQ, support contact', () => {
    expect(t).toContain('Smart casual')
    expect(t).toMatch(/India|Kolkata|IST/)
    expect(html).toContain('href="https://northwind.invalid/refunds"')
    expect(html).toContain('href="https://northwind.invalid/terms"')
    expect(html).toContain('href="https://northwind.invalid/privacy"')
    expect(html).toContain('href="https://northwind.invalid/faq"')
    expect(html).toContain('href="tel:+91 90000 00000"')
  })

  it('admission: passes, prices and a register CTA per pass', () => {
    expect(t).toContain('General')
    expect(t).toContain('₹800')
    expect(html).toMatch(/href="\/events\/launch-night\/register\?[^"]*ga/)
  })
})

// ═══ Tickets, pricing and the fee note ═══════════════════════════════════════

describe('Custom template — pricing copy', () => {
  it('organizer-absorbs: "All prices include taxes"; attendee-pays: fees added at checkout — never both', () => {
    const absorbs = text(page({ ...propsOf(customEvent()), attendeePaysFees: false }))
    expect(absorbs).toContain(TAX_INCLUSIVE_NOTE)
    expect(absorbs).not.toContain(FEES_ADDED_AT_CHECKOUT_NOTE)

    const pays = text(page({ ...propsOf(customEvent()), attendeePaysFees: true }))
    expect(pays).toContain(FEES_ADDED_AT_CHECKOUT_NOTE)
    expect(pays).not.toContain(TAX_INCLUSIVE_NOTE)
  })

  it('a free event shows no tax / fee note and "Free"', () => {
    const free = customEvent({ pricing: { eventType: 'free', passes: [{ id: 'f', name: 'Entry', description: '', price: 0, quantity: 50, unlimited: false, status: 'active', visibility: 'public' }] } })
    const t = text(page({ ...propsOf(free), attendeePaysFees: true }))
    expect(t).toContain('Free')
    expect(t).not.toContain(TAX_INCLUSIVE_NOTE)
    expect(t).not.toContain(FEES_ADDED_AT_CHECKOUT_NOTE)
  })

  it('"From ₹…" ignores a hidden sold-out pass (it used to read From ₹300)', () => {
    const p = propsOf(customEvent())
    const soldOutEarly = { ...p, availability: { ...p.availability, early: { ...p.availability.early, status: 'sold_out' as const, remaining: 0 } } }
    const t = text(page(soldOutEarly))
    expect(t).toContain('From ₹800')
    expect(t).not.toContain('From ₹300')
    // While it IS on sale, it is the cheapest.
    expect(text(page(p))).toContain('From ₹300')
  })

  it('registration closed (cancelled): no register links, the closed message instead', () => {
    const html = page(propsOf(customEvent({}, 'cancelled')))
    expect(html).not.toMatch(/\/register\?/)
    expect(text(html)).toContain('This event has been cancelled.')
  })
})

// ═══ Optional fields empty ═══════════════════════════════════════════════════

describe('Custom template — optional fields empty', () => {
  const bare = customEvent({
    details: {
      info: { name: 'Bare Event', tagline: '', shortDesc: '', fullDesc: '', language: '', dressCode: '' },
      media: { coverBanner: { value: '' }, logo: { value: '' }, galleryImages: [], promoVideoUrl: '' },
      schedule: { startDate: '2099-05-01', startTime: '', endDate: '', endTime: '', timezone: '', agenda: [] },
      venue: { type: 'physical', physical: { name: '', city: 'Madurai' } },
      organizer: { name: '', email: '', phone: '', website: '', logoUrl: '', social: {} },
      support: {},
      seo: {},
    },
    event: { customEventSubtype: null },
  })

  it('renders without the empty sections and without placeholders', () => {
    const html = page(propsOf(bare))
    const t = text(html)
    expect(t).toContain('Bare Event')
    expect(t).toContain('Madurai')                            // kicker falls back to the city
    expect(html).not.toContain('logo"')                       // no logo img
    for (const gone of ['About the event', 'Good to know', 'Hosted by', 'How the day unfolds', 'Moments', 'Instagram', 'Read the terms'])
      expect(t, gone).not.toContain(gone)
  })

  it('social links stay hidden when the organizer turns them off', () => {
    const off = customEvent({ details: { publicPage: { showSocialLinks: false } } })
    const html = page(propsOf(off))
    expect(html).not.toContain('instagram.com')
    expect(text(html)).toContain('Northwind Labs')            // the organizer block itself stays
  })
})

// ═══ Shared surfaces (other templates) ═══════════════════════════════════════

describe('shared ticket section (fallback + composed templates) uses the same fee rule', () => {
  const p = propsOf(customEvent())
  const render = (attendeePaysFees?: boolean) => text(renderToStaticMarkup(createElement(TicketSection, {
    passes: p.passes, isFreeEvent: false, attendeePaysFees, slug: p.slug, availability: p.availability,
    registrationOpen: true, closedMessage: '',
  })))
  it('absent / false → tax-inclusive note; true → fees added at checkout', () => {
    expect(render()).toContain(TAX_INCLUSIVE_NOTE)
    expect(render(false)).toContain(TAX_INCLUSIVE_NOTE)
    expect(render(true)).toContain(FEES_ADDED_AT_CHECKOUT_NOTE)
    expect(render(true)).not.toContain(TAX_INCLUSIVE_NOTE)
  })
})

describe('fallback sticky registration card (fundraising / unknown types) uses the same fee rule', () => {
  const p = propsOf(customEvent())
  const render = (attendeePaysFees?: boolean) => text(renderToStaticMarkup(createElement(StickyRegistrationCard, {
    passes: p.passes, isFreeEvent: false, attendeePaysFees, slug: p.slug, availability: p.availability,
    registrationOpen: true, closedMessage: '', registrationEndDate: '', saved: false, onSave: () => {},
  })))
  it('absent / false → "Incl. taxes"; true → fees added at checkout, never "Incl. taxes"', () => {
    expect(render()).toContain(TAX_INCLUSIVE_NOTE_SHORT)
    expect(render(false)).toContain(TAX_INCLUSIVE_NOTE_SHORT)
    expect(render(true)).toContain(FEES_ADDED_AT_CHECKOUT_NOTE_SHORT)
    expect(render(true)).not.toContain(TAX_INCLUSIVE_NOTE_SHORT)
  })

  it('the real fallback page passes the server-resolved flag through', async () => {
    const { EventDetailClient } = await import('@/components/event-templates/fallback/EventDetailClient')
    const fundraising = { ...propsOf(customEvent({ event: { eventType: 'fundraising' } })), attendeePaysFees: true }
    const t = text(renderToStaticMarkup(createElement(EventDetailClient, fundraising)))
    expect(t).toContain(FEES_ADDED_AT_CHECKOUT_NOTE_SHORT)
    expect(t).toContain(FEES_ADDED_AT_CHECKOUT_NOTE)
    expect(t).not.toContain(TAX_INCLUSIVE_NOTE_SHORT)
  })
})
