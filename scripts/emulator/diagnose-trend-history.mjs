/* RD-DASHBOARD-08 — is an empty Registration Trend a DATA gap or a RETRIEVAL bug?
 *
 *   dotenv -e .env.emulator -- node scripts/emulator/diagnose-trend-history.mjs
 *
 * ═══ THE QUESTION ════════════════════════════════════════════════════════════
 * An event with thousands of confirmed registrations can render "0 · last 30 days". The
 * brief is explicit that this must not be faked, and equally explicit that it must not be
 * shrugged off. So this script establishes WHICH of the two it is, by construction:
 *
 *   1. Seed an event with real registrations spread over the last 60 days.
 *   2. DELETE its daily rollup rows and reset the coverage marker to today — reproducing
 *      exactly the state of an organizer whose rollups began after their event did.
 *   3. Read the rollups back: empty. The counters still say the registrations exist.
 *   4. Run the SAME reconstruction the backfill script performs, from registeredAt.
 *   5. Read the rollups back again: populated, and summing to the counter.
 *
 * If step 5 reproduces the totals, the history was never missing — only unrecorded, and
 * reconstructible. That is a retrieval/backfill problem, not an absence of data, and the
 * honest UI state plus a backfill run is the remedy. Nothing is invented at any point:
 * every value comes from a registration document that already existed.
 */
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run: emulator host not set.'); process.exit(2)
}
if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-registerdesk' })
const db = getFirestore()

const UID  = 'profiling-organizer-uid'
const SLUG = 'coastal-marathon-2026'
const DAY  = 86_400_000
const NOW  = Date.now()
const TZ   = 330
const dayKey = ms => {
  const d = new Date(ms + TZ * 60_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
const days30 = Array.from({ length: 30 }, (_, i) => dayKey(NOW - (29 - i) * DAY))

const readSeries = async (scope) => {
  const refs = days30.map(d => db.doc(`organizerDailyStats/${UID}__${scope}__${d}`))
  const snaps = await db.getAll(...refs)
  return snaps.reduce((n, s) => n + (s.exists ? (s.data().confirmed ?? 0) : 0), 0)
}

async function main() {
  console.log('\n═══ STEP 1 · seed HISTORICAL registrations (60 days back) ═══')
  const HIST = 90
  let batch = db.batch()
  for (let i = 0; i < HIST; i++) {
    const at = NOW - (i % 60) * DAY - 3_600_000
    batch.set(db.doc(`registrations/${SLUG}-hist-${i}`), {
      organizerUid: UID, eventSlug: SLUG, eventName: 'Coastal Marathon 2026',
      passId: 'pass_10k', passName: '10K Run',
      attendee: { name: `Historic Runner ${i}`, email: `hist${i}@test`, phone: '+919000000000' },
      status: 'confirmed', paymentStatus: 'paid', amount: 1_65_000, emailStatus: 'sent',
      registeredAt: Timestamp.fromMillis(at), updatedAt: Timestamp.fromMillis(at), checkedInAt: null,
    })
    if ((i + 1) % 400 === 0) { await batch.commit(); batch = db.batch() }
  }
  await batch.commit()
  console.log(`  ${HIST} registrations written across the last 60 days`)

  console.log('\n═══ STEP 2 · WIPE the rollups, as if they began today ═══')
  const all = await db.collection('organizerDailyStats').get()
  let wiped = 0
  batch = db.batch()
  for (const d of all.docs) {
    if (!d.id.startsWith(`${UID}__`)) continue
    batch.delete(d.ref); wiped++
    if (wiped % 400 === 0) { await batch.commit(); batch = db.batch() }
  }
  await batch.commit()
  await db.doc(`organizerDailyStats/${UID}__meta`).set({
    organizerUid: UID, since: dayKey(NOW), backfilledAt: Timestamp.fromMillis(NOW),
  })
  console.log(`  ${wiped} rollup rows deleted; coverage marker reset to ${dayKey(NOW)}`)

  console.log('\n═══ STEP 3 · what the Dashboard would now read ═══')
  const before = await readSeries(SLUG)
  const counter = (await db.doc(`registrationCounters/${SLUG}`).get()).data()?.totalCount ?? 0
  console.log(`  trend total over 30 days : ${before}`)
  console.log(`  counter says confirmed   : ${counter}`)
  console.log(`  → the registrations EXIST; only their day-by-day breakdown is unrecorded.`)
  console.log(`  → "No registration activity" here would be FALSE. The panel now says`)
  console.log(`    "Daily history not available for this period" instead.`)

  console.log('\n═══ STEP 4 · reconstruct from registeredAt (what the backfill does) ═══')
  const regs = await db.collection('registrations').where('organizerUid', '==', UID).get()
  const byKey = new Map()
  const bump = (scope, day, field, by) => {
    const k = `${scope}|${day}`
    const row = byKey.get(k) ?? { confirmed: 0, cancelled: 0, revenuePaise: 0, checkedIn: 0 }
    row[field] += by; byKey.set(k, row)
  }
  let scanned = 0
  for (const doc of regs.docs) {
    const r = doc.data()
    const at = r.registeredAt?.toMillis?.()
    if (!at) continue
    scanned++
    const day = dayKey(at)
    const slug = typeof r.eventSlug === 'string' ? r.eventSlug : null
    if (r.status === 'confirmed') {
      bump('__all__', day, 'confirmed', 1); bump('__all__', day, 'revenuePaise', r.amount ?? 0)
      if (slug) { bump(slug, day, 'confirmed', 1); bump(slug, day, 'revenuePaise', r.amount ?? 0) }
    }
  }
  batch = db.batch(); let ops = 0
  for (const [k, row] of byKey) {
    const [scope, day] = k.split('|')
    batch.set(db.doc(`organizerDailyStats/${UID}__${scope}__${day}`), {
      organizerUid: UID, eventId: scope, day, ...row, updatedAt: Timestamp.fromMillis(NOW),
    })
    if (++ops % 400 === 0) { await batch.commit(); batch = db.batch() }
  }
  await batch.commit()
  const earliest = [...byKey.keys()].map(k => k.split('|')[1]).sort()[0]
  await db.doc(`organizerDailyStats/${UID}__meta`).set({
    organizerUid: UID, since: earliest, backfilledAt: Timestamp.fromMillis(NOW),
  })
  console.log(`  ${scanned} registrations scanned → ${byKey.size} scope-day rows, coverage from ${earliest}`)

  console.log('\n═══ STEP 5 · read the trend again ═══')
  const after = await readSeries(SLUG)
  console.log(`  trend total over 30 days : ${after}`)
  console.log(`\n  VERDICT: ${after > before
    ? 'RECONSTRUCTIBLE — the history was unrecorded, not absent. Backfill is the remedy.'
    : 'GENUINELY ABSENT — no registeredAt data exists to rebuild from.'}`)
}

main().catch(e => { console.error(e); process.exit(1) })
