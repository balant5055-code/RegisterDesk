/* RD-ANALYTICS-07 — fixtures for the comparison and coverage states. EMULATOR ONLY.
 *
 * Runs AFTER `scripts/qa/rd-analytics-06-seed.mjs`, which publishes the two fixture events.
 * RD-06 seeded 90 rollup days and no coverage marker, which is not enough to photograph
 * what RD-07 added:
 *
 *   • a PREVIOUS-PERIOD baseline needs the window before the window. At 90D that is 180
 *     days of history, so the marathon's rollups are extended to 200 days.
 *   • the COVERAGE FLOOR decides whether a baseline is trustworthy at all. Without a
 *     marker `readCoverage` returns ROLLUP_EPOCH, which would clip every chart to the
 *     handful of days since that date and hide the very thing under test.
 *
 * Two modes, because coverage is per-ORGANIZER and both states cannot exist at once:
 *
 *   node rd-analytics-07-seed.mjs full     → coverage reaches back before all history
 *   node rd-analytics-07-seed.mjs partial  → coverage begins mid-window, so the notice
 *                                            appears and the baseline is refused
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

const UID   = 'profiling-organizer-uid'
const SLUG  = 'rd-analytics-06-marathon'
const AMOUNT = 150_000

/** IST business-day key — the same rule lib/dashboard/dailyStats.ts writes with. */
const dayKey = ms => new Date(ms + 330 * 60_000).toISOString().slice(0, 10)

const MODE = process.argv[2] === 'partial' ? 'partial' : 'full'
const DAYS = 200

/**
 * A curve with a real SHAPE across 200 days, so a period comparison has something to
 * report other than noise. Two properties matter, and the first is easy to get wrong:
 *
 *   COHERENCE — the rollups and the registration counter describe the same event. A curve
 *   that sums to more arrivals in 30 days than the event has taken in its lifetime makes
 *   every screenshot unreadable: the reader cannot tell a fixture artefact from the
 *   category error the page exists to prevent. The whole series therefore sums to roughly
 *   the seeded confirmed count.
 *
 *   MOVEMENT — the recent window runs deliberately hotter than the one before it, so a
 *   positive delta is a fact about the fixture rather than a coincidence of rounding.
 */
async function seedRollups() {
  const now = Date.now()
  let batch = db.batch()
  let n = 0
  for (let i = DAYS - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86_400_000)
    // i = days ago. A quiet long tail, a warmer preceding month, a hot final month, and a
    // hotter final week — so 7D, 30D and 90D each have their own story rather than three
    // views of one flat line, and a weekly bump gives the chart real texture.
    const base = i < 7 ? 7 : i < 14 ? 5 : i < 30 ? 4 : i < 60 ? 3 : 2
    const confirmed = Math.max(0, base + (i % 7 === 3 ? 3 : 0) + (i % 4 === 0 ? 1 : 0))
    batch.set(db.collection('organizerDailyStats').doc(`${UID}__${SLUG}__${day}`), {
      organizerUid: UID, eventId: SLUG, day,
      confirmed, cancelled: i % 7 === 0 ? 1 : 0,
      revenuePaise: confirmed * AMOUNT,
      checkedIn: Math.round(confirmed / 3),
    })
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch() }
  }
  await batch.commit()
}

/**
 * The coverage marker. `full` predates every rollup row, so nothing is withheld and both
 * the period and its baseline are complete. `partial` starts 12 days ago — inside the 30D
 * window and after the whole of its baseline — which is exactly the state where a naive
 * implementation would sum the missing days to zero and report a collapse.
 */
async function seedCoverage() {
  const since = MODE === 'full'
    ? dayKey(Date.now() - (DAYS + 10) * 86_400_000)
    : dayKey(Date.now() - 12 * 86_400_000)
  await db.doc(`organizerDailyStats/${UID}__meta`).set({
    organizerUid: UID, since, backfilledAt: null,
  })
  return since
}

await seedRollups()
const since = await seedCoverage()
console.log(`mode=${MODE} · ${DAYS} rollup days for ${SLUG} · coverage since ${since}`)
