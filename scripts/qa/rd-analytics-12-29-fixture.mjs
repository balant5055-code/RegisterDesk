/* RD-ANALYTICS-12-29 — registration composition fixtures. EMULATOR ONLY.
 *
 * Two events in ONE workspace so isolation is photographable, with a source population
 * that exercises every honest state:
 *
 *   a29-mix    online + walk-in + pre-field ("not recorded") rows across every status;
 *              three passes so the pass mix has a remainder-free list; rules email ON,
 *              mobile OFF
 *   a29-clean  online only, no legacy rows — the "not recorded" column must NOT appear;
 *              rules both OFF
 *
 *   node rd-analytics-12-29-fixture.mjs
 */
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('Refusing to run outside the emulator.'); process.exit(1) }
const PROJECT = process.env.GCLOUD_PROJECT ?? ''
if (!PROJECT.startsWith('demo-')) { console.error(`Refusing to run outside a demo- project (got "${PROJECT}").`); process.exit(1) }
if (!getApps().length) initializeApp({ projectId: PROJECT })
const db = getFirestore()

const UID = 'profiling-organizer-uid'

let BASE_DRAFT = null
async function baseDraft() {
  if (BASE_DRAFT) return BASE_DRAFT
  const snap = await db.collection(`users/${UID}/eventDrafts`).limit(1).get()
  BASE_DRAFT = snap.empty ? {} : (snap.docs[0].data() ?? {})
  return BASE_DRAFT
}

async function publish(slug, eventType, order, rules, passes) {
  const draftId = `${slug}-draft`
  const base = await baseDraft()
  await db.doc(`users/${UID}/eventDrafts/${draftId}`).set({
    ...base,
    id: draftId, uid: UID, status: 'published', lifecycleStatus: 'published', eventType,
    updatedAt: new Date(Date.now() - order * 60_000),
    eventDetails: {
      ...(base.eventDetails ?? {}),
      info: { ...((base.eventDetails ?? {}).info ?? {}), name: slug },
      seo:  { ...((base.eventDetails ?? {}).seo  ?? {}), urlSlug: slug },
    },
  }, { merge: true })
  await db.doc(`events/${slug}`).set({
    slug, uid: UID, draftId, lifecycleStatus: 'published', publishedAt: new Date(Date.now() - 90 * 86_400_000),
    totalCapacity: 1_000, eventType,
    eventDetails: { info: { name: slug } },
    registrationForm: { registrationRules: rules },
    pricing: { passes: passes.map(([id, name]) => ({ id, name })) },
  })
}

async function wipe(slug) {
  const snap = await db.collection('registrations').where('eventSlug', '==', slug).get()
  let batch = db.batch(); let n = 0
  for (const d of snap.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = db.batch() } }
  await batch.commit()
}

let seq = 0
async function rows(slug, spec) {
  let batch = db.batch(); let n = 0
  const passCounts = {}
  for (const [count, status, source, passId] of spec) {
    for (let i = 0; i < count; i++) {
      batch.set(db.collection('registrations').doc(`${slug}-r-${String(seq++).padStart(5, '0')}`), {
        organizerUid: UID, eventSlug: slug, eventName: slug, status, paymentStatus: 'not_required', amount: 0,
        passId, passName: passId, ticketCode: `${slug}-${seq}`, checkedIn: false,
        attendee: { name: `P ${seq}`, email: `p${seq}@${slug}.test`, phone: '', formResponses: {} },
        registeredAt: new Date(Date.now() - (n % 40) * 86_400_000),
        ...(source ? { registrationSource: source } : {}),
      })
      if (status === 'confirmed') passCounts[passId] = (passCounts[passId] ?? 0) + 1
      if (++n % 400 === 0) { await batch.commit(); batch = db.batch() }
    }
  }
  await batch.commit()
  const confirmed = Object.values(passCounts).reduce((s, v) => s + v, 0)
  await db.doc(`registrationCounters/${slug}`).set({ totalCount: confirmed, passCounts, revenuePaise: 0 }, { merge: false })
  return n
}

{
  const slug = 'a29-mix'
  await wipe(slug)
  await publish(slug, 'workshop', 0, { limitPerEmail: true, limitPerMobile: false },
                [['general', 'General'], ['student', 'Student'], ['vip', 'VIP']])
  const n = await rows(slug, [
    [300, 'confirmed', 'online', 'general'],
    [120, 'confirmed', 'online', 'student'],
    [ 40, 'confirmed', 'walkin', 'general'],
    [ 20, 'confirmed', 'walkin', 'vip'],
    [ 60, 'confirmed', null,     'general'],   // pre-field rows: NOT online
    [ 15, 'pending',   'online', 'general'],
    [ 25, 'cancelled', 'online', 'general'],
    [  5, 'cancelled', 'walkin', 'general'],
    [ 10, 'cancelled', null,     'general'],
    [  3, 'rejected',  'online', 'student'],
  ])
  console.log(`${slug}: ${n} registrations (online 463, walk-in 65, not recorded 70; confirmed 540)`)
}
{
  const slug = 'a29-clean'
  await wipe(slug)
  await publish(slug, 'meetup', 1, { limitPerEmail: false, limitPerMobile: false }, [['general', 'General']])
  const n = await rows(slug, [
    [ 48, 'confirmed', 'online', 'general'],
    [  2, 'cancelled', 'online', 'general'],
  ])
  console.log(`${slug}: ${n} registrations (online 50, walk-in 0, not recorded 0)`)
}
console.log('\nRD-ANALYTICS-12-29 fixtures seeded.')
process.exit(0)
