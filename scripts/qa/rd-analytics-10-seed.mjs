/* RD-ANALYTICS-10 — the event-type × capability matrix, as real events. EMULATOR ONLY.
 *
 * The point of this fixture is that the matrix cannot be faked. Every combination below is
 * a real published event with a real `identifierConfigs` document, so the browser pass
 * exercises the same resolution path production would.
 *
 * It writes TEN events — every event type the product supports — with capabilities chosen
 * to break the old `eventType === 'sports'` rule in both directions:
 *
 *   sports      + identifiers ON  + timing ON    ← the case the old rule got right
 *   sports      + identifiers ON  + timing OFF   ← old rule showed a timing panel: WRONG
 *   sports      + identifiers OFF + timing OFF   ← old rule showed both: WRONG
 *   conference  + identifiers ON  + timing ON    ← old rule showed neither: WRONG
 *   workshop    + identifiers ON  + timing OFF
 *   exhibition  + identifiers OFF + timing ON    ← chips without platform-issued numbers
 *   cultural / fundraising / meetup / community / awards + neither
 *
 * Also seeds an OVER-ATTENDED event: more checked in than confirmed, so the
 * over-attendance state can be photographed rather than imagined.
 *
 *   node rd-analytics-10-seed.mjs
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

/** IST business-day key — the rule lib/dashboard/dailyStats.ts writes with. */
const dayKey = ms => new Date(ms + 330 * 60_000).toISOString().slice(0, 10)

/**
 * [slug, eventType, identifiers, identifierLabel, timing, timingLabel, capacity]
 *
 * Labels are deliberately varied: a fixture that called every identifier a "Bib" could not
 * catch a hardcoded noun in the UI.
 */
const MATRIX = [
  ['a10-sports-both',      'sports',      true,  'Bib',              true,  'Timing Chip',  500],
  ['a10-sports-ids',       'sports',      true,  'Bib',              false, null,           400],
  ['a10-sports-none',      'sports',      false, null,               false, null,           300],
  ['a10-conference-both',  'conference',  true,  'Badge',            true,  'Transponder',  250],
  ['a10-workshop-ids',     'workshop',    true,  'Token',            false, null,           null],
  ['a10-exhibition-timing','exhibition',  false, null,               true,  'Wristband',    null],
  ['a10-cultural-none',    'cultural',    false, null,               false, null,           null],
  ['a10-fundraising-none', 'fundraising', false, null,               false, null,           null],
  ['a10-meetup-none',      'meetup',      false, null,               false, null,           60],
  ['a10-community-none',   'community',   false, null,               false, null,           null],
  ['a10-awards-none',      'awards',      false, null,               false, null,           null],
]

/**
 * The draft the event SELECTOR can actually render.
 *
 * Resolved once and cloned for every fixture. A hand-assembled three-field draft is
 * invisible to the events list — the same trap `rd-analytics-06-seed.mjs` documents — and
 * an invisible event cannot be selected, so every capability assertion would test the
 * "select an event" placeholder instead of the module.
 */
/** Slug order, used only to stamp deterministic `updatedAt` values. */
const MATRIX_ORDER = [...MATRIX.map(m => m[0]), 'a10-over-attended']

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
     * REQUIRED, and the reason this fixture's twelve events were invisible.
     *
     * `/api/organizer/events` lists drafts with `orderBy('updatedAt', 'desc')`. Firestore
     * excludes documents that do not carry the ordered field, so a draft written without
     * it is published, resolvable by slug through the API, and completely absent from the
     * event selector — which made every capability assertion test the "Select a single
     * event" placeholder instead of the module.
     *
     * Each event is stamped a distinct instant so the list order is deterministic rather
     * than dependent on write timing.
     */
    updatedAt: new Date(Date.now() - MATRIX_ORDER.indexOf(slug) * 60_000),
    eventDetails: {
      ...(base.eventDetails ?? {}),
      info: { ...((base.eventDetails ?? {}).info ?? {}), name: slug },
      seo:  { ...((base.eventDetails ?? {}).seo ?? {}), urlSlug: slug },
    },
  }, { merge: true })
  await db.doc(`events/${slug}`).set({
    slug, uid: UID, draftId, lifecycleStatus: 'published', publishedAt: new Date(),
    totalCapacity: capacity, eventType,
    eventDetails: { info: { name: slug } },
    pricing: { passes: [{ id: 'pass-a', name: 'General' }] },
  })
  return draftId
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
      // The field identifier progress is counted on. Two thirds hold one.
      hasIdentifier: i % 3 !== 0,
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

/** Thirty days of check-in history so the trend has a real shape. */
async function seedRollups(slug, days, perDay) {
  const now = Date.now()
  const batch = db.batch()
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86_400_000)
    batch.set(db.collection('organizerDailyStats').doc(`${UID}__${slug}__${day}`), {
      organizerUid: UID, eventId: slug, day,
      confirmed: perDay, cancelled: 0, revenuePaise: perDay * 100_000,
      checkedIn: i < 10 ? Math.round(perDay * 1.5) : 0,
    })
  }
  await batch.commit()
}

async function seedTimingTags(slug, n) {
  let batch = db.batch()
  for (let i = 0; i < n; i++) {
    batch.set(db.collection('identifierTagLocks').doc(`${slug}__tag-${i}`), {
      eventSlug: slug, tag: `TAG-${i}`, normalizedTag: `tag-${i}`,
      state: i < n - 2 ? 'assigned' : 'replaced',
      registrationId: `${slug}-r-${String(i).padStart(4, '0')}`,
      identifierValue: null, passId: 'pass-a', replacedBy: null, reason: null,
      source: 'manual', jobId: null, assignedBy: UID, assignedAt: new Date(), updatedAt: new Date(),
    })
    if ((i + 1) % 400 === 0) { await batch.commit(); batch = db.batch() }
  }
  await batch.commit()
}

for (const [slug, eventType, ids, idLabel, timing, timingLabel, capacity] of MATRIX) {
  await publish(slug, eventType, capacity)
  await seedRegistrations(slug, 60, 24)
  await seedRollups(slug, 30, 2)

  // The capability document. Written ONLY when something is enabled, so the events with
  // neither capability are genuinely unconfigured — the state most events are in.
  if (ids || timing) {
    await db.collection('identifierConfigs').doc(slug).set({
      eventSlug: slug, enabled: ids, label: idLabel ?? 'Bib', preset: 'bib',
      ...(timing ? { tagMapping: { enabled: true, mode: 'mapped', label: timingLabel } } : {}),
    })
  }
  if (timing) await seedTimingTags(slug, 40)
  console.log(`${slug.padEnd(24)} ${eventType.padEnd(12)} ids=${ids} timing=${timing} capacity=${capacity}`)
}

// ── The over-attendance event: more admitted than the roster confirms ─────────
const OVER = 'a10-over-attended'
await publish(OVER, 'community', 100)
await seedRegistrations(OVER, 120, 120)
// Then cancel 20 of them AFTER they were admitted — the realistic cause of >100%.
{
  const batch = db.batch()
  for (let i = 0; i < 20; i++) {
    batch.update(db.collection('registrations').doc(`${OVER}-r-${String(i).padStart(4, '0')}`),
                 { status: 'cancelled' })
  }
  await batch.commit()
}
await seedRollups(OVER, 30, 4)
console.log(`${OVER.padEnd(24)} community    100 confirmed, 120 checked in (over-attendance)`)
