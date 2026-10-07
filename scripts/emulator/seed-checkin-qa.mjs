/* RD-CHECKIN-2.0 · browser-QA fixture. EMULATOR ONLY. DEV TOOLING.
 *
 *   npx dotenv-cli -e .env.emulator -- node scripts/emulator/seed-checkin-qa.mjs
 *   npx dotenv-cli -e .env.emulator -- node scripts/emulator/seed-checkin-qa.mjs --clean
 *
 * ═══ WHAT THIS SEEDS AND WHY ══════════════════════════════════════════════════
 * One organizer, two published events, and a population shaped so the acceptance
 * pass can reach every state the workspace can render WITHOUT contriving anything:
 *
 *   • 40 confirmed attendees, all with bibs → the ordinary admission path
 *   • 1 attendee with NO bib               → the identifier prompt
 *   • 2 attendees named "Arun …"           → an ambiguous name, which must not auto-select
 *   • 1 already checked in                 → the duplicate / already-checked-in card
 *   • cancelled / pending / refunded       → each refusal with its own message
 *   • a SECOND event the staff account is NOT assigned to → the 403 path
 *
 * Deterministic: fixed ids, fixed timestamps, `set()` not `add()`. Re-running
 * overwrites rather than duplicating, so a screenshot taken twice is the same
 * screenshot.
 *
 * ═══ SAFETY ═══════════════════════════════════════════════════════════════════
 * Refuses to run unless both emulator hosts are set AND the project id is a
 * `demo-` project. Pointed at production this would be destructive.
 */
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST
const FS_HOST   = process.env.FIRESTORE_EMULATOR_HOST
const PROJECT   = process.env.GCLOUD_PROJECT ?? ''

if (!AUTH_HOST || !FS_HOST || !PROJECT.startsWith('demo-')) {
  console.error('Refusing to seed: emulator hosts unset or non-demo project.')
  process.exit(2)
}

export const QA = {
  uid:      'qa-checkin-organizer',
  email:    'qa.checkin@registerdesk.test',
  password: 'QaCheckinPassw0rd!',
  orgName:  'Meridian Race Company',

  eventId:   'qa-checkin-event',
  slug:      'meridian-city-half',
  eventName: 'Meridian City Half Marathon',

  otherEventId:   'qa-checkin-other',
  otherSlug:      'meridian-trail-10k',
  otherEventName: 'Meridian Trail 10K',
}

const N_CONFIRMED = 40
const CREATED_AT  = new Date('2026-08-01T04:30:00.000Z')

if (!getApps().length) initializeApp({ projectId: PROJECT })
const db = getFirestore()
const auth = getAuth()

const ticket = i => `RD-MCH-${String(i).padStart(5, '0')}`
const regId  = i => `${QA.slug}-r-${String(i).padStart(5, '0')}`

/** Names that read like a real start list, so the screenshots are legible. */
const FIRST = ['Aditya', 'Meera', 'Rohan', 'Kavya', 'Nikhil', 'Ananya', 'Vikram', 'Divya',
  'Sanjay', 'Priya', 'Karthik', 'Shreya', 'Rahul', 'Nithya', 'Arjun', 'Lakshmi',
  'Manish', 'Sneha', 'Vivek', 'Pooja']
const LAST = ['Sharma', 'Iyer', 'Reddy', 'Nair', 'Menon', 'Patel', 'Krishnan', 'Desai',
  'Rao', 'Verma']

async function clean() {
  const del = async ids => {
    for (let k = 0; k < ids.length; k += 400) {
      const b = db.batch()
      ids.slice(k, k + 400).forEach(id => b.delete(db.collection('registrations').doc(id)))
      await b.commit()
    }
  }
  // Sub-collections first — deleting a parent leaves them orphaned.
  const all = await db.collection('registrations').where('eventSlug', '==', QA.slug).get()
  for (const d of all.docs) {
    for (const sub of ['checkinHistory', 'auditLog']) {
      const s = await d.ref.collection(sub).get()
      if (!s.empty) { const b = db.batch(); s.docs.forEach(x => b.delete(x.ref)); await b.commit() }
    }
  }
  await del(all.docs.map(d => d.id))

  // ORPHANED history. Firestore does not cascade: deleting a registration leaves
  // its `checkinHistory` subcollection behind, so entries written by a previous run
  // survive into the next one and surface as "Registration removed" rows. Harmless
  // in the product (that fallback is deliberate) but it makes a fixture
  // non-deterministic, so the collection group is swept explicitly.
  const orphans = await db.collectionGroup('checkinHistory').where('eventSlug', '==', QA.slug).get()
  if (!orphans.empty) {
    for (let k = 0; k < orphans.docs.length; k += 400) {
      const b = db.batch()
      orphans.docs.slice(k, k + 400).forEach(d => b.delete(d.ref))
      await b.commit()
    }
  }

  const locks = await db.collection('identifierLocks').where('eventSlug', '==', QA.slug).get()
  if (!locks.empty) { const b = db.batch(); locks.docs.forEach(d => b.delete(d.ref)); await b.commit() }

  const staff = await db.collection('staffAccounts').where('organizerUid', '==', QA.uid).get()
  for (const d of staff.docs) {
    await auth.deleteUser(d.id).catch(() => {})
    await db.collection('staffUsernames').doc(d.data().username).delete().catch(() => {})
    await d.ref.delete()
  }
  const members = await db.collection('teamMembers').where('organizerUid', '==', QA.uid).get()
  if (!members.empty) { const b = db.batch(); members.docs.forEach(d => b.delete(d.ref)); await b.commit() }

  const shards = await db.collection(`registrationCounters/${QA.slug}/attendanceShards`).get()
  if (!shards.empty) { const b = db.batch(); shards.docs.forEach(d => b.delete(d.ref)); await b.commit() }

  await Promise.all([
    db.doc(`registrationCounters/${QA.slug}`).delete().catch(() => {}),
    db.doc(`identifierConfigs/${QA.slug}`).delete().catch(() => {}),
    db.doc(`users/${QA.uid}/eventDrafts/${QA.eventId}`).delete().catch(() => {}),
    db.doc(`users/${QA.uid}/eventDrafts/${QA.otherEventId}`).delete().catch(() => {}),
    db.doc(`events/${QA.slug}`).delete().catch(() => {}),
    db.doc(`events/${QA.otherSlug}`).delete().catch(() => {}),
  ])
  // The organizer itself is a fixture too. Leaving it behind means "cleaned" is not
  // true, and the next run would silently reuse a half-removed account.
  await auth.deleteUser(QA.uid).catch(() => {})
  await db.doc(`users/${QA.uid}`).delete().catch(() => {})

  console.log(JSON.stringify({
    cleaned: all.size, staff: staff.size, organizer: 'removed',
  }))
}

async function seedAuthUser() {
  const props = {
    email: QA.email, password: QA.password, emailVerified: true, displayName: 'Meridian Ops',
  }
  try { await auth.createUser({ uid: QA.uid, ...props }) }
  catch (e) {
    if (e.code !== 'auth/uid-already-exists' && e.code !== 'auth/email-already-exists') throw e
    await auth.updateUser(QA.uid, props)
  }
}

const passes = [
  { id: 'p21', name: 'Half Marathon', price: 0, unlimited: true,  quantity: null, status: 'active' },
  { id: 'p10', name: '10K',           price: 0, unlimited: false, quantity: 500,  status: 'active' },
]

const registrationForm = {
  fields: [
    { id: 'f_tshirt', label: 'T-shirt size', type: 'select' },
    { id: 'f_emerg',  label: 'Emergency contact', type: 'text' },
    { id: 'f_blood',  label: 'Blood group', type: 'text' },
  ],
  registrationRules: { limitPerEmail: false, limitPerMobile: false },
}

const eventBody = (name, slug) => ({
  uid: QA.uid,
  status: 'published',
  lifecycleStatus: 'published',
  eventDetails: {
    info: { name, description: 'Emulator QA fixture.' },
    seo:  { urlSlug: slug },
    schedule: { startDate: '2026-09-20', endDate: '2026-09-20' },
  },
  pricing: { eventType: 'free', passes },
  registrationForm,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
})

async function seed() {
  await seedAuthUser()

  await db.doc(`users/${QA.uid}`).set({
    uid: QA.uid, name: 'Meridian Ops', email: QA.email,
    organizationName: QA.orgName, role: 'organizer',
    mobile: { e164: '+919000000000', countryCode: '+91', verified: false },
    createdAt: CREATED_AT, updatedAt: CREATED_AT,
  }, { merge: true })

  await Promise.all([
    db.doc(`users/${QA.uid}/eventDrafts/${QA.eventId}`).set(eventBody(QA.eventName, QA.slug)),
    db.doc(`users/${QA.uid}/eventDrafts/${QA.otherEventId}`).set(eventBody(QA.otherEventName, QA.otherSlug)),
    db.doc(`events/${QA.slug}`).set(eventBody(QA.eventName, QA.slug)),
    db.doc(`events/${QA.otherSlug}`).set(eventBody(QA.otherEventName, QA.otherSlug)),
    // Identifiers ON, so the bib appears on rows and on the verification card, and
    // the one attendee without a value exercises the blocking prompt.
    db.doc(`identifierConfigs/${QA.slug}`).set({
      eventSlug: QA.slug, enabled: true, label: 'Bib Number',
      format: { caseMode: 'preserve', allowManualOverride: true },
      autoAssignOnRegistration: false,
      pools: [{ id: 'default', name: 'Default', ranges: [{ start: 1000, end: 9999 }], passIds: [] }],
      defaultPoolId: 'default',
    }),
  ])

  const rows = []
  let checkedIn = 0

  for (let i = 0; i < N_CONFIRMED; i++) {
    // Two people sharing a first name, so ambiguity is real rather than staged.
    const name = i === 5  ? 'Arun Kumar'
               : i === 17 ? 'Arun Prasad'
               : `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`

    // One attendee arrives with no bib — the identifier prompt case.
    const noBib = i === 9
    const bib   = noBib ? null : String(1000 + i)

    // One is already through the gate — the duplicate card without scanning twice.
    const already = i === 2
    if (already) checkedIn++

    rows.push([db.collection('registrations').doc(regId(i)), {
      organizerUid: QA.uid, eventSlug: QA.slug, eventName: QA.eventName,
      status: 'confirmed', paymentStatus: 'paid',
      passId: i % 3 === 0 ? 'p10' : 'p21',
      passName: i % 3 === 0 ? '10K' : 'Half Marathon',
      amount: 0,
      attendee: {
        name,
        email: `${name.toLowerCase().replace(/\s+/g, '.')}.${i}@runners.test`,
        // Stored WITH separators, the shape the validator permits and the form
        // that a single canonical lookup would have missed.
        phone: `+91 9${String(8000000 + i).padStart(9, '0')}`.slice(0, 17),
        formResponses: { f_tshirt: ['S', 'M', 'L', 'XL'][i % 4], f_emerg: '+91 90000 11111', f_blood: 'O+' },
      },
      ticketCode: ticket(i),
      checkedIn: already,
      ...(already ? { checkedInAt: new Date('2026-09-20T01:32:11.000Z'), checkedInBy: QA.uid, checkedInSource: 'qr' } : {}),
      ...(bib ? { identifier: { value: bib, label: 'Bib Number', state: 'assigned' } } : {}),
      registeredAt: new Date(CREATED_AT.getTime() + i * 60_000),
    }])

    if (bib) {
      rows.push([db.collection('identifierLocks').doc(`${QA.slug}__${bib}`), {
        eventSlug: QA.slug, value: bib, numeric: Number(bib), poolId: 'default',
        templateId: null, state: already ? 'consumed' : 'assigned',
        registrationId: regId(i), everCheckedIn: already, reason: null,
        assignedAt: CREATED_AT, releasedAt: null, createdAt: CREATED_AT, updatedAt: CREATED_AT,
      }])
    }
  }

  // Ineligible populations — one of each refusal.
  // NAMES MUST NOT CONTAIN THE STATE. The first pass named these "Ravi Cancelled",
  // "Neha Refunded" and so on — and the acceptance assertion for "cancelled" then
  // matched the ATTENDEE NAME rather than any refusal. A false PASS that hid a real
  // defect for a whole run. Neutral names make the assertion mean what it says.
  const blocked = [
    [90, 'cancelled', 'paid',     'Ravi Bhatt'],
    [91, 'pending',   'pending',  'Sunita Joshi'],
    [92, 'rejected',  'paid',     'Imran Qureshi'],
    [93, 'confirmed', 'refunded', 'Neha Kulkarni'],
  ]
  for (const [i, status, paymentStatus, name] of blocked) {
    rows.push([db.collection('registrations').doc(regId(i)), {
      organizerUid: QA.uid, eventSlug: QA.slug, eventName: QA.eventName,
      status, paymentStatus, passId: 'p21', passName: 'Half Marathon', amount: 0,
      attendee: { name, email: `blocked${i}@runners.test`, phone: `+91 97000000${i}`, formResponses: {} },
      ticketCode: ticket(i), checkedIn: false,
      registeredAt: new Date(CREATED_AT.getTime() + i * 60_000),
    }])
  }

  for (let k = 0; k < rows.length; k += 400) {
    const b = db.batch()
    rows.slice(k, k + 400).forEach(([ref, d]) => b.set(ref, d))
    await b.commit()
  }

  await db.doc(`registrationCounters/${QA.slug}`).set({
    eventSlug: QA.slug, organizerUid: QA.uid,
    totalCount: N_CONFIRMED, pendingCount: 1, cancelledCount: 1, rejectedCount: 1,
    checkedInCount: checkedIn, revenuePaise: 0,
    passCounts: { p21: N_CONFIRMED }, statsVersion: 2,
    updatedAt: CREATED_AT,
  }, { merge: true })

  console.log(JSON.stringify({
    organizer: { email: QA.email, password: QA.password },
    event:     { id: QA.eventId, slug: QA.slug, name: QA.eventName },
    other:     { id: QA.otherEventId, slug: QA.otherSlug },
    truth: {
      confirmed: N_CONFIRMED, checkedIn,
      ambiguousName: 'Arun', ambiguous: ['Arun Kumar', 'Arun Prasad'],
      noBibTicket: ticket(9), noBibName: 'Kavya Nair',
      alreadyCheckedInTicket: ticket(2),
      firstTicket: ticket(0), firstBib: '1000',
      cancelledTicket: ticket(90), refundedTicket: ticket(93),
    },
  }, null, 1))
}

;(process.argv.includes('--clean') ? clean() : seed())
  .catch(e => { console.error('FATAL', e); process.exit(1) })
