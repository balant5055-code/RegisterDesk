// MC-06F · Poison-session quarantine — REAL Firestore (emulator).
//
// MC-06E measured the failure this prevents. `listSealed` is ordered oldest-first, so a
// session that can never settle sits at the head of the queue and consumes the batch limit on
// every pass, starving every other organizer behind it. I hit it for real: ~10 corrupt
// sessions left by another suite blocked a healthy suite's sessions entirely.
//
// Quarantine is therefore not about repairing the broken session. It is about keeping the
// queue moving. The session stays SEALED and still owed a resolution — it has simply stopped
// blocking everyone else.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const TIMEOUT_MS = 60_000

describeEmu('MC-06F · poison-session quarantine', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let sessions: typeof import('@/features/media-credits/services/sessionService')
  let settlement: typeof import('@/features/media-credits/services/sessionSettlementService')
  let cleanup: typeof import('@/features/media-credits/services/sessionCleanupService')
  let sessionRepo: typeof import('@/features/media-credits/repositories/sessionRepo')
  let slots: typeof import('@/features/media-credits/utils/sessionSlots')

  const UID = `emu-mc06f-poison-${process.pid}`
  const EVT = { eventId: 'p-evt', eventSlug: 'p-evt', galleryId: 'p-gal' }
  const SEED = 2000
  let seq = 0

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    const svc = await import('@/features/media-credits/services')
    ledgerService = svc.ledgerService
    walletService = svc.walletService
    sessions    = await import('@/features/media-credits/services/sessionService')
    settlement  = await import('@/features/media-credits/services/sessionSettlementService')
    cleanup     = await import('@/features/media-credits/services/sessionCleanupService')
    sessionRepo = await import('@/features/media-credits/repositories/sessionRepo')
    slots       = await import('@/features/media-credits/utils/sessionSlots')
  })

  // Quarantined sessions are permanently unsettleable by construction. Left behind they would
  // pollute other suites exactly as MC-06E's leftovers did.
  afterAll(async () => {
    businessConfig.clearRuntimeOverrides()
    const snap = await adminDb.collection('mediaCreditSessions')
      .where('organizerUid', '==', UID).get()
    const batch = adminDb.batch()
    snap.docs.forEach(d => batch.delete(d.ref))
    await batch.commit()
  })

  async function reset() {
    businessConfig.clearRuntimeOverrides()
    const batch = adminDb.batch()
    batch.delete(adminDb.doc(`mediaCreditWallets/${UID}`))
    for (const col of ['mediaCreditLedger', 'mediaCreditReservations', 'mediaCreditSessions']) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    await batch.commit()
    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: 100,
      minCreditPurchase: 1, refundsEnabled: true, refundWindowDays: 30,
      refundServiceChargeMethod: 'percent', refundServiceChargePercent: 10,
      refundServiceChargeFixedPaise: 0, minRefundablePaise: 100,
    } as never)
    await ledgerService.credit({
      organizerUid: UID, entryId: `p-seed:${Date.now()}:${++seq}`,
      credits: SEED, reason: 'grant', actorUid: 'test', actorKind: 'platform',
    })
  }

  async function sealedSession(uploads: number) {
    const sessionId = `p-${process.pid}-${++seq}`
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount: 10, actorUid: 'test', ...EVT,
    })
    for (let i = 0; i < uploads; i++) {
      const assetId = slots.deriveAssetId(sessionId, i)
      await ledgerService.reserve({
        organizerUid: UID, assetId, credits: 1, actorUid: 'test', sessionId, slotIndex: i, ...EVT,
      })
      await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' })
    }
    await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: 'test' })
    return sessionId
  }

  const drive = async (passes: number, limit = 50) => {
    let quarantined = 0
    for (let i = 0; i < passes; i++) {
      const r = await settlement.settleSealedSessions({ limit, budgetMs: 30_000 })
      quarantined += r.quarantined
    }
    return quarantined
  }

  beforeEach(async () => { await reset() })

  it('counts attempts and QUARANTINES at the threshold', async () => {
    const bad = await sealedSession(3)
    await adminDb.doc(`mediaCreditSessions/${bad}`).update({ creditsPerPhotoAtOpen: 'corrupt' })

    await drive(settlement.MAX_SETTLEMENT_ATTEMPTS)

    const stored = await sessionRepo.read(bad)
    expect(stored!.settlementAttempts).toBeGreaterThanOrEqual(settlement.MAX_SETTLEMENT_ATTEMPTS)
    expect(stored!.quarantined).toBe(true)
    expect(stored!.quarantinedAt).not.toBeNull()
    // Still SEALED: deferred to an operator, not resolved.
    expect(stored!.status).toBe('SEALED')
  }, TIMEOUT_MS)

  it('THE point: a quarantined session leaves the queue so others are not starved', async () => {
    const bad = await sealedSession(3)
    await adminDb.doc(`mediaCreditSessions/${bad}`).update({ allocatedCredits: 'corrupt' })

    // limit 1 = a single queue slot, which the poison session would occupy forever.
    await drive(settlement.MAX_SETTLEMENT_ATTEMPTS, 1)
    expect((await sessionRepo.read(bad))!.quarantined).toBe(true)

    const good = await sealedSession(4)
    await settlement.settleSealedSessions({ limit: 1, budgetMs: 30_000 })

    expect((await sessionRepo.read(good))!.status).toBe('SETTLED')
    expect((await walletService.getBalance(UID)).balance).toBe(SEED - 4)
  }, TIMEOUT_MS)

  it('a healthy session is never quarantined', async () => {
    const good = await sealedSession(5)
    await drive(3)
    const stored = await sessionRepo.read(good)
    expect(stored!.status).toBe('SETTLED')
    expect(stored!.quarantined).toBe(false)
    expect(stored!.settlementAttempts).toBe(0)
  }, TIMEOUT_MS)

  it('quarantine is reported in metrics, separated from pendingSettlement', async () => {
    const before = await cleanup.sessionMetrics()
    const bad = await sealedSession(2)
    await adminDb.doc(`mediaCreditSessions/${bad}`).update({ creditsPerPhotoAtOpen: null })
    await drive(settlement.MAX_SETTLEMENT_ATTEMPTS)

    const after = await cleanup.sessionMetrics()
    expect(after.quarantined - before.quarantined).toBe(1)
    // A quarantined session is SEALED but no longer queued, so it must not inflate the
    // "work still to do" figure an operator watches.
    expect(after.pendingSettlement - before.pendingSettlement).toBe(0)
  }, TIMEOUT_MS)

  it('quarantine charges NOTHING — the credits stay held for a human', async () => {
    const bad = await sealedSession(6)
    await adminDb.doc(`mediaCreditSessions/${bad}`).update({ allocatedCredits: NaN })
    await drive(settlement.MAX_SETTLEMENT_ATTEMPTS + 2)

    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(SEED)      // never charged
    expect(b.held).toBe(10)           // still held — deferred, not resolved
    expect(b.available).toBeGreaterThanOrEqual(0)
  }, TIMEOUT_MS)

  it('the sweep reports exactly how many it quarantined', async () => {
    const bad = await sealedSession(2)
    await adminDb.doc(`mediaCreditSessions/${bad}`).update({ creditsPerPhotoAtOpen: -1 })
    expect(await drive(settlement.MAX_SETTLEMENT_ATTEMPTS)).toBe(1)
  }, TIMEOUT_MS)

  it('a quarantined session is listed for an operator', async () => {
    const bad = await sealedSession(2)
    await adminDb.doc(`mediaCreditSessions/${bad}`).update({ allocatedCredits: 'x' })
    await drive(settlement.MAX_SETTLEMENT_ATTEMPTS)

    const listed = await sessionRepo.listQuarantined(50)
    expect(listed.map(s => s.sessionId)).toContain(bad)
  }, TIMEOUT_MS)

  it('THE invariant holds with a quarantined session present', async () => {
    const bad = await sealedSession(3)
    await adminDb.doc(`mediaCreditSessions/${bad}`).update({ creditsPerPhotoAtOpen: 'x' })
    const good = await sealedSession(4)
    await drive(settlement.MAX_SETTLEMENT_ATTEMPTS)

    expect((await sessionRepo.read(good))!.status).toBe('SETTLED')

    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    const sum = snap.docs.reduce((n, d) => n + (d.get('delta') as number), 0)
    const b = await walletService.getBalance(UID)

    expect(b.balance).toBe(sum)
    expect(b.available).toBeGreaterThanOrEqual(0)
    expect(b.held).toBeGreaterThanOrEqual(0)
  }, TIMEOUT_MS)
})
