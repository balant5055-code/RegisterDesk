/* RD-ANALYTICS-12-11 — report export jobs to give History something to show. EMULATOR ONLY.
 *
 * History renders states that are hard to reach on demand: an artifact whose 24-hour link has
 * expired, a job that failed with a raw internal message, a cancelled job that still carries
 * an output. Waiting a day or breaking the storage layer to produce them is not validation,
 * so they are seeded directly into the same collection the export engine writes.
 *
 * A live export created through the UI is still worth doing on top of this — that is what
 * proves the refresh problem is actually solved — but it can only ever produce ONE state.
 *
 *   node rd-analytics-12-11-fixture.mjs
 */
import { initializeApp, getApps } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('Refusing to run outside the emulator.'); process.exit(1)
}
const PROJECT = process.env.GCLOUD_PROJECT ?? ''
if (!PROJECT.startsWith('demo-')) {
  console.error(`Refusing to run outside a demo- project (got "${PROJECT}").`); process.exit(1)
}

if (!getApps().length) initializeApp({ projectId: PROJECT })
const auth = getAuth()
const db   = getFirestore()

const OWNER = 'profiling-organizer-uid'
const financeUser = await auth.getUserByEmail('finance.a11@registerdesk.test').catch(() => null)
const FINANCE = financeUser?.uid ?? 'finance-unknown'

const HOUR = 3_600_000
const ago  = ms => Timestamp.fromMillis(Date.now() - ms)

const output = (kind, format, expiresInMs) => ({
  path: `reportExports/${OWNER}/seed-${kind}/${kind}.${format}`,
  filename: `${kind}_2026-01-01_2026-01-31.${format}`,
  contentType: format === 'csv' ? 'text/csv' : 'application/octet-stream',
  rowCount: 1234, truncated: false,
  expiresAt: Timestamp.fromMillis(Date.now() + expiresInMs),
})

const base = (id, kind, format, over = {}) => ({
  id,
  doc: {
    jobId: id, organizerUid: OWNER, createdBy: OWNER,
    kind, format, filenameBase: kind, heading: kind,
    filters: { from: '2026-01-01', to: '2026-01-31' },
    status: 'completed',
    counts: { total: 1, processed: 1, succeeded: 1, failed: 0 },
    cursor: 'done', error: null, lockedUntil: null,
    createdAt: ago(HOUR), startedAt: ago(HOUR), updatedAt: ago(HOUR), completedAt: ago(HOUR),
    output: output(kind, format, 12 * HOUR),
    ...over,
  },
})

const rows = [
  // Downloadable, and the newest thing in the feed.
  base('rex_seed_txn', 'transactions', 'csv', { createdAt: ago(1 * 60_000), completedAt: ago(1 * 60_000) }),

  // Created by someone else in the workspace — `createdByYou` must be false.
  base('rex_seed_settle', 'settlements', 'xlsx', {
    createdBy: FINANCE, createdAt: ago(2 * HOUR), completedAt: ago(2 * HOUR),
  }),

  // Completed, but the artifact's 24-hour link is gone. The job document is NOT deleted —
  // three clocks, and this is the one that ran out.
  base('rex_seed_expired', 'wallet-ledger', 'pdf', {
    createdAt: ago(30 * HOUR), completedAt: ago(30 * HOUR),
    output: { ...output('wallet-ledger', 'pdf', 0), expiresAt: ago(6 * HOUR) },
  }),

  // Failed, with a message that must never reach the browser.
  base('rex_seed_failed', 'donations', 'csv', {
    status: 'failed', output: undefined,
    error: 'FirebaseError: 7 PERMISSION_DENIED: Missing index on projects/rd-prod/databases/(default)/collectionGroups/donations',
    createdAt: ago(4 * HOUR), completedAt: ago(4 * HOUR),
  }),

  // Cancelled — and deliberately still carrying an output, which is what cancelJob leaves
  // behind. It must not be offered as a download.
  base('rex_seed_cancelled', 'refunds', 'csv', {
    status: 'cancelled', createdAt: ago(5 * HOUR), completedAt: ago(5 * HOUR),
  }),

  // In flight.
  base('rex_seed_pending', 'gst', 'csv', {
    status: 'pending', output: undefined, completedAt: null,
    counts: { total: 1, processed: 0, succeeded: 0, failed: 0 },
    createdAt: ago(6 * HOUR),
  }),
  base('rex_seed_processing', 'broadcast-usage', 'xlsx', {
    status: 'processing', output: undefined, completedAt: null,
    counts: { total: 1, processed: 0, succeeded: 0, failed: 0 },
    createdAt: ago(7 * HOUR),
  }),

  // A kind no registry entry describes. It must not appear at all — an unregistered kind
  // has no permission to check against, and every sibling route treats that as a refusal.
  base('rex_seed_retired', 'legacy-attendance-report', 'csv', {
    createdAt: ago(8 * HOUR), completedAt: ago(8 * HOUR),
  }),
]

// Enough filler to push the feed past one page of 25, so "Load more" is exercised.
for (let i = 0; i < 30; i++) {
  rows.push(base(`rex_seed_fill_${i}`, 'transactions', 'csv', {
    createdAt: ago((20 + i) * HOUR), completedAt: ago((20 + i) * HOUR),
  }))
}

// `output: undefined` above expresses "this job produced no file", which is how the runner
// leaves a pending or failed job — the field is ABSENT, not null. Firestore rejects an
// explicit undefined, so the key is dropped rather than written as null: a null `output`
// would be a shape the real engine never produces.
let batch = db.batch()
for (const r of rows) {
  const doc = Object.fromEntries(Object.entries(r.doc).filter(([, v]) => v !== undefined))
  batch.set(db.collection('reportExportJobs').doc(r.id), doc)
}
await batch.commit()

console.log(`seeded ${rows.length} report export jobs for ${OWNER}`)
console.log(`  finance member uid: ${FINANCE}`)
console.log('  states: available, other-creator, expired-artifact, failed, cancelled, pending, processing, retired-kind, +30 filler')
