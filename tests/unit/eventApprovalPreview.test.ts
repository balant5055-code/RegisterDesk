// Super Admin event preview + linked-campaign gate — pure rules and source contracts.
//   • ONE template-props mapping: for every event type the preview's props for a PENDING
//     event equal the public page's props for the same event once published
//   • the preview can never become an indexable or canonical public page
//   • a linked campaign follows its event's public visibility (pure rule)
// The emulator suites (eventApprovalPreview / linkedCampaignGate) prove the server boundaries.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// eventPageProps' DATA loader reads Firestore; the mapping under test is pure.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import { buildEventPageProps, type EventPageData } from '@/lib/events/eventPageProps'
import { linkedEventAllowsCampaign, linkedEventSlugOf } from '@/lib/campaigns/linkedEventGate'
import type { PublishedEvent } from '@/lib/firebase/firestore/events'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Every event type TemplateRouter routes, plus the running/team sports split and the fallback. */
const TYPES: [string, string | null][] = [
  ['community', null], ['conference', null], ['sports', 'marathon'], ['sports', 'football'],
  ['workshop', null], ['exhibition', null], ['cultural', null], ['awards', null], ['meetup', null],
  ['custom', null], ['fundraising', null], ['something_new', null],
]

function event(eventType: string, eventSubtype: string | null, lifecycleStatus: string): PublishedEvent {
  return {
    slug: `ev-${eventType}`, uid: 'org', draftId: 'd', eventType, eventSubtype, visibility: 'public',
    pricing: {
      eventType: 'paid',
      passes: [
        { id: 'p1', name: 'General', description: 'Entry', price: 500, quantity: 100, unlimited: false, status: 'active', visibility: 'public' },
        { id: 'p2', name: 'Comp', description: '', price: 0, quantity: 5, unlimited: false, status: 'active', visibility: 'invite_only' },
      ],
    },
    eventDetails: {
      info: { name: `The ${eventType} event`, tagline: 'Tag', shortDesc: 'Short', fullDesc: 'Full description', language: 'English' },
      media: { coverBanner: { value: 'https://example.invalid/b.png' }, logo: { value: '' }, galleryImages: [{ value: 'https://example.invalid/g.png' }] },
      schedule: { startDate: '2099-03-01', startTime: '09:00', endDate: '2099-03-01', endTime: '17:00', timezone: 'Asia/Kolkata', agenda: [{ title: 'Keynote' }] },
      venue: { type: 'physical', physical: { name: 'Hall', city: 'Chennai' } },
      organizer: { name: 'Org', email: 'org@rd.test' },
      typeDetails: { speakers: [{ name: 'Ada', order: 1 }], judges: [{ name: 'Grace', order: 2 }] },
      sponsors: [{ name: 'Acme', order: 1 }],
      faq: [{ question: 'Q?', answer: 'A.' }],
      support: { supportEmail: 'help@rd.test', termsUrl: 'https://example.invalid/t' },
      applications: { speaker: { enabled: true }, sponsor: { enabled: false } },
    },
    planType: 'paid_event', capacityPlan: 'unlimited' as never, totalCapacity: 100,
    registrationForm: null, accessControl: null,
    lifecycleStatus: lifecycleStatus as never, publishedAt: null, updatedAt: null,
  }
}

const DATA: EventPageData = { counter: null, linkedCampaign: null, exhibitorDirectory: [] }

describe('one mapping for the public page and the admin preview — every event type', () => {
  for (const [type, subtype] of TYPES) {
    it(`${type}${subtype ? `/${subtype}` : ''}: pending preview props === published public props`, () => {
      const pub     = buildEventPageProps(`ev-${type}`, event(type, subtype, 'published'), DATA).props
      const preview = buildEventPageProps(`ev-${type}`, event(type, subtype, 'pending_review'), DATA, { displayLifecycle: 'published' }).props
      // identical — including the clock-derived pass fields (no early-bird / sales window here)
      expect(preview).toEqual(pub)
      expect(preview).toMatchObject({
        eventType: type, lifecycleStatus: 'published', registrationOpen: true,
        title: `The ${type} event`, description: 'Full description', faq: [{ question: 'Q?', answer: 'A.' }],
        speakerApplicationsOpen: true,
      })
      expect(preview.speakers.map(s => s.name)).toEqual(['Ada', 'Grace'])
      expect(preview.sponsors.map(s => s.name)).toEqual(['Acme'])
      // invite-only tickets are withheld from the page exactly as on the public route
      expect(preview.passes.map(p => p.name)).toEqual(['General'])
    })
  }

  it('without the override a pending event renders closed (the public page never shows it anyway)', () => {
    const p = buildEventPageProps('x', event('conference', null, 'pending_review'), DATA).props
    expect(p.lifecycleStatus).toBe('pending_review')
    expect(p.registrationOpen).toBe(false)
    expect(p.speakerApplicationsOpen).toBe(false)
  })

  it('the public page and the preview API both go through the shared builder', () => {
    const page = code(read('app/events/[slug]/page.tsx'))
    expect(page).toContain('buildEventPageProps(slug, event, data)')
    expect(page).toContain('<TemplateRouter {...props} />')
    const api = code(read('app/api/admin/events/[slug]/preview/route.ts'))
    expect(api).toContain("buildEventPageProps(slug, event, data, { displayLifecycle: 'published' })")
    expect(code(read('app/(admin-preview)/admin/preview/events/[slug]/AdminEventPreview.tsx'))).toContain('<TemplateRouter {...data.props} />')
  })
})

describe('the preview can never be an indexable or canonical public page', () => {
  const layout = code(read('app/(admin-preview)/layout.tsx'))
  const api    = code(read('app/api/admin/events/[slug]/preview/route.ts'))

  it('the preview route group is noindex/nofollow and declares no canonical', () => {
    expect(layout).toMatch(/robots:\s*\{\s*index: false, follow: false/)
    expect(layout).not.toContain('alternates')
    expect(layout).not.toContain('canonical')
  })

  it('it lives under /admin, which robots.txt disallows, and is absent from the sitemap', () => {
    expect(read('app/robots.ts')).toContain("'/admin'")
    // no URL path beginning /admin (imports such as '@/lib/firebase/admin' are not paths)
    expect(code(read('app/sitemap.ts'))).not.toMatch(/['`/]\/?admin\/preview|['`]\/admin/)
    expect(code(read('app/sitemap.ts'))).not.toContain('preview')
  })

  it('the preview API is Super-Admin-gated, no-store and noindex', () => {
    expect(api).toContain("resolveAdminUid(req.headers.get('authorization'))")
    expect(api).toMatch(/Cache-Control': 'no-store/)
    expect(api).toMatch(/X-Robots-Tag': 'noindex, nofollow/)
  })

  it('the public event route has no admin or preview bypass of the public gate', () => {
    const page = code(read('app/events/[slug]/page.tsx'))
    for (const bypass of ['ADMIN_UIDS', 'resolveAdminUid', 'displayLifecycle', 'searchParams', 'includeUnapprovedCampaign']) {
      expect(page, bypass).not.toContain(bypass)
    }
    expect(code(read('app/events/[slug]/layout.tsx'))).toContain('await requirePublicEvent(slug)')
  })

  it('the approvals queue opens the admin preview, never the public URL', () => {
    const q = code(read('app/(admin)/admin/event-approvals/PageClient.tsx'))
    expect(q).toContain('href={`/admin/preview/events/${encodeURIComponent(r.slug)}`}')
    expect(q).not.toContain('href={`/events/${r.slug}`}')
  })
})

describe('the live-content copy applies the first submission’s event-type cleanup', () => {
  // buildLiveContentSync is shared by Save Changes, resubmit and republish.
  const pass = (o: Record<string, unknown> = {}) => ({ id: 'p1', name: 'General', type: 'paid', price: 500, status: 'active', ...o })

  it('another type’s typeDetails keys never reach the copied snapshot', async () => {
    const { buildLiveContentSync } = await import('@/lib/events/editing/liveContentSync')
    const live  = { eventType: 'conference', eventSubtype: null, pricing: { eventType: 'paid', passes: [pass()] }, eventDetails: { info: { name: 'X' }, typeDetails: { speakers: [] } } }
    const draft = { eventType: 'conference', eventSubtype: null, pricing: { eventType: 'paid', passes: [pass()] },
      eventDetails: { info: { name: 'X' }, typeDetails: { speakers: [{ name: 'Ada' }], judges: [{ name: 'Leftover Judge' }], categories: ['x'] } } }
    const r = buildLiveContentSync(draft, live, 'ev-x', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const td = (r.update.eventDetails as Record<string, unknown>).typeDetails as Record<string, unknown>
    expect(Object.keys(td).sort()).toEqual(['hallLayout', 'speakers', 'sponsors', 'tracks'])
    expect(td.speakers).toEqual([{ name: 'Ada' }])
    expect(JSON.stringify(td)).not.toContain('Leftover Judge')
    expect(((r.update.eventDetails as Record<string, unknown>).seo as Record<string, unknown>).urlSlug).toBe('ev-x')
  })

  it('race details survive only on a type that has them', async () => {
    const { buildLiveContentSync } = await import('@/lib/events/editing/liveContentSync')
    const race = { category: '10K', customCategory: '', minAge: 12, maxAge: null }
    const mk = (eventType: string, eventSubtype: string | null) => ({ eventType, eventSubtype, pricing: { eventType: 'paid', passes: [pass({ raceDetails: race })] }, eventDetails: { info: { name: 'X' } } })
    const conf = buildLiveContentSync(mk('conference', null), mk('conference', null), 'a', {})
    const run  = buildLiveContentSync(mk('sports', 'marathon'), mk('sports', 'marathon'), 'b', {})
    if (!conf.ok || !run.ok) throw new Error('unexpected refusal')
    expect(((conf.update.pricing as { passes: Record<string, unknown>[] }).passes[0]).raceDetails).toBeNull()
    expect(((run.update.pricing as { passes: Record<string, unknown>[] }).passes[0]).raceDetails).toEqual(race)
  })
})

describe('linked campaigns follow their event (pure rule)', () => {
  it('public statuses allow, everything else — and cancelled — refuses', () => {
    for (const s of ['published', 'registration_closed', 'completed']) expect(linkedEventAllowsCampaign({ lifecycleStatus: s as never })).toBe(true)
    for (const s of ['pending_review', 'draft', 'changes_requested', 'unpublished', 'archived', 'cancelled', 'brand_new_state'])
      expect(linkedEventAllowsCampaign({ lifecycleStatus: s as never }), s).toBe(false)
    expect(linkedEventAllowsCampaign({ lifecycleStatus: 'published', moderationStatus: 'taken_down' as never })).toBe(false)
    expect(linkedEventAllowsCampaign(null)).toBe(false)
  })

  it('a standalone campaign is unlinked; an event_plus_donation campaign is always linked', () => {
    expect(linkedEventSlugOf({ campaignType: 'donation_only', slug: 'c1' })).toBeNull()
    expect(linkedEventSlugOf({ linkedEventSlug: 'ev1' })).toBe('ev1')
    expect(linkedEventSlugOf({ linkedEventId: 'ev2' })).toBe('ev2')
    expect(linkedEventSlugOf({ campaignType: 'event_plus_donation', slug: 'ev3' })).toBe('ev3')
    expect(linkedEventSlugOf({ campaignType: 'event_plus_donation' }, 'docid')).toBe('docid')
  })

  it('submission still writes the linked campaign as active — the gate is read-side, no migration', () => {
    // documents the root cause the gate exists for; if publish ever writes a pending status
    // instead, the read-side gate still holds and this note should be revisited.
    expect(read('app/api/events/publish/route.ts')).toMatch(/linkedEventSlug: slug,[\s\S]{0,1200}status:\s*'active'/)
  })
})
