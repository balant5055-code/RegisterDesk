// RD-CUSTOM-PUBLIC-01 · /events/[slug] — social-preview metadata and JSON-LD, for EVERY event type.
//
//   • the SEO tab's "Social Share Image" is the link-preview image when set (it was saved and then
//     ignored: previews always took the cover banner); cover → logo remain the fallbacks
//   • a meeting link the organizer reveals only after registration never reaches the JSON-LD
//     (it was printed into the page's structured data in clear text)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactElement } from 'react'

const h = vi.hoisted(() => ({ event: null as unknown }))

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
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

const { generateMetadata, default: EventPage } = await import('@/app/events/[slug]/page')

const ZOOM = 'https://zoom.us/j/987?pwd=HIDDEN'

function event(eventType: string, over: { seo?: Record<string, unknown>; online?: Record<string, unknown>; venueType?: string } = {}) {
  return {
    slug: 'ev', uid: 'o', draftId: 'd', eventType, eventSubtype: null, visibility: 'public',
    pricing: { eventType: 'free', passes: [] },
    eventDetails: {
      info: { name: 'Ev', shortDesc: 'Short' },
      media: { coverBanner: { value: 'https://cdn.example.invalid/cover.jpg' }, logo: { value: 'https://cdn.example.invalid/logo.png' } },
      schedule: { startDate: '2099-01-01', startTime: '10:00' },
      venue: {
        type: over.venueType ?? 'online',
        online: { platform: 'zoom', meetingUrl: ZOOM, meetingId: '987', passcode: 'PASS-777', revealAfterRegistration: true, joinInstructions: '', ...over.online },
      },
      seo: { metaTitle: '', metaDescription: '', keywords: [], ...over.seo },
    },
    lifecycleStatus: 'published', planType: 'free_event', capacityPlan: 'free', totalCapacity: null,
    registrationForm: null, accessControl: null, publishedAt: null, updatedAt: null,
  }
}

const params = Promise.resolve({ slug: 'ev' })
const ogImage = async () => {
  const md = await generateMetadata({ params })
  return { og: (md.openGraph?.images as { url: string }[])[0]?.url, tw: (md.twitter?.images as string[])[0] }
}
async function jsonLd(): Promise<Record<string, unknown>> {
  const tree = await EventPage({ params }) as ReactElement<{ children: ReactElement<{ dangerouslySetInnerHTML?: { __html: string } }>[] }>
  const script = tree.props.children.find(c => c?.props?.dangerouslySetInnerHTML)!
  return JSON.parse(script.props.dangerouslySetInnerHTML!.__html)
}

const TYPES = ['custom', 'conference', 'workshop', 'sports', 'community', 'meetup', 'fundraising']

describe('social preview image', () => {
  beforeEach(() => { h.event = null })

  for (const type of TYPES) {
    it(`${type}: the organizer's share image wins`, async () => {
      h.event = event(type, { seo: { shareImageUrl: 'https://cdn.example.invalid/share.jpg' } })
      expect(await ogImage()).toEqual({ og: 'https://cdn.example.invalid/share.jpg', tw: 'https://cdn.example.invalid/share.jpg' })
    })
  }

  it('unset / blank / not a web URL → the cover banner, then the logo (unchanged fallbacks)', async () => {
    for (const shareImageUrl of [undefined, '', '   ', 'javascript:alert(1)', 'data:image/png;base64,AAA']) {
      h.event = event('custom', { seo: { shareImageUrl } })
      expect((await ogImage()).og, String(shareImageUrl)).toBe('https://cdn.example.invalid/cover.jpg')
    }
    const noCover = event('custom') as { eventDetails: { media: { coverBanner: { value: string } } } }
    noCover.eventDetails.media.coverBanner.value = ''
    h.event = noCover
    expect((await ogImage()).og).toBe('https://cdn.example.invalid/logo.png')
  })
})

describe('JSON-LD never prints a private meeting link', () => {
  for (const type of TYPES) {
    it(`${type}: reveal-after-registration → the event page URL, no link / passcode`, async () => {
      h.event = event(type)
      const ld = await jsonLd()
      expect(ld.location).toEqual({ '@type': 'VirtualLocation', url: expect.stringMatching(/\/events\/ev$/) })
      expect(JSON.stringify(ld)).not.toMatch(/zoom\.us|HIDDEN/)
    })
  }

  it('a link the organizer made public is still the VirtualLocation url', async () => {
    h.event = event('custom', { online: { revealAfterRegistration: false } })
    expect((await jsonLd()).location).toEqual({ '@type': 'VirtualLocation', url: ZOOM })
    expect(JSON.stringify(await jsonLd())).not.toContain('PASS-777')   // passcode never
  })

  it('a physical event keeps its Place location', async () => {
    h.event = event('custom', { venueType: 'physical' })
    expect((await jsonLd()).location).toMatchObject({ '@type': 'Place' })
  })
})
