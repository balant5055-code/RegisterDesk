// RD-CUSTOM-AUDIT-02 · Custom Event — every wizard field, from the SAVED event to what a visitor gets.
//
// Each realistic events/{slug} document below is shaped exactly as the wizard + publish write it.
// It goes through the ONE projection the public page and the Super Admin preview share
// (buildEventPageProps), the real Custom template is rendered to HTML, and the page's own
// metadata, JSON-LD and the public calendar file are produced by their real handlers. A field is
// "public" only if its value is in that OUTPUT; a private value must be in none of it.
//
// Defects pinned here (each fails on the pre-fix code):
//   • pass internals (code, badge prefix/category, coupon/tax flags, milestone thresholds) reached the browser
//   • the event-level "Show remaining seats" switch was ignored
//   • "Registration closes" date never shown; "Show attendee count" ignored on Custom
//   • gallery stopped at 6 images; address dropped the country; session type / track not shown
//   • early-bird context and pass booking / policy notes not shown
//   • legacy description / cover / logo names (accepted by the publish checklist) rendered nothing
//   • calendar.ics: raw Markdown, raw platform id, hybrid address dropped

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ReactNode, type ReactElement } from 'react'

const h = vi.hoisted(() => ({ event: null as unknown }))

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
vi.mock('next/navigation', () => ({ usePathname: () => '/events/aurora-launch', useRouter: () => ({ push: () => {} }) }))
vi.mock('@/components/event-templates/EventDetailsFramework', () => ({
  EventDetailsFramework: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/lib/events/publicEventAccess', () => ({ findPublicEvent: async () => h.event }))
vi.mock('@/lib/firebase/firestore/events', async orig => ({
  ...(await orig<typeof import('@/lib/firebase/firestore/events')>()),
  getEventBySlug: async () => h.event,
}))
vi.mock('@/lib/config/resolveBrandingConfig', () => ({
  getBrandingConfig: async () => ({ platformName: 'RegisterDesk', baseUrl: 'https://rd.example.invalid' }),
}))
vi.mock('@/components/report/ReportButton', () => ({ default: () => null }))
vi.mock('@/components/event-templates/TemplateRouter', () => ({ TemplateRouter: () => null }))
vi.mock('@/features/race-operations/components/public/EventResultsBanner', () => ({ EventResultsBanner: () => null }))
vi.mock('@/lib/events/eventPageProps', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/events/eventPageProps')>()),
  loadEventPageData: async () => ({ counter: null, linkedCampaign: null, exhibitorDirectory: [] }),
}))

import { buildEventPageProps, type EventPageData } from '@/lib/events/eventPageProps'
import { CustomTemplate } from '@/components/event-templates/custom/CustomTemplate'
import type { PublishedEvent } from '@/lib/firebase/firestore/events'
import type { EventDetailProps } from '@/components/event-templates/types'

const page   = await import('@/app/events/[slug]/page')
const icsApi = await import('@/app/api/events/[slug]/calendar.ics/route')

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ')

// ─── Private values: planted in the saved event, must appear in NO public output ──────────────
const SECRET = {
  meetingUrl: 'https://zoom.us/j/7700112233?pwd=PRIVATEPWD', meetingId: '770 011 2233', passcode: 'PASS-PRIV-91',
  passCode: 'INT-VIP-0042', badgePrefix: 'BDGPFX', badgeCategory: 'BADGECAT-ALPHA', milestoneMsg: 'SECRET-THRESHOLD-MSG',
  inviteCode: 'INVITE-ZZ-8812', approvedEmail: 'vip.guest@private.invalid', utm: 'utm-private-campaign',
  ga: 'G-PRIVATE123', pixel: 'PIXEL-PRIVATE-77', webhook: 'https://hooks.private.invalid/abc',
  reminderNote: 'reminder-channel-private',
}

const GALLERY = Array.from({ length: 9 }, (_, i) => ({ source: 'url', value: `https://cdn.example.invalid/g${i + 1}.jpg`, origin: 'url' }))

type Over = { details?: Record<string, unknown>; pricing?: Record<string, unknown>; event?: Record<string, unknown> }

/** A fully populated Custom Event, every wizard step filled in. */
function fullEvent(over: Over = {}): PublishedEvent {
  const details = {
    info: {
      name: 'Aurora Product Launch', tagline: 'The first look', shortDesc: 'A one-night reveal of Aurora.',
      fullDesc: '## The evening\nAn **exclusive** first look.\n\n- Live demo\n- Founder Q&A\n\nMore at [our site](https://aurora.invalid/more).',
      language: 'en', dressCode: 'Smart casual',
    },
    media: {
      logo: { source: 'url', value: 'https://cdn.example.invalid/aurora-logo.png' },
      coverBanner: { source: 'url', value: 'https://cdn.example.invalid/aurora-cover.jpg' },
      bannerPositionX: 0, bannerPositionY: 0, bannerScale: 1,
      galleryImages: GALLERY, promoVideoUrl: 'https://youtu.be/dQw4w9WgXcQ',
    },
    venue: {
      type: 'hybrid',
      physical: {
        name: 'Harbour Pavilion', addressLine1: '1 Marina Walk', addressLine2: 'Gate 3', city: 'Kochi', state: 'Kerala',
        country: 'India', pincode: '682001', mapsLink: 'https://maps.example.invalid/harbour', instructions: 'Valet at Gate 3.',
        maps: { layoutImageUrl: 'https://cdn.example.invalid/layout.png', parkingMapUrl: 'https://cdn.example.invalid/parking.png', entryGateMapUrl: '' },
      },
      online: { platform: 'zoom', platformCustomName: '', meetingUrl: SECRET.meetingUrl, meetingId: SECRET.meetingId, passcode: SECRET.passcode, revealAfterRegistration: true, joinInstructions: 'Stream opens at 6:55 PM.' },
    },
    schedule: {
      timezone: 'Asia/Kolkata', startDate: '2099-08-14', startTime: '19:00', endDate: '2099-08-14', endTime: '22:00', doorsOpenTime: '18:30',
      agenda: [
        { id: 's1', date: '2099-08-14', startTime: '19:00', endTime: '19:30', title: 'Opening keynote', description: 'Why Aurora.', type: 'keynote', speakerIds: [], location: 'Main stage', track: 'Product', isBreak: false, order: 1 },
        { id: 's2', date: '2099-08-14', startTime: '19:30', endTime: '19:45', title: 'Interval', description: '', type: 'break', speakerIds: [], location: '', track: '', isBreak: true, order: 2 },
        { id: 's3', date: '2099-08-14', startTime: '19:45', endTime: '20:30', title: 'Hands-on demo', description: '', type: 'session', speakerIds: [], location: 'Hall B', track: '', isBreak: false, order: 3 },
      ],
    },
    organizer: {
      name: 'Aurora Labs', email: 'hello@aurora.invalid', phone: '+91 90000 33333', website: 'https://aurora.invalid',
      logoUrl: 'https://cdn.example.invalid/aurora-org.png',
      social: { facebook: '', instagram: 'https://instagram.com/aurora', linkedin: 'https://linkedin.com/company/aurora', youtube: '', twitter: '', hashtags: ['AuroraLaunch'] },
    },
    support: {
      supportEmail: 'help@aurora.invalid', supportPhone: '+91 90000 44444', faqUrl: 'https://aurora.invalid/faq',
      termsUrl: 'https://aurora.invalid/terms', refundPolicyUrl: 'https://aurora.invalid/refunds', privacyPolicyUrl: 'https://aurora.invalid/privacy',
      refundWindow: { useExternalPolicyUrl: true, fullRefundDaysBefore: null, partialRefundDaysBefore: null, partialRefundPercent: 50, noRefundDaysBefore: null },
    },
    communication: { confirmation: { channels: ['email'], calendarInvite: true, generateQrTicket: true }, reminders: [{ id: 'r1', enabled: true, timing: '1d', channels: ['email'], note: SECRET.reminderNote }] },
    seo: { urlSlug: 'aurora-launch', metaTitle: 'Aurora Launch Night', metaDescription: 'Be first to see Aurora.', shareImageUrl: 'https://cdn.example.invalid/share.jpg', keywords: ['launch', 'aurora'], utmSource: SECRET.utm, utmMedium: SECRET.utm, utmCampaign: SECRET.utm },
    publicPage: { showOrganizerInfo: true, showSpeakers: true, showSponsors: true, showVenueMap: true, showAgenda: true, showGallery: true, showSocialLinks: true, showAttendeeCount: true },
    integrations: { webhookUrl: SECRET.webhook, zapierWebhookUrl: SECRET.webhook, googleAnalyticsId: SECRET.ga, metaPixelId: SECRET.pixel },
    applications: { speaker: { enabled: false, closingDate: '', message: '' }, sponsor: { enabled: false, closingDate: '', message: '' } },
    typeDetails: null, sponsors: [],
    ...over.details,
  }
  const pass = (o: Record<string, unknown>) => ({
    description: '', type: 'paid', unlimited: false, minPurchase: 1, maxPurchase: 5, hideWhenSoldOut: false,
    salesStartDate: '', salesEndDate: '', showRemainingSeats: true, visibility: 'public', featured: false,
    benefits: [], customBenefits: [], raceDetails: null, eventType: 'custom', eventSubtype: '', status: 'active',
    earlyBirdEnabled: false, earlyBirdPrice: null, earlyBirdEndDate: '',
    advancedSettings: { transferable: false, refundable: false, waitlist: false, groupBooking: false, badgePrefix: SECRET.badgePrefix, badgeCategory: SECRET.badgeCategory, couponEligible: true, taxApplicable: true },
    code: SECRET.passCode,
    ...o,
  })
  return {
    slug: 'aurora-launch', uid: 'org-aurora', draftId: 'd-aurora', eventType: 'custom', eventSubtype: null,
    customEventSubtype: 'Product Launch', visibility: 'public',
    pricing: {
      eventType: 'paid', registrationOpenDate: '2026-01-01', registrationEndDate: '2099-08-10', showRemainingSeats: true,
      passes: [
        pass({ id: 'ga', name: 'General Admission', description: 'Standing access', price: 1500, quantity: 200, featured: true,
          earlyBirdEnabled: true, earlyBirdPrice: 999, earlyBirdEndDate: '2099-07-31', maxPurchase: 4,
          benefits: [], customBenefits: ['Welcome drink'],
          advancedSettings: { transferable: true, refundable: true, waitlist: false, groupBooking: false, badgePrefix: SECRET.badgePrefix, badgeCategory: SECRET.badgeCategory, couponEligible: true, taxApplicable: true },
          milestoneAlerts: [{ id: 'm1', threshold: 999999, message: SECRET.milestoneMsg, enabled: true }] }),
        pass({ id: 'vip', name: 'VIP Lounge', description: 'Lounge + meet the founders', price: 5000, quantity: 20 }),
        pass({ id: 'soldout', name: 'Founders Table', price: 9000, quantity: 10 }),
        pass({ id: 'hidden-soldout', name: 'Early Supporters', price: 500, quantity: 10, hideWhenSoldOut: true }),
        pass({ id: 'later', name: 'Late Entry', price: 800, quantity: 50, salesStartDate: '2099-08-12T18:00' }),
        pass({ id: 'invite', name: 'Press Pass', price: 0, quantity: 10, visibility: 'invite_only' }),
        pass({ id: 'off', name: 'Retired Pass', price: 100, quantity: 10, status: 'inactive' }),
      ],
      ...over.pricing,
    },
    eventDetails: details,
    planType: 'paid_event', capacityPlan: 'unlimited', totalCapacity: null,
    registrationForm: { fields: [{ id: 'f1', label: 'Company', type: 'text' }] },
    accessControl: { type: 'invite_code', inviteCode: SECRET.inviteCode, approvedContacts: [SECRET.approvedEmail], confirmationMode: 'auto' },
    lifecycleStatus: 'published', publishedAt: null, updatedAt: null,
    ...over.event,
  } as unknown as PublishedEvent
}

const COUNTER = { totalCount: 57, passCounts: { ga: 37, vip: 0, soldout: 10, 'hidden-soldout': 10, later: 0 } }
const DATA: EventPageData = { counter: COUNTER as never, linkedCampaign: null, exhibitorDirectory: [] }
const propsOf = (ev: PublishedEvent, data: EventPageData = DATA) => buildEventPageProps(ev.slug, ev, data).props
const render  = (p: EventDetailProps) => renderToStaticMarkup(createElement(CustomTemplate, p))

async function publicOutputs(ev: PublishedEvent): Promise<{ props: string; html: string; meta: string; jsonLd: string; ics: string }> {
  h.event = ev
  const p    = propsOf(ev)
  const meta = await page.generateMetadata({ params: Promise.resolve({ slug: ev.slug }) })
  const tree = await page.default({ params: Promise.resolve({ slug: ev.slug }) }) as ReactElement<{ children: ReactElement<{ dangerouslySetInnerHTML?: { __html: string } }>[] }>
  const ld   = tree.props.children.find(c => c?.props?.dangerouslySetInnerHTML)!.props.dangerouslySetInnerHTML!.__html
  const ics  = await (await icsApi.GET(new Request('http://x/api/events/aurora-launch/calendar.ics') as never, { params: Promise.resolve({ slug: ev.slug }) })).text()
  return { props: JSON.stringify(p), html: render(p), meta: JSON.stringify(meta), jsonLd: ld, ics }
}

// ═══ 1 · Fully populated ═════════════════════════════════════════════════════

describe('fully populated Custom Event — every public field is VISIBLE on the page', () => {
  const html = render(propsOf(fullEvent()))
  const t    = text(html)

  it('Event Type step: the organizer’s own event kind is the kicker', () => {
    expect(t).toContain('Product Launch')
  })
  it('Details: name, tagline, short description, rich full description, language, dress code', () => {
    for (const s of ['Aurora Product Launch', 'The first look', 'A one-night reveal of Aurora.', 'The evening', 'Live demo', 'Founder Q&A', 'Smart casual', 'English'])
      expect(t, s).toContain(s)
    expect(html).toContain('<strong class="font-semibold">exclusive</strong>')
    expect(html).toContain('href="https://aurora.invalid/more"')
  })
  it('Media: event logo, cover poster, promo video, EVERY gallery image (9, not the first 6)', () => {
    expect(html).toContain('src="https://cdn.example.invalid/aurora-logo.png"')
    expect(html).toContain('src="https://cdn.example.invalid/aurora-cover.jpg"')
    expect(html).toContain('youtube')
    for (const g of GALLERY) expect(html, g.value).toContain(`src="${g.value}"`)
  })
  it('Venue: name, both address lines, city/state/pincode AND country, instructions, directions, maps', () => {
    for (const s of ['Harbour Pavilion', '1 Marina Walk', 'Gate 3', 'Kochi, Kerala, 682001, India', 'Valet at Gate 3.'])
      expect(t, s).toContain(s)
    expect(html).toContain('href="https://maps.example.invalid/harbour"')
    expect(html).toContain('https://cdn.example.invalid/layout.png')
    expect(html).toContain('https://cdn.example.invalid/parking.png')
  })
  it('Online part of a hybrid event: platform + join instructions, link promised after registration', () => {
    expect(t).toContain('Online via Zoom')
    expect(t).toContain('Stream opens at 6:55 PM.')
    expect(t).toContain('The joining link is shared after you register.')
    expect(t).toContain('In person & online')
  })
  it('hybrid: the registration card names the HALL, not the online platform (it read "Zoom")', () => {
    expect(t).toContain('Harbour Pavilion Kochi · In person & online')
    expect(t).not.toContain('Zoom Kochi · In person & online')
  })
  it('Schedule: date, start–end time, doors open, timezone, registration deadline', () => {
    expect(t).toMatch(/7:00\s*PM\s*–\s*10:00\s*PM/i)
    expect(t).toMatch(/Doors open 6:30\s*PM/i)
    expect(t).toMatch(/Registration closes .*2099/)
  })
  it('Agenda: title, times, description, location, session TYPE and TRACK; break styled, no "Session" noise', () => {
    for (const s of ['Opening keynote', 'Why Aurora.', 'Keynote · Product track · Main stage', 'Interval', 'Hands-on demo', 'Hall B'])
      expect(t, s).toContain(s)
    expect(t).not.toMatch(/Session · Hall B/)
  })
  it('Organizer: name, logo, website, contact, call, social links, hashtags', () => {
    for (const s of ['Hosted by Aurora Labs', '#AuroraLaunch']) expect(t, s).toContain(s)
    for (const href of ['https://aurora.invalid', 'mailto:help@aurora.invalid', 'tel:+91 90000 33333', 'https://instagram.com/aurora', 'https://linkedin.com/company/aurora'])
      expect(html, href).toContain(`href="${href}"`)
    expect(html).toContain('src="https://cdn.example.invalid/aurora-org.png"')
  })
  it('Support & policies: support email / phone, FAQ, terms, privacy, refunds', () => {
    for (const href of ['tel:+91 90000 44444', 'https://aurora.invalid/faq', 'https://aurora.invalid/terms', 'https://aurora.invalid/privacy', 'https://aurora.invalid/refunds'])
      expect(html, href).toContain(`href="${href}"`)
  })
  it('Attendee count (toggle ON) from the confirmed total', () => {
    expect(t).toContain('57 registered')
  })
})

// ═══ 2 · Passes & pricing ════════════════════════════════════════════════════

describe('passes — multiple, with sold-out, hidden, scheduled, invite-only and inactive', () => {
  const p    = propsOf(fullEvent())
  const sold = { ...p, availability: {
    ...p.availability,
    soldout:          { ...p.availability.soldout, status: 'sold_out' as const, remaining: 0 },
    'hidden-soldout': { ...p.availability['hidden-soldout'], status: 'sold_out' as const, remaining: 0 },
  } }
  const html = render(sold)
  const t    = text(html)

  it('on-sale passes: name, description, price, a register link each', () => {
    for (const s of ['General Admission', 'Standing access', 'VIP Lounge', 'Lounge + meet the founders', '₹5,000']) expect(t, s).toContain(s)
    expect(html).toMatch(/href="\/events\/aurora-launch\/register\?[^"]*vip/)
  })
  it('early bird: the effective price, the regular price struck through and when it ends', () => {
    expect(t).toContain('₹999')
    expect(html).toMatch(/<s class="tabular-nums">₹1,500<\/s>/)
    expect(t).toMatch(/Early bird until 31 Jul 2099/)
  })
  it('booking limit and policy flags from the pass builder', () => {
    for (const s of ['Up to 4 entries per booking', 'Entry is transferable', 'Entry is refundable', 'Welcome drink']) expect(t, s).toContain(s)
  })
  it('remaining seats when shown', () => {
    expect(t).toMatch(/\d+ places left/)
  })
  it('sold out shown as Sold out; a sold-out pass set to hide is hidden; a scheduled pass says when it opens', () => {
    expect(t).toContain('Founders Table')
    expect(t).toContain('Sold out')
    expect(t).not.toContain('Early Supporters')
    expect(t).toContain('Late Entry')
    expect(t).toMatch(/Opens 12 Aug 2099, 6:00\s*PM/i)
  })
  it('invite-only and inactive passes never appear', () => {
    expect(t).not.toContain('Press Pass')
    expect(t).not.toContain('Retired Pass')
  })
  it('"From ₹…" uses only passes on sale (₹999 early bird), never the hidden sold-out ₹500', () => {
    expect(t).toContain('From ₹999')
    expect(t).not.toContain('From ₹500')
  })
  it('event-level "Show remaining seats" OFF hides seat counts on every pass', () => {
    const off = text(render(propsOf(fullEvent({ pricing: { showRemainingSeats: false } }))))
    expect(off).not.toMatch(/places left/)
  })
})

// ═══ 3 · Toggles, partial and legacy events, venue modes ═════════════════════

describe('visibility toggles and conditional sections', () => {
  it('Show attendee count OFF → no count', () => {
    const t = text(render(propsOf(fullEvent({ details: { publicPage: { showAttendeeCount: false } } }))))
    expect(t).not.toMatch(/\d+ registered/)
  })
  it('Show agenda / gallery / venue map OFF → those sections are gone, the rest stays', () => {
    const html = render(propsOf(fullEvent({ details: { publicPage: { showAgenda: false, showGallery: false, showVenueMap: false } } })))
    expect(html).not.toContain('Opening keynote')
    expect(html).not.toContain('g1.jpg')
    expect(html).not.toContain('layout.png')
    expect(html).toContain('Harbour Pavilion')
  })
  it('Show organizer info OFF → no organizer identity, contact or socials; support stays', () => {
    const html = render(propsOf(fullEvent({ details: { publicPage: { showOrganizerInfo: false } } })))
    for (const gone of ['Aurora Labs', 'aurora-org.png', 'instagram.com', '#AuroraLaunch', 'tel:+91 90000 33333']) expect(html, gone).not.toContain(gone)
    expect(html).toContain('tel:+91 90000 44444')
  })
  it('registration not open yet → the opening date; no closing-date row', () => {
    const t = text(render(propsOf(fullEvent({ pricing: { registrationOpenDate: '2099-07-01' } }))))
    expect(t).toMatch(/Registration opens on 1 Jul 2099/)
    expect(t).not.toMatch(/Registration closes/)
  })
})

describe('partially populated event — only what was entered, no empty shells', () => {
  const partial = fullEvent({
    details: {
      info: { name: 'Small Meetup', tagline: '', shortDesc: '', fullDesc: '', language: '', dressCode: '' },
      media: { logo: { value: '' }, coverBanner: { value: '' }, galleryImages: [], promoVideoUrl: '' },
      venue: { type: 'physical', physical: { name: '', addressLine1: '', addressLine2: '', city: 'Pune', state: '', country: '', pincode: '', mapsLink: '', instructions: '', maps: { layoutImageUrl: '', parkingMapUrl: '', entryGateMapUrl: '' } } },
      schedule: { timezone: '', startDate: '2099-09-01', startTime: '', endDate: '', endTime: '', doorsOpenTime: '', agenda: [] },
      organizer: { name: '', email: '', phone: '', website: '', logoUrl: '', social: { facebook: '', instagram: '', linkedin: '', youtube: '', twitter: '', hashtags: [] } },
      support: {}, publicPage: {},
    },
    pricing: { registrationOpenDate: '', registrationEndDate: '' },
    event: { customEventSubtype: null },
  })
  const html = render(propsOf(partial, { counter: null, linkedCampaign: null, exhibitorDirectory: [] }))
  const t    = text(html)
  it('renders what exists', () => {
    expect(t).toContain('Small Meetup')
    expect(t).toContain('Pune')
    expect(t).toContain('General Admission')
  })
  it('no undefined / null / NaN, no empty sections', () => {
    expect(t).not.toMatch(/\bundefined\b|\bnull\b|NaN/)
    for (const gone of ['About the event', 'How the day unfolds', 'Moments', 'Hosted by', 'A glimpse of the event', 'Registration closes', '57 registered'])
      expect(t, gone).not.toContain(gone)
  })
})

describe('legacy / older events — no resubmission needed', () => {
  it('older description / cover / logo field names render (the publish checklist already accepted them)', () => {
    const legacy = fullEvent({ details: {
      info: { name: 'Legacy Gala', description: 'A legacy description that predates fullDesc.', coverImage: 'https://cdn.example.invalid/legacy-cover.jpg', logoUrl: 'https://cdn.example.invalid/legacy-logo.png' },
      media: { galleryImages: [] },
    } })
    const p = propsOf(legacy)
    expect(p.description).toBe('A legacy description that predates fullDesc.')
    const html = render(p)
    expect(text(html)).toContain('A legacy description that predates fullDesc.')
    expect(html).toContain('src="https://cdn.example.invalid/legacy-cover.jpg"')
    expect(html).toContain('src="https://cdn.example.invalid/legacy-logo.png"')
  })
  it('the CURRENT names always win over a legacy value', () => {
    const both = fullEvent({ details: { info: { name: 'X', fullDesc: 'Current text', description: 'Old text' } } })
    expect(propsOf(both).description).toBe('Current text')
  })
  it('events saved without the newer optional fields still render (no country, track, early bird, registration dates)', () => {
    const old = fullEvent({ pricing: { registrationOpenDate: undefined, registrationEndDate: undefined, showRemainingSeats: undefined } })
    const t = text(render(propsOf(old)))
    expect(t).toContain('General Admission')
    expect(t).not.toContain('Registration closes')
    expect(t).toMatch(/places left/)                                     // absent switch ⇒ unchanged behaviour
  })
})

describe('venue modes', () => {
  it('in person only → no online block', () => {
    const t = text(render(propsOf(fullEvent({ details: { venue: { type: 'physical', physical: { name: 'Hall A', city: 'Goa', country: 'India' }, online: { platform: 'zoom', meetingUrl: SECRET.meetingUrl } } } }))))
    expect(t).toContain('Hall A')
    expect(t).not.toContain('Online via')
  })
  it('online only → platform, no address, no map', () => {
    const html = render(propsOf(fullEvent({ details: { venue: { type: 'online', online: { platform: 'google_meet', meetingUrl: SECRET.meetingUrl, revealAfterRegistration: true, joinInstructions: '' } } } })))
    expect(text(html)).toContain('Online via Google Meet')
    expect(text(html)).toContain('Online event')
    expect(html).not.toContain('maps.google.com')
  })
})

// ═══ 4 · Privacy: nothing private in any public output ═══════════════════════

describe('private values appear in NO public output (props, HTML, metadata, JSON-LD, calendar file)', () => {
  beforeEach(() => { h.event = null })

  it('the full event', async () => {
    const out = await publicOutputs(fullEvent())
    for (const [where, body] of Object.entries(out))
      for (const [name, secret] of Object.entries(SECRET))
        expect(body.includes(secret), `${name} leaked into ${where}`).toBe(false)
  })

  it('pass objects carry only public fields', () => {
    const p = propsOf(fullEvent())
    const keys = new Set(p.passes.flatMap(x => Object.keys(x)))
    for (const k of ['code', 'milestoneAlerts', 'eventType', 'eventSubtype', 'minPurchase', 'type']) expect(keys.has(k), k).toBe(false)
    expect(Object.keys(p.passes[0].advancedSettings ?? {}).sort()).toEqual(['groupBooking', 'refundable', 'transferable', 'waitlist'])
  })

  it('metadata and JSON-LD still carry the public SEO fields', async () => {
    const out = await publicOutputs(fullEvent())
    expect(out.meta).toContain('Aurora Launch Night')
    expect(out.meta).toContain('Be first to see Aurora.')
    expect(out.meta).toContain('https://cdn.example.invalid/share.jpg')
    expect(out.jsonLd).toContain('"@type":"Event"')
    expect(out.jsonLd).toContain('General Admission')
  })

  it('calendar.ics: plain-text description, platform NAME, hybrid keeps the address', async () => {
    const raw = (await publicOutputs(fullEvent({ details: { info: { name: 'Aurora', shortDesc: '', fullDesc: '**Bold** launch' } } }))).ics
    // RFC 5545: lines are folded at 75 octets and commas are escaped — unfold before matching.
    const ics = raw.replace(/\r?\n[ \t]/g, '').replace(/\\,/g, ',')
    expect(ics).toContain('Bold launch')
    expect(ics).not.toContain('**')
    expect(ics).toContain('Harbour Pavilion')
    expect(ics).toContain('also online via Zoom')
    expect(ics).not.toMatch(/\bzoom\b \(Online\)/)
  })
})
