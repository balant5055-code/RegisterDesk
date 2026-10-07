/* RD-ANALYTICS-12-31 — makes `a29-mix` (seeded by rd-analytics-12-29-fixture.mjs) fire the two
 * card families the 12-28/12-29 fixtures cannot: capacity (540 confirmed against 600) and a
 * revenue movement in the IST daily rollups (₹1,000/day for the last 30 days against ₹500/day
 * for the 30 before) that only a `transactions` viewer may see. EMULATOR ONLY.
 *
 *   node rd-analytics-12-31-fixture.mjs
 */
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('Refusing to run outside the emulator.'); process.exit(1) }
const PROJECT = process.env.GCLOUD_PROJECT ?? ''
if (!PROJECT.startsWith('demo-')) { console.error(`Refusing to run outside a demo- project (got "${PROJECT}").`); process.exit(1) }
if (!getApps().length) initializeApp({ projectId: PROJECT })
const db = getFirestore()

const UID = 'profiling-organizer-uid'
const SLUG = 'a29-mix'
const DAY = 86_400_000
const dayKey = ms => new Date(ms + 330 * 60_000).toISOString().slice(0, 10)

await db.doc(`events/${SLUG}`).set({ totalCapacity: 600 }, { merge: true })

const now = Date.now()
let batch = db.batch(); let n = 0
for (let i = 0; i < 60; i++) {
  const day = dayKey(now - i * DAY)
  const recent = i < 30
  batch.set(db.doc(`organizerDailyStats/${UID}__${SLUG}__${day}`), {
    organizerUid: UID, eventId: SLUG, day,
    confirmed: recent ? 3 : 1, cancelled: 0, revenuePaise: recent ? 100_000 : 50_000, checkedIn: 0,
  })
  if (++n % 400 === 0) { await batch.commit(); batch = db.batch() }
}
await batch.commit()
// Coverage marker so the previous window is on record.
await db.doc(`organizerDailyStats/${UID}__meta`).set({ organizerUid: UID, since: dayKey(now - 120 * DAY) }, { merge: true })
console.log(`${SLUG}: capacity 600 (540 confirmed → 90%), rollups 60 days (₹1,000/day recent vs ₹500/day prior, 3 vs 1 confirmed/day)`)
process.exit(0)
