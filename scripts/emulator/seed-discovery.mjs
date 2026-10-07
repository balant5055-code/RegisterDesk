/* Seeds published events for a VISUAL QA pass of /events. DEV TOOL ONLY — emulator only.
 *
 *   dotenv -e .env.emulator -- node scripts/emulator/seed-discovery.mjs
 *
 * These documents exist so the discovery page can be audited at real widths with real
 * layout pressure: long and short titles, banner and no-banner cards, free and paid,
 * sold-out and filling-fast capacity, online / hybrid / physical, several cities and
 * states, and every event type in the canonical taxonomy.
 *
 * NOTHING here ships. The page itself never hardcodes an event — it renders whatever
 * listPublishedEvents returns. Refuses to run against anything but a `demo-` project.
 */
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

const projectId = process.env.GCLOUD_PROJECT ?? 'demo-registerdesk'
if (!projectId.startsWith('demo-') || !process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('[seed-discovery] refusing to run: emulator profile not active.')
  process.exit(1)
}

initializeApp({ projectId })
const db = getFirestore()

const day = n => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

const banner = seed => `https://picsum.photos/seed/${seed}/960/600`

/** slug, name, type, city, state, venue, dayOffset, price, capacity, registered, banner, org */
const FIXTURES = [
  ['tn-marathon-2026',      'Coimbatore Half Marathon 2026',                    'sports',      'Coimbatore', 'Tamil Nadu',  'physical',  9,  899,  2000, 1680, 'rd-run',   'Kovai Runners Trust'],
  ['saas-summit-blr',       'India SaaS Summit — Scaling to $100M ARR',         'conference',  'Bengaluru',  'Karnataka',   'physical',  21, 4999, 600,  520,  'rd-saas',  'SaaSBoomi'],
  ['design-sprint-hyd',     'Product Design Sprint Bootcamp',                   'workshop',    'Hyderabad',  'Telangana',   'physical',  4,  1499, 40,   40,   'rd-design','Nudge Design Lab'],
  ['founders-mixer-mum',    'Founders & Funders Mixer',                         'meetup',      'Mumbai',     'Maharashtra', 'physical',  2,  0,    150,  128,  'rd-mixer', 'Bombay Startup Club'],
  ['auto-expo-delhi',       'North India Auto & Mobility Expo',                 'exhibition',  'Delhi',      'Delhi',       'physical',  38, 299,  12000,3400, 'rd-expo',  'Capital Expo Group'],
  ['carnatic-nights-chn',   'Margazhi Carnatic Nights',                         'cultural',    'Chennai',    'Tamil Nadu',  'physical',  1,  650,  800,  610,  'rd-music', 'Madras Sabha Collective'],
  ['clean-coast-goa',       'Clean Coast Volunteer Drive',                      'community',   'Panaji',     'Goa',         'physical',  6,  0,    300,  92,   null,       'Blue Shore Foundation'],
  ['edtech-awards-2026',    'National EdTech Excellence Awards',                'awards',      'Noida',      'Uttar Pradesh','hybrid',   45, 2500, 500,  180,  'rd-award', 'EdLeaders India'],
  ['run-for-sight-jaipur',  'Run For Sight — Charity 10K',                      'fundraising', 'Jaipur',     'Rajasthan',   'physical',  16, 500,  1500, 1240, 'rd-sight', 'Netra Jyoti Trust'],
  ['ai-builders-online',    'AI Builders Live: Shipping Agents in Production',  'workshop',    null,         null,          'online',    3,  0,    5000, 3120, 'rd-ai',    'BuildSpace India'],
  ['kolkata-lit-fest',      'Kolkata Literature & Ideas Festival',              'cultural',    'Kolkata',    'West Bengal', 'physical',  27, 1200, 2500, 640,  'rd-lit',   'Bengal Arts Council'],
  ['cyclothon-pune',        'Pune Monsoon Cyclothon',                           'sports',      'Pune',       'Maharashtra', 'physical',  12, 1250, 3000, 900,  'rd-cycle', 'Deccan Cycling Club'],
  ['msme-conclave-ahd',     'Gujarat MSME Growth Conclave',                     'conference',  'Ahmedabad',  'Gujarat',     'hybrid',    33, 0,    900,  260,  'rd-msme',  'Gujarat Chamber of Commerce'],
  ['robotics-champ-kochi',  'South India Schools Robotics Championship',        'sports',      'Kochi',      'Kerala',      'physical',  19, 750,  1200, 1010, 'rd-robot', 'STEM Kerala'],
  ['women-in-tech-blr',     'Women in Tech: Leadership Circle',                 'meetup',      'Bengaluru',  'Karnataka',   'physical',  8,  0,    120,  118,  'rd-wit',   'WiT Bengaluru'],
  ['handloom-mela-varanasi','Varanasi Handloom & Craft Mela',                   'exhibition',  'Varanasi',   'Uttar Pradesh','physical', 52, 100,  8000, 410,  'rd-craft', 'Kashi Weavers Society'],
  ['startup-demo-day',      'Demo Day — Cohort 12',                             'custom',      'Gurugram',   'Haryana',     'hybrid',    14, 0,    400,  330,  null,       'Nurture Ventures'],
  ['bhopal-yoga-fest',      'Bhopal Wellness & Yoga Festival',                  'community',   'Bhopal',     'Madhya Pradesh','physical',24, 349,  1000, 275,  'rd-yoga',  'Sattva Wellness Trust'],
]

function eventDoc([slug, name, type, city, state, venue, offset, price, capacity, registered, bannerSeed, org], i) {
  const start = day(offset)
  return {
    lifecycleStatus: 'published',
    visibility:      'public',
    eventType:       type,
    totalCapacity:   capacity,
    // Newest-first ordering is by publishedAt; stagger so the canonical order is stable.
    publishedAt:     Timestamp.fromDate(new Date(Date.now() - i * 36e5)),
    eventDetails: {
      info:     { name, tagline: 'Registrations are open on RegisterDesk.' },
      schedule: {
        startDate: start,
        endDate:   i % 5 === 0 ? day(offset + 2) : start,
        startTime: ['06:00', '09:30', '10:00', '17:30', '18:45'][i % 5],
      },
      venue:    { type: venue, physical: city ? { city, state } : {} },
      media:    bannerSeed ? { coverBanner: { value: banner(bannerSeed) } } : {},
      organizer:{ name: org },
    },
    pricing: price === 0
      ? { eventType: 'free', passes: [] }
      : { eventType: 'paid', passes: [{ name: 'Standard', price, status: 'active' }] },
    registrationForm: { settings: { approvalMode: 'auto' } },
  }
}

const run = async () => {
  const batch = db.batch()
  FIXTURES.forEach((f, i) => {
    batch.set(db.collection('events').doc(f[0]), eventDoc(f, i))
    batch.set(db.collection('registrationCounters').doc(f[0]), { totalCount: f[9] })
  })
  await batch.commit()
  console.log(`[seed-discovery] wrote ${FIXTURES.length} published events`)
}

run().catch(err => { console.error(err); process.exit(1) })
