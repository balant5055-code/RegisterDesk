// MC-06A · Session foundation — REAL Firestore (emulator).
//
// What needs a real database here is the ATOMICITY of open (hold + session commit together
// or not at all) and the SERIALISATION of concurrent opens and seals on one document. Both
// are Firestore transaction semantics, which a mock would simply grant us.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const CONTENTION_TIMEOUT_MS = 30_000

describeEmu('MC-06A · upload sessions', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let sessions: typeof import('@/features/media-credits/services/sessionService')
  let cleanup:  typeof import('@/features/media-credits/services/sessionCleanupService')
  let sessionRepo: typeof import('@/features/media-credits/repositories/sessionRepo')
  let errs: typeof import('@/features/media-credits/errors')

  const UID = `emu-session-organizer-${process.pid}`
  const EVT = { eventId: 'sess-evt', eventSlug: 'sess-evt', galleryId: 'sess-gal' }
  let seq = 0
  /** Unique per test — session ids are permanent, so a reused one would collide across runs. */
  const nextId = () => `sess-${process.pid}-${++seq}`

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
    cleanup     = await import('@/features/media-credits/services/sessionCleanupService')
    sessionRepo = await import('@/features/media-credits/repositories/sessionRepo')
    errs = await import('@/features/media-credits/errors')
  })

  afterAll(() => { businessConfig.clearRuntimeOverrides() })

  function configure(patch: Record<string, unknown> = {}) {
    businessConfig.setRuntimeOverride('mediaStudio', {
      creditsEnabled: true, creditsPerPhoto: 1, creditUnitPricePaise: 100,
      minCreditPurchase: 1, refundsEnabled: true, refundWindowDays: 30,
      refundServiceChargeMethod: 'percent', refundServiceChargePercent: 10,
      refundServiceChargeFixedPaise: 0, minRefundablePaise: 100,
      ...patch,
    } as never)
  }

  async function reset(credits: number) {
    businessConfig.clearRuntimeOverrides()
    const batch = adminDb.batch()
    batch.delete(adminDb.doc(`mediaCreditWallets/${UID}`))
    for (const col of ['mediaCreditLedger', 'mediaCreditSessions']) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    await batch.commit()
    configure()
    if (credits > 0) {
      await ledgerService.credit({
        organizerUid: UID, entryId: `sess-seed:${Date.now()}:${credits}`,
        credits, reason: 'grant', actorUid: 'test', actorKind: 'platform',
      })
    }
  }

  const open = (sessionId: string, slotCount: number) => sessions.openSession({
    sessionId, organizerUid: UID, slotCount, actorUid: 'test', ...EVT,
  })

  beforeEach(async () => { await reset(1000) })

  // ── Open ───────────────────────────────────────────────────────────────────

  it('opens a session and holds exactly the credits its slots need', async () => {
    const id = nextId()
    const s = await open(id, 250)

    expect(s.status).toBe('ACTIVE')
    expect(s.slotCount).toBe(250)
    expect(s.allocatedCredits).toBe(250)
    expect(s.creditsPerPhotoAtOpen).toBe(1)
    expect(s.consumedSlots).toBeNull()

    // A hold moves NO credits: balance untouched, available falls.
    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(1000)
    expect(b.held).toBe(250)
    expect(b.available).toBe(750)
  })

  it('prices slots using creditsPerPhoto and snapshots it', async () => {
    configure({ creditsPerPhoto: 2 })
    const s = await open(nextId(), 100)

    expect(s.allocatedCredits).toBe(200)
    expect(s.creditsPerPhotoAtOpen).toBe(2)
    expect((await walletService.getBalance(UID)).held).toBe(200)
  })

  it('a later pricing change does NOT re-price an open session', async () => {
    const id = nextId()
    await open(id, 100)
    configure({ creditsPerPhoto: 5 })

    const reread = await sessions.getSession(UID, id)
    expect(reread!.creditsPerPhotoAtOpen).toBe(1)   // the terms it opened on
    expect(reread!.allocatedCredits).toBe(100)
  })

  it('refuses a session it cannot afford, and holds nothing', async () => {
    await expect(open(nextId(), 5000)).rejects.toThrow(errs.InsufficientCreditsError)
    const b = await walletService.getBalance(UID)
    expect(b.held).toBe(0)
    expect(b.balance).toBe(1000)
  })

  it('ROLLBACK: a refused open writes no session document', async () => {
    const id = nextId()
    await expect(open(id, 5000)).rejects.toThrow()
    expect(await sessionRepo.read(id)).toBeNull()
  })

  it.each([0, -5, NaN])('refuses a non-positive slotCount (%s)', async slotCount => {
    await expect(open(nextId(), slotCount)).rejects.toThrow(errs.InvalidCreditOperationError)
  })

  it('is unreachable when credits are disabled', async () => {
    configure({ creditsEnabled: false })
    await expect(open(nextId(), 10)).rejects.toThrow(errs.CreditsDisabledError)
  })

  // ── Duplicate / idempotent open ────────────────────────────────────────────

  it('DUPLICATE OPEN is idempotent — the second call holds nothing extra', async () => {
    const id = nextId()
    const first  = await open(id, 200)
    const second = await open(id, 200)

    expect(second.sessionId).toBe(first.sessionId)
    expect((await walletService.getBalance(UID)).held).toBe(200)   // not 400
  })

  it('a duplicate open with DIFFERENT slots returns the original, unchanged', async () => {
    const id = nextId()
    await open(id, 100)
    const again = await open(id, 900)

    expect(again.slotCount).toBe(100)                              // the winner's terms
    expect((await walletService.getBalance(UID)).held).toBe(100)
  })

  it('CONCURRENT OPEN: 8 simultaneous opens of one id place exactly one hold', async () => {
    const id = nextId()
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => open(id, 150)),
    )
    expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    expect((await walletService.getBalance(UID)).held).toBe(150)   // never 8 × 150
  }, CONTENTION_TIMEOUT_MS)

  it('another workspace cannot claim an existing session id', async () => {
    const id = nextId()
    await open(id, 100)
    await expect(sessions.openSession({
      sessionId: id, organizerUid: 'other-workspace', slotCount: 100,
      actorUid: 'intruder', ...EVT,
    })).rejects.toThrow(errs.InvalidCreditOperationError)
  })

  // ── Seal ───────────────────────────────────────────────────────────────────

  it('seals an ACTIVE session', async () => {
    const id = nextId()
    await open(id, 100)

    const outcome = await sessions.sealSession({
      sessionId: id, organizerUid: UID, reason: 'CLOSED', sealedBy: 'test',
    })
    expect(outcome.sealed).toBe(true)

    const stored = await sessionRepo.read(id)
    expect(stored!.status).toBe('SEALED')
    expect(stored!.sealReason).toBe('CLOSED')
    expect(stored!.sealedAt).not.toBeNull()
  })

  it('DUPLICATE SEAL is idempotent and reports the existing state', async () => {
    const id = nextId()
    await open(id, 100)
    await sessions.sealSession({ sessionId: id, reason: 'CLOSED', sealedBy: 'a' })
    const second = await sessions.sealSession({ sessionId: id, reason: 'EXPIRED', sealedBy: 'b' })

    expect(second.sealed).toBe(false)
    expect(second.sealed === false && second.reason).toBe('already_sealed')
    // The first seal's reason stands — a replay must not rewrite why it was sealed.
    expect((await sessionRepo.read(id))!.sealReason).toBe('CLOSED')
  })

  it('CONCURRENT SEAL: 6 simultaneous seals produce exactly one winner', async () => {
    const id = nextId()
    await open(id, 100)

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => sessions.sealSession({
        sessionId: id, reason: 'CLOSED', sealedBy: 'racer',
      })),
    )
    expect(outcomes.filter(o => o.sealed).length).toBe(1)
    expect((await sessionRepo.read(id))!.status).toBe('SEALED')
  }, CONTENTION_TIMEOUT_MS)

  it('sealing an unknown session throws', async () => {
    await expect(sessions.sealSession({
      sessionId: 'no-such-session', reason: 'CLOSED', sealedBy: 'test',
    })).rejects.toThrow(errs.InvalidCreditOperationError)
  })

  it('another workspace cannot seal a session', async () => {
    const id = nextId()
    await open(id, 100)
    await expect(sessions.sealSession({
      sessionId: id, organizerUid: 'other-workspace', reason: 'CLOSED', sealedBy: 'intruder',
    })).rejects.toThrow(errs.InvalidCreditOperationError)
  })

  // ── Expiry + cleanup ───────────────────────────────────────────────────────

  it('a fresh session is not expired', async () => {
    const id = nextId()
    await open(id, 100)
    expect(sessions.isExpired((await sessionRepo.read(id))!)).toBe(false)
  })

  it('detects an expired session, and FAILS CLOSED on an unreadable expiry', async () => {
    const id = nextId()
    await open(id, 100)
    const doc = (await sessionRepo.read(id))!

    expect(sessions.isExpired({ ...doc, expiresAt: null })).toBe(true)
    // A settled or sealed session is never "expired" — expiry only applies to ACTIVE.
    expect(sessions.isExpired({ ...doc, status: 'SEALED' })).toBe(false)
  })

  it('CLEANUP seals an expired session and reports it', async () => {
    const id = nextId()
    await open(id, 100)
    await adminDb.doc(`mediaCreditSessions/${id}`).update({
      expiresAt: new Date(Date.now() - 60_000),
    })

    const report = await cleanup.sealExpiredSessions({ limit: 50 })
    expect(report.sealed).toBeGreaterThanOrEqual(1)

    const stored = await sessionRepo.read(id)
    expect(stored!.status).toBe('SEALED')
    expect(stored!.sealReason).toBe('EXPIRED')
    expect(stored!.sealedBy).toBe(cleanup.SESSION_SWEEP_ACTOR)
  })

  it('CLEANUP leaves an unexpired session alone', async () => {
    const id = nextId()
    await open(id, 100)
    await cleanup.sealExpiredSessions({ limit: 50 })
    expect((await sessionRepo.read(id))!.status).toBe('ACTIVE')
  })

  it('CLEANUP is idempotent — a second pass seals nothing again', async () => {
    const id = nextId()
    await open(id, 100)
    await adminDb.doc(`mediaCreditSessions/${id}`).update({
      expiresAt: new Date(Date.now() - 60_000),
    })

    const first  = await cleanup.sealExpiredSessions({ limit: 50 })
    const second = await cleanup.sealExpiredSessions({ limit: 50 })
    expect(first.sealed).toBeGreaterThanOrEqual(1)
    expect(second.sealed).toBe(0)   // already SEALED is no longer ACTIVE
  })

  it('CLEANUP runs even when credits are DISABLED', async () => {
    // Spec v1.0 §20. Turning the feature off must not strand credits taken while it was on.
    const id = nextId()
    await open(id, 100)
    await adminDb.doc(`mediaCreditSessions/${id}`).update({
      expiresAt: new Date(Date.now() - 60_000),
    })
    configure({ creditsEnabled: false })

    const report = await cleanup.sealExpiredSessions({ limit: 50 })
    expect(report.sealed).toBeGreaterThanOrEqual(1)
    expect((await sessionRepo.read(id))!.status).toBe('SEALED')
  })

  // ── Reads ──────────────────────────────────────────────────────────────────

  it('reads are tenant-scoped', async () => {
    const id = nextId()
    await open(id, 100)
    expect(await sessions.getSession(UID, id)).toBeTruthy()
    expect(await sessions.getSession('another-workspace', id)).toBeNull()

    const { sessions: mine } = await sessions.listSessions(UID, 25)
    expect(mine.map(s => s.sessionId)).toContain(id)
  })

  // ── Invariant ──────────────────────────────────────────────────────────────

  it('THE invariant: a hold never changes balance, and balance still equals the ledger', async () => {
    await open(nextId(), 300)
    await open(nextId(), 200)

    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    const sum = snap.docs.reduce((n, d) => n + (d.get('delta') as number), 0)

    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(sum)      // holds write no ledger entry
    expect(b.held).toBe(500)
    expect(b.available).toBe(500)
  })
})
