/* RD-ANALYTICS-12-15 — a PUBLISHED event, so the browser can actually exercise the money
 * boundary. EMULATOR ONLY.
 *
 * The base seed creates one DRAFT event. Every Analytics module then renders "Select a single
 * event to see its analytics" for every role, because `resolveAnalyticsEventIdentity` reads
 * the published bridge document and there is none — so the browser cannot distinguish
 * "manager is refused money" from "nobody has any data". The first QA run said exactly that,
 * for all three roles.
 *
 * This adds the published bridge doc and a little revenue, so the Revenue module has
 * something to withhold.
 *
 *   node rd-analytics-12-15-fixture.mjs
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

const OWNER = 'profiling-organizer-uid'
const SLUG  = 'profiling-draft-event'

// The draft the base seed already wrote, promoted to published.
await db.doc(`users/${OWNER}/eventDrafts/${SLUG}`).set({
  status: 'published', lifecycleStatus: 'published', slug: SLUG, publishedAt: new Date(),
}, { merge: true })

// The bridge document analytics resolves identity from.
await db.doc(`events/${SLUG}`).set({
  uid: OWNER, draftId: SLUG, eventName: 'Profiling Marathon 2026', slug: SLUG,
  eventType: 'sports', status: 'published', publishedAt: new Date(),
}, { merge: true })

// A registration counter, so the modules have non-zero aggregates to show.
await db.doc(`registrationCounters/${SLUG}`).set({
  totalCount: 128, revenuePaise: 4_820_000, passCounts: {},
}, { merge: true })

console.log(`published ${SLUG} for ${OWNER} (128 registrations, ₹48,200 revenue)`)
console.log('Analytics modules now have data, so the finance boundary is observable in a browser.')
