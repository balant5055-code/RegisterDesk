/* RD-ANALYTICS-12-28 — communication intelligence fixtures. EMULATOR ONLY.
 *
 * Two events in ONE workspace so isolation is photographable — their figures must differ —
 * and every message row carries what the windowed reads key on: `organizerUid`, `eventSlug`
 * and a real `createdAt`. The RD-11 seed wrote neither, which is correct for the lifetime
 * aggregates it exercised and useless for a window.
 *
 *   a28-intel   both channels; rows dated across the last 45 days INCLUDING one written at
 *               23:45 UTC on the day before the window starts (which is INSIDE the window
 *               in IST); broadcast rows with campaignId; bounces, complaints, WhatsApp read,
 *               wallet-held; 4 campaigns (3 in the window, 1 before); 600 reminders so the
 *               recipient page OVERFLOWS and the total is withheld; 30 certificates.
 *   a28-other   a small email-only event — different numbers on every figure.
 *
 *   node rd-analytics-12-28-fixture.mjs
 */
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

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
const IST = 330 * 60_000
const DAY = 86_400_000
const dayKey = ms => new Date(ms + IST).toISOString().slice(0, 10)
/** IST midnight (as a UTC instant) of the day `n` days before today's IST date. */
const istMidnightDaysAgo = n => Date.parse(`${dayKey(Date.now() - n * DAY)}T00:00:00.000Z`) - IST

let BASE_DRAFT = null
async function baseDraft() {
  if (BASE_DRAFT) return BASE_DRAFT
  const snap = await db.collection(`users/${UID}/eventDrafts`).limit(1).get()
  BASE_DRAFT = snap.empty ? {} : (snap.docs[0].data() ?? {})
  return BASE_DRAFT
}

async function publish(slug, eventType, order, publishedAt) {
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
    slug, uid: UID, draftId, lifecycleStatus: 'published',
    publishedAt: Timestamp.fromMillis(publishedAt),
    totalCapacity: 500, eventType,
    eventDetails: { info: { name: slug } },
    pricing: { passes: [{ id: 'pass-a', name: 'General' }] },
  })
  await db.doc(`registrationCounters/${slug}`).set({ totalCount: 40, passCounts: { 'pass-a': 40 }, revenuePaise: 0 }, { merge: true })
}

async function wipe(slug) {
  for (const [col, field] of [['emailLogs', 'eventId'], ['broadcastCampaigns', 'eventSlug'],
                              ['scheduledReminders', 'eventId'], ['certificates', 'eventId']]) {
    const snap = await db.collection(col).where(field, '==', slug).get()
    let batch = db.batch(); let n = 0
    for (const d of snap.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = db.batch() } }
    await batch.commit()
  }
}

let seq = 0
async function rows(slug, spec) {
  let batch = db.batch(); let n = 0
  for (const [count, row, at] of spec) {
    for (let i = 0; i < count; i++) {
      const createdAt = typeof at === 'function' ? at(i) : at
      batch.set(db.collection('emailLogs').doc(`${slug}-m-${String(seq++).padStart(5, '0')}`), {
        eventId: slug, eventSlug: slug, organizerUid: UID,
        templateKey: 'registration', recipientEmail: `p${i}@${slug}.test`, recipientName: `P ${i}`,
        subject: 's', provider: 'ses', registrationId: `${slug}-r-${i}`,
        ...row,
        createdAt: Timestamp.fromMillis(createdAt), updatedAt: Timestamp.fromMillis(createdAt),
      })
      if (++n % 400 === 0) { await batch.commit(); batch = db.batch() }
    }
  }
  await batch.commit()
  return n
}

const now = Date.now()
const inWindow  = i => now - (i % 25) * DAY                 // last 25 days (inside a 30-day window)
const before    = i => now - (32 + (i % 20)) * DAY          // 32–51 days ago (previous window, mostly)
// 23:45 UTC on the IST day BEFORE the 30-day window's first day ⇒ 05:15 IST on the window's
// first day. A UTC bucketing puts it OUTSIDE; the IST window must count it.
const boundaryUtc = istMidnightDaysAgo(29) + IST - 15 * 60_000  // = (window day 1) 00:00 IST − 15 min... see below
// Explanation: istMidnightDaysAgo(29) is 00:00 IST of the window's first day, expressed in UTC
// (i.e. 18:30 UTC the previous day). Adding IST gives 00:00 UTC of that IST day; minus 15 min
// is 23:45 UTC of the PREVIOUS UTC day — which is 05:15 IST on the window's first day.

// ── a28-intel ─────────────────────────────────────────────────────────────────
{
  const slug = 'a28-intel'
  await wipe(slug)
  await publish(slug, 'conference', 0, now - 120 * DAY)
  const n = await rows(slug, [
    // automatic email, inside the window
    [ 300, { status: 'delivered' }, inWindow ],
    [  60, { status: 'sent' }, inWindow ],
    [  20, { status: 'failed', error: 'bounce' }, inWindow ],
    [   3, { status: 'failed', error: 'complaint' }, inWindow ],
    [   7, { status: 'failed', error: 'SES 554' }, inWindow ],
    [   5, { status: 'queued' }, inWindow ],
    [   4, { status: 'skipped', error: 'suppressed' }, inWindow ],
    // the IST-boundary row: attempted at 23:45 UTC the day before the window (05:15 IST day 1)
    [   1, { status: 'delivered', templateKey: 'boundary' }, boundaryUtc ],
    // automatic email, previous window
    [ 150, { status: 'delivered' }, before ],
    [  10, { status: 'failed', error: 'bounce' }, before ],
    // broadcast email campaign rows (campaignId + templateKey 'broadcast')
    [ 200, { status: 'delivered', templateKey: 'broadcast', campaignId: 'a28-c1' }, inWindow ],
    [  50, { status: 'sent',      templateKey: 'broadcast', campaignId: 'a28-c2' }, inWindow ],
    [ 100, { status: 'delivered', templateKey: 'broadcast', campaignId: 'a28-c0' }, before ],
    // WhatsApp transactional
    [  80, { status: 'delivered', channel: 'whatsapp', provider: 'meta', waStatus: 'delivered', costPaise: 50 }, inWindow ],
    [  40, { status: 'delivered', channel: 'whatsapp', provider: 'meta', waStatus: 'read', costPaise: 50 }, inWindow ],
    [  12, { status: 'failed',    channel: 'whatsapp', provider: 'meta', waStatus: 'failed', costPaise: 0 }, inWindow ],
    [   9, { status: 'failed',    channel: 'whatsapp', provider: 'meta', deliveryUnknown: true, costPaise: 0 }, inWindow ],
    [   6, { status: 'skipped',   channel: 'whatsapp', provider: 'meta', error: 'Insufficient wallet balance', costPaise: 0 }, inWindow ],
    [  30, { status: 'delivered', channel: 'whatsapp', provider: 'meta', waStatus: 'delivered', costPaise: 50 }, before ],
    // WhatsApp broadcast
    [  70, { status: 'delivered', channel: 'whatsapp', provider: 'meta', waStatus: 'delivered', templateKey: 'broadcast', campaignId: 'a28-c3', costPaise: 50 }, inWindow ],
  ])
  const camps = [
    ['a28-c0', 'email',    'sent',      now - 40 * DAY],
    ['a28-c1', 'email',    'sent',      now - 20 * DAY],
    ['a28-c2', 'email',    'partial',   now - 5 * DAY],
    ['a28-c3', 'whatsapp', 'sent',      now - 2 * DAY],
    ['a28-c4', 'email',    'scheduled', now - 1 * DAY],
    ['a28-c5', 'email',    'draft',     now - 1 * DAY],
  ]
  const b = db.batch()
  for (const [id, channel, status, at] of camps) {
    b.set(db.doc(`broadcastCampaigns/${id}`), {
      organizerUid: UID, eventId: slug, eventSlug: slug, eventName: slug, channel, status,
      audience: 'confirmed', subject: id, html: '<p>x</p>', recipientCount: 100,
      successCount: status === 'sent' ? 100 : status === 'partial' ? 50 : 0,
      failCount: status === 'partial' ? 50 : 0,
      estimatedCostPaise: 0, actualCostPaise: channel === 'whatsapp' ? 5_000 : 0, failReason: null,
      createdAt: Timestamp.fromMillis(at), scheduledFor: null, sentAt: status === 'sent' || status === 'partial' ? Timestamp.fromMillis(at + 3_600_000) : null,
    })
  }
  await b.commit()
  // 600 reminders: status counts must be exact (aggregates), recipient total WITHHELD (page > 500).
  let rb = db.batch(); let rn = 0
  for (let i = 0; i < 600; i++) {
    const status = i < 500 ? 'sent' : i < 560 ? 'scheduled' : i < 580 ? 'partial' : 'failed'
    rb.set(db.doc(`scheduledReminders/${slug}-rem-${i}`), { eventId: slug, organizerUid: UID, status, channel: 'email', counts: { recipients: 10, sent: 10, failed: 0, skipped: 0 } })
    if (++rn % 400 === 0) { await rb.commit(); rb = db.batch() }
  }
  await rb.commit()
  const cb = db.batch()
  for (let i = 0; i < 30; i++) cb.set(db.doc(`certificates/${slug}-cert-${i}`), { eventId: slug, downloadCount: i < 12 ? 1 : 0 })
  await cb.commit()
  console.log(`${slug}: ${n} message rows, ${camps.length} campaigns, 600 reminders, 30 certificates`)
  console.log(`  boundary row at ${new Date(boundaryUtc).toISOString()} (IST day ${dayKey(boundaryUtc)}; window day 1 = ${dayKey(istMidnightDaysAgo(29))})`)
}

// ── a28-other ─────────────────────────────────────────────────────────────────
{
  const slug = 'a28-other'
  await wipe(slug)
  await publish(slug, 'workshop', 1, now - 60 * DAY)
  const n = await rows(slug, [
    [ 25, { status: 'delivered' }, inWindow ],
    [  2, { status: 'failed', error: 'bounce' }, inWindow ],
  ])
  await db.doc('broadcastCampaigns/a28-o1').set({
    organizerUid: UID, eventId: slug, eventSlug: slug, eventName: slug, channel: 'email', status: 'sent',
    audience: 'all', subject: 'o1', html: '<p>x</p>', recipientCount: 25, successCount: 25, failCount: 0,
    estimatedCostPaise: 0, actualCostPaise: 0, failReason: null,
    createdAt: Timestamp.fromMillis(now - 3 * DAY), scheduledFor: null, sentAt: Timestamp.fromMillis(now - 3 * DAY),
  })
  console.log(`${slug}: ${n} message rows, 1 campaign`)
}

console.log('\nRD-ANALYTICS-12-28 fixtures seeded.')
process.exit(0)
