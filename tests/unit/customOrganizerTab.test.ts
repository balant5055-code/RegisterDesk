// RD-CUSTOM-ORG-01 · Custom Event — every Organizer-tab field, from the saved event to the public page.
//
// The Organizer tab (components/wizard/EventDetailsBuilder.tsx → Tab3Organizer) writes 17 fields:
//
//   eventDetails.organizer   name · email · phone · website · logoUrl
//                            social.{facebook, instagram, linkedin, youtube, twitter} · social.hashtags
//   eventDetails.support     supportEmail · supportPhone · faqUrl · termsUrl · refundPolicyUrl
//                            · privacyPolicyUrl · refundWindow{useExternalPolicyUrl, full/partial/no-refund days}
//
// Publish copies eventDetails verbatim onto events/{slug}; buildEventPageProps (shared by the public
// page and the Super Admin preview) projects it; the Custom template renders it. Each test below
// starts from the saved DOCUMENT and asserts on the rendered HTML (or the page's JSON-LD).
//
//   PUBLIC, always (no toggle)          support email · support phone · FAQ · terms · privacy · refunds
//   PUBLIC, "Show organizer info"       name (block title + hero "Presented by") · logo · website
//                                       · Contact (support email → organizer email → organizer phone)
//                                       · organizer phone as its own Call action          ← was missing
//   PUBLIC, + "Show social links"       the five social links · event hashtags             ← hashtags were missing
//   CONDITIONAL, refund toggle          structured window ON → its rules replace the policy link;
//                                       OFF → the Refund Policy URL
//   JSON-LD organizer                   follows "Show organizer info"                      ← ignored it
//   NOT DISPLAYED (by design)           organizer email when a Support Email exists — the one canonical
//                                       Contact target is the support address (contactModel); it is an
//                                       attendee-facing field, not a secret
//
// Nothing in the Organizer tab is private platform data: the organizer's PRIVATE account email /
// mobile live in /users/{uid} (lib/organizer/recipients.ts) and are never read by the public page.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ReactNode, type ReactElement } from 'react'

const h = vi.hoisted(() => ({ event: null as unknown }))

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
vi.mock('next/navigation', () => ({ usePathname: () => '/events/org-tab', useRouter: () => ({ push: () => {} }) }))
vi.mock('@/components/event-templates/EventDetailsFramework', () => ({
  EventDetailsFramework: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/lib/events/publicEventAccess', () => ({ findPublicEvent: async () => h.event }))
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

import { buildEventPageProps } from '@/lib/events/eventPageProps'
import { CustomTemplate } from '@/components/event-templates/custom/CustomTemplate'
import type { PublishedEvent } from '@/lib/firebase/firestore/events'

const { default: EventPage } = await import('@/app/events/[slug]/page')

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ')

const ORGANIZER = {
  name: 'Lotus Arts Trust', email: 'hello@lotus.invalid', phone: '+91 98000 11111', website: 'https://lotus.invalid',
  logoUrl: 'https://cdn.example.invalid/lotus-logo.png',
  social: {
    facebook: 'https://facebook.com/lotus', instagram: 'https://instagram.com/lotus', linkedin: 'https://linkedin.com/company/lotus',
    youtube: 'https://youtube.com/@lotus', twitter: 'https://twitter.com/lotus', hashtags: ['LotusFest', '#Chennai2099'],
  },
}
const SUPPORT = {
  supportEmail: 'tickets@lotus.invalid', supportPhone: '+91 98000 22222',
  faqUrl: 'https://lotus.invalid/faq', termsUrl: 'https://lotus.invalid/terms',
  refundPolicyUrl: 'https://lotus.invalid/refunds', privacyPolicyUrl: 'https://lotus.invalid/privacy',
  refundWindow: { useExternalPolicyUrl: true, fullRefundDaysBefore: null, partialRefundDaysBefore: null, partialRefundPercent: 50, noRefundDaysBefore: null },
}

type Over = { organizer?: Record<string, unknown>; support?: Record<string, unknown>; publicPage?: Record<string, unknown> }

function saved(over: Over = {}, lifecycleStatus = 'published'): PublishedEvent {
  return {
    slug: 'org-tab', uid: 'o', draftId: 'd', eventType: 'custom', eventSubtype: null, customEventSubtype: 'Recital', visibility: 'public',
    pricing: { eventType: 'free', passes: [{ id: 'p', name: 'Entry', description: '', price: 0, quantity: 50, unlimited: false, status: 'active', visibility: 'public' }] },
    eventDetails: {
      info: { name: 'Evening Recital', shortDesc: 'An evening of music.', fullDesc: '' },
      media: { coverBanner: { value: '' }, logo: { value: '' }, galleryImages: [] },
      schedule: { startDate: '2099-03-01', startTime: '18:00', endDate: '2099-03-01', endTime: '20:00', timezone: 'Asia/Kolkata', agenda: [] },
      venue: { type: 'physical', physical: { name: 'Music Hall', city: 'Chennai' } },
      organizer: { ...ORGANIZER, ...over.organizer },
      support:   { ...SUPPORT,   ...over.support },
      publicPage: { ...over.publicPage },
      typeDetails: null, seo: {},
    },
    planType: 'free_event', capacityPlan: 'free' as never, totalCapacity: null,
    registrationForm: null, accessControl: null, lifecycleStatus: lifecycleStatus as never, publishedAt: null, updatedAt: null,
  } as PublishedEvent
}

const DATA = { counter: null, linkedCampaign: null, exhibitorDirectory: [] }
const render = (ev: PublishedEvent) => renderToStaticMarkup(createElement(CustomTemplate, buildEventPageProps(ev.slug, ev, DATA).props))

async function jsonLd(ev: PublishedEvent): Promise<Record<string, unknown>> {
  h.event = ev
  const tree = await EventPage({ params: Promise.resolve({ slug: ev.slug }) }) as ReactElement<{ children: ReactElement<{ dangerouslySetInnerHTML?: { __html: string } }>[] }>
  const script = tree.props.children.find(c => c?.props?.dangerouslySetInnerHTML)!
  return JSON.parse(script.props.dangerouslySetInnerHTML!.__html)
}

describe('saved → projected: every Organizer-tab field reaches the template props unchanged', () => {
  it('organizer + support objects and every support field', () => {
    const p = buildEventPageProps('org-tab', saved(), DATA).props
    expect(p.organizer).toEqual(ORGANIZER)
    expect(p).toMatchObject({
      supportEmail: SUPPORT.supportEmail, supportPhone: SUPPORT.supportPhone, faqUrl: SUPPORT.faqUrl,
      termsUrl: SUPPORT.termsUrl, refundPolicyUrl: SUPPORT.refundPolicyUrl, privacyPolicyUrl: SUPPORT.privacyPolicyUrl,
      refundWindow: SUPPORT.refundWindow, showOrg: true, showSocial: true,
    })
  })

  it('review-pending: the admin preview carries the same fields as the published page', () => {
    const preview = buildEventPageProps('org-tab', saved({}, 'pending_review'), DATA, { displayLifecycle: 'published' }).props
    expect(preview).toEqual(buildEventPageProps('org-tab', saved(), DATA).props)
  })
})

describe('rendered — all toggles on (the defaults)', () => {
  const html = render(saved())
  const t = text(html)

  it('organizer name: block title and hero "Presented by"', () => {
    expect(t).toContain('Hosted by Lotus Arts Trust')
    expect(t).toContain('Presented by Lotus Arts Trust')
  })
  it('organizer logo and website', () => {
    expect(html).toContain('src="https://cdn.example.invalid/lotus-logo.png"')
    expect(html).toContain('href="https://lotus.invalid"')
  })
  it('Contact goes to the Support Email (the canonical target); the organizer email is not displayed then', () => {
    expect(html).toContain('href="mailto:tickets@lotus.invalid"')
    expect(html).not.toContain('hello@lotus.invalid')
  })
  it('organizer phone: its own Call action (it never appeared before)', () => {
    expect(html).toContain('href="tel:+91 98000 11111"')
    expect(html).toContain('aria-label="Call Lotus Arts Trust on +91 98000 11111"')
  })
  it('all five social links', () => {
    for (const url of Object.values(ORGANIZER.social).filter((v): v is string => typeof v === 'string'))
      expect(html, url).toContain(`href="${url}"`)
  })
  it('event hashtags, each once with a single # (they were never rendered)', () => {
    expect(t).toContain('#LotusFest')
    expect(t).toContain('#Chennai2099')
    expect(t).not.toContain('##Chennai2099')
  })
  it('support email, support phone, FAQ, terms, privacy, refund policy link', () => {
    for (const href of ['mailto:tickets@lotus.invalid', 'tel:+91 98000 22222', SUPPORT.faqUrl, SUPPORT.termsUrl, SUPPORT.privacyPolicyUrl, SUPPORT.refundPolicyUrl])
      expect(html, href).toContain(`href="${href}"`)
  })
})

describe('rendered — the toggles', () => {
  it('"Show organizer info" OFF hides every organizer field but keeps the support section', () => {
    const html = render(saved({ publicPage: { showOrganizerInfo: false } }))
    const t = text(html)
    for (const gone of ['Hosted by', 'Presented by', 'lotus-logo.png', 'href="https://lotus.invalid"', 'tel:+91 98000 11111', 'instagram.com', '#LotusFest'])
      expect(html.includes(gone) || t.includes(gone), gone).toBe(false)
    for (const kept of ['mailto:tickets@lotus.invalid', 'tel:+91 98000 22222', SUPPORT.termsUrl, SUPPORT.faqUrl])
      expect(html, kept).toContain(kept)
  })

  it('"Show social links" OFF hides the links AND the hashtags; the organizer block stays', () => {
    const html = render(saved({ publicPage: { showSocialLinks: false } }))
    expect(html).not.toMatch(/facebook\.com|instagram\.com|linkedin\.com|youtube\.com|twitter\.com/)
    expect(text(html)).not.toContain('#LotusFest')
    expect(text(html)).toContain('Hosted by Lotus Arts Trust')
  })

  it('structured refund window ON → its rules replace the policy link; OFF → the link', () => {
    const on = text(render(saved({ support: { refundWindow: { useExternalPolicyUrl: false, fullRefundDaysBefore: 7, partialRefundDaysBefore: 3, partialRefundPercent: 50, noRefundDaysBefore: 1 } } })))
    expect(on).toContain('Full refund up to 7 days before')
    expect(on).toContain('50% refund up to 3 days before')
    expect(on).toContain('No refund within 1 day of the event')
    expect(on).not.toContain('Read the refund policy')
    expect(text(render(saved()))).toContain('Read the refund policy')
  })
})

describe('rendered — contact fallbacks and empty fields', () => {
  it('no Support Email → Contact uses the organizer email', () => {
    expect(render(saved({ support: { supportEmail: '' } }))).toContain('href="mailto:hello@lotus.invalid"')
  })
  it('no emails at all → Contact dials the organizer phone, and no duplicate Call action', () => {
    const html = render(saved({ organizer: { email: '' }, support: { supportEmail: '' } }))
    expect(html.match(/href="tel:\+91 98000 11111"/g)).toHaveLength(1)
    expect(html).not.toContain('aria-label="Call Lotus Arts Trust')
  })
  it('organizer phone equal to the support phone → listed once, under Good to know', () => {
    const html = render(saved({ organizer: { phone: SUPPORT.supportPhone } }))
    expect(html.match(/href="tel:\+91 98000 22222"/g)).toHaveLength(1)
  })
  it('every optional field empty → no empty actions, links or hashtag line', () => {
    const html = render(saved({
      organizer: { phone: '', website: '', logoUrl: '', social: { facebook: '', instagram: '', linkedin: '', youtube: '', twitter: '', hashtags: [] } },
      support: { supportEmail: '', supportPhone: '', faqUrl: '', termsUrl: '', refundPolicyUrl: '', privacyPolicyUrl: '' },
    }))
    const t = text(html)
    expect(t).toContain('Hosted by Lotus Arts Trust')
    expect(html).toContain('href="mailto:hello@lotus.invalid"')             // the required organizer email
    for (const gone of ['tel:', 'Website', '#', 'Read the'])
      expect(t.includes(gone) || html.includes(`href="${gone}`), gone).toBe(false)
    // "Good to know" stays for the timezone, but holds no support rows
    expect(t).toContain('Good to know')
    for (const row of [' Email ', ' Phone ', ' Terms ', ' Privacy ', ' FAQ ', ' Refunds ']) expect(t, row).not.toContain(row)
  })
})

describe('JSON-LD follows "Show organizer info"', () => {
  beforeEach(() => { h.event = null })
  it('on → Organization with the organizer name and email', async () => {
    expect((await jsonLd(saved())).organizer).toEqual({ '@type': 'Organization', name: 'Lotus Arts Trust', email: 'hello@lotus.invalid' })
  })
  it('off → no organizer in the structured data at all', async () => {
    const ld = await jsonLd(saved({ publicPage: { showOrganizerInfo: false } }))
    expect(ld.organizer).toBeUndefined()
    expect(JSON.stringify(ld)).not.toMatch(/Lotus Arts Trust|hello@lotus\.invalid/)
  })
})
