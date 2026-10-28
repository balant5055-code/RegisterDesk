// RD-CUSTOM-AUDIT-03 · visibility settings enforced on the PUBLIC page — counts, seats, organizer,
// registration instructions — rendered through the real templates and checked in the page data.
//
//   • registration counts: zeroed in the page data unless "Show attendee count" is on (they were
//     sent on every event); seats left withheld when remaining seats are hidden (capacity −
//     remaining = the count), and "low" no longer prints a hidden number
//   • "Show organizer info" OFF hides the organizer on EVERY template: the shared hero's
//     "Hosted by" (Meetup / Team Sports / composed), Community's partner / volunteer contact
//     cards, the Sports cover caption and Sports' contact fallback — the Support Email stays
//   • Access Control: an invite code / approved list / manual approval is TOLD to the attendee
//     on the Custom page (mode only — never the code or the list)
//   • a promo video on a host that cannot be embedded becomes a plain link instead of vanishing

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/events/vis', useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}))

import { buildEventPageProps, publicAvailability, type EventPageData } from '@/lib/events/eventPageProps'
import { TemplateRouter } from '@/components/event-templates/TemplateRouter'
import type { PublishedEvent } from '@/lib/firebase/firestore/events'
import type { PassAvailability } from '@/lib/registrations/types'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')

const ORG = { name: 'Riverbank Collective', email: 'org-private@riverbank.invalid', phone: '+91 91111 22222', website: 'https://riverbank.invalid', logoUrl: '', social: { facebook: '', instagram: '', linkedin: '', youtube: '', twitter: '', hashtags: [] }, verified: true }

function event(eventType: string, eventSubtype: string | null, over: { publicPage?: Record<string, unknown>; pricing?: Record<string, unknown>; accessControl?: unknown; registrationForm?: unknown; typeDetails?: unknown; media?: Record<string, unknown> } = {}): PublishedEvent {
  return {
    slug: 'vis', uid: 'o', draftId: 'd', eventType, eventSubtype, visibility: 'public',
    pricing: {
      eventType: 'paid', showRemainingSeats: true,
      passes: [
        { id: 'a', name: 'Standard', description: '', price: 400, quantity: 100, unlimited: false, status: 'active', visibility: 'public', showRemainingSeats: true },
        { id: 'b', name: 'Quiet', description: '', price: 900, quantity: 10, unlimited: false, status: 'active', visibility: 'public', showRemainingSeats: false },
      ],
      ...over.pricing,
    },
    eventDetails: {
      info: { name: 'Riverbank Day', shortDesc: 'A day by the river.', fullDesc: 'Join us by the river.' },
      media: { coverBanner: { value: '' }, logo: { value: '' }, galleryImages: [], promoVideoUrl: '', ...over.media },
      schedule: { startDate: '2099-04-04', startTime: '09:00', endDate: '2099-04-04', endTime: '17:00', timezone: 'Asia/Kolkata', agenda: [] },
      venue: { type: 'physical', physical: { name: 'Riverbank Lawn', city: 'Pune' } },
      organizer: ORG,
      support: { supportEmail: 'support@riverbank.invalid', termsUrl: 'https://riverbank.invalid/terms' },
      publicPage: { ...over.publicPage },
      typeDetails: over.typeDetails ?? null, seo: {},
    },
    planType: 'paid_event', capacityPlan: 'unlimited' as never, totalCapacity: null,
    registrationForm: (over.registrationForm ?? null) as never, accessControl: (over.accessControl ?? null) as never,
    lifecycleStatus: 'published' as never, publishedAt: null, updatedAt: null,
  } as PublishedEvent
}

// 93 of 100 and 8 of 10 sold → both 'low'-ish; event total 101
const COUNTER = { totalCount: 101, passCounts: { a: 93, b: 8 } }
const DATA: EventPageData = { counter: COUNTER as never, linkedCampaign: null, exhibitorDirectory: [] }
const props = (ev: PublishedEvent) => buildEventPageProps('vis', ev, DATA).props
const page  = (ev: PublishedEvent) => renderToStaticMarkup(createElement(TemplateRouter, props(ev)))

// ═══ Registration counts and seats ═══════════════════════════════════════════

describe('registration counts and seats in the page data', () => {
  it('"Show attendee count" OFF (default) → no confirmed counts anywhere in the page data', () => {
    const p = props(event('custom', null))
    for (const a of Object.values(p.availability)) { expect(a.passCount).toBe(0); expect(a.eventTotalCount).toBe(0) }
    expect(JSON.stringify(p)).not.toMatch(/"(passCount|eventTotalCount)":(101|93|8)\b/)
  })

  it('ON → the event total is available, and the Custom page shows it', () => {
    const ev = event('custom', null, { publicPage: { showAttendeeCount: true } })
    expect(Object.values(props(ev).availability)[0].eventTotalCount).toBe(101)
    expect(text(page(ev))).toContain('101 registered')
  })

  it('a pass whose remaining seats are hidden carries no seat number and no "low" status', () => {
    const p = props(event('custom', null))
    expect(p.availability.a.remaining).toBe(7)                         // shown pass: exact seats kept
    expect(p.availability.b).toMatchObject({ remaining: null, status: 'available' })
    expect(text(page(event('custom', null)))).not.toMatch(/\b2 places left/)
  })

  it('event-level "Show remaining seats" OFF → no pass carries a seat number', () => {
    const p = props(event('custom', null, { pricing: { showRemainingSeats: false } }))
    expect(Object.values(p.availability).every(a => a.remaining === null)).toBe(true)
  })

  it('"Sold out" always survives — it decides whether a pass can be bought', () => {
    const raw: Record<string, PassAvailability> = { b: { passId: 'b', passCapacity: 10, passCount: 10, eventCapacity: null, eventTotalCount: 10, remaining: 0, status: 'sold_out' } }
    expect(publicAvailability(raw, [{ id: 'b', name: 'Quiet', description: '', price: 1, quantity: 10, unlimited: false, showRemainingSeats: false }], false).b)
      .toMatchObject({ status: 'sold_out', remaining: null, passCount: 0 })
  })

  for (const [type, sub] of [['conference', null], ['community', null], ['sports', 'marathon'], ['meetup', null], ['fundraising', null]] as const) {
    it(`${type}${sub ? `/${sub}` : ''}: renders with hidden seats (no "null left", no hidden number)`, () => {
      const t = text(page(event(type, sub)))
      expect(t).not.toMatch(/null (left|seats|remaining)|Only\s+left/)
      expect(t).not.toMatch(/\b2 (left|seats left|places left|spots left)/)
    })
  }
})

// ═══ "Show organizer info" on every template ═════════════════════════════════

describe('"Show organizer info" — on and off, per affected template', () => {
  const OFF = { publicPage: { showOrganizerInfo: false } }

  it('shared hero (Meetup / composed): "Hosted by" + verified only when ON', () => {
    expect(text(page(event('meetup', null)))).toContain('Hosted by Riverbank Collective')
    const off = text(page(event('meetup', null, OFF)))
    expect(off).not.toContain('Hosted by')
    expect(off).not.toContain('Riverbank Collective')
  })

  it('Team Sports (composed hero): same rule', () => {
    expect(text(page(event('sports', 'football')))).toContain('Riverbank Collective')
    expect(text(page(event('sports', 'football', OFF)))).not.toContain('Riverbank Collective')
  })

  it('Community: the partner / volunteer cards use the organizer email only when ON', () => {
    const td = { volunteerInstructions: 'Help us set up the lawn.', impactGoal: 'Clean river' }
    const on = page(event('community', null, { typeDetails: td }))
    expect(on).toContain('mailto:org-private@riverbank.invalid?subject=Partnership%20Enquiry')
    const off = page(event('community', null, { typeDetails: td, ...OFF }))
    expect(off).not.toContain('org-private@riverbank.invalid')
    expect(off).not.toContain('Become a Sponsor')
    expect(text(off)).toContain('Give Your Time')                          // the volunteer path itself stays
  })

  it('Sports (running): the cover caption and the contact fallback only when ON; Support Email stays', () => {
    const on = page(event('sports', 'marathon'))
    expect(text(on)).toContain('Riverbank Collective')
    const off = page(event('sports', 'marathon', OFF))
    expect(off).not.toContain('Riverbank Collective')
    expect(off).not.toContain('org-private@riverbank.invalid')
    expect(off).not.toContain('+91 91111 22222')
    expect(off).toContain('support@riverbank.invalid')
  })

  it('Custom: unchanged rule (covered in customOrganizerTab) — sanity check', () => {
    expect(page(event('custom', null, OFF))).not.toContain('Riverbank Collective')
  })
})

// ═══ Access Control told to the attendee (Custom) ════════════════════════════

describe('Custom: how registration works', () => {
  it('open + auto confirm → no note', () => {
    expect(text(page(event('custom', null)))).not.toMatch(/invite code|organizer approves|invited guests/i)
  })
  it('invite code → told, never the code itself', () => {
    const html = page(event('custom', null, { accessControl: { type: 'invite_code', inviteCode: { code: 'SECRET-INV-55' }, confirmationMode: 'auto' } }))
    expect(text(html)).toContain('An invite code from the organizer is required to register.')
    expect(html).not.toContain('SECRET-INV-55')
    expect(JSON.stringify(props(event('custom', null, { accessControl: { type: 'invite_code', inviteCode: { code: 'SECRET-INV-55' } } })))).not.toContain('SECRET-INV-55')
  })
  it('approved contacts → told, never the list', () => {
    const ev = event('custom', null, { accessControl: { type: 'approved_contacts', approvedContacts: ['guest-private@x.invalid'] } })
    expect(text(page(ev))).toContain('invited guests on the organizer’s list')
    expect(page(ev) + JSON.stringify(props(ev))).not.toContain('guest-private@x.invalid')
  })
  it('manual approval: from Access Control, else from the form’s approval rule', () => {
    expect(text(page(event('custom', null, { accessControl: { type: 'open', confirmationMode: 'manual' } })))).toContain('confirmed once the organizer approves them')
    expect(text(page(event('custom', null, { registrationForm: { registrationRules: { approvalMode: 'manual' } } })))).toContain('confirmed once the organizer approves them')
    // Access Control wins over a stale form rule (the submit route's precedence)
    expect(text(page(event('custom', null, { accessControl: { confirmationMode: 'auto' }, registrationForm: { registrationRules: { approvalMode: 'manual' } } })))).not.toContain('organizer approves')
  })
})

// ═══ Promo video fallback ════════════════════════════════════════════════════

describe('Custom: promo video', () => {
  it('an embeddable link is embedded; any other http(s) link becomes "Watch the video"; junk shows nothing', () => {
    expect(page(event('custom', null, { media: { promoVideoUrl: 'https://youtu.be/dQw4w9WgXcQ' } }))).toContain('<iframe')
    const other = page(event('custom', null, { media: { promoVideoUrl: 'https://videos.example.invalid/launch.mp4' } }))
    expect(other).toContain('href="https://videos.example.invalid/launch.mp4"')
    expect(text(other)).toContain('Watch the video')
    expect(page(event('custom', null, { media: { promoVideoUrl: 'javascript:alert(1)' } }))).not.toContain('javascript:')
  })
})
