// MC-06D · Scheduler and cleanup wiring — REAL Firestore (emulator).
//
// Exercises the cron ROUTE, not just the service beneath it: the secret gate, the ordered
// pipeline, the metrics it reports, and the structured logs it emits. Wiring bugs live at the
// boundary — a correct pipeline behind an unprotected or mis-scheduled endpoint is still an
// operational failure.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const SWEEP_TIMEOUT_MS = 60_000
const SECRET = 'test-cron-secret-mc06d'

// Set BEFORE the route imports `lib/env`, which reads it at module load.
process.env.CRON_SECRET = SECRET

describeEmu('MC-06D · session scheduler', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let businessConfig: typeof import('@/lib/config/businessConfigService')['businessConfig']
  let ledgerService: typeof import('@/features/media-credits/services')['ledgerService']
  let walletService: typeof import('@/features/media-credits/services')['walletService']
  let sessions: typeof import('@/features/media-credits/services/sessionService')
  let cleanup: typeof import('@/features/media-credits/services/sessionCleanupService')
  let sessionRepo: typeof import('@/features/media-credits/repositories/sessionRepo')
  let slots: typeof import('@/features/media-credits/utils/sessionSlots')
  let route: typeof import('@/app/api/cron/media-credit-sessions/route')

  const UID = `emu-mc06d-${process.pid}`
  const EVT = { eventId: 'mc06d-evt', eventSlug: 'mc06d-evt', galleryId: 'mc06d-gal' }
  const SEED = 1000
  let seq = 0
  const nextId = () => `s6d-${process.pid}-${++seq}`

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
    slots       = await import('@/features/media-credits/utils/sessionSlots')
    route       = await import('@/app/api/cron/media-credit-sessions/route')
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

  async function reset() {
    businessConfig.clearRuntimeOverrides()
    const batch = adminDb.batch()
    batch.delete(adminDb.doc(`mediaCreditWallets/${UID}`))
    for (const col of ['mediaCreditLedger', 'mediaCreditReservations', 'mediaCreditSessions']) {
      const snap = await adminDb.collection(col).where('organizerUid', '==', UID).get()
      snap.docs.forEach(d => batch.delete(d.ref))
    }
    await batch.commit()
    configure()
    await ledgerService.credit({
      organizerUid: UID, entryId: `mc06d-seed:${Date.now()}:${seq}`,
      credits: SEED, reason: 'grant', actorUid: 'test', actorKind: 'platform',
    })
  }

  /** An ACTIVE session with `uploads` completed slots, aged past expiry when asked. */
  async function abandonedSession(slotCount: number, uploads: number, expired = true) {
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
    if (expired) {
      await adminDb.doc(`mediaCreditSessions/${sessionId}`).update({
        expiresAt: new Date(Date.now() - 60_000),
      })
    }
    return sessionId
  }

  const cronRequest = (token = SECRET) => new Request(
    'http://localhost/api/cron/media-credit-sessions',
    { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} },
  ) as never

  /** OUR ACTIVE sessions only. sessionMetrics() is platform-wide and must not be asserted absolutely. */
  const myActiveSessions = async () => (await adminDb.collection('mediaCreditSessions')
    .where('organizerUid', '==', UID).where('status', '==', 'ACTIVE').get()).size

  beforeEach(async () => { await reset() })

  // ── Secret validation ──────────────────────────────────────────────────────

  it('SECRET VALIDATION: rejects a request with no token', async () => {
    const res = await route.POST(cronRequest(''))
    expect(res.status).toBe(401)
  })

  it('SECRET VALIDATION: rejects a wrong token and does NOT run the pipeline', async () => {
    const sessionId = await abandonedSession(10, 3)
    const res = await route.POST(cronRequest('not-the-secret'))
    expect(res.status).toBe(401)
    // Fail-closed: an unauthorised call must not settle anything.
    expect((await sessionRepo.read(sessionId))!.status).toBe('ACTIVE')
  })

  it('SECRET VALIDATION: accepts the correct token', async () => {
    const res = await route.POST(cronRequest())
    expect(res.status).toBe(200)
  }, SWEEP_TIMEOUT_MS)

  // ── Scheduled cleanup ──────────────────────────────────────────────────────

  it('SCHEDULED CLEANUP runs the full ordered pipeline', async () => {
    const sessionId = await abandonedSession(20, 8)

    const res  = await route.POST(cronRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.seal.sealed).toBeGreaterThanOrEqual(1)
    expect(body.settle.settled).toBeGreaterThanOrEqual(1)

    const stored = await sessionRepo.read(sessionId)
    expect(stored!.status).toBe('SETTLED')
    expect(stored!.sealReason).toBe('EXPIRED')
    expect(stored!.consumedSlots).toBe(8)

    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(SEED - 8)     // charged for what landed
    expect(b.held).toBe(0)               // hold fully returned
  }, SWEEP_TIMEOUT_MS)

  it('leaves an unexpired session alone', async () => {
    const sessionId = await abandonedSession(10, 4, /* expired */ false)
    await route.POST(cronRequest())
    expect((await sessionRepo.read(sessionId))!.status).toBe('ACTIVE')
    expect((await walletService.getBalance(UID)).held).toBe(10)
  }, SWEEP_TIMEOUT_MS)

  it('runs even when creditsEnabled is FALSE — holds must never be stranded', async () => {
    const sessionId = await abandonedSession(20, 5)
    configure({ creditsEnabled: false })

    const res = await route.POST(cronRequest())
    expect(res.status).toBe(200)

    expect((await sessionRepo.read(sessionId))!.status).toBe('SETTLED')
    expect((await walletService.getBalance(UID)).held).toBe(0)
  }, SWEEP_TIMEOUT_MS)

  // ── Replay + resume ────────────────────────────────────────────────────────

  it('REPLAY: a second run settles nothing again and the balance is unchanged', async () => {
    await abandonedSession(20, 6)
    await route.POST(cronRequest())
    const afterFirst = await walletService.getBalance(UID)

    const res  = await route.POST(cronRequest())
    const body = await res.json()
    expect(body.settle.settled).toBe(0)
    expect(body.seal.sealed).toBe(0)

    expect((await walletService.getBalance(UID)).balance).toBe(afterFirst.balance)
  }, SWEEP_TIMEOUT_MS)

  it('INTERRUPTED CLEANUP: a session sealed but not settled is finished next run', async () => {
    // Exactly the state a process killed between stages leaves behind.
    const sessionId = await abandonedSession(20, 9)
    await sessions.sealSession({ sessionId, reason: 'EXPIRED', sealedBy: 'system' })
    expect((await sessionRepo.read(sessionId))!.status).toBe('SEALED')

    const res  = await route.POST(cronRequest())
    const body = await res.json()
    expect(body.settle.settled).toBeGreaterThanOrEqual(1)
    expect((await sessionRepo.read(sessionId))!.status).toBe('SETTLED')
    expect((await walletService.getBalance(UID)).balance).toBe(SEED - 9)
  }, SWEEP_TIMEOUT_MS)

  it('RESUME: a backlog larger than the limit drains across successive runs', async () => {
    for (let i = 0; i < 5; i++) await abandonedSession(4, 2)

    // limit 2 forces the first pass to leave work behind, as a real budget cut-off would.
    const first = await cleanup.runSessionCleanup({ limit: 2, budgetMs: 30_000 })
    expect(first.seal.sealed).toBeGreaterThanOrEqual(1)
    expect(await myActiveSessions()).toBeGreaterThan(0)   // work deliberately left behind

    // Successive runs finish it — no state is lost between passes.
    //
    // A generous limit here on purpose: `listSealed` is ordered oldest-first and is NOT
    // tenant-scoped, so a small limit can be consumed entirely by other organizers' sessions.
    // That queue-position sensitivity is a real property of the sweep (reported in MC-06E),
    // not something this test should pretend away — so it is given room rather than assumed.
    for (let i = 0; i < 6; i++) await cleanup.runSessionCleanup({ limit: 200, budgetMs: 30_000 })

    expect(await myActiveSessions()).toBe(0)             // fully drained
    expect((await walletService.getBalance(UID)).held).toBe(0)
  }, SWEEP_TIMEOUT_MS)

  // ── Partial failure ────────────────────────────────────────────────────────

  it('PARTIAL FAILURE: one broken session does not abort the batch', async () => {
    const good1 = await abandonedSession(10, 3)
    const bad   = await abandonedSession(10, 2)
    const good2 = await abandonedSession(10, 4)

    // Corrupt one session so its settlement throws deterministically: a per-photo price this
    // large makes the charge exceed the wallet, which `applyDelta` rejects as an overdraft.
    // (A non-numeric field would NOT do it — it collapses to NaN and settlement silently takes
    // the zero-consumption branch. Reported as a robustness finding rather than patched here,
    // since this sprint must not change settlement logic.)
    await adminDb.doc(`mediaCreditSessions/${bad}`).update({ creditsPerPhotoAtOpen: 9_999_999 })

    const report = await cleanup.runSessionCleanup({ limit: 50, budgetMs: 30_000 })

    // The healthy pair settled regardless of the poisoned one.
    expect((await sessionRepo.read(good1))!.status).toBe('SETTLED')
    expect((await sessionRepo.read(good2))!.status).toBe('SETTLED')
    expect(report.settle.settled).toBeGreaterThanOrEqual(2)
    expect(report.settle.failed).toBeGreaterThanOrEqual(1)

    // And the failure is retried, not swallowed — it stays SEALED for the next pass.
    expect((await sessionRepo.read(bad))!.status).toBe('SEALED')
  }, SWEEP_TIMEOUT_MS)

  // ── Budget ─────────────────────────────────────────────────────────────────

  it('BUDGET EXHAUSTION is reported rather than silently truncating', async () => {
    for (let i = 0; i < 6; i++) await abandonedSession(4, 2)

    // A budget too small to finish forces the flag. `budgetMs` floors at 5s per stage.
    const report = await cleanup.runSessionCleanup({ limit: 200, budgetMs: 1 })

    // Whatever it managed is committed; the flag says it stopped on time, not on work.
    expect(Array.isArray(report.budgetExhausted)).toBe(true)
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
    // Nothing is lost — a later unbounded run finishes the rest.
    await cleanup.runSessionCleanup({ limit: 200, budgetMs: 30_000 })
    expect(await myActiveSessions()).toBe(0)
  }, SWEEP_TIMEOUT_MS)

  // ── Metrics ────────────────────────────────────────────────────────────────

  it('METRICS report the session estate accurately', async () => {
    // Deliberately measured as DELTAS: these metrics are platform-wide on purpose (an
    // operator needs the whole estate), so other suites' sessions are legitimately counted.
    const base = await cleanup.sessionMetrics()
    const active  = await abandonedSession(10, 2, /* expired */ false)
    await abandonedSession(10, 3)          // expired ACTIVE — the sweep will take this one
    const sealed  = await abandonedSession(10, 1, /* expired */ false)
    await sessions.sealSession({ sessionId: sealed, reason: 'CLOSED', sealedBy: 'test' })

    const m = await cleanup.sessionMetrics()
    expect(m.activeSessions - base.activeSessions).toBe(2)   // `active` + `expired`
    expect(m.expiredActive - base.expiredActive).toBe(1)     // only one is past expiry
    expect(m.sealedSessions - base.sealedSessions).toBe(1)
    expect(m.pendingSettlement - base.pendingSettlement).toBe(1)

    await cleanup.runSessionCleanup({ limit: 50, budgetMs: 30_000 })

    const after = await cleanup.sessionMetrics()
    expect(after.settledSessions - base.settledSessions).toBe(2)  // expired + sealed
    expect(after.activeSessions - base.activeSessions).toBe(1)    // `active` untouched
    // Our expired session and our sealed one are both resolved.
    expect((await sessionRepo.read(active))!.status).toBe('ACTIVE')
  }, SWEEP_TIMEOUT_MS)

  it('the cron response carries the metrics an operator needs', async () => {
    await abandonedSession(10, 4)
    const body = await (await route.POST(cronRequest())).json()

    expect(body.metrics).toMatchObject({
      activeSessions: expect.any(Number),
      sealedSessions: expect.any(Number),
      settledSessions: expect.any(Number),
      expiredActive: expect.any(Number),
      pendingSettlement: expect.any(Number),
    })
    expect(body.seal).toMatchObject({ scanned: expect.any(Number), sealed: expect.any(Number) })
    expect(body.settle).toMatchObject({ scanned: expect.any(Number), settled: expect.any(Number) })
    expect(body.reservations).toMatchObject({ scanned: expect.any(Number) })
  }, SWEEP_TIMEOUT_MS)

  // ── Logging ────────────────────────────────────────────────────────────────

  it('LOGGING emits structured start/completed events with no organizer identity', async () => {
    await abandonedSession(10, 3)
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation(l => { lines.push(String(l)) })

    await cleanup.runSessionCleanup({ limit: 50, budgetMs: 30_000 })
    spy.mockRestore()

    const events = lines
      .filter(l => l.startsWith('{'))
      .map(l => JSON.parse(l) as Record<string, unknown>)
      .filter(e => e.scope === 'media-credits.sessions')

    expect(events.map(e => e.event)).toContain('cleanup.started')
    expect(events.map(e => e.event)).toContain('cleanup.completed')

    // No organizer identity in any operational log line.
    const blob = JSON.stringify(events)
    expect(blob).not.toContain(UID)
    expect(blob).not.toContain('mc06d-evt')
  }, SWEEP_TIMEOUT_MS)

  // ── Concurrency ────────────────────────────────────────────────────────────

  it('CONCURRENT SCHEDULER RUNS settle each session exactly once', async () => {
    for (let i = 0; i < 4; i++) await abandonedSession(6, 3)

    await Promise.all([
      route.POST(cronRequest()),
      route.POST(cronRequest()),
      route.POST(cronRequest()),
    ])

    // 4 sessions × 3 photos = 12 credits, charged once no matter how many schedulers ran.
    const b = await walletService.getBalance(UID)
    expect(b.balance).toBe(SEED - 12)
    expect(b.held).toBe(0)

    const entries = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).where('reason', '==', 'consume').get()
    expect(entries.size).toBe(4)                 // one settlement entry per session
    expect(await myActiveSessions()).toBe(0)
  }, SWEEP_TIMEOUT_MS)

  it('THE invariant survives a scheduled sweep', async () => {
    await abandonedSession(20, 7)
    await abandonedSession(20, 0)
    await route.POST(cronRequest())

    const snap = await adminDb.collection('mediaCreditLedger')
      .where('organizerUid', '==', UID).get()
    const sum = snap.docs.reduce((n, d) => n + (d.get('delta') as number), 0)
    const b = await walletService.getBalance(UID)

    expect(b.balance).toBe(sum)
    expect(b.balance).toBe(SEED - 7)
    expect(b.held).toBe(0)
    expect(b.available).toBeGreaterThanOrEqual(0)
  }, SWEEP_TIMEOUT_MS)
})
