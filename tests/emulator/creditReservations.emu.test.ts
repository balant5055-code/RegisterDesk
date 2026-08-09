// MC-06B · Session-scoped reservations and upload integration — REAL Firestore (emulator).
//
// Supersedes the MC-03 suite of the same name. Those tests asserted that `reserve` held
// credits and `consume` debited the wallet; Architecture Spec v1.0 moved both to the session
// boundary, so they were testing behaviour that no longer exists. What is asserted here is
// the behaviour that replaced it — and, above all, that the wallet and ledger are NEVER
// touched per photo.
//
// The seal barrier needs a real Firestore: it works because a transaction that READ the
// session is aborted when a seal writes it. A mock would simply grant the read.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const CONTENTION_TIMEOUT_MS = 30_000

describeEmu('MC-06B · session-scoped uploads', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let consumeInTx: typeof import('@/features/media-credits/services')['consumeInTx']
  let sessions: typeof import('@/features/media-credits/services/sessionService')
  let reservationRepo: typeof import('@/features/media-credits/repositories/reservationRepo')
  let slots: typeof import('@/features/media-credits/utils/sessionSlots')
  let errs: typeof import('@/features/media-credits/errors')

  const UID = `emu-mc06b-${process.pid}`
  const EVT = { eventId: 'mc06b-evt', eventSlug: 'mc06b-evt', galleryId: 'mc06b-gal' }
  let seq = 0
  const nextSession = () => `s6b-${process.pid}-${++seq}`

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
    consumeInTx   = svc.consumeInTx
    sessions = await import('@/features/media-credits/services/sessionService')
    reservationRepo = await import('@/features/media-credits/repositories/reservationRepo')
    slots = await import('@/features/media-credits/utils/sessionSlots')
    errs  = await import('@/features/media-credits/errors')
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  async function reset(credits: number) {
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
      organizerUid: UID, entryId: `mc06b-seed:${Date.now()}:${credits}`,
      credits, reason: 'grant', actorUid: 'test', actorKind: 'platform',
    })
  }

  /** Opens a session and returns its id + slot count. */
  async function openSession(slotCount: number) {
    const sessionId = nextSession()
    await sessions.openSession({
      sessionId, organizerUid: UID, slotCount, actorUid: 'test', ...EVT,
    })
    return sessionId
  }

  /** Claims a slot the way `uploads/prepare` does. */
  async function claimSlot(sessionId: string, slotIndex: number) {
    const assetId = slots.deriveAssetId(sessionId, slotIndex)
    await ledgerService.reserve({
      organizerUid: UID, assetId, credits: 1, actorUid: 'test',
      sessionId, slotIndex, ...EVT,
    })
    return assetId
  }

  /** Snapshot of everything that must NOT move per photo. */
  async function financialSnapshot() {
    const b = await walletService.getBalance(UID)
    const ledger = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    return { balance: b.balance, held: b.held, available: b.available, ledgerEntries: ledger.size }
  }

  beforeEach(async () => { await reset(1000) })

  // ── Session upload ─────────────────────────────────────────────────────────

  it('SESSION UPLOAD: a full slot claim + consume moves NO wallet and NO ledger', async () => {
    const sessionId = await openSession(10)
    const before = await financialSnapshot()

    const assetId = await claimSlot(sessionId, 0)
    await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' })

    const after = await financialSnapshot()
    // THE assertion of this sprint. The upload path is financially inert.
    expect(after).toEqual(before)
    expect((await reservationRepo.read(assetId))!.status).toBe('consumed')
  })

  it('WALLET UNTOUCHED across many photos in one session', async () => {
    const sessionId = await openSession(50)
    const before = await financialSnapshot()

    for (let i = 0; i < 50; i++) {
      const assetId = await claimSlot(sessionId, i)
      await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' })
    }

    const after = await financialSnapshot()
    expect(after.balance).toBe(before.balance)          // nothing charged yet
    expect(after.held).toBe(before.held)                // hold set at open, unchanged
    expect(after.ledgerEntries).toBe(before.ledgerEntries)
  }, CONTENTION_TIMEOUT_MS)

  it('LEDGER UNTOUCHED: no consume or release entry is written per photo', async () => {
    const sessionId = await openSession(5)
    const a = await claimSlot(sessionId, 0)
    const b = await claimSlot(sessionId, 1)
    await ledgerService.consume({ organizerUid: UID, assetId: a, actorUid: 'test' })
    await ledgerService.release({ organizerUid: UID, assetId: b, actorUid: 'test' })

    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    const reasons = snap.docs.map(d => d.get('reason') as string)
    expect(reasons).not.toContain('consume')
    expect(reasons).not.toContain('release')
  })

  it('the session hold is what makes credits unavailable', async () => {
    const before = await walletService.getBalance(UID)
    expect(before.held).toBe(0)

    await openSession(300)

    const after = await walletService.getBalance(UID)
    expect(after.balance).toBe(1000)   // a hold moves nothing
    expect(after.held).toBe(300)
    expect(after.available).toBe(700)
  })

  // ── Slot validation ────────────────────────────────────────────────────────

  it('SLOT VALIDATION: a slot outside the allocation never yields an assetId', async () => {
    const sessionId = await openSession(10)
    const session = await sessions.getSession(UID, sessionId)

    expect(slots.resolveSlot(sessionId, 9, session!.slotCount).ok).toBe(true)
    expect(slots.resolveSlot(sessionId, 10, session!.slotCount).ok).toBe(false)
    expect(slots.resolveSlot(sessionId, -1, session!.slotCount).ok).toBe(false)
  })

  it('RESERVATION/SESSION LINKAGE is recorded on the reservation', async () => {
    const sessionId = await openSession(10)
    const assetId = await claimSlot(sessionId, 7)

    const r = await reservationRepo.read(assetId)
    expect(r!.sessionId).toBe(sessionId)
    expect(r!.slotIndex).toBe(7)
    expect(r!.reservationId).toBe(assetId)                       // id ≡ assetId preserved
    expect(assetId).toBe(slots.deriveAssetId(sessionId, 7))      // derived, not random
  })

  // ── Duplicates ─────────────────────────────────────────────────────────────

  it('DUPLICATE SLOT: claiming the same slot twice is a no-op, not a second reservation', async () => {
    const sessionId = await openSession(10)
    await claimSlot(sessionId, 3)
    await claimSlot(sessionId, 3)

    const snap = await adminDb.collection('mediaCreditReservations')
      .where('sessionId', '==', sessionId).get()
    expect(snap.size).toBe(1)
  })

  it('DUPLICATE RESERVATION: a spent slot can never be re-claimed', async () => {
    const sessionId = await openSession(10)
    const assetId = await claimSlot(sessionId, 4)
    await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' })

    // MC-03's guarantee, preserved: a consumed assetId is spent forever.
    await expect(claimSlot(sessionId, 4)).rejects.toThrow(errs.InvalidCreditOperationError)
  })

  // ── Complete + retry ───────────────────────────────────────────────────────

  it('COMPLETE marks the slot consumed', async () => {
    const sessionId = await openSession(10)
    const assetId = await claimSlot(sessionId, 0)
    await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' })
    expect((await reservationRepo.read(assetId))!.status).toBe('consumed')
  })

  it('RETRY COMPLETE is idempotent', async () => {
    const sessionId = await openSession(10)
    const assetId = await claimSlot(sessionId, 0)
    const before = await financialSnapshot()

    await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' })
    await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' })
    await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' })

    expect((await reservationRepo.read(assetId))!.status).toBe('consumed')
    expect(await financialSnapshot()).toEqual(before)
  })

  it('a released slot can never be consumed, and a consumed slot never released', async () => {
    const sessionId = await openSession(10)
    const a = await claimSlot(sessionId, 0)
    const b = await claimSlot(sessionId, 1)

    await ledgerService.release({ organizerUid: UID, assetId: a, actorUid: 'test' })
    await expect(ledgerService.consume({ organizerUid: UID, assetId: a, actorUid: 'test' }))
      .rejects.toThrow(errs.InvalidCreditOperationError)

    await ledgerService.consume({ organizerUid: UID, assetId: b, actorUid: 'test' })
    await ledgerService.release({ organizerUid: UID, assetId: b, actorUid: 'test' })   // no-op
    expect((await reservationRepo.read(b))!.status).toBe('consumed')
  })

  it('another workspace cannot consume a slot', async () => {
    const sessionId = await openSession(10)
    const assetId = await claimSlot(sessionId, 0)
    await expect(ledgerService.consume({
      organizerUid: 'other-workspace', assetId, actorUid: 'intruder',
    })).rejects.toThrow(errs.InvalidCreditOperationError)
  })

  // ── The seal barrier ───────────────────────────────────────────────────────

  it('SEAL RACE: a slot cannot be consumed once its session is sealed', async () => {
    const sessionId = await openSession(10)
    const assetId = await claimSlot(sessionId, 0)

    await sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: 'test' })

    await expect(ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' }))
      .rejects.toThrow(errs.SessionNotActiveError)
    // The slot is still `held` — nothing partially committed.
    expect((await reservationRepo.read(assetId))!.status).toBe('held')
  })

  it('SEAL RACE: a completion racing a seal is all-or-nothing, never partial', async () => {
    // The barrier cannot be forced deterministically — that is the point of it. So this runs
    // the race repeatedly and asserts the OUTCOME SET rather than a specific winner: whoever
    // wins, the reservation is only ever `held` or `consumed`, and the session is sealed.
    //
    // Deliberately NOT done by calling `sealSession` inside the completion transaction: that
    // is a nested transaction on a document the outer one already read, so the two deadlock
    // until timeout — a test artefact, not a behaviour worth asserting.
    for (let round = 0; round < 6; round++) {
      const sessionId = await openSession(4)
      const assetId = await claimSlot(sessionId, 0)

      const [consumed] = await Promise.allSettled([
        adminDb.runTransaction(async tx => {
          await consumeInTx(tx, { organizerUid: UID, assetId, actorUid: 'test' })
        }),
        sessions.sealSession({ sessionId, reason: 'CLOSED', sealedBy: 'racer' }),
      ])

      const reservation = await reservationRepo.read(assetId)
      if (consumed.status === 'fulfilled') {
        expect(reservation!.status).toBe('consumed')     // won the race, committed whole
      } else {
        expect(reservation!.status).toBe('held')         // lost, rolled back whole
      }
      // Either way the session sealed and nothing financial moved.
      const stored = await adminDb.doc(`mediaCreditSessions/${sessionId}`).get()
      expect(stored.get('status')).toBe('SEALED')
    }

    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(1000)                          // no photo ever charged the wallet
  }, CONTENTION_TIMEOUT_MS)

  it('consuming a slot whose session does not exist fails closed', async () => {
    const sessionId = await openSession(10)
    const assetId = await claimSlot(sessionId, 0)
    await adminDb.doc(`mediaCreditSessions/${sessionId}`).delete()

    await expect(ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' }))
      .rejects.toThrow(errs.InvalidCreditOperationError)
  })

  // ── Concurrency ────────────────────────────────────────────────────────────

  it('CONCURRENT UPLOADS: 20 slots in parallel all succeed, wallet untouched', async () => {
    const sessionId = await openSession(20)
    const before = await financialSnapshot()

    await Promise.all(Array.from({ length: 20 }, async (_, i) => {
      const assetId = await claimSlot(sessionId, i)
      await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' })
    }))

    const snap = await adminDb.collection('mediaCreditReservations')
      .where('sessionId', '==', sessionId).get()
    expect(snap.size).toBe(20)
    expect(snap.docs.every(d => d.get('status') === 'consumed')).toBe(true)
    // 20 concurrent uploads, zero financial writes — the contention is structurally gone.
    expect(await financialSnapshot()).toEqual(before)
  }, CONTENTION_TIMEOUT_MS)

  it('CONCURRENT UPLOADS: parallel claims of ONE slot produce exactly one reservation', async () => {
    const sessionId = await openSession(10)
    await Promise.allSettled(Array.from({ length: 8 }, () => claimSlot(sessionId, 2)))

    const snap = await adminDb.collection('mediaCreditReservations')
      .where('sessionId', '==', sessionId).get()
    expect(snap.size).toBe(1)
  }, CONTENTION_TIMEOUT_MS)

  // ── Invariant ──────────────────────────────────────────────────────────────

  it('THE invariant: balance equals the sum of ledger deltas throughout a session', async () => {
    const sessionId = await openSession(30)
    for (let i = 0; i < 30; i++) {
      const assetId = await claimSlot(sessionId, i)
      await ledgerService.consume({ organizerUid: UID, assetId, actorUid: 'test' })
    }

    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    const sum = snap.docs.reduce((n, d) => n + (d.get('delta') as number), 0)
    const b = await walletService.getBalance(UID)

    // Holds true CONTINUOUSLY, not just at session boundaries — the defect MC-ARCH-01B
    // caught in the original design, where per-photo ledger entries would have broken it.
    expect(b.balance).toBe(sum)
    expect(b.available).toBeGreaterThanOrEqual(0)
    expect(b.held).toBeGreaterThanOrEqual(0)
  }, CONTENTION_TIMEOUT_MS)
})
