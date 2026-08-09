// MC-10.6 · Early session release — REAL Firestore (emulator).
//
// The organizer cancels; the credits their session was holding come back now instead of in
// six hours. The route is a thin caller of `sealSession` + `settleSession`, so what needs
// proving is not new arithmetic — there is none — but that triggering the EXISTING lifecycle
// early is safe under every race the sweep can create.
//
// Every test drives the same two service calls the route makes, in the same order.
//
// ═══ HOW TO RUN ══════════════════════════════════════════════════════════════
//   npm run emu:start        # requires JDK 21+
//   npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const CONTENTION_TIMEOUT_MS = 60_000

describeEmu('MC-10.6 · early session release', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let openSession: typeof import('@/features/media-credits/services/sessionService')['openSession']
  let sealSession: typeof import('@/features/media-credits/services/sessionService')['sealSession']
  let settleSession: typeof import('@/features/media-credits/services/sessionSettlementService')['settleSession']
  let runSessionCleanup: typeof import('@/features/media-credits/services/sessionCleanupService')['runSessionCleanup']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let createGrant: typeof import('@/features/media-credits/services/grantService')['createGrant']
  let deriveAssetId: typeof import('@/features/media-credits/utils/sessionSlots')['deriveAssetId']
  let errs: typeof import('@/features/media-credits/errors')

  const UID    = 'emu-release-organizer'
  const OTHER  = 'emu-release-intruder'
  const ACTOR  = 'emu-release-actor'
  const EVENT  = { eventId: 'evt_1', eventSlug: 'evt-1', galleryId: 'gal_1' }

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    ;({ openSession, sealSession } = await import('@/features/media-credits/services/sessionService'))
    ;({ settleSession } = await import('@/features/media-credits/services/sessionSettlementService'))
    ;({ runSessionCleanup } = await import('@/features/media-credits/services/sessionCleanupService'))
    ;({ ledgerService, walletService } = await import('@/features/media-credits/services'))
    ;({ createGrant } = await import('@/features/media-credits/services/grantService'))
    ;({ deriveAssetId } = await import('@/features/media-credits/utils/sessionSlots'))
    errs = await import('@/features/media-credits/errors')
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  async function reset(fund = 1_000) {
    businessConfig.clearRuntimeOverrides()
    const batch = adminDb.batch()
    for (const uid of [UID, OTHER]) batch.delete(adminDb.doc(`mediaCreditWallets/${uid}`))
    for (const col of ['mediaCreditLedger', 'mediaCreditGrants', 'mediaCreditSessions',
                       'mediaCreditReservations']) {
      for (const uid of [UID, OTHER]) {
        const snap = await adminDb.collection(col).where('organizerUid', '==', uid).get()
        snap.docs.forEach(d => batch.delete(d.ref))
      }
    }
    await batch.commit()
    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: 100, minCreditPurchase: 1,
    } as never)
    await createGrant({
      grantId: `fund_rel_${fund}`, organizerUid: UID, credits: fund,
      reason: 'migration', note: 'Funding the release tests.', actorUid: ACTOR,
    })
  }

  beforeEach(async () => { await reset() })

  /** What the route does, in the order it does it. */
  async function release(sessionId: string, organizerUid = UID) {
    const seal = await sealSession({
      sessionId, organizerUid, reason: 'CLOSED', sealedBy: ACTOR,
    })
    const settled = await settleSession(sessionId)
    return { seal, settled }
  }

  async function openBatch(sessionId: string, slots: number) {
    return openSession({
      sessionId, organizerUid: UID, ...EVENT, slotCount: slots, actorUid: ACTOR,
    })
  }

  async function uploadSlot(sessionId: string, slotIndex: number) {
    const assetId = deriveAssetId(sessionId, slotIndex)
    await ledgerService.reserve({
      organizerUid: UID, assetId, ...EVENT, credits: 1,
      sessionId, slotIndex, actorUid: ACTOR,
    })
    await adminDb.runTransaction(async tx => {
      const { consumeInTx } = await import('@/features/media-credits/services')
      await consumeInTx(tx, { organizerUid: UID, assetId, actorUid: ACTOR })
    })
  }

  // ── Cancel immediately ─────────────────────────────────────────────────────

  it('cancelling before any photo uploads returns the WHOLE allocation at once', async () => {
    await openBatch('rel_none', 100)
    expect((await walletService.getBalance(UID)).held).toBe(100)

    const { settled } = await release('rel_none')

    expect(settled.consumedSlots).toBe(0)
    expect(settled.creditsReleased).toBe(100)
    // A zero-consumption settlement writes no ledger entry — there was no movement.
    expect(settled.entryId).toBeNull()

    const after = await walletService.getBalance(UID)
    expect(after.balance).toBe(1_000)     // nothing charged
    expect(after.held).toBe(0)            // nothing still held
    expect(after.available).toBe(1_000)
  })

  // ── Cancel mid-batch / after 50% ───────────────────────────────────────────

  it('cancelling mid-batch charges what uploaded and releases the rest', async () => {
    await openBatch('rel_mid', 20)
    for (let i = 0; i < 7; i++) await uploadSlot('rel_mid', i)

    const { settled } = await release('rel_mid')

    expect(settled.consumedSlots).toBe(7)
    expect(settled.creditsConsumed).toBe(7)
    expect(settled.creditsReleased).toBe(13)

    const after = await walletService.getBalance(UID)
    expect(after.balance).toBe(993)
    expect(after.held).toBe(0)
  })

  it('cancelling at exactly 50% splits the allocation correctly', async () => {
    await openBatch('rel_half', 40)
    for (let i = 0; i < 20; i++) await uploadSlot('rel_half', i)

    const { settled } = await release('rel_half')
    expect(settled.consumedSlots).toBe(20)
    expect(settled.creditsReleased).toBe(20)
    expect((await walletService.getBalance(UID)).balance).toBe(980)
  }, CONTENTION_TIMEOUT_MS)

  // ── Cancel twice ───────────────────────────────────────────────────────────

  it('cancelling twice settles ONCE', async () => {
    await openBatch('rel_twice', 10)
    await uploadSlot('rel_twice', 0)

    const first  = await release('rel_twice')
    const second = await release('rel_twice')

    expect(first.seal.sealed).toBe(true)
    expect(second.seal.sealed).toBe(false)          // already terminal — a replay, not a fault
    if (!second.seal.sealed) expect(second.seal.reason).toBe('already_settled')
    expect(second.settled.settled).toBe(false)      // no second settlement

    // ONE settlement ledger entry, and the balance moved once.
    const entries = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).where('reason', '==', 'consume').get()
    expect(entries.size).toBe(1)
    expect((await walletService.getBalance(UID)).balance).toBe(999)
  })

  it('four parallel cancels of one session settle it once', async () => {
    await openBatch('rel_parallel', 12)
    for (let i = 0; i < 3; i++) await uploadSlot('rel_parallel', i)

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => release('rel_parallel')),
    )
    // None surfaces an error to the organizer.
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(4)

    const entries = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).where('reason', '==', 'consume').get()
    expect(entries.size).toBe(1)

    const after = await walletService.getBalance(UID)
    expect(after.balance).toBe(997)
    expect(after.held).toBe(0)
  }, CONTENTION_TIMEOUT_MS)

  // ── Cancel racing the scheduler ────────────────────────────────────────────

  it('cancel and the scheduler racing settle the session exactly once', async () => {
    await openBatch('rel_sweep', 15)
    for (let i = 0; i < 5; i++) await uploadSlot('rel_sweep', i)

    await Promise.allSettled([release('rel_sweep'), runSessionCleanup()])

    const entries = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).where('reason', '==', 'consume').get()
    expect(entries.size).toBe(1)

    const after = await walletService.getBalance(UID)
    expect(after.balance).toBe(995)
    expect(after.held).toBe(0)
  }, CONTENTION_TIMEOUT_MS)

  it('the scheduler finds nothing left to do after a release', async () => {
    await openBatch('rel_then_sweep', 8)
    await uploadSlot('rel_then_sweep', 0)
    await release('rel_then_sweep')

    const balanceBefore = await walletService.getBalance(UID)
    await runSessionCleanup()
    const balanceAfter = await walletService.getBalance(UID)

    // The safety net runs harmlessly over an already-settled session.
    expect(balanceAfter).toEqual(balanceBefore)
  }, CONTENTION_TIMEOUT_MS)

  // ── Ownership ──────────────────────────────────────────────────────────────

  it('another workspace cannot release a session it does not own', async () => {
    await openBatch('rel_owned', 10)

    await expect(release('rel_owned', OTHER))
      .rejects.toBeInstanceOf(errs.InvalidCreditOperationError)

    // Untouched: still ACTIVE, still holding.
    const session = (await adminDb.doc('mediaCreditSessions/rel_owned').get()).data()
    expect(session?.status).toBe('ACTIVE')
    expect((await walletService.getBalance(UID)).held).toBe(10)
  })

  it('releasing an unknown session is refused, not silently accepted', async () => {
    await expect(release('rel_does_not_exist'))
      .rejects.toBeInstanceOf(errs.InvalidCreditOperationError)
  })

  // ── Interaction with the rest of the lifecycle ─────────────────────────────

  it('a slot cannot be claimed after release — the seal barrier still holds', async () => {
    await openBatch('rel_barrier', 10)
    await uploadSlot('rel_barrier', 0)
    await release('rel_barrier')

    // MC-06F: reserve requires a live ACTIVE session. A late upload finds a SETTLED one and
    // is refused with the specific error, not a generic one — the caller can tell "this
    // session is over" apart from "this request was malformed".
    await expect(ledgerService.reserve({
      organizerUid: UID, assetId: deriveAssetId('rel_barrier', 1), ...EVENT,
      credits: 1, sessionId: 'rel_barrier', slotIndex: 1, actorUid: ACTOR,
    })).rejects.toBeInstanceOf(errs.SessionNotActiveError)

    expect((await walletService.getBalance(UID)).balance).toBe(999)
  })

  it('a released session does not stop a NEW batch from opening', async () => {
    await openBatch('rel_first', 30)
    await release('rel_first')
    expect((await walletService.getBalance(UID)).available).toBe(1_000)

    // The recovered credits are immediately usable — the whole point of the sprint.
    await openBatch('rel_second', 900)
    expect((await walletService.getBalance(UID)).held).toBe(900)
  }, CONTENTION_TIMEOUT_MS)

  // ── Financial invariants ───────────────────────────────────────────────────

  it('I1 · balance equals the sum of ledger deltas after several releases', async () => {
    await openBatch('rel_i1_a', 10)
    for (let i = 0; i < 4; i++) await uploadSlot('rel_i1_a', i)
    await release('rel_i1_a')

    await openBatch('rel_i1_b', 6)
    await release('rel_i1_b')

    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    const sum = snap.docs.reduce((n, d) => n + (d.data().delta as number), 0)

    const after = await walletService.getBalance(UID)
    expect(after.balance).toBe(sum)
    expect(after.held).toBe(0)
  }, CONTENTION_TIMEOUT_MS)

  it('releasing writes exactly one wallet-moving entry per session, and none for an empty one', async () => {
    await openBatch('rel_empty', 5)
    await release('rel_empty')

    await openBatch('rel_used', 5)
    await uploadSlot('rel_used', 0)
    await release('rel_used')

    const consume = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).where('reason', '==', 'consume').get()
    // One for the session that consumed something; none for the one that did not.
    expect(consume.size).toBe(1)
  })
})
