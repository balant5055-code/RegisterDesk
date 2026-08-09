// MC-10.2 · The upload client's session contract — REAL Firestore (emulator).
//
// MC-10.1 found that `useUploadQueue` sent no `sessionId`/`slotIndex`, so `creditsEnabled:
// true` made `/uploads/prepare` fail closed on every photo. The client now sends them. These
// tests drive the SERVER exactly as the fixed client does — `assignSlots` produces the slots,
// and each one is opened and claimed through the real services — so they prove the contract
// the client depends on rather than the client's own JavaScript.
//
// What needs a real database: slot uniqueness under concurrency, replay of a prepare on a
// held slot, and the guarantee that a cancelled batch strands no credits. All three are
// claims about Firestore transaction semantics.
//
// ═══ HOW TO RUN ══════════════════════════════════════════════════════════════
//   npm run emu:start        # requires JDK 21+
//   npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { MAX_CONCURRENT_UPLOADS } from '@/features/media-studio/utils/queueMachine'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const CONTENTION_TIMEOUT_MS = 60_000

describeEmu('MC-10.2 · upload client session contract', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let openSession: typeof import('@/features/media-credits/services/sessionService')['openSession']
  let sealSession: typeof import('@/features/media-credits/services/sessionService')['sealSession']
  let settleSession: typeof import('@/features/media-credits/services/sessionSettlementService')['settleSession']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let createGrant: typeof import('@/features/media-credits/services/grantService')['createGrant']
  let deriveAssetId: typeof import('@/features/media-credits/utils/sessionSlots')['deriveAssetId']
  let assignSlots: typeof import('@/features/media-studio/utils/uploadSession')['assignSlots']
  let errs: typeof import('@/features/media-credits/errors')

  const UID   = 'emu-upload-organizer'
  const ACTOR = 'emu-upload-actor'
  const EVENT = { eventId: 'evt_1', eventSlug: 'evt-1', galleryId: 'gal_1' }

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    ;({ openSession, sealSession } = await import('@/features/media-credits/services/sessionService'))
    ;({ settleSession } = await import('@/features/media-credits/services/sessionSettlementService'))
    ;({ ledgerService, walletService } = await import('@/features/media-credits/services'))
    ;({ createGrant } = await import('@/features/media-credits/services/grantService'))
    ;({ deriveAssetId } = await import('@/features/media-credits/utils/sessionSlots'))
    ;({ assignSlots } = await import('@/features/media-studio/utils/uploadSession'))
    errs = await import('@/features/media-credits/errors')
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  function enableCredits(patch: Record<string, unknown> = {}) {
    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: 100,
      minCreditPurchase: 1, ...patch,
    } as never)
  }

  async function reset(fund = 1_000) {
    businessConfig.clearRuntimeOverrides()
    const batch = adminDb.batch()
    batch.delete(adminDb.doc(`mediaCreditWallets/${UID}`))
    for (const col of ['mediaCreditLedger', 'mediaCreditGrants', 'mediaCreditSessions',
                       'mediaCreditReservations']) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    await batch.commit()
    enableCredits()
    if (fund > 0) {
      await createGrant({
        grantId: `fund_${UID}_${fund}`, organizerUid: UID, credits: fund,
        reason: 'migration', note: 'Funding the upload contract tests.', actorUid: ACTOR,
      })
    }
  }

  beforeEach(async () => { await reset() })

  /** What the fixed client sends for one queued batch. */
  function clientBatch(n: number, sessionId: string) {
    const items = Array.from({ length: n }, (_, i) => ({
      id: `q${i}`, state: 'queued', sessionId: null as string | null,
    }))
    return assignSlots(items, sessionId)
  }

  /** The server half of `/uploads/prepare`, for one photo. */
  async function prepare(slot: { sessionId: string; slotIndex: number; sessionSlots: number }) {
    const session = await openSession({
      sessionId: slot.sessionId, organizerUid: UID, ...EVENT,
      slotCount: slot.sessionSlots, actorUid: ACTOR,
    })
    const assetId = deriveAssetId(slot.sessionId, slot.slotIndex)
    await ledgerService.reserve({
      organizerUid: UID, assetId, ...EVENT,
      credits: session.creditsPerPhotoAtOpen,
      sessionId: slot.sessionId, slotIndex: slot.slotIndex, actorUid: ACTOR,
    })
    return assetId
  }

  /** The server half of `/uploads/complete`, for one photo. */
  const complete = (assetId: string) =>
    adminDb.runTransaction(async tx => {
      const { consumeInTx } = await import('@/features/media-credits/services')
      await consumeInTx(tx, { organizerUid: UID, assetId, actorUid: ACTOR })
    })

  // ── Single upload ──────────────────────────────────────────────────────────

  it('a single photo opens a session, claims slot 0 and settles for one credit', async () => {
    const [slot] = clientBatch(1, 'us_single')
    expect(slot).toMatchObject({ slotIndex: 0, sessionSlots: 1 })

    const assetId = await prepare(slot)
    expect(assetId).toBe(deriveAssetId('us_single', 0))

    const held = await walletService.getBalance(UID)
    expect(held.held).toBe(1)
    expect(held.available).toBe(999)

    await complete(assetId)
    await sealSession({ sessionId: 'us_single', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
    await settleSession('us_single')

    const after = await walletService.getBalance(UID)
    expect(after.balance).toBe(999)
    expect(after.held).toBe(0)
    expect(after.available).toBe(999)
  })

  // ── 100-photo batch ────────────────────────────────────────────────────────

  it('a 100-photo batch uses ONE session and charges exactly 100', async () => {
    const slots = clientBatch(100, 'us_100')
    expect(new Set(slots.map(s => s.sessionId)).size).toBe(1)

    for (const s of slots) await complete(await prepare(s))

    // One session document for the whole batch — not one per photo.
    const sessions = await adminDb.collection('mediaCreditSessions')
      .where('organizerUid', '==', UID).get()
    expect(sessions.size).toBe(1)

    await sealSession({ sessionId: 'us_100', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
    await settleSession('us_100')

    const after = await walletService.getBalance(UID)
    expect(after.balance).toBe(900)
    expect(after.held).toBe(0)
  }, CONTENTION_TIMEOUT_MS)

  // ── Retry ──────────────────────────────────────────────────────────────────

  it('a RETRY reuses its slot and is charged once, not twice', async () => {
    // The failure this sprint exists to prevent. The client keeps sessionId+slotIndex on the
    // item, so the retry re-derives the same assetId and replays onto its own held slot.
    const [slot] = clientBatch(1, 'us_retry')

    const first  = await prepare(slot)
    const second = await prepare(slot)          // the retry — identical payload
    expect(second).toBe(first)

    const reservations = await adminDb.collection('mediaCreditReservations')
      .where('organizerUid', '==', UID).get()
    expect(reservations.size).toBe(1)           // ONE slot consumed, not two

    await complete(first)
    await sealSession({ sessionId: 'us_retry', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
    await settleSession('us_retry')

    expect((await walletService.getBalance(UID)).balance).toBe(999)
  })

  it('a retry AFTER the photo completed is refused rather than re-charged', async () => {
    const [slot] = clientBatch(1, 'us_spent')
    const assetId = await prepare(slot)
    await complete(assetId)

    // The slot is consumed. Re-preparing it must fail — the server answers 409.
    await expect(prepare(slot)).rejects.toBeInstanceOf(errs.InvalidCreditOperationError)
  })

  // ── Cancellation ───────────────────────────────────────────────────────────

  it('a CANCELLED batch strands no credits — unused slots come back at settlement', async () => {
    const slots = clientBatch(10, 'us_cancel')

    // Three photos upload, then the organizer cancels. The remaining seven never call prepare.
    for (const s of slots.slice(0, 3)) await complete(await prepare(s))

    expect((await walletService.getBalance(UID)).held).toBe(10)   // whole batch still held

    await sealSession({ sessionId: 'us_cancel', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
    await settleSession('us_cancel')

    const after = await walletService.getBalance(UID)
    expect(after.balance).toBe(997)        // charged for 3
    expect(after.held).toBe(0)             // the other 7 returned
    expect(after.available).toBe(997)
  })

  it('a batch cancelled BEFORE any upload costs nothing at all', async () => {
    // The client mints a session id at `start` but the server opens nothing until the first
    // prepare names it. An abandoned id therefore holds no credits and leaves nothing behind.
    clientBatch(50, 'us_never_used')

    const before = await walletService.getBalance(UID)
    expect(before.balance).toBe(1_000)
    expect(before.held).toBe(0)

    const sessions = await adminDb.collection('mediaCreditSessions')
      .where('organizerUid', '==', UID).get()
    expect(sessions.size).toBe(0)
  })

  // ── Duplicate calls ────────────────────────────────────────────────────────

  it('a duplicate PREPARE on a held slot is a no-op', async () => {
    const [slot] = clientBatch(1, 'us_dup_prep')
    await prepare(slot)
    await prepare(slot)
    await prepare(slot)

    const reservations = await adminDb.collection('mediaCreditReservations')
      .where('organizerUid', '==', UID).get()
    expect(reservations.size).toBe(1)
    expect((await walletService.getBalance(UID)).held).toBe(1)
  })

  it('a duplicate COMPLETE does not double-consume', async () => {
    const [slot] = clientBatch(1, 'us_dup_comp')
    const assetId = await prepare(slot)

    await complete(assetId)
    // The reservation is already `consumed`; a replay must not move the balance again.
    await complete(assetId).catch(() => { /* terminal reservation — either outcome is safe */ })

    await sealSession({ sessionId: 'us_dup_comp', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
    await settleSession('us_dup_comp')
    expect((await walletService.getBalance(UID)).balance).toBe(999)
  })

  it('a duplicate SETTLE does not charge twice', async () => {
    const [slot] = clientBatch(1, 'us_dup_settle')
    await complete(await prepare(slot))
    await sealSession({ sessionId: 'us_dup_settle', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })

    await settleSession('us_dup_settle')
    await settleSession('us_dup_settle')

    expect((await walletService.getBalance(UID)).balance).toBe(999)
  })

  // ── Parallel ───────────────────────────────────────────────────────────────

  it('parallel uploads within one batch claim distinct slots', async () => {
    // Driven through a bounded window, exactly like the real client.
    //
    // An earlier version fired all 24 at once with `Promise.all`. That is 6× the concurrency
    // the product ever reaches, and every one of those transactions raced to `tx.create` the
    // SAME session document — one won and 23 retried with backoff until the emulator's lock
    // timeout fired. It passed twice and failed on the third run. A test that invents
    // contention the product cannot produce measures the emulator, not the code.
    const slots = clientBatch(24, 'us_parallel')
    const window = MAX_CONCURRENT_UPLOADS
    for (let i = 0; i < slots.length; i += window) {
      await Promise.all(
        slots.slice(i, i + window).map(async s => complete(await prepare(s))),
      )
    }

    const reservations = await adminDb.collection('mediaCreditReservations')
      .where('organizerUid', '==', UID).get()
    expect(reservations.size).toBe(24)
    expect(new Set(reservations.docs.map(d => d.id)).size).toBe(24)

    await sealSession({ sessionId: 'us_parallel', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
    await settleSession('us_parallel')
    expect((await walletService.getBalance(UID)).balance).toBe(976)
  }, CONTENTION_TIMEOUT_MS)

  it('two independent batches hold and settle separately', async () => {
    const a = clientBatch(5, 'us_batch_a')
    const b = clientBatch(3, 'us_batch_b')

    for (const s of a) await complete(await prepare(s))
    for (const s of b) await complete(await prepare(s))

    expect((await walletService.getBalance(UID)).held).toBe(8)

    for (const id of ['us_batch_a', 'us_batch_b']) {
      await sealSession({ sessionId: id, organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
      await settleSession(id)
    }
    const after = await walletService.getBalance(UID)
    expect(after.balance).toBe(992)
    expect(after.held).toBe(0)
  })

  // ── The affordability gate still holds ─────────────────────────────────────

  it('a batch larger than the balance is refused at session open', async () => {
    await reset(5)
    const slots = clientBatch(50, 'us_too_big')
    await expect(prepare(slots[0])).rejects.toBeInstanceOf(errs.InsufficientCreditsError)

    // Nothing was held, and no session exists to reclaim.
    expect((await walletService.getBalance(UID)).held).toBe(0)
  })

  // ── MC-10.5 · running out mid-batch, topping up, resuming ──────────────────

  it('a batch that outruns the balance stops, tops up and RESUMES onto the same slots', async () => {
    // The journey MC-10.3 found broken. Everything here is the organizer's real path:
    // upload until the credits run out, buy more, resume, finish.
    await reset(20)

    // 25 photos, only 20 credits. The session cannot open — this is the 402 the client now
    // classifies as `insufficient_credits` instead of `unknown`.
    const slots = clientBatch(25, 'us_stop')
    await expect(prepare(slots[0])).rejects.toBeInstanceOf(errs.InsufficientCreditsError)

    // Nothing was held and no session exists — the stop costs nothing.
    expect((await walletService.getBalance(UID)).held).toBe(0)
    expect((await adminDb.collection('mediaCreditSessions')
      .where('organizerUid', '==', UID).get()).size).toBe(0)

    // The organizer tops up. (A grant here stands in for a purchase: both land through the
    // same single writer, and MC-08 already proves the Razorpay half.)
    await createGrant({
      grantId: 'topup_stop', organizerUid: UID, credits: 30,
      reason: 'support', note: 'Topping up after the batch outran the balance.', actorUid: ACTOR,
    })
    expect((await walletService.getBalance(UID)).available).toBe(50)

    // Resume. The client keeps sessionId and slotIndex on each item (MC-10.2), so the very
    // same slots are used — no renumbering, no second allocation.
    for (const s of slots) await complete(await prepare(s))

    expect((await adminDb.collection('mediaCreditReservations')
      .where('organizerUid', '==', UID).get()).size).toBe(25)

    await sealSession({ sessionId: 'us_stop', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
    await settleSession('us_stop')

    const after = await walletService.getBalance(UID)
    expect(after.balance).toBe(25)     // 50 funded − 25 photos
    expect(after.held).toBe(0)
  }, CONTENTION_TIMEOUT_MS)

  it('a PARTIAL batch keeps what already uploaded when the next session cannot open', async () => {
    await reset(10)

    // First batch of 10 fits exactly.
    const first = clientBatch(10, 'us_partial_a')
    for (const s of first) await complete(await prepare(s))
    await sealSession({ sessionId: 'us_partial_a', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
    await settleSession('us_partial_a')
    expect((await walletService.getBalance(UID)).balance).toBe(0)

    // The next batch cannot start. The first ten stay uploaded and paid for.
    const second = clientBatch(5, 'us_partial_b')
    await expect(prepare(second[0])).rejects.toBeInstanceOf(errs.InsufficientCreditsError)

    const reservations = await adminDb.collection('mediaCreditReservations')
      .where('organizerUid', '==', UID).get()
    expect(reservations.size).toBe(10)                    // the first batch, untouched
    expect((await walletService.getBalance(UID)).balance).toBe(0)
  })

  // ── I1 across the whole contract ───────────────────────────────────────────

  it('I1 · balance equals the sum of ledger deltas after a mixed run', async () => {
    const slots = clientBatch(12, 'us_i1')
    for (const s of slots.slice(0, 8)) await complete(await prepare(s))
    await sealSession({ sessionId: 'us_i1', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
    await settleSession('us_i1')

    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    const sum = snap.docs.reduce((n, d) => n + (d.data().delta as number), 0)

    expect((await walletService.getBalance(UID)).balance).toBe(sum)
  })
  // ── MS-FINAL-01 · skipped duplicates cost nothing ──────────────────────────

  describe('duplicate skipping', () => {
    /** The client after a scan: duplicates are in the `duplicate` state, the rest queued. */
    function batchWithDuplicates(total: number, duplicateIds: readonly number[], sessionId: string) {
      const items = Array.from({ length: total }, (_, i) => ({
        id: `q${i}`,
        state: duplicateIds.includes(i) ? 'duplicate' : 'queued',
        sessionId: null as string | null,
      }))
      return assignSlots(items, sessionId)
    }

    it('a skipped duplicate never opens a slot, reserves or is charged', async () => {
      // 10 photos, 4 already uploaded. Only 6 should cost anything.
      const slots = batchWithDuplicates(10, [2, 5, 7, 9], 'us_dup_skip')
      expect(slots).toHaveLength(6)
      expect(slots.every(s => s.sessionSlots === 6)).toBe(true)

      for (const s of slots) await complete(await prepare(s))

      // The session held SIX, not ten.
      const session = (await adminDb.doc('mediaCreditSessions/us_dup_skip').get()).data()
      expect(session?.slotCount).toBe(6)
      expect(session?.allocatedCredits).toBe(6)

      // Six reservations — none for the duplicates.
      const reservations = await adminDb.collection('mediaCreditReservations')
        .where('organizerUid', '==', UID).get()
      expect(reservations.size).toBe(6)

      await sealSession({ sessionId: 'us_dup_skip', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
      await settleSession('us_dup_skip')

      const after = await walletService.getBalance(UID)
      expect(after.balance).toBe(994)      // charged for 6, not 10
      expect(after.held).toBe(0)
    }, CONTENTION_TIMEOUT_MS)

    it('a batch that is ENTIRELY duplicates opens no session and costs nothing', async () => {
      const slots = batchWithDuplicates(8, [0, 1, 2, 3, 4, 5, 6, 7], 'us_dup_all')
      expect(slots).toEqual([])

      const before = await walletService.getBalance(UID)
      expect(before.balance).toBe(1_000)
      expect(before.held).toBe(0)

      const sessions = await adminDb.collection('mediaCreditSessions')
        .where('organizerUid', '==', UID).get()
      expect(sessions.size).toBe(0)
    })

    it('a batch with NO duplicates behaves exactly as before', async () => {
      const slots = batchWithDuplicates(5, [], 'us_dup_none')
      expect(slots).toHaveLength(5)

      for (const s of slots) await complete(await prepare(s))
      await sealSession({ sessionId: 'us_dup_none', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
      await settleSession('us_dup_none')

      expect((await walletService.getBalance(UID)).balance).toBe(995)
    })

    it('"upload anyway" charges for them, in a session of its own', async () => {
      // The organizer chose to upload 3 duplicates after skipping nothing. They are
      // re-queued, get slots on the next Start, and are paid for like any other photo.
      const first = batchWithDuplicates(5, [0, 1, 2], 'us_dup_first')
      expect(first).toHaveLength(2)
      for (const s of first) await complete(await prepare(s))
      await sealSession({ sessionId: 'us_dup_first', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
      await settleSession('us_dup_first')
      expect((await walletService.getBalance(UID)).balance).toBe(998)

      // resolveDuplicate returns them to `queued`; the next Start slots all three.
      const second = batchWithDuplicates(3, [], 'us_dup_anyway')
      expect(second).toHaveLength(3)
      for (const s of second) await complete(await prepare(s))
      await sealSession({ sessionId: 'us_dup_anyway', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
      await settleSession('us_dup_anyway')

      expect((await walletService.getBalance(UID)).balance).toBe(995)
    })

    it('I1 holds across a mixed batch', async () => {
      const slots = batchWithDuplicates(12, [1, 4, 8], 'us_dup_i1')
      for (const s of slots) await complete(await prepare(s))
      await sealSession({ sessionId: 'us_dup_i1', organizerUid: UID, reason: 'CLOSED', sealedBy: ACTOR })
      await settleSession('us_dup_i1')

      const snap = await adminDb.collection('mediaCreditLedger')
        .where('organizerUid', '==', UID).get()
      const sum = snap.docs.reduce((n, d) => n + (d.data().delta as number), 0)
      expect((await walletService.getBalance(UID)).balance).toBe(sum)
    }, CONTENTION_TIMEOUT_MS)
  })

})
