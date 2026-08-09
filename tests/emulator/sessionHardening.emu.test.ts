// MC-06E · Production hardening — REAL Firestore (emulator).
//
// Every scenario here is data that "cannot happen" through the API: corrupt numbers, missing
// documents, deleted records, impossible states. Each one asserts the same property —
// **fail closed**. The system refuses and reports, and never quietly charges the wrong amount.
//
// The failure mode this exists to prevent is not a crash. It is a SILENT UNDER-CHARGE: MC-06D
// found that a non-numeric `creditsPerPhotoAtOpen` settled a whole session for free.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const TIMEOUT_MS = 60_000

describeEmu('MC-06E · corruption and fail-closed behaviour', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let sessions: typeof import('@/features/media-credits/services/sessionService')
  let settlement: typeof import('@/features/media-credits/services/sessionSettlementService')
  let cleanup: typeof import('@/features/media-credits/services/sessionCleanupService')
  let sessionRepo: typeof import('@/features/media-credits/repositories/sessionRepo')
  let slots: typeof import('@/features/media-credits/utils/sessionSlots')
  let errs: typeof import('@/features/media-credits/errors')

  const UID = `emu-mc06e-${process.pid}`
  const EVT = { eventId: 'mc06e-evt', eventSlug: 'mc06e-evt', galleryId: 'mc06e-gal' }
  const SEED = 1000
  let seq = 0
  const nextId = () => `s6e-${process.pid}-${++seq}`

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
    sessions    = await import('@/features/media-credits/services/sessionService')
    settlement  = await import('@/features/media-credits/services/sessionSettlementService')
    cleanup     = await import('@/features/media-credits/services/sessionCleanupService')
    sessionRepo = await import('@/features/media-credits/repositories/sessionRepo')
    slots       = await import('@/features/media-credits/utils/sessionSlots')
    errs        = await import('@/features/media-credits/errors')
  })

  // This suite deliberately leaves permanently-unsettleable sessions behind. They are SEALED
  // forever, and `listSealed` orders oldest-first — so left in place they would occupy the
  // head of the settlement queue and starve every later suite's sessions. Cleaning up is not
  // tidiness here; without it the pollution silently breaks other tests.
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
      organizerUid: UID, entryId: `mc06e-seed:${Date.now()}:${seq}`,
      credits: SEED, reason: 'grant', actorUid: 'test', actorKind: 'platform',
    })
  }

  /** A SEALED session with `uploads` consumed slots, ready to settle. */
  async function sealedSession(slotCount: number, uploads: number) {
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
    await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: 'test' })
    return sessionId
  }

  beforeEach(async () => { await reset() })

  // ── Corrupt session numbers ────────────────────────────────────────────────

  it.each([
    ['creditsPerPhotoAtOpen', 'not-a-number'],
    ['creditsPerPhotoAtOpen', null],
    ['creditsPerPhotoAtOpen', 1.5],
    ['creditsPerPhotoAtOpen', -1],
    ['allocatedCredits',      'oops'],
    ['allocatedCredits',      -5],
  ])('CORRUPT SESSION (%s = %s) fails closed and charges NOTHING', async (field, value) => {
    const sessionId = await sealedSession(20, 10)
    await adminDb.doc(`mediaCreditSessions/${sessionId}`).update({ [field]: value })

    await expect(settlement.settleSession(sessionId))
      .rejects.toThrow(errs.CorruptSessionDataError)

    // THE assertion: nothing settled for free. Before MC-06E's guard, a NaN here charged 0
    // and marked the session SETTLED — the organizer got the whole batch at no cost.
    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(SEED)
    expect((await sessionRepo.read(sessionId))!.status).toBe('SEALED')  // retryable
  }, TIMEOUT_MS)

  it('a corrupt session is REPORTED with the field name, never its value', async () => {
    const sessionId = await sealedSession(10, 4)
    await adminDb.doc(`mediaCreditSessions/${sessionId}`)
      .update({ creditsPerPhotoAtOpen: 'SENSITIVE-VALUE' })

    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation(l => { lines.push(String(l)) })
    await settlement.settleSession(sessionId).catch(() => { /* expected */ })
    spy.mockRestore()

    const corrupt = lines
      .filter(l => l.startsWith('{'))
      .map(l => JSON.parse(l) as Record<string, unknown>)
      .filter(e => e.event === 'session.corrupt')

    expect(corrupt).toHaveLength(1)
    expect(corrupt[0].field).toBe('creditsPerPhotoAtOpen')
    expect(JSON.stringify(corrupt[0])).not.toContain('SENSITIVE-VALUE')
  }, TIMEOUT_MS)

  it('the sweep isolates a corrupt session and settles the healthy ones', async () => {
    const good1 = await sealedSession(10, 3)
    const bad   = await sealedSession(10, 2)
    const good2 = await sealedSession(10, 4)
    await adminDb.doc(`mediaCreditSessions/${bad}`).update({ allocatedCredits: 'corrupt' })

    const report = await cleanup.runSessionCleanup({ limit: 50, budgetMs: 30_000 })

    expect(report.settle.settled).toBeGreaterThanOrEqual(2)
    expect(report.settle.failed).toBeGreaterThanOrEqual(1)
    expect((await sessionRepo.read(good1))!.status).toBe('SETTLED')
    expect((await sessionRepo.read(good2))!.status).toBe('SETTLED')
    expect((await sessionRepo.read(bad))!.status).toBe('SEALED')   // left for a human
    expect((await walletService.getBalance(UID)).balance).toBe(SEED - 7)
  }, TIMEOUT_MS)

  // ── Missing / deleted documents ────────────────────────────────────────────

  it('DELETED SESSION: settlement refuses rather than inventing a charge', async () => {
    const sessionId = await sealedSession(10, 3)
    await adminDb.doc(`mediaCreditSessions/${sessionId}`).delete()

    await expect(settlement.settleSession(sessionId))
      .rejects.toThrow(errs.InvalidCreditOperationError)
    expect((await walletService.getBalance(UID)).balance).toBe(SEED)
  }, TIMEOUT_MS)

  it('DELETED SESSION mid-upload: consuming a slot fails closed', async () => {
    const sessionId = nextId()
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount: 10, actorUid: 'test', ...EVT,
    })
    const assetId = slots.deriveAssetId(sessionId, 0)
    await ledgerService.reserve({
      organizerUid: UID, assetId, credits: 1, actorUid: 'test', sessionId, slotIndex: 0, ...EVT,
    })
    await adminDb.doc(`mediaCreditSessions/${sessionId}`).delete()

    await expect(ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' }))
      .rejects.toThrow(errs.InvalidCreditOperationError)
  }, TIMEOUT_MS)

  it('MISSING RESERVATION: consuming a slot that was never claimed fails closed', async () => {
    const sessionId = nextId()
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount: 10, actorUid: 'test', ...EVT,
    })
    await expect(ledgerService.consume({
      organizerUid: UID, assetId: slots.deriveAssetId(sessionId, 3), actorUid: 'test',
    })).rejects.toThrow(errs.InvalidCreditOperationError)
  }, TIMEOUT_MS)

  it('DELETED RESERVATION: settlement simply does not count it', async () => {
    const sessionId = nextId()
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount: 10, actorUid: 'test', ...EVT,
    })
    for (let i = 0; i < 4; i++) {
      const assetId = slots.deriveAssetId(sessionId, i)
      await ledgerService.reserve({
        organizerUid: UID, assetId, credits: 1, actorUid: 'test', sessionId, slotIndex: i, ...EVT,
      })
      await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' })
    }
    // Erase one consumed slot's evidence.
    await adminDb.doc(`mediaCreditReservations/${slots.deriveAssetId(sessionId, 0)}`).delete()
    await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: 'test' })

    const result = await settlement.settleSession(sessionId)
    // Under-charges by the erased slot rather than failing — the count is derived from what
    // exists, and a missing record is indistinguishable from a slot never used. Errs toward
    // the organizer, which is the right direction for a charge.
    expect(result.consumedSlots).toBe(3)
    expect((await walletService.getBalance(UID)).balance).toBe(SEED - 3)
  }, TIMEOUT_MS)

  it('MISSING WALLET: settling for an organizer with no wallet document is safe', async () => {
    const sessionId = await sealedSession(10, 0)
    await adminDb.doc(`mediaCreditWallets/${UID}`).delete()

    // Zero consumption, so nothing is charged and the absent wallet is created empty by the
    // merge write rather than throwing.
    const result = await settlement.settleSession(sessionId)
    expect(result.creditsConsumed).toBe(0)
    const b = await walletService.getBalance(UID)
    expect(b.available).toBeGreaterThanOrEqual(0)
    expect(b.held).toBeGreaterThanOrEqual(0)
  }, TIMEOUT_MS)

  // ── Unexpected states ──────────────────────────────────────────────────────

  it('UNEXPECTED STATE: settling an ACTIVE session is refused', async () => {
    const sessionId = nextId()
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount: 10, actorUid: 'test', ...EVT,
    })
    await expect(settlement.settleSession(sessionId))
      .rejects.toThrow(errs.InvalidCreditOperationError)
  }, TIMEOUT_MS)

  it('UNEXPECTED STATE: an unknown status is refused rather than guessed at', async () => {
    const sessionId = await sealedSession(10, 3)
    await adminDb.doc(`mediaCreditSessions/${sessionId}`).update({ status: 'WHO_KNOWS' })

    await expect(settlement.settleSession(sessionId))
      .rejects.toThrow(errs.InvalidCreditOperationError)
    expect((await walletService.getBalance(UID)).balance).toBe(SEED)
  }, TIMEOUT_MS)

  it('a corrupt session cannot be settled by RETRY either — it stays refused', async () => {
    const sessionId = await sealedSession(10, 5)
    await adminDb.doc(`mediaCreditSessions/${sessionId}`).update({ allocatedCredits: NaN })

    for (let i = 0; i < 3; i++) {
      await settlement.settleSession(sessionId).catch(() => { /* expected */ })
    }
    expect((await walletService.getBalance(UID)).balance).toBe(SEED)
    expect((await sessionRepo.read(sessionId))!.status).toBe('SEALED')
  }, TIMEOUT_MS)

  it('THE invariant survives every corruption scenario', async () => {
    const ok  = await sealedSession(10, 4)
    const bad = await sealedSession(10, 3)
    await adminDb.doc(`mediaCreditSessions/${bad}`).update({ creditsPerPhotoAtOpen: 'x' })

    await settlement.settleSession(ok)
    await settlement.settleSession(bad).catch(() => { /* expected */ })

    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    const sum = snap.docs.reduce((n, d) => n + (d.get('delta') as number), 0)
    const b = await walletService.getBalance(UID)

    expect(b.balance).toBe(sum)
    expect(b.available).toBeGreaterThanOrEqual(0)
    expect(b.held).toBeGreaterThanOrEqual(0)
  }, TIMEOUT_MS)
})

// ─── MC-06F · Service-level slot validation ───────────────────────────────────
//
// MC-06E found the bound lived only in the upload route, so a caller reaching the service
// directly could claim past a session's allocation. These assert the guarantee now holds at
// the SERVICE boundary, independent of caller discipline.

describeEmu('MC-06F · service-level slot validation', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let sessions: typeof import('@/features/media-credits/services/sessionService')
  let slots: typeof import('@/features/media-credits/utils/sessionSlots')
  let errs: typeof import('@/features/media-credits/errors')

  const UID = `emu-mc06f-slot-${process.pid}`
  const EVT = { eventId: 'f-evt', eventSlug: 'f-evt', galleryId: 'f-gal' }
  let seq = 0

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) {
      throw new Error('Refusing to run outside a demo- project.')
    }
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ businessConfig } = await import('@/lib/config/businessConfigService'))
    ;({ ledgerService } = await import('@/features/media-credits/services'))
    sessions = await import('@/features/media-credits/services/sessionService')
    slots    = await import('@/features/media-credits/utils/sessionSlots')
    errs     = await import('@/features/media-credits/errors')
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  /** A live session with 10 slots and credits behind it. */
  async function liveSession() {
    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: 100,
      minCreditPurchase: 1, refundsEnabled: true, refundWindowDays: 30,
      refundServiceChargeMethod: 'percent', refundServiceChargePercent: 10,
      refundServiceChargeFixedPaise: 0, minRefundablePaise: 100,
    } as never)
    await ledgerService.credit({
      organizerUid: UID, entryId: `f-seed:${Date.now()}:${++seq}`,
      credits: 500, reason: 'grant', actorUid: 'test', actorKind: 'platform',
    })
    const sessionId = `f-slot-${process.pid}-${seq}`
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount: 10, actorUid: 'test', ...EVT,
    })
    return sessionId
  }

  const claim = (sessionId: string, slotIndex: number, assetId?: string) =>
    ledgerService.reserve({
      organizerUid: UID, assetId: assetId ?? slots.deriveAssetId(sessionId, slotIndex),
      credits: 1, actorUid: 'test', sessionId, slotIndex, ...EVT,
    })

  it('accepts a slot inside the allocation', async () => {
    const sessionId = await liveSession()
    await expect(claim(sessionId, 9)).resolves.toBeUndefined()
  }, TIMEOUT_MS)

  it.each([10, 11, 999])('REJECTS slotIndex >= slotCount (%s) at the service', async idx => {
    const sessionId = await liveSession()
    await expect(claim(sessionId, idx)).rejects.toThrow(errs.InvalidCreditOperationError)
  }, TIMEOUT_MS)

  it.each([-1, -100, 1.5, NaN])('REJECTS an invalid slotIndex (%s)', async idx => {
    const sessionId = await liveSession()
    await expect(claim(sessionId, idx)).rejects.toThrow(errs.InvalidCreditOperationError)
  }, TIMEOUT_MS)

  it('REJECTS an assetId that is not the slot\'s derived id', async () => {
    // Without this check a caller could pair a valid index with an arbitrary assetId and
    // claim a slot the bound never actually covered.
    const sessionId = await liveSession()
    await expect(claim(sessionId, 3, 'an-asset-id-i-made-up'))
      .rejects.toThrow(errs.InvalidCreditOperationError)
  }, TIMEOUT_MS)

  it('REJECTS a claim against an unknown session', async () => {
    await expect(claim('no-such-session', 0)).rejects.toThrow(errs.InvalidCreditOperationError)
  }, TIMEOUT_MS)

  it('REJECTS a claim against a SEALED session', async () => {
    const sessionId = await liveSession()
    await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: 'test' })
    await expect(claim(sessionId, 0)).rejects.toThrow(errs.SessionNotActiveError)
  }, TIMEOUT_MS)

  it('REJECTS a claim from another workspace', async () => {
    const sessionId = await liveSession()
    await expect(ledgerService.reserve({
      organizerUid: 'other-workspace', assetId: slots.deriveAssetId(sessionId, 0),
      credits: 1, actorUid: 'intruder', sessionId, slotIndex: 0, ...EVT,
    })).rejects.toThrow(errs.InvalidCreditOperationError)
  }, TIMEOUT_MS)

  it('a rejected claim writes NO reservation', async () => {
    const sessionId = await liveSession()
    await claim(sessionId, 50).catch(() => { /* expected */ })
    const snap = await adminDb.collection('mediaCreditReservations')
      .where('sessionId', '==', sessionId).get()
    expect(snap.empty).toBe(true)
  }, TIMEOUT_MS)
})
