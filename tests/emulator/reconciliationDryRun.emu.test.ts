// Events/pass reconciliation — the `repair: false` DRY RUN must be genuinely read-only.
// REAL Firestore (emulator).
//
// THE BUG THIS PINS. `reconcileOneEvent`'s repairs were always gated on `repair`, but the
// three `writeCursor()` calls in `run()` were NOT. So a "report-only" run still wrote
// `reconciliationCursors` — mutating the shared paging state the real scheduled run depends
// on. A dry-run could advance the cursor past events the next repairing run then skipped,
// or wrap it back to the start. Read-only has to mean read-only, especially for a mode whose
// entire purpose is to inspect production safely before a migration.
//
// It needs a real Firestore: the claim is "no document was written", and only an actual
// datastore can answer that. A mocked SDK would be asserting against the mock.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

vi.mock('@/lib/monitoring/sentry', () => ({
  captureError: () => {}, captureFinancialError: () => {}, captureWebhookError: () => {},
  flushMonitoring: async () => {},
}))

// Loaded inside beforeAll (repo convention): a top-level import pulls in the Admin SDK and
// would throw on the missing service-account key even when this suite is skipped.
let adminDb: import('firebase-admin/firestore').Firestore
let reconcilePasses: typeof import('@/lib/reconciliation/events')['reconcilePasses']

const SLUG = 'recon-dryrun-event'
const PASS = 'pass-dry-a'
/** reconcilePasses → run({ events:false, passes:true }) → entityType 'pass'. */
const CURSOR_KEY = 'recon:pass'

const counterRef = () => adminDb.collection('registrationCounters').doc(SLUG)
const cursorRef  = () => adminDb.collection('reconciliationCursors').doc(CURSOR_KEY)

/** Full stored state of the counter, for before/after equivalence. */
const counterState = async () => JSON.stringify((await counterRef().get()).data() ?? null)
const cursorState  = async () => {
  const s = await cursorRef().get()
  return s.exists ? JSON.stringify(s.data()) : null
}
/** Only this event's mismatches — the scan covers every counter in the emulator. */
const mine = (ms: { entityId: string }[]) => ms.filter(m => m.entityId.includes(SLUG))

describeEmu('reconciliation dry run · repair:false writes nothing (real Firestore)', () => {
  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ reconcilePasses } = await import('@/lib/reconciliation/events'))
  })

  beforeEach(async () => {
    // Clear only what this suite owns, plus every counter (the reconciler pages over the
    // whole collection, so a stray counter from another suite would widen the scan).
    for (const c of ['registrationCounters', 'registrations', 'events']) {
      const s = await adminDb.collection(c).limit(300).get()
      await Promise.all(s.docs.map(d => d.ref.delete()))
    }
    await cursorRef().delete()

    await adminDb.collection('events').doc(SLUG).set({
      slug: SLUG, uid: 'org-dry-1', lifecycleStatus: 'published', totalCapacity: null,
      eventDetails: { info: { name: 'Reconciliation dry-run fixture' } },
      pricing: { passes: [{ id: PASS, name: 'Pass A', price: 100, status: 'active', unlimited: true }] },
    })

    // THREE confirmed registrations on PASS…
    for (const i of [1, 2, 3]) {
      await adminDb.collection('registrations').doc(`recon-dry-r${i}`).set({
        id: `recon-dry-r${i}`, eventSlug: SLUG, passId: PASS,
        status: 'confirmed', amount: 100, updatedAt: Timestamp.now(),
      })
    }
    // …but an EMPTY passCounts map. A known per-pass mismatch of exactly +3.
    await counterRef().set({
      eventSlug: SLUG, totalCount: 3, passCounts: {}, revenuePaise: 300, statsVersion: 2,
    })
  })

  it('repair:false DETECTS the mismatch but writes neither the counter nor the cursor', async () => {
    const counterBefore = await counterState()
    expect(await cursorState()).toBeNull()

    const dry = await reconcilePasses({ repair: false })

    // Detection still works — a read-only run is useless if it reports nothing.
    const found = mine(dry.mismatches)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ entityType: 'pass', field: 'registrationCount', expected: 3, actual: 0 })

    // …and it is honest about having repaired nothing.
    expect(found.every(m => m.repaired === false)).toBe(true)
    expect(dry.repaired).toBe(0)

    // Nothing was written.
    expect(await counterState()).toBe(counterBefore)
    expect((await counterRef().get()).data()?.passCounts).toEqual({})
    expect(await cursorState()).toBeNull()          // ← the regression this file exists for
  }, 30_000)

  it('repair:true still repairs the counter AND advances the cursor', async () => {
    const real = await reconcilePasses({ repair: true })

    expect(mine(real.mismatches).every(m => m.repaired === true)).toBe(true)
    expect(real.repaired).toBeGreaterThan(0)
    expect((await counterRef().get()).data()?.passCounts?.[PASS]).toBe(3)
    expect(await cursorState()).not.toBeNull()
  }, 30_000)

  it('a dry-run cannot disturb a cursor an already-established repairing run depends on', async () => {
    await reconcilePasses({ repair: true })
    const established = await cursorState()
    expect(established).not.toBeNull()

    await reconcilePasses({ repair: false })

    expect(await cursorState()).toBe(established)
  }, 30_000)

  it('dry → repair → dry: the second dry run finds nothing left and still writes nothing', async () => {
    // 1. Dry run: detects, changes nothing.
    const before = await counterState()
    const dry1 = await reconcilePasses({ repair: false })
    expect(mine(dry1.mismatches)).toHaveLength(1)
    expect(await counterState()).toBe(before)
    expect(await cursorState()).toBeNull()

    // 2. Real run: repairs.
    await reconcilePasses({ repair: true })
    expect((await counterRef().get()).data()?.passCounts?.[PASS]).toBe(3)

    // 3. Dry run again: nothing left to report, and still no writes.
    const repaired = await counterState()
    const cursorAfterRepair = await cursorState()

    const dry2 = await reconcilePasses({ repair: false })

    expect(mine(dry2.mismatches)).toHaveLength(0)
    expect(dry2.repaired).toBe(0)
    expect(await counterState()).toBe(repaired)
    expect(await cursorState()).toBe(cursorAfterRepair)
  }, 30_000)
})
