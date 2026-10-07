/* RD-ANALYTICS-11 — the communication scenarios, as real events. EMULATOR ONLY.
 *
 * Every state the Communications module can render has to be photographable, and most of
 * them differ only in which figures are ABSENT. A fixture that sent a comfortable mixture to
 * every event would render one screen six times and prove nothing.
 *
 *   a11-email-heavy    email only, healthy delivery                    → the ordinary case
 *   a11-whatsapp-heavy WhatsApp only, with unknowns and rejections     → both failure kinds
 *   a11-mixed          both channels, every state, one over the cap    → truncation visible
 *   a11-quiet          published, has never sent a message             → measured ZERO
 *   a11-thin-webhook   5,000 sent, 4 confirmed outcomes                → the flattering rate
 *
 * `a11-mixed` is seeded past the 5,000-row bound ON PURPOSE: the counts must stay exact
 * (they are aggregates) while the template breakdown withdraws itself and
 * `limits.communications` goes false. That contrast is the whole phase, and it cannot be
 * photographed on a small event.
 *
 * Legacy email rows carry NO `channel` field, exactly like every row written before WhatsApp
 * shipped — the population an equality filter on `channel == 'email'` would lose.
 *
 *   node rd-analytics-11-seed.mjs
 */
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run outside the emulator.'); process.exit(1)
}
const PROJECT = process.env.GCLOUD_PROJECT ?? ''
if (!PROJECT.startsWith('demo-')) {
  console.error(`Refusing to run outside a demo- project (got "${PROJECT}").`); process.exit(1)
}

if (!getApps().length) initializeApp({ projectId: PROJECT })
const db = getFirestore()

const UID = 'profiling-organizer-uid'
const dayKey = ms => new Date(ms + 330 * 60_000).toISOString().slice(0, 10)

/**
 * [slug, eventType, capacity, messages]
 *
 * `messages` is a list of [count, row] pairs. A row without `channel` is a legacy email row;
 * a row with `deliveryUnknown` is a transport timeout that keeps `status: 'failed'`, which is
 * the pair of facts this module exists to separate.
 */
const SCENARIOS = [
  ['a11-email-heavy', 'conference', 400, [
    [1_400, { status: 'delivered', costPaise: 8, templateKey: 'registration-confirmed' }],
    [  300, { status: 'sent',      costPaise: 8, templateKey: 'event-reminder' }],
    [   40, { status: 'failed',    costPaise: 8, templateKey: 'event-reminder' }],
    [   25, { status: 'skipped',                 templateKey: 'event-reminder' }],
    [   10, { status: 'queued',                  templateKey: 'certificate-ready' }],
  ]],

  ['a11-whatsapp-heavy', 'sports', 800, [
    [  900, { status: 'delivered', channel: 'whatsapp', costPaise: 35 }],
    [  260, { status: 'sent',      channel: 'whatsapp', costPaise: 35 }],
    [   70, { status: 'failed',    channel: 'whatsapp', costPaise: 35 }],
    // Sends that timed out. Delivery is UNKNOWABLE — not failed — and must not appear in
    // either rate's divisor.
    [  180, { status: 'failed',    channel: 'whatsapp', deliveryUnknown: true, costPaise: 35 }],
    [   30, { status: 'delivered', templateKey: 'registration-confirmed', costPaise: 8 }],
  ]],

  // Over the 5,000 bound: aggregates stay exact, the template breakdown withdraws.
  ['a11-mixed', 'workshop', 6_000, [
    [3_000, { status: 'delivered', costPaise: 8, templateKey: 'registration-confirmed' }],
    [  900, { status: 'sent',      costPaise: 8, templateKey: 'event-reminder' }],
    [  120, { status: 'failed',    costPaise: 8, templateKey: 'event-reminder' }],
    [  600, { status: 'delivered', channel: 'whatsapp', costPaise: 35 }],
    [  300, { status: 'sent',      channel: 'whatsapp', costPaise: 35 }],
    [   60, { status: 'failed',    channel: 'whatsapp', costPaise: 35 }],
    [  140, { status: 'failed',    channel: 'whatsapp', deliveryUnknown: true, costPaise: 35 }],
    [   80, { status: 'skipped' }],
  ]],

  // Published, real registrations, and has never sent anything. A MEASURED zero.
  ['a11-quiet', 'meetup', 100, []],

  /**
   * The state a delivery rate alone cannot describe: 5,000 messages sent, 4 outcomes
   * confirmed. The delivery rate is a true 100% over a divisor of 4, and it is the
   * unconfirmed share beside it that says the webhook has stopped reporting.
   */
  ['a11-thin-webhook', 'exhibition', 5_000, [
    [4_996, { status: 'sent',      costPaise: 8, templateKey: 'event-reminder' }],
    [    4, { status: 'delivered', costPaise: 8, templateKey: 'event-reminder' }],
  ]],
]

const ORDER = SCENARIOS.map(s => s[0])

let BASE_DRAFT = null
async function baseDraft() {
  if (BASE_DRAFT) return BASE_DRAFT
  const snap = await db.collection(`users/${UID}/eventDrafts`).limit(1).get()
  BASE_DRAFT = snap.empty ? {} : (snap.docs[0].data() ?? {})
  return BASE_DRAFT
}

async function publish(slug, eventType, capacity) {
  const draftId = `${slug}-draft`
  const base = await baseDraft()
  await db.doc(`users/${UID}/eventDrafts/${draftId}`).set({
    ...base,
    id: draftId, uid: UID, status: 'published', lifecycleStatus: 'published', eventType,
    /**
     * REQUIRED — see rd-analytics-10-seed.mjs. `/api/organizer/events` orders by
     * `updatedAt`, and Firestore excludes documents missing the ordered field, so a draft
     * written without it is published, resolvable by slug, and INVISIBLE in the event
     * selector. Every assertion would then photograph the "select an event" placeholder.
     */
    updatedAt: new Date(Date.now() - ORDER.indexOf(slug) * 60_000),
    eventDetails: {
      ...(base.eventDetails ?? {}),
      info: { ...((base.eventDetails ?? {}).info ?? {}), name: slug },
      seo:  { ...((base.eventDetails ?? {}).seo  ?? {}), urlSlug: slug },
    },
  }, { merge: true })
  await db.doc(`events/${slug}`).set({
    slug, uid: UID, draftId, lifecycleStatus: 'published', publishedAt: new Date(),
    totalCapacity: capacity, eventType,
    eventDetails: { info: { name: slug } },
    pricing: { passes: [{ id: 'pass-a', name: 'General' }] },
  })
}

async function seedRegistrations(slug, confirmed, checkedIn) {
  let batch = db.batch()
  for (let i = 0; i < confirmed; i++) {
    const isIn = i < checkedIn
    batch.set(db.collection('registrations').doc(`${slug}-r-${String(i).padStart(4, '0')}`), {
      organizerUid: UID, eventSlug: slug, eventName: slug,
      status: 'confirmed', paymentStatus: 'paid', amount: 100_000,
      passId: 'pass-a', passName: 'General', ticketCode: `${slug}-${i}`,
      checkedIn: isIn, ...(isIn ? { checkedInAt: new Date() } : {}),
      attendee: { name: `P ${i}`, email: `p${i}@${slug}.test`, phone: '', formResponses: {} },
      registeredAt: new Date(),
    })
    if ((i + 1) % 400 === 0) { await batch.commit(); batch = db.batch() }
  }
  await batch.commit()
  await db.doc(`registrationCounters/${slug}`).set({
    totalCount: confirmed, passCounts: { 'pass-a': confirmed },
    revenuePaise: confirmed * 100_000,
  }, { merge: true })
}

async function seedRollups(slug, days, perDay) {
  const now = Date.now()
  const batch = db.batch()
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86_400_000)
    batch.set(db.collection('organizerDailyStats').doc(`${UID}__${slug}__${day}`), {
      organizerUid: UID, eventId: slug, day,
      confirmed: perDay, cancelled: 0, revenuePaise: perDay * 100_000, checkedIn: 0,
    })
  }
  await batch.commit()
}

async function seedMessages(slug, spec) {
  let n = 0
  let batch = db.batch()
  for (const [count, row] of spec) {
    for (let i = 0; i < count; i++) {
      batch.set(db.collection('emailLogs').doc(`${slug}-m-${String(n).padStart(5, '0')}`), {
        eventId: slug, organizerUid: UID, ...row,
        sentAt: new Date(Date.now() - (n % 30) * 86_400_000),
      })
      n++
      if (n % 400 === 0) { await batch.commit(); batch = db.batch() }
    }
  }
  await batch.commit()
  return n
}

/** Reminders record EXECUTION, not delivery — the labels on screen must say so. */
async function seedReminders(slug) {
  const batch = db.batch()
  const rows = [
    { status: 'sent',      counts: { recipients: 420 } },
    { status: 'sent',      counts: { recipients: 380 } },
    { status: 'scheduled', counts: { recipients: 200 } },
    { status: 'failed',    counts: { recipients: 0 } },
  ]
  rows.forEach((r, i) =>
    batch.set(db.collection('scheduledReminders').doc(`${slug}-rem-${i}`), { eventId: slug, ...r }))
  await batch.commit()
}

async function seedCertificates(slug, issued, downloaded) {
  let batch = db.batch()
  for (let i = 0; i < issued; i++) {
    batch.set(db.collection('certificates').doc(`${slug}-cert-${i}`), {
      eventId: slug, downloadCount: i < downloaded ? 1 + (i % 3) : 0,
    })
    if ((i + 1) % 400 === 0) { await batch.commit(); batch = db.batch() }
  }
  await batch.commit()
}

for (const [slug, eventType, capacity, messages] of SCENARIOS) {
  await publish(slug, eventType, capacity)
  await seedRegistrations(slug, 60, 20)
  await seedRollups(slug, 30, 2)
  const sent = await seedMessages(slug, messages)
  // The quiet event gets no reminders and no certificates either — every communication
  // figure on it must be a measured zero, and none of them may be "unavailable".
  if (messages.length) {
    await seedReminders(slug)
    await seedCertificates(slug, 30, 12)
  }
  console.log(`${slug.padEnd(20)} ${eventType.padEnd(12)} messages=${String(sent).padStart(5)}`)
}

console.log('\nRD-ANALYTICS-11 fixtures seeded.')
process.exit(0)
