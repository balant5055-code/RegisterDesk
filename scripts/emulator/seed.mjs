/* RD-EVENT-16 — deterministic Emulator Suite seed. DEV TOOLING ONLY.
 *
 *   npm run emu:seed
 *
 * ═══ DETERMINISM ══════════════════════════════════════════════════════════════
 * Running this twice produces the same result. Every document is written with a FIXED id
 * and `set()` (not `add()`), and the auth user is created with an explicit uid. Re-running
 * overwrites rather than duplicating — so a profiling baseline is always taken against the
 * same data, which is the whole point.
 *
 * Timestamps are fixed constants, never Date.now(). A seed whose content changes per run
 * would silently change the snapshot payload size, and snapshot cost scales with draft size.
 *
 * ═══ SAFETY ═══════════════════════════════════════════════════════════════════
 * This refuses to run unless the emulator host variables are set. It writes an organizer
 * profile and a draft event; pointed at production it would be destructive.
 */
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST
if (!AUTH_HOST || !FS_HOST) {
  console.error(
    'Refusing to seed: emulator hosts are not set.\n' +
    '  FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST must both be set.\n' +
    '  Use `npm run emu:seed`, which sets them for you.',
  )
  process.exit(2)
}

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-registerdesk'

// ─── The seeded organizer. Predictable by design; these are emulator-only values. ───
export const SEED = {
  uid: 'profiling-organizer-uid',
  email: 'profiling@registerdesk.test',
  password: 'ProfilingPassw0rd!',
  displayName: 'Profiling Organizer',
  organizationName: 'Profiling Events Co',
  draftId: 'profiling-draft-event',
}

/** Wizard step the seeded draft opens on. Invalid or absent values fall back to 0. */
/**
 * Pricing mode. RD_SEED_PRICING=free produces a genuinely free event.
 *
 * RD-EVENT-36: an earlier seed set `pricing.eventType: 'free'` while keeping six paid
 * passes at 1500–4000. The app read the contradiction and kept rendering the PAID footer
 * ("Continue to Payment"), so the harness exercised the wrong branch for two sprints.
 * Pricing mode must therefore drive BOTH the event type and every pass — never one alone.
 */
const SEED_PRICING = process.env.RD_SEED_PRICING === 'free' ? 'free' : 'paid'

const SEED_STEP = (() => {
  const raw = Number(process.env.RD_SEED_STEP)
  return Number.isInteger(raw) && raw >= 0 && raw <= 8 ? raw : 0
})()

// Fixed instants — never Date.now(), so the payload is byte-stable across runs.
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z')

if (!getApps().length) initializeApp({ projectId: PROJECT_ID })
const db = getFirestore()
const auth = getAuth()

/** Creates or resets the auth user at a FIXED uid, with a verified email. */
async function seedAuthUser() {
  const props = {
    uid: SEED.uid,
    email: SEED.email,
    emailVerified: true,          // an unverified account is routed to OTP, which is not automatable
    password: SEED.password,
    displayName: SEED.displayName,
    disabled: false,
  }
  try {
    await auth.createUser(props)
    console.log(`  auth user created  ${SEED.email}`)
  } catch (err) {
    if (err.code !== 'auth/uid-already-exists' && err.code !== 'auth/email-already-exists') throw err
    // Re-running must converge on the same state, so update rather than skip.
    const { uid, ...rest } = props
    await auth.updateUser(uid, rest)
    console.log(`  auth user updated  ${SEED.email}`)
  }
}

/**
 * The canonical organizer profile at /users/{uid}.
 *
 * Field names mirror `lib/firebase/firestore/index.ts` (createOrganizerProfile) — this seed
 * does NOT define a schema, it populates the existing one.
 */
async function seedOrganizerProfile() {
  await db.doc(`users/${SEED.uid}`).set({
    uid: SEED.uid,
    email: SEED.email,
    name: SEED.displayName,
    organizationName: SEED.organizationName,
    role: 'organizer',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }, { merge: true })
  console.log(`  users/${SEED.uid}`)
}

/**
 * A draft event sized like a real one.
 *
 * Size matters: `writeSnapshot` serialises the WHOLE draft, so a baseline captured against
 * an empty draft does not compare to one captured against a populated event. Six passes and
 * twenty form fields approximate a typical marathon.
 */
function buildDraft() {
  // CANONICAL shape — `EventPassFull` in components/wizard/AddPassEditor.tsx.
  //
  // An earlier version of this seed invented a plausible-looking shape (`pricePaise`,
  // `maxQuantity`, `perks`). The Pricing step then crashed on `pass.quantity.toLocaleString()`
  // and the error boundary replaced the entire wizard — which read as "Continue is disabled"
  // and blocked the audit of four steps. Seed data must match the type the app consumes.
  const passes = Array.from({ length: 6 }, (_, i) => ({
    id: `pass_${i}`,
    name: `Pass ${i + 1}`,
    code: `PASS${i + 1}`,
    description: 'A reasonably typical pass description for profiling.',
    type: SEED_PRICING,
    price: SEED_PRICING === 'free' ? 0 : 1500 + i * 500,
    earlyBirdEnabled: false,
    earlyBirdPrice: null,
    earlyBirdEndDate: '',
    unlimited: false,
    quantity: 500,
    minPurchase: 1,
    maxPurchase: 10,
    hideWhenSoldOut: false,
    salesStartDate: '2026-01-01',
    salesEndDate: '2026-06-01',
    showRemainingSeats: true,
    visibility: 'public',
    featured: false,
    benefits: ['T-shirt', 'Medal', 'Refreshments'],
    customBenefits: [],
    raceDetails: null,
    eventType: 'sports',
    eventSubtype: 'running',
    advancedSettings: { taxes: [], fees: [], coupons: [], discounts: [] },
    status: 'active',
  }))
  const fields = Array.from({ length: 20 }, (_, i) => ({
    id: `field_${i}`,
    label: `Field ${i + 1}`,
    type: i % 3 === 0 ? 'select' : 'text',
    required: i % 2 === 0,
    placeholder: 'Enter a value',
    helpText: 'Some helper text here.',
    options: i % 3 === 0 ? ['Option A', 'Option B', 'Option C'] : [],
    linkedPassIds: [],
  }))
  return {
    id: SEED.draftId,
    uid: SEED.uid,
    status: 'draft',
    lifecycleStatus: 'draft',
    // RD-EVENT-31 — `emu:seed` RESETS this to 0 on every run, which is what makes the seed
    // deterministic. Set RD_SEED_STEP to open the draft directly on a wizard step instead:
    //   RD_SEED_STEP=7 npm run emu:seed    → opens on Review
    // Indices follow lib/events/builder/stepRegistry.ts (standard flow):
    //   0 eventType · 1 visibility · 2 access · 3 pricing · 4 form · 5 details · 6 license · 7 review
    currentStep: SEED_STEP,
    completedValues: Array(9).fill(null),
    eventType: 'sports',
    eventSubtype: 'marathon',
    customEventSubtype: null,
    campaignType: 'event_only',
    linkedCampaign: null,
    visibility: 'public',
    accessControl: { type: 'open', approvedContacts: [], confirmationMode: 'auto' },
    // `eventType` is the free/paid choice the `pricing_model` requirement checks.
    pricing: { eventType: SEED_PRICING, passes, feeModel: 'organizer_pays' },
    registrationForm: { template: 'standard', fields },
    // CANONICAL nested shape — the structure `evaluatePublishRequirements` actually reads
    // (`info.name`, `schedule.startDate`, `venue.physical.name`, `organizer.email`).
    //
    // RD-EVENT-28: this was previously FLAT (`eventDetails.name`, `eventDetails.venue`), so
    // every field read as absent. RD-EVENT-26's Review Summary made it visible — "Name: Not
    // provided" beside an event called Profiling Marathon 2026 — and it meant four of the
    // seven publish blockers were seed artefacts rather than real gaps. Same class of bug as
    // the fabricated pass shape in RD-EVENT-19: invented structure tests nothing.
    eventDetails: {
      info: {
        name: 'Profiling Marathon 2026',
        tagline: 'A deterministic event for performance runs',
        description: 'A long-form description used to exercise the publish requirements. '.repeat(4),
        // Optional fields the RD-EVENT-24 warning/suggestion requirements read. Canonical
        // paths only — same `info.*` nesting as name/description, never invented keys.
        coverImage: 'https://example.test/cover.jpg',
        logoUrl:    'https://example.test/logo.png',
        socialLinks: [
          { platform: 'instagram', url: 'https://example.test/ig' },
          { platform: 'x',         url: 'https://example.test/x'  },
        ],
      },
      schedule: {
        startDate: '2026-09-01', startTime: '06:00',
        endDate:   '2026-09-01', endTime:   '12:00',
        timezone:  'Asia/Kolkata',
      },
      venue: {
        type: 'physical',
        physical: { name: 'Emulator Park', address: 'MG Road', city: 'Bengaluru', state: 'Karnataka' },
      },
      organizer: {
        name: 'Profiling Events Co',
        email: 'profiling@registerdesk.test',
        phone: '+919999999999',
        website: 'https://example.test',
      },
    },
    communicationBilling: null,
    // RD-EVENT-40: V2 has a DISTINCT 'free' tier; 'starter' is PAID under V2 (V1 starter was
    // the free one). Seeding 'starter' made isPaidLicense true, so the CTA correctly routed
    // to /api/licensing/purchase — which 500s in the emulator for lack of Razorpay config.
    licenseTier: 'free',
    publishedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }
}

/** Written at a FIXED id under the organizer's drafts, so re-seeding overwrites. */
async function seedDraft() {
  await db.doc(`users/${SEED.uid}/eventDrafts/${SEED.draftId}`).set(buildDraft())
  console.log(`  users/${SEED.uid}/eventDrafts/${SEED.draftId}  (step ${SEED_STEP}, ${SEED_PRICING})`)
}

/**
 * RD-TEST-01 — remove publish artefacts belonging to THIS seeded event.
 *
 * A successful publish writes `events/{slug}` and `eventLicenses/{slug}`. The seed reset the
 * draft but left both behind, so the second publish of any session returned
 * 409 "An Event License already exists for this event." That looked like a product defect
 * for three sprints; it was stale fixture state.
 *
 * SCOPED BY CONSTRUCTION: it deletes documents owned by the seeded organizer only, matched
 * on uid, plus the deterministic slug this fixture always produces. It never enumerates or
 * wipes a collection. Unrelated emulator data is untouched, and running it twice is a no-op
 * the second time.
 */
async function clearPublishArtefacts() {
  // Mirrors the server's slug rule (app/api/events/publish/route.ts):
  //   slugify(eventName) + '-' + draftId.slice(-6)
  const slugified = 'profiling-marathon-2026'
  const slug = `${slugified}-${SEED.draftId.slice(-6)}`

  let removed = 0
  for (const col of ['events', 'eventLicenses']) {
    // 1. the deterministic id this fixture produces
    const byId = db.doc(`${col}/${slug}`)
    if ((await byId.get()).exists) { await byId.delete(); removed++ }

    // 2. anything else owned by the seeded organizer — covers a slug that changed because
    //    the fixture's event name was edited. Still scoped to this uid, never the collection.
    for (const field of ['uid', 'organizerUid']) {
      const snap = await db.collection(col).where(field, '==', SEED.uid).get().catch(() => null)
      if (!snap) continue
      for (const d of snap.docs) { await d.ref.delete(); removed++ }
    }
  }
  console.log(`  cleared ${removed} publish artefact(s)`)
}

async function main() {
  console.log(`Seeding emulators (project ${PROJECT_ID})`)
  console.log(`  auth      ${AUTH_HOST}`)
  console.log(`  firestore ${FS_HOST}`)
  await clearPublishArtefacts()
  await seedAuthUser()
  await seedOrganizerProfile()
  await seedDraft()
  console.log('\nSeed complete. Credentials:')
  console.log(`  RD_PROFILE_EMAIL=${SEED.email}`)
  console.log(`  RD_PROFILE_PASSWORD=${SEED.password}`)
}

main().catch(err => { console.error(err); process.exit(1) })
