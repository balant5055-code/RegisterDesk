// MC-06C · Settlement engine — REAL Firestore (emulator).
//
// Settlement is the ONLY place credits are consumed, so this is where the money moves and
// where the guarantees have to hold: exactly once, atomically, and with the ledger and wallet
// agreeing afterwards.
//
// A real database is required for the atomicity and concurrency claims — two settlements
// serialise on the session document, which is the primary idempotency guard.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

/**
 * These tests drive real uploads — one transaction per photo — so a 100-photo session is a
 * hundred sequential round trips. vitest's 5s default measures emulator latency, not
 * correctness, so the whole file runs on a realistic budget.
 */
const SETTLEMENT_TIMEOUT_MS = 60_000

describeEmu('MC-06C · session settlement', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let sessions: typeof import('@/features/media-credits/services/sessionService')
  let settlement: typeof import('@/features/media-credits/services/sessionSettlementService')
  let sessionCleanup: typeof import('@/features/media-credits/services/sessionCleanupService')
  let sessionRepo: typeof import('@/features/media-credits/repositories/sessionRepo')
  let reservationRepo: typeof import('@/features/media-credits/repositories/reservationRepo')
  let slots: typeof import('@/features/media-credits/utils/sessionSlots')
  let errs: typeof import('@/features/media-credits/errors')

  const UID = `emu-mc06c-${process.pid}`
  const EVT = { eventId: 'mc06c-evt', eventSlug: 'mc06c-evt', galleryId: 'mc06c-gal' }
  const SEED = 1000
  let seq = 0
  const nextId = () => `s6c-${process.pid}-${++seq}`

  beforeAll(async () => {
    const project = process.env.GCLOUD_PROJECT ?? ''
    if (!project.startsWith('demo-')) {
      throw new Error(`Refusing to run: GCLOUD_PROJECT must be a demo- project, got "${project}".`)
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    const svc = await import('@/features/media-credits/services')
    ledgerService = svc.ledgerService
    walletService = svc.walletService
    sessions       = await import('@/features/media-credits/services/sessionService')
    settlement     = await import('@/features/media-credits/services/sessionSettlementService')
    sessionCleanup = await import('@/features/media-credits/services/sessionCleanupService')
    sessionRepo     = await import('@/features/media-credits/repositories/sessionRepo')
    reservationRepo = await import('@/features/media-credits/repositories/reservationRepo')
    slots = await import('@/features/media-credits/utils/sessionSlots')
    errs  = await import('@/features/media-credits/errors')
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  async function reset(creditsPerPhoto = 1) {
    businessConfig.clearRuntimeOverrides()
    const batch = adminDb.batch()
    batch.delete(adminDb.doc(`mediaCreditWallets/${UID}`))
    for (const col of ['mediaCreditLedger', 'mediaCreditReservations', 'mediaCreditSessions']) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    await batch.commit()
    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto, creditUnitPricePaise: 100,
      minCreditPurchase: 1, refundsEnabled: true, refundWindowDays: 30,
      refundServiceChargeMethod: 'percent', refundServiceChargePercent: 10,
      refundServiceChargeFixedPaise: 0, minRefundablePaise: 100,
    } as never)
    await ledgerService.credit({
      organizerUid: UID, entryId: `mc06c-seed:${Date.now()}:${seq}`,
      credits: SEED, reason: 'grant', actorUid: 'test', actorKind: 'platform',
    })
  }

  /** Opens a session, uploads `uploads` of its `slotCount` slots, and seals it. */
  async function sessionWith(slotCount: number, uploads: number, seal = true) {
    const sessionId = nextId()
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount, actorUid: 'test', ...EVT,
    })
    for (let i = 0; i < uploads; i++) {
      const assetId = slots.deriveAssetId(sessionId, i)
      await ledgerService.reserve({
        organizerUid: UID, assetId, credits: 1, actorUid: 'test',
        sessionId, slotIndex: i, ...EVT,
      })
      await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' })
    }
    if (seal) await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: 'test' })
    return sessionId
  }

  async function ledgerSum() {
    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    return snap.docs.reduce((n, d) => n + (d.get('delta') as number), 0)
  }

  beforeEach(async () => { await reset() })

  // ── Successful settlement ──────────────────────────────────────────────────

  it('FULL UPLOADS: charges every slot and releases nothing', async () => {
    const sessionId = await sessionWith(100, 100)
    const result = await settlement.settleSession(sessionId)

    expect(result.settled).toBe(true)
    expect(result.consumedSlots).toBe(100)
    expect(result.creditsConsumed).toBe(100)
    expect(result.creditsReleased).toBe(0)

    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(SEED - 100)
    expect(b.held).toBe(0)                    // the whole allocation resolved
    expect(b.available).toBe(SEED - 100)
  }, SETTLEMENT_TIMEOUT_MS)

  it('PARTIAL UPLOADS: charges only what landed and returns the rest', async () => {
    const sessionId = await sessionWith(100, 37)
    const result = await settlement.settleSession(sessionId)

    expect(result.consumedSlots).toBe(37)
    expect(result.creditsConsumed).toBe(37)
    expect(result.creditsReleased).toBe(63)   // 100 held − 37 used

    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(SEED - 37)
    expect(b.held).toBe(0)
    expect(b.available).toBe(SEED - 37)
  }, SETTLEMENT_TIMEOUT_MS)

  it('ZERO UPLOADS: charges nothing, returns the whole hold, writes NO ledger entry', async () => {
    const before = await ledgerSum()
    const sessionId = await sessionWith(50, 0)
    const result = await settlement.settleSession(sessionId)

    expect(result.consumedSlots).toBe(0)
    expect(result.creditsConsumed).toBe(0)
    expect(result.creditsReleased).toBe(50)
    expect(result.entryId).toBeNull()         // no balance moved ⇒ nothing to record

    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(SEED)
    expect(b.held).toBe(0)
    expect(await ledgerSum()).toBe(before)
    expect((await sessionRepo.read(sessionId))!.status).toBe('SETTLED')
  }, SETTLEMENT_TIMEOUT_MS)

  it('honours the per-photo price SNAPSHOTTED at open, not the live one', async () => {
    await reset(2)                                    // 2 credits per photo at open
    const sessionId = await sessionWith(10, 5)        // holds 20, uses 5 slots
    businessConfig.setRuntimeOverride('mediaStudio', { creditsPerPhoto: 9 } as never)

    const result = await settlement.settleSession(sessionId)
    expect(result.creditsConsumed).toBe(10)           // 5 × 2, never 5 × 9
    expect(result.creditsReleased).toBe(10)           // 20 held − 10 used
  })

  // ── Counting ───────────────────────────────────────────────────────────────

  it('COUNTS consumed only — held, released and never-claimed are ignored', async () => {
    const sessionId = nextId()
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount: 10, actorUid: 'test', ...EVT,
    })
    const claim = async (i: number) => {
      const assetId = slots.deriveAssetId(sessionId, i)
      await ledgerService.reserve({
        organizerUid: UID, assetId, credits: 1, actorUid: 'test',
        sessionId, slotIndex: i, ...EVT,
      })
      return assetId
    }
    // 3 consumed, 2 released, 1 left held, 4 never claimed.
    for (const i of [0, 1, 2]) {
      await ledgerService.consume({ organizerUid: UID, assetId: await claim(i), actorUid: 'test' })
    }
    for (const i of [3, 4]) {
      await ledgerService.release({ organizerUid: UID, assetId: await claim(i), actorUid: 'test' })
    }
    await claim(5)

    expect(await reservationRepo.countConsumedBySession(sessionId)).toBe(3)

    await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: 'test' })
    const result = await settlement.settleSession(sessionId)
    expect(result.consumedSlots).toBe(3)
    expect(result.creditsConsumed).toBe(3)
  })

  // ── Guards ─────────────────────────────────────────────────────────────────

  it('refuses to settle an ACTIVE session — the count would be a moving target', async () => {
    const sessionId = await sessionWith(10, 3, /* seal */ false)
    await expect(settlement.settleSession(sessionId))
      .rejects.toThrow(errs.InvalidCreditOperationError)
    expect((await walletService.getBalance(UID)).balance).toBe(SEED)
  }, SETTLEMENT_TIMEOUT_MS)

  it('refuses an unknown session', async () => {
    await expect(settlement.settleSession('no-such-session'))
      .rejects.toThrow(errs.InvalidCreditOperationError)
  })

  // ── Idempotency ────────────────────────────────────────────────────────────

  it('DUPLICATE SETTLEMENT debits once and reports the existing outcome', async () => {
    const sessionId = await sessionWith(100, 40)
    const first  = await settlement.settleSession(sessionId)
    const second = await settlement.settleSession(sessionId)
    const third  = await settlement.settleSession(sessionId)

    expect(first.settled).toBe(true)
    expect(second.settled).toBe(false)                        // replay, not a second settle
    expect(second.creditsConsumed).toBe(first.creditsConsumed)
    expect(third.creditsConsumed).toBe(first.creditsConsumed)

    expect((await walletService.getBalance(UID)).balance).toBe(SEED - 40)
  }, SETTLEMENT_TIMEOUT_MS)

  it('WALLET UPDATED ONCE and LEDGER UPDATED ONCE across repeated settlement', async () => {
    const sessionId = await sessionWith(100, 25)
    await settlement.settleSession(sessionId)
    await settlement.settleSession(sessionId)

    const entries = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).where('reason', '==', 'consume').get()
    expect(entries.size).toBe(1)
    expect(entries.docs[0].id).toBe(`session-settle:${sessionId}`)
    expect(entries.docs[0].get('delta')).toBe(-25)

    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(SEED - 25)
    expect(b.held).toBe(0)
  }, SETTLEMENT_TIMEOUT_MS)

  it('CONCURRENT SETTLEMENT: 8 simultaneous settles debit exactly once', async () => {
    const sessionId = await sessionWith(100, 60)

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => settlement.settleSession(sessionId)),
    )
    const winners = results.filter(
      r => r.status === 'fulfilled' && r.value.settled,
    ).length
    expect(winners).toBe(1)

    expect((await walletService.getBalance(UID)).balance).toBe(SEED - 60)
    const entries = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).where('reason', '==', 'consume').get()
    expect(entries.size).toBe(1)
  }, SETTLEMENT_TIMEOUT_MS)

  it('SESSION MARKED SETTLED records the count and the entry it settled on', async () => {
    const sessionId = await sessionWith(100, 12)
    await settlement.settleSession(sessionId)

    const stored = await sessionRepo.read(sessionId)
    expect(stored!.status).toBe('SETTLED')
    expect(stored!.consumedSlots).toBe(12)
    expect(stored!.settlementEntryId).toBe(`session-settle:${sessionId}`)
    expect(stored!.settledAt).not.toBeNull()
  })

  // ── Crash recovery / replay ────────────────────────────────────────────────

  it('CRASH RECOVERY: a session sealed but never settled is picked up by the sweep', async () => {
    const sessionId = await sessionWith(100, 30)   // sealed, settlement never ran

    const report = await settlement.settleSealedSessions({ limit: 50 })
    expect(report.settled).toBeGreaterThanOrEqual(1)
    expect(report.creditsConsumed).toBeGreaterThanOrEqual(30)

    expect((await sessionRepo.read(sessionId))!.status).toBe('SETTLED')
    expect((await walletService.getBalance(UID)).balance).toBe(SEED - 30)
  }, SETTLEMENT_TIMEOUT_MS)

  it('SETTLEMENT REPLAY: a second sweep settles nothing again', async () => {
    await sessionWith(100, 30)
    const first  = await settlement.settleSealedSessions({ limit: 50 })
    const second = await settlement.settleSealedSessions({ limit: 50 })

    expect(first.settled).toBeGreaterThanOrEqual(1)
    expect(second.settled).toBe(0)                 // nothing left in SEALED
    expect((await walletService.getBalance(UID)).balance).toBe(SEED - 30)
  })

  // ── Cleanup ordering ───────────────────────────────────────────────────────

  it('CLEANUP ORDERING: expired session is sealed, settled, then reservations reclaimed', async () => {
    const sessionId = await sessionWith(20, 8, /* seal */ false)
    // Age it so the sweep treats it as abandoned.
    await adminDb.doc(`mediaCreditSessions/${sessionId}`).update({
      expiresAt: new Date(Date.now() - 60_000),
    })

    const report = await sessionCleanup.runSessionCleanup({ limit: 50 })

    expect(report.seal.sealed).toBeGreaterThanOrEqual(1)
    expect(report.settle.settled).toBeGreaterThanOrEqual(1)

    const stored = await sessionRepo.read(sessionId)
    expect(stored!.status).toBe('SETTLED')
    expect(stored!.sealReason).toBe('EXPIRED')
    expect(stored!.consumedSlots).toBe(8)

    // Charged for exactly what landed, hold fully returned.
    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(SEED - 8)
    expect(b.held).toBe(0)
  }, SETTLEMENT_TIMEOUT_MS)

  it('CLEANUP ORDERING: reclaiming reservations first would under-charge — it does not', async () => {
    // If the sweep released reservations before settling, the count would drop to zero and
    // the organizer would be charged nothing for photos that really landed.
    const sessionId = await sessionWith(20, 15, /* seal */ false)
    await adminDb.doc(`mediaCreditSessions/${sessionId}`).update({
      expiresAt: new Date(Date.now() - 60_000),
    })

    await sessionCleanup.runSessionCleanup({ limit: 50 })

    expect((await sessionRepo.read(sessionId))!.consumedSlots).toBe(15)
    expect((await walletService.getBalance(UID)).balance).toBe(SEED - 15)
  }, SETTLEMENT_TIMEOUT_MS)

  // ── The invariant ──────────────────────────────────────────────────────────

  it('LEDGER == WALLET after settling several sessions', async () => {
    const a = await sessionWith(50, 20)
    const b = await sessionWith(50, 0)
    const c = await sessionWith(50, 50)
    for (const s of [a, b, c]) await settlement.settleSession(s)

    const wallet = await walletService.getBalance(UID)
    expect(wallet.balance).toBe(await ledgerSum())
    expect(wallet.balance).toBe(SEED - 70)          // 20 + 0 + 50
    expect(wallet.held).toBe(0)
    expect(wallet.available).toBeGreaterThanOrEqual(0)
  }, SETTLEMENT_TIMEOUT_MS)

  it('LEDGER == WALLET holds mid-flight, with one session settled and one still open', async () => {
    const settled = await sessionWith(50, 20)
    await settlement.settleSession(settled)
    await sessionWith(50, 10, /* seal */ false)     // still ACTIVE, holding 50

    const wallet = await walletService.getBalance(UID)
    expect(wallet.balance).toBe(await ledgerSum())  // continuous, not just at boundaries
    expect(wallet.held).toBe(50)                    // the open session's allocation
    expect(wallet.available).toBe(wallet.balance - 50)
  }, SETTLEMENT_TIMEOUT_MS)
})
