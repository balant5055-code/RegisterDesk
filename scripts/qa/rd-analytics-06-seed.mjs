/* RD-ANALYTICS-06 — publishes the seeded fixture event and gives it real analytics data.
 *
 * DEV TOOL, EMULATOR ONLY. Runs AFTER `npm run emu:seed`, which creates the organizer and
 * a draft. That draft is never published, so the Analytics Overview would have nothing to
 * report on. This adds exactly what the Overview reads and nothing else:
 *
 *   users/{uid}/eventDrafts/{id}   → published lifecycle + a urlSlug (so the selector lists it)
 *   events/{slug}                  → the bridge doc the Overview resolves identity from
 *   registrationCounters/{slug}    → per-pass CONFIRMED counts
 *   registrations/*                → real rows, so the count() aggregates have something to count
 *   organizerDailyStats/*          → the rollup rows the trend is read from
 *
 * A SECOND event is written with no capacity and no registrations, so the uncapped and
 * empty states can be photographed rather than imagined.
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

const UID     = 'profiling-organizer-uid'
/**
 * The draft id `scripts/emulator/seed.mjs` actually writes.
 *
 * This constant read `profiling-event-draft` — a transposition of the real
 * `profiling-draft-event` — and nothing noticed, because `findDraftId()` fell back to
 * `docs[0]` and that happened to be the right document while it was the only one. Pinning
 * the id turned a silent wrong-document write into an immediate, obvious failure, which is
 * how the typo surfaced.
 */
const DRAFT   = 'profiling-draft-event'
const SLUG    = 'rd-analytics-06-marathon'
const DRAFT_2 = 'profiling-event-draft-empty'
const SLUG_2  = 'rd-analytics-06-workshop'

const PASS_A = 'pass-5k', PASS_B = 'pass-10k'
const AMOUNT = 150_000                       // ₹1,500 in paise

/** IST business-day key — the same rule lib/dashboard/dailyStats.ts writes with. */
const dayKey = ms => new Date(ms + 330 * 60_000).toISOString().slice(0, 10)

/**
 * The draft `npm run emu:seed` creates, pinned by ID.
 *
 * ═══ WHAT WAS WRONG (found in RD-ANALYTICS-10) ═══════════════════════════════
 * This took `docs[0]` of an unordered five-document page. With only the emulator seed's
 * own draft present that happened to be right, so the defect was invisible for four
 * phases. The moment another fixture adds drafts, `docs[0]` is whichever id sorts first —
 * and RD-ANALYTICS-10's fixtures begin with "a10-", which sorts before "profiling-".
 * This seed then published the marathon ON TOP of an unrelated fixture event and left the
 * real draft unpublished, silently corrupting both.
 *
 * The id is deterministic (`scripts/emulator/seed.mjs` writes exactly this one), so it is
 * addressed directly. A missing document is a hard failure rather than a guess: seeding
 * the wrong event is worse than not seeding at all, because the run still looks green.
 */
async function findDraftId() {
  const ref = db.doc(`users/${UID}/eventDrafts/${DRAFT}`)
  if ((await ref.get()).exists) return DRAFT
  throw new Error(
    `Expected the emulator seed's draft "${DRAFT}" to exist. Run \`npm run emu:seed\` first — ` +
    `this script must never publish over an arbitrary draft.`)
}

async function publishDraft(draftId, slug, { name, capacity, eventType, cloneFrom }) {
  const ref = db.doc(`users/${UID}/eventDrafts/${draftId}`)
  // A draft the events LIST cannot render is invisible to the event selector, so the
  // second fixture clones the first rather than being assembled from three fields.
  const base = cloneFrom ? (await db.doc(`users/${UID}/eventDrafts/${cloneFrom}`).get()).data() ?? {} : {}
  const cur = { ...base, ...((await ref.get()).data() ?? {}) }
  const details = cur.eventDetails ?? {}
  await ref.set({
    ...cur,
    id: draftId, uid: UID,
    status: 'published', lifecycleStatus: 'published',
    eventType,
    /**
     * REQUIRED for the event selector to see this draft at all.
     *
     * `/api/organizer/events` lists with `orderBy('updatedAt', 'desc')`, and Firestore
     * EXCLUDES documents that lack the ordered field — the same semantic the codebase
     * already relies on deliberately when it counts check-ins with `orderBy('checkedInAt')`.
     * A fixture draft written without it exists, resolves through the API by slug, and is
     * still invisible in the picker, which is exactly how RD-ANALYTICS-10's browser matrix
     * came to render "Select a single event" for twelve correctly-published events.
     */
    updatedAt: new Date(),
    eventDetails: {
      ...details,
      info: { ...(details.info ?? {}), name },
      seo:  { ...(details.seo ?? {}), urlSlug: slug },
    },
  }, { merge: true })

  await db.doc(`events/${slug}`).set({
    slug, uid: UID, draftId,
    lifecycleStatus: 'published', publishedAt: new Date(),
    totalCapacity: capacity,
    eventType,
    eventDetails: { info: { name } },
    pricing: { passes: [{ id: PASS_A, name: '5 KM' }, { id: PASS_B, name: '10 KM' }] },
  })
}

async function seedRegistrations(slug, n) {
  // Enough rows for every aggregate to have something real to count. The Overview reads
  // counts through count()/sum(), so this is about correctness of the fixture, not volume.
  const mix = [
    ['confirmed', 'paid', 0.62], ['confirmed', 'not_required', 0.08],
    ['confirmed', 'refunded', 0.03], ['confirmed', 'refund_pending', 0.02],
    ['pending', 'pending', 0.10], ['cancelled', 'paid', 0.08],
    ['waitlisted', 'pending', 0.04], ['rejected', 'paid', 0.03],
  ]
  const rows = []
  let i = 0
  for (const [status, paymentStatus, share] of mix) {
    for (let k = 0; k < Math.round(n * share); k++, i++) {
      const confirmed = status === 'confirmed'
      const checkedIn = confirmed && i % 3 === 0
      rows.push([`${slug}-reg-${String(i).padStart(5, '0')}`, {
        organizerUid: UID, eventSlug: slug, eventName: slug,
        status, paymentStatus, amount: AMOUNT,
        passId: i % 2 === 0 ? PASS_A : PASS_B,
        passName: i % 2 === 0 ? '5 KM' : '10 KM',
        ticketCode: `TC-${i}`, checkedIn,
        ...(checkedIn ? { checkedInAt: new Date() } : {}),
        attendee: { name: `Runner ${i}`, email: `r${i}@test.local`, phone: '', formResponses: {} },
        registeredAt: new Date(),
      }])
    }
  }
  for (let j = 0; j < rows.length; j += 450) {
    const b = db.batch()
    for (const [id, data] of rows.slice(j, j + 450)) b.set(db.collection('registrations').doc(id), data)
    await b.commit()
  }

  const confirmedA = rows.filter(([, d]) => d.status === 'confirmed' && d.passId === PASS_A).length
  const confirmedB = rows.filter(([, d]) => d.status === 'confirmed' && d.passId === PASS_B).length
  await db.doc(`registrationCounters/${slug}`).set({
    totalCount: rows.length,
    passCounts: { [PASS_A]: confirmedA, [PASS_B]: confirmedB },
    revenuePaise: (confirmedA + confirmedB) * AMOUNT,
  }, { merge: true })
  return rows.length
}

async function seedRollups(slug, days) {
  // A believable arrival curve — a slow start, a mid spike, a run-in. Flat noise would
  // photograph as a grey band and prove nothing about the chart.
  const now = Date.now()
  const b = db.batch()
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86_400_000)
    const t = (days - i) / days
    const confirmed = Math.max(0, Math.round(6 + 40 * Math.sin(t * Math.PI) + (i % 5 === 0 ? 18 : 0)))
    b.set(db.collection('organizerDailyStats').doc(`${UID}__${slug}__${day}`), {
      organizerUid: UID, eventId: slug, day,
      confirmed, cancelled: i % 7 === 0 ? 2 : 0,
      revenuePaise: confirmed * AMOUNT,
      checkedIn: Math.round(confirmed / 3),
    })
  }
  await b.commit()
}

const draftId = await findDraftId()
await publishDraft(draftId, SLUG, { name: 'Coimbatore Marathon 2026', capacity: 900, eventType: 'sports' })
const n = await seedRegistrations(SLUG, 640)
await seedRollups(SLUG, 90)
console.log(`published ${SLUG} — ${n} registrations, 90 rollup days, capacity 900 (sports)`)

// The uncapped / empty counterpart, so those states can be photographed.
await publishDraft(DRAFT_2, SLUG_2, { name: 'Product Design Workshop', capacity: null, eventType: 'workshop', cloneFrom: draftId })
await db.doc(`registrationCounters/${SLUG_2}`).set({ totalCount: 0, passCounts: {}, revenuePaise: 0 })
console.log(`published ${SLUG_2} — no capacity, no registrations (workshop)`)
