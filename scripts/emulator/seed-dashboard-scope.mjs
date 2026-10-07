/* RD-DASHBOARD-05 — two-event fixture for verifying the Dashboard's event scope.
 *
 *   npm run emu:seed && dotenv -e .env.emulator -- node scripts/emulator/seed-dashboard-scope.mjs
 *
 * ═══ WHY TWO EVENTS WITH DELIBERATELY DIFFERENT NUMBERS ═══════════════════════
 * The whole point of the scope work is that switching the Event Selector changes what the
 * Dashboard shows. A fixture with one event, or with two similar ones, cannot tell a
 * WORKING scope from a BROKEN one — both render plausible numbers. So the two events here
 * are an order of magnitude apart on every axis (registrations, revenue, check-ins,
 * pending, cancelled, per-pass split, daily shape), which makes "the page did not change"
 * impossible to miss and impossible to mistake for a rounding difference.
 *
 * Event A · Coastal Marathon 2026 — big, live, healthy
 * Event B · Hill Trail Run 2026   — small, nearly full, with a pending queue
 *
 * ═══ DETERMINISM AND SAFETY ═══════════════════════════════════════════════════
 * Every document has a FIXED id and is written with set(), so re-running converges rather
 * than duplicating. Timestamps derive from a FIXED `TODAY` constant, not Date.now(), so
 * the rollup rows always line up with the day buckets the API asks for.
 *
 * It refuses to run without the emulator host variables — pointed at production it would
 * be destructive.
 */
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST
const FS_HOST   = process.env.FIRESTORE_EMULATOR_HOST
if (!AUTH_HOST || !FS_HOST) {
  console.error('Refusing to seed: emulator hosts are not set. Use dotenv -e .env.emulator.')
  process.exit(2)
}

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-registerdesk'
const UID = 'profiling-organizer-uid'

if (!getApps().length) initializeApp({ projectId: PROJECT_ID })
const db = getFirestore()

// ─── The reporting day, computed the SAME way lib/dashboard/dailyStats.ts does ───
// Fixed-offset IST arithmetic, not toLocaleDateString: the rollup ids the API reads are
// built that way, and a fixture that bucketed by the host's zone would write rows the API
// never looks at — which reads on screen as "no activity", the exact lie under test.
const TZ_OFFSET_MIN = 330
const dayKey = (ms) => {
  const d = new Date(ms + TZ_OFFSET_MIN * 60_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
const NOW = Date.now()
const DAY = 86_400_000
const ALL_EVENTS = '__all__'

// ─── The two events ────────────────────────────────────────────────────────────

const EVENTS = [
  {
    draftId:  'scope-event-coastal',
    slug:     'coastal-marathon-2026',
    name:     'Coastal Marathon 2026',
    city:     'Chennai',
    startsInDays: 24,
    lifecycle: 'published',
    capacity: null,                       // paid event ⇒ no free-tier capacity
    passes: [
      { id: 'pass_10k', name: '10K Run',        price: 1200, confirmed: 260 },
      { id: 'pass_21k', name: 'Half Marathon',  price: 1800, confirmed: 120 },
      { id: 'pass_42k', name: 'Full Marathon',  price: 2500, confirmed:  40 },
    ],
    confirmed: 420, pending: 12, cancelled: 18, rejected: 3, checkedIn: 96,
    emailsToday: 31, emailsFailedToday: 4, campaigns: 5, reached: 1180,
    licenseTier: 'starter',               // 100 → 420 used = OVER the ceiling: critical + upgrade CTA
    ledgerCaptured: 300,                  // 300 of 420 paid online → gross < ticket revenue, on purpose
    revenuePaise: 420 * 1_65_000,          // ≈ ₹6.93L
    /** Daily shape: a steady, busy event. */
    daily: (i) => ({ confirmed: 6 + (i % 5), revenuePaise: (6 + (i % 5)) * 1_65_000, checkedIn: i < 3 ? 32 : 0, cancelled: i % 7 === 0 ? 1 : 0 }),
  },
  {
    draftId:  'scope-event-hilltrail',
    slug:     'hill-trail-run-2026',
    name:     'Hill Trail Run 2026',
    city:     'Coonoor',
    startsInDays: 5,
    lifecycle: 'published',
    capacity: null,
    passes: [
      { id: 'pass_5k',  name: '5K Trail',  price: 600, confirmed: 24 },
      { id: 'pass_12k', name: '12K Trail', price: 900, confirmed: 13 },
    ],
    confirmed: 37, pending: 9, cancelled: 2, rejected: 0, checkedIn: 4,
    emailsToday: 6, emailsFailedToday: 1, campaigns: 2, reached: 44,
    licenseTier: 'professional',          // 5,000 → 37 used = 0.7 %, healthy, no CTA
    ledgerCaptured: 30,                   // 30 of 37 paid online
    revenuePaise: 37 * 72_000,             // ≈ ₹26.6k
    /** Daily shape: a small event with a late burst — visibly a different curve. */
    daily: (i) => ({ confirmed: i < 6 ? 3 : 0, revenuePaise: i < 6 ? 3 * 72_000 : 0, checkedIn: i === 0 ? 4 : 0, cancelled: 0 }),
  },
]

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10)

/**
 * platformTransactions — the per-event MONEY ledger (entityId = eventSlug).
 *
 * ═══ WHY GROSS DELIBERATELY ≠ TICKET REVENUE ═════════════════════════════════
 * This fixture reproduces the reported "Confirmed revenue ≠ Gross revenue" discrepancy on
 * purpose: only SOME confirmed registrations have a captured gateway payment. The rest are
 * confirmed without one — the manual-approval / offline / comp case — so they count toward
 * the ticket-revenue counter and NOT toward the gateway ledger.
 *
 * That is the structural reason the two figures differ, and the fixture proves the
 * dashboard now reports both honestly under labels that distinguish them.
 */
async function seedLedger(e) {
  const captured = e.ledgerCaptured          // how many of the confirmed registrations paid online
  let batch = db.batch()
  for (let i = 0; i < captured; i++) {
    const gross = e.passes[0].price * 100
    const feeBase = Math.round(gross * 0.02)
    const gst     = Math.round(feeBase * 0.18)
    const gw      = Math.round(gross * 0.0236)
    batch.set(db.doc(`platformTransactions/ptx_${e.draftId}-${i}`), {
      id: `ptx_${e.draftId}-${i}`,
      type: 'registration_payment', category: 'revenue',
      organizerUid: UID,
      entityId: e.slug, entityType: 'event',
      sourceId: `${e.draftId}-reg-${i}`, sourceType: 'registration',
      payerName: `${e.city} Runner ${i}`, payerEmail: `runner${i}@${e.slug}.test`,
      grossAmountPaise: gross,
      platformFeeBasePaise: feeBase, platformFeeGstPaise: gst,
      platformFeeTotalPaise: feeBase + gst,
      gatewayFeeEstimatePaise: gw,
      netSettlementPaise: gross - feeBase - gst - gw,
      feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'fallback',
      currency: 'INR', gateway: 'razorpay',
      gatewayPaymentId: `pay_FIXTURE${e.draftId}${i}`,
      status: 'captured',
      paidAt: Timestamp.fromMillis(NOW - i * 3_600_000),
      createdAt: Timestamp.fromMillis(NOW - i * 3_600_000),
    })
    if ((i + 1) % 400 === 0) { await batch.commit(); batch = db.batch() }
  }
  await batch.commit()
}

/**
 * eventLicenses/{slug} — the REGISTRATION ENTITLEMENT, not event capacity.
 *
 * V1 tiers, whose catalog limits are fixed in lib/licensing/eventLicense.ts:
 *   growth       → 1,000   · Coastal has 420 used   → 42 %, healthy, no upgrade offered
 *   starter      →   100   · Hill Trail has 37 used → 37 %, healthy
 * The fixture never states a limit itself; it states a TIER, and the dashboard resolves
 * the number from the catalog. A hardcoded limit here would test nothing.
 */
async function seedLicense(e) {
  await db.doc(`eventLicenses/${e.slug}`).set({
    eventId:      e.slug,
    organizerUid: UID,
    tier:         e.licenseTier,
    status:       'active',
    version:      1,
    amountPaise:  0,
    orderId:      null,
    paidAt:       Timestamp.fromMillis(NOW - 60 * DAY),
    upgradedFrom: null,
    upgradedAt:   null,
    createdAt:    Timestamp.fromMillis(NOW - 60 * DAY),
    updatedAt:    Timestamp.fromMillis(NOW - 60 * DAY),
  })
}

/** A published draft, in the CANONICAL nested shape the dashboard route reads. */
function buildDraft(e) {
  const start = NOW + e.startsInDays * DAY
  return {
    id: e.draftId,
    uid: UID,
    status: 'published',
    lifecycleStatus: e.lifecycle,
    currentStep: 8,
    eventType: 'sports',
    eventSubtype: 'marathon',
    visibility: 'public',
    accessControl: { type: 'open', approvedContacts: [], confirmationMode: 'auto' },
    pricing: {
      eventType: 'paid',
      feeModel: 'organizer_pays',
      // Registration closes two days before the event — gives the "closing soon" signal a
      // real field to read rather than an invented one.
      registrationEndDate: isoDate(start - 2 * DAY),
      passes: e.passes.map(p => ({
        id: p.id, name: p.name, code: p.id.toUpperCase(), type: 'paid', price: p.price,
        unlimited: true, quantity: 0, minPurchase: 1, maxPurchase: 10,
        visibility: 'public', status: 'active', benefits: [], customBenefits: [],
        advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] },
      })),
    },
    registrationForm: { template: 'standard', fields: [] },
    eventDetails: {
      info: { name: e.name, tagline: `${e.city} · scope fixture`, description: 'Dashboard scope fixture.' },
      seo:  { urlSlug: e.slug },
      schedule: { startDate: isoDate(start), startTime: '06:00', endDate: isoDate(start), endTime: '12:00', timezone: 'Asia/Kolkata' },
      venue: { type: 'physical', physical: { name: `${e.city} Grounds`, address: 'Main Road', city: e.city, state: 'Tamil Nadu' } },
      organizer: { name: 'Profiling Events Co', email: 'profiling@registerdesk.test', phone: '+919999999999' },
      capacity: e.capacity === null ? {} : { totalCapacity: e.capacity },
    },
    communicationBilling: null,
    licenseTier: 'free',
    reviewStatus: null,
    publishedAt: Timestamp.fromMillis(NOW - 60 * DAY),
    createdAt:   Timestamp.fromMillis(NOW - 70 * DAY),
    updatedAt:   Timestamp.fromMillis(NOW - 1 * DAY),
  }
}

async function seedEvent(e) {
  await db.doc(`users/${UID}/eventDrafts/${e.draftId}`).set(buildDraft(e))

  // The counting SSOT. statsVersion at the current version so the route trusts the
  // denormalized revenue and status counts rather than falling back to aggregates —
  // which is also what makes this fixture cheap to read.
  await db.doc(`registrationCounters/${e.slug}`).set({
    eventSlug:      e.slug,
    totalCount:     e.confirmed,
    passCounts:     Object.fromEntries(e.passes.map(p => [p.id, p.confirmed])),
    checkedInCount: e.checkedIn,
    statsVersion:   2,
    revenuePaise:   e.revenuePaise,
    pendingCount:   e.pending,
    cancelledCount: e.cancelled,
    rejectedCount:  e.rejected,
    passCheckedInCounts: Object.fromEntries(e.passes.map(p => [p.id, Math.round(p.confirmed * 0.2)])),
    updatedAt:      Timestamp.fromMillis(NOW),
  })

  // A handful of real registration documents. These drive the ACTIVITY FEED, which is the
  // most visible scope tell on screen: a name from the wrong event under the wrong heading
  // is instantly obvious in a way a slightly-off total is not.
  const batch = db.batch()
  for (let i = 0; i < 8; i++) {
    const at = NOW - i * 3 * 3_600_000
    const pass = e.passes[i % e.passes.length]
    batch.set(db.doc(`registrations/${e.draftId}-reg-${i}`), {
      organizerUid:  UID,
      eventSlug:     e.slug,
      eventName:     e.name,
      passId:        pass.id,
      passName:      pass.name,
      // NESTED, matching RegistrationDocument. An earlier version of this fixture wrote
      // flat `attendeeName`/`attendeeEmail`; the activity feed reads `r.attendee.name` and
      // the whole dashboard 500'd. Fixture data must match the type the app consumes.
      attendee: {
        name:  `${e.city} Runner ${i + 1}`,
        email: `runner${i + 1}@${e.slug}.test`,
        phone: '+919000000000',
      },
      status:        'confirmed',
      paymentStatus: 'paid',
      amount:        pass.price * 100,
      emailStatus:   'sent',
      registeredAt:  Timestamp.fromMillis(at),
      updatedAt:     Timestamp.fromMillis(at),
      checkedInAt:   i < 2 ? Timestamp.fromMillis(NOW - 3_600_000) : null,
    })
  }
  await batch.commit()

  await seedComms(e)
  await seedLicense(e)
  await seedLedger(e)

  console.log(`  ${e.name.padEnd(24)} slug=${e.slug.padEnd(24)} confirmed=${String(e.confirmed).padStart(4)}  revenue=₹${(e.revenuePaise / 100).toLocaleString('en-IN')}  emails today=${e.emailsToday}/${e.emailsFailedToday} campaigns=${e.campaigns}`)
}

/**
 * Communication volume, per event and deliberately different between the two.
 *
 * Equal volumes would let a BROKEN scope pass: both events would show the same plausible
 * number and nobody could tell whether the filter ran. 31-vs-6 emails and 5-vs-2 campaigns
 * make an unscoped query show up as the wrong figure, not as a coincidence.
 */
async function seedComms(e) {
  let batch = db.batch()

  // emailLogs — today's window, split across the two status partitions the dashboard counts.
  const mk = (n, status, i) => db.batch && db.doc(`emailLogs/${e.draftId}-${status}-${i}`)
  for (let i = 0; i < e.emailsToday; i++) {
    batch.set(mk(null, 'ok', i), {
      organizerUid: UID, eventSlug: e.slug,
      // Alternating sent/delivered: BOTH belong to the "sent" partition the card counts,
      // so this also proves the `in` filter still works alongside the eventSlug equality.
      status: i % 2 === 0 ? 'sent' : 'delivered',
      channel: 'email', to: `runner${i}@${e.slug}.test`,
      createdAt: Timestamp.fromMillis(NOW - i * 60_000),
    })
  }
  for (let i = 0; i < e.emailsFailedToday; i++) {
    batch.set(mk(null, 'failed', i), {
      organizerUid: UID, eventSlug: e.slug, status: 'failed', channel: 'email',
      to: `bounce${i}@${e.slug}.test`, createdAt: Timestamp.fromMillis(NOW - i * 60_000),
    })
  }
  await batch.commit()

  // broadcastCampaigns — count + Σ successCount, the two figures the card reports.
  batch = db.batch()
  for (let i = 0; i < e.campaigns; i++) {
    batch.set(db.doc(`broadcastCampaigns/${e.draftId}-camp-${i}`), {
      organizerUid: UID, eventId: e.draftId, eventSlug: e.slug,
      status: 'sent',
      successCount: Math.round(e.reached / e.campaigns),
      createdAt: Timestamp.fromMillis(NOW - (i + 1) * DAY),
    })
  }
  await batch.commit()
}

/**
 * Rollup rows for BOTH scopes.
 *
 * The workspace row is the SUM of the event rows, written explicitly rather than derived —
 * exactly as the live write path maintains it. Writing only the event rows would leave the
 * all-events trend flat while the per-event ones had data, which is the mirror image of the
 * defect this fixture exists to catch.
 */
async function seedRollups(days = 90) {
  let batch = db.batch()
  let ops = 0
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0 } }

  for (let i = 0; i < days; i++) {
    const day = dayKey(NOW - i * DAY)
    const totals = { confirmed: 0, cancelled: 0, revenuePaise: 0, checkedIn: 0 }

    for (const e of EVENTS) {
      const row = e.daily(i)
      totals.confirmed    += row.confirmed
      totals.cancelled    += row.cancelled
      totals.revenuePaise += row.revenuePaise
      totals.checkedIn    += row.checkedIn
      batch.set(db.doc(`organizerDailyStats/${UID}__${e.slug}__${day}`), {
        organizerUid: UID, eventId: e.slug, day, ...row, updatedAt: Timestamp.fromMillis(NOW),
      })
      ops++
    }

    batch.set(db.doc(`organizerDailyStats/${UID}__${ALL_EVENTS}__${day}`), {
      organizerUid: UID, eventId: ALL_EVENTS, day, ...totals, updatedAt: Timestamp.fromMillis(NOW),
    })
    ops++
    if (ops >= 400) await flush()
  }
  await flush()

  // Coverage marker LAST, so an interrupted run never claims history it does not have.
  await db.doc(`organizerDailyStats/${UID}__meta`).set({
    organizerUid: UID, since: dayKey(NOW - (days - 1) * DAY), backfilledAt: Timestamp.fromMillis(NOW),
  })
  console.log(`  rollups: ${days} days × (${EVENTS.length} events + workspace)`)
}

/** The organizer's revenue wallet — the canonical settlement source. Workspace-level. */
async function seedWallet() {
  const gross = EVENTS.reduce((s, e) => s + e.revenuePaise, 0)
  const fee   = Math.round(gross * 0.02)
  // CANONICAL field names — `lifetime*`, the ones the settlement card actually reads. An
  // earlier version invented `grossRevenuePaise`/`platformFeePaise` and the card rendered a
  // full ₹0 settlement that looked exactly like a real organizer with no sales.
  await db.doc(`organizerRevenueWallets/${UID}`).set({
    organizerUid:       UID,
    lifetimeGrossPaise: gross,
    lifetimeFeesPaise:  fee,
    lifetimeNetPaise:   gross - fee,
    updatedAt:          Timestamp.fromMillis(NOW),
  }, { merge: true })
  // The COMMUNICATION credit wallet — a different document from the revenue wallet above,
  // and the one the "Wallet balance" KPI reads. Seeded with a real balance so the
  // "All events" scope label has a non-zero figure to qualify: a ₹0 wallet would let a
  // broken label pass QA unnoticed.
  await db.doc(`organizerWallets/${UID}`).set({
    organizerUid: UID, balancePaise: 4_85_000, currency: 'INR', updatedAt: Timestamp.fromMillis(NOW),
  }, { merge: true })

  console.log(`  wallet: revenue gross ₹${(gross / 100).toLocaleString('en-IN')}, comms credit ₹4,850 (both WORKSPACE-level — must stay labelled)`)
}

/**
 * A genuine DRAFT — never published, no public slug.
 *
 * The Event Selector lists it (the list request carries no tab filter), so the Dashboard has
 * to serve it. This fixture is what proves the draft path renders honest zeros with a stated
 * reason instead of failing or borrowing the workspace's numbers.
 */
const DRAFT = { draftId: 'scope-event-draft', name: 'Monsoon 10K 2027' }

/**
 * A COMPLETED and an ARCHIVED event.
 *
 * The Event Selector must never hide an event STATE — an organizer has to be able to reach a
 * finished race to pull its reports. Both are seeded WITHOUT counters, so they contribute
 * nothing to the workspace totals the isolation checks assert; they exist purely to prove
 * they stay listed and selectable.
 */
const TERMINAL = [
  { draftId: 'scope-event-completed', name: 'Lakeside Run 2025',  lifecycle: 'completed', daysAgo: 120 },
  { draftId: 'scope-event-archived',  name: 'Old City Dash 2024', lifecycle: 'archived',  daysAgo: 400 },
]

async function seedTerminalEvents() {
  for (const t of TERMINAL) {
    await db.doc(`users/${UID}/eventDrafts/${t.draftId}`).set({
      id: t.draftId,
      uid: UID,
      status: 'published',
      lifecycleStatus: t.lifecycle,
      currentStep: 8,
      eventType: 'sports',
      eventSubtype: 'marathon',
      visibility: 'public',
      accessControl: { type: 'open', approvedContacts: [], confirmationMode: 'auto' },
      pricing: { eventType: 'paid', feeModel: 'organizer_pays', passes: [] },
      registrationForm: { template: 'standard', fields: [] },
      eventDetails: {
        info: { name: t.name, tagline: 'Terminal-state fixture' },
        seo:  { urlSlug: t.draftId },
        schedule: { startDate: isoDate(NOW - t.daysAgo * DAY), timezone: 'Asia/Kolkata' },
        venue: { type: 'physical', physical: { city: 'Chennai', state: 'Tamil Nadu' } },
        organizer: { name: 'Profiling Events Co', email: 'profiling@registerdesk.test' },
      },
      communicationBilling: null,
      licenseTier: 'free',
      reviewStatus: null,
      publishedAt: Timestamp.fromMillis(NOW - (t.daysAgo + 30) * DAY),
      createdAt:   Timestamp.fromMillis(NOW - (t.daysAgo + 40) * DAY),
      updatedAt:   Timestamp.fromMillis(NOW - t.daysAgo * DAY),
    })
    console.log(`  ${t.name.padEnd(24)} ${t.lifecycle.toUpperCase()} — must stay selectable`)
  }
}

async function seedDraftEvent() {
  await db.doc(`users/${UID}/eventDrafts/${DRAFT.draftId}`).set({
    id: DRAFT.draftId,
    uid: UID,
    status: 'draft',
    lifecycleStatus: 'draft',
    currentStep: 3,
    eventType: 'sports',
    eventSubtype: 'marathon',
    visibility: 'public',
    accessControl: { type: 'open', approvedContacts: [], confirmationMode: 'auto' },
    pricing: { eventType: 'paid', feeModel: 'organizer_pays', passes: [] },
    registrationForm: { template: 'standard', fields: [] },
    eventDetails: {
      info: { name: DRAFT.name, tagline: 'Not published yet' },
      // NO seo.urlSlug — that absence IS the draft state the route keys on.
      schedule: { startDate: isoDate(NOW + 200 * DAY), timezone: 'Asia/Kolkata' },
      venue: { type: 'physical', physical: { city: 'Kochi', state: 'Kerala' } },
      organizer: { name: 'Profiling Events Co', email: 'profiling@registerdesk.test' },
    },
    communicationBilling: null,
    licenseTier: 'free',
    reviewStatus: null,
    publishedAt: null,
    createdAt: Timestamp.fromMillis(NOW - 2 * DAY),
    updatedAt: Timestamp.fromMillis(NOW - 2 * DAY),
  })
  console.log(`  ${DRAFT.name.padEnd(24)} DRAFT — no slug, no counters, no rollups`)
}

/**
 * A registration document with NO `attendee` map.
 *
 * `route.ts` read `r.attendee.name` unguarded, so one row like this returned 500 for the
 * WHOLE endpoint — every KPI, chart and alert gone because one feed row was incomplete.
 * Seeding it deliberately is what turns that from a story into a regression test.
 */
async function seedMalformedRegistration() {
  await db.doc(`registrations/${EVENTS[1].draftId}-reg-malformed`).set({
    organizerUid: UID,
    eventSlug:    EVENTS[1].slug,
    eventName:    EVENTS[1].name,
    passId:       EVENTS[1].passes[0].id,
    passName:     EVENTS[1].passes[0].name,
    // attendee: DELIBERATELY ABSENT
    status:       'confirmed',
    paymentStatus:'paid',
    amount:       60_000,
    registeredAt: Timestamp.fromMillis(NOW - 30 * 60_000),
    updatedAt:    Timestamp.fromMillis(NOW - 30 * 60_000),
    checkedInAt:  null,
  })
  console.log('  malformed registration seeded (no `attendee` map) — must NOT 500 the API')
}

async function main() {
  console.log(`Seeding dashboard scope fixture (project ${PROJECT_ID})`)
  for (const e of EVENTS) await seedEvent(e)
  await seedDraftEvent()
  await seedTerminalEvents()
  await seedMalformedRegistration()
  await seedRollups()
  await seedWallet()
  console.log('\nDone. Sign in as profiling@registerdesk.test / ProfilingPassw0rd! and switch events.')
}

main().catch(err => { console.error(err); process.exit(1) })
