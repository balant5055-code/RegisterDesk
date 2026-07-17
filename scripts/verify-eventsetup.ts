// Unit verification for the Event Setup Center registry derives (Phase H.4.1).
// The registry is pure (type-only imports) so it runs without Firebase.
// Run: npx tsx scripts/verify-eventsetup.ts   (exits non-zero on any failure)

import { SETUP_MODULES } from '../lib/eventSetup/registry'
import { EMPTY_ENRICHMENT } from '../lib/eventSetup/types'
import type { EventDetailResponse } from '../app/api/organizer/events/[eventId]/route'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
}

const PASS = { id: 'p1', name: 'GA', description: null, price: 10000, unlimited: false, capacity: 100, sold: 0, status: 'active', salesStartDate: null, salesEndDate: null }

const BASE = {
  draftId: 'd1', status: 'published', lifecycleStatus: 'published',
  name: 'My Event', tagline: null, shortDesc: 'A great event', fullDesc: null, slug: 'my-event',
  startDate: '2026-08-01', startTime: '09:00', endDate: '2026-08-01', endTime: '17:00', timezone: 'Asia/Kolkata',
  bannerUrl: 'https://x/b.jpg', logoUrl: 'https://x/l.png',
  eventType: 'conference', eventSubtype: 'tech_conference', campaignType: null, visibility: 'public',
  venueType: 'physical', venueName: 'Hall A', venueCity: 'Mumbai', venueAddress: '123 St', onlinePlatform: null, onlineMeetingUrl: null,
  totalCapacity: null, totalRegistrations: 0, checkedInCount: 0, estimatedRevenue: 0, isFreeEvent: false,
  passes: [PASS], publishedAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  organizerName: null, organizerEmail: null, organizerPhone: null, organizerWebsite: null,
  speakers: [], sponsors: [{ id: 's1', name: 'Acme', logoUrl: 'x', website: '', tier: '', order: 0 }],
  galleryImages: [], metaTitle: 'T', metaDescription: 'D', keywords: [],
  registrationRules: {}, pricing: { whatsappEnabled: true, smsEnabled: false, certEnabled: true },
  linkedCampaignSlug: null, donationTotalPaise: 0, donorCount: 0,
} as unknown as EventDetailResponse

const evt = (over: Partial<EventDetailResponse> = {}): EventDetailResponse => ({ ...BASE, ...over } as EventDetailResponse)
const derive = (key: string, e: EventDetailResponse) => {
  const m = SETUP_MODULES.find(x => x.key === key)
  if (!m) throw new Error(`module '${key}' not found`)
  return m.derive({ event: e, enrich: EMPTY_ENRICHMENT })
}

console.log('── basic_info ──')
check('name+desc → ready',            derive('basic_info', evt()).state === 'ready')
check('no name → needs_attention',    derive('basic_info', evt({ name: '' })).state === 'needs_attention')
check('no desc → needs_attention',    derive('basic_info', evt({ shortDesc: null, fullDesc: null })).state === 'needs_attention')

console.log('── event_type ──')
check('type set → ready',             derive('event_type', evt()).state === 'ready')
check('no type → needs_attention',    derive('event_type', evt({ eventType: null })).state === 'needs_attention')
check('registrations → locked note',  derive('event_type', evt({ totalRegistrations: 5 })).reason.includes('locked'))

console.log('── schedule ──')
check('startDate → ready',            derive('schedule', evt()).state === 'ready')
check('no startDate → needs_attention', derive('schedule', evt({ startDate: null })).state === 'needs_attention')

console.log('── venue ──')
check('physical+name → ready',        derive('venue', evt()).state === 'ready')
check('online+platform → ready',      derive('venue', evt({ venueType: 'online', onlinePlatform: 'Zoom' })).state === 'ready')
check('online no platform → attn',    derive('venue', evt({ venueType: 'online', onlinePlatform: null })).state === 'needs_attention')
check('no venue → needs_attention',   derive('venue', evt({ venueType: null })).state === 'needs_attention')

console.log('── capacity ──')
check('capacity 100 → ready',         derive('capacity', evt()).state === 'ready')
check('no passes → needs_attention',  derive('capacity', evt({ passes: [] })).state === 'needs_attention')
check('unlimited → ready',            derive('capacity', evt({ passes: [{ ...PASS, unlimited: true, capacity: null }] })).state === 'ready')
check('zero seats → needs_attention', derive('capacity', evt({ passes: [{ ...PASS, capacity: 0 }] })).state === 'needs_attention')

console.log('── visibility ──')
check('public → ready',               derive('visibility', evt()).state === 'ready')
check('private → ready',              derive('visibility', evt({ visibility: 'private' })).state === 'ready')
check('null → unknown',               derive('visibility', evt({ visibility: null })).state === 'unknown')

console.log('── branding ──')
check('both → ready',                 derive('branding', evt()).state === 'ready')
check('one → needs_attention',        derive('branding', evt({ bannerUrl: null })).state === 'needs_attention')
check('none → needs_attention',       derive('branding', evt({ logoUrl: null, bannerUrl: null })).state === 'needs_attention')

console.log('── sponsors ──')
check('has sponsor → ready',          derive('sponsors', evt()).state === 'ready')
check('none → disabled',              derive('sponsors', evt({ sponsors: [] })).state === 'disabled')

console.log('── communication ──')
{
  const r = derive('communication', evt())
  check('ready', r.state === 'ready')
  check('lists Email+WhatsApp+Certificates', r.reason.includes('Email') && r.reason.includes('WhatsApp') && r.reason.includes('Certificates'))
  check('omits disabled SMS', !r.reason.includes('SMS'))
}

console.log('── email (enriched, no longer unknown) ──')
check('ready', derive('email', evt()).state === 'ready')

console.log('── coverage: all 14 requested areas have a module ──')
const keys = new Set(SETUP_MODULES.map(m => m.key))
const REQUIRED = ['basic_info', 'event_type', 'branding', 'venue', 'schedule', 'registration', 'payment', 'capacity', 'communication', 'certificate_templates', 'sponsors', 'volunteers', 'visibility', 'event_status']
for (const k of REQUIRED) check(`area '${k}' present`, keys.has(k))

console.log('── robustness: no derive throws on a sparse event ──')
const sparse = { ...BASE, passes: [], sponsors: [], pricing: null } as unknown as EventDetailResponse
for (const m of SETUP_MODULES) {
  try { const r = m.derive({ event: sparse, enrich: EMPTY_ENRICHMENT }); check(`'${m.key}' returns a state`, typeof r.state === 'string' && typeof r.reason === 'string') }
  catch { check(`'${m.key}' did NOT throw`, false) }
}

console.log('')
if (failures > 0) { console.error(`❌ ${failures} assertion(s) FAILED`); process.exit(1) }
console.log('✅ All Event Setup Center registry assertions passed')
