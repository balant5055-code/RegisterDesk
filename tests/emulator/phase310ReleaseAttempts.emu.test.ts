// Phase 3.10A — settlement-release attempt EVIDENCE, through the REAL release job on REAL Firestore
// (synthetic emulator data only). The evidence never touches the ledger row, never blocks or changes a release,
// and refines the stuck-release report: a recorded, repeated INSUFFICIENT refusal is confirmed; a never-
// attempted row and transient errors are not.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const DAY = 86_400_000

const fx = vi.hoisted(() => ({ failPathPrefix: null as string | null, failCount: 0 }))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('Phase 3.10A · settlement-release attempt evidence', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let att: typeof import('@/lib/settlements/releaseAttempts')
  let stuck: typeof import('@/lib/reconciliation/stuckReleases')
  let n = 0

  async function payment(uid: string, net: number, daysAgo = 40) {
    const id = `p310-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: 'event_registration', category: 'ticketed', organizerUid: uid, entityId: 'e', entityType: 'event', sourceId: id, sourceType: 'registration',
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0,
      netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    await db.doc(`platformTransactions/ptx_${id}`).update({ paidAt: new Date(Date.now() - daysAgo * DAY) })
    return `ptx_${id}`
  }
  const setPending = (uid: string, v: number) => db.doc(`organizerRevenueWallets/${uid}`).update({ pendingPaise: v })
  const attempt = async (ptxId: string) => (await db.doc(`settlementReleaseAttempts/${ptxId}`).get()).data() ?? null
  const ptx = async (id: string) => (await db.doc(`platformTransactions/${id}`).get()).data()!
  const entryFor = async (ptxId: string) => (await stuck.reportStuckReleases()).entries.find(e => e.ptxId === ptxId) ?? null

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    credit = (await import('@/lib/firebase/firestore/platformTransactions')).recordPlatformTransactionAndCredit
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    att = await import('@/lib/settlements/releaseAttempts')
    stuck = await import('@/lib/reconciliation/stuckReleases')
  }, T)
  beforeEach(() => {
    vi.restoreAllMocks()
    fx.failPathPrefix = null; fx.failCount = 0
    // failures injected INSIDE transactions: a read of a matching path rejects (nothing partial can commit)
    const orig = db.runTransaction.bind(db)
    vi.spyOn(db, 'runTransaction').mockImplementation((async (fn: (tx: FirebaseFirestore.Transaction) => unknown, opts?: never) =>
      orig(async tx => {
        const get = tx.get.bind(tx) as (q: unknown) => unknown
        ;(tx as unknown as { get: unknown }).get = (q: { path?: string }) => {
          const path = typeof q?.path === 'string' ? q.path : ''
          if (fx.failPathPrefix && fx.failCount > 0 && path.startsWith(fx.failPathPrefix)) { fx.failCount--; return Promise.reject(new Error('14 UNAVAILABLE: simulated transient read failure')) }
          return get(q)
        }
        // Phase 3.10B — the evidence reads its record + ledger row with tx.getAll: injected the same way
        const getAll = (tx.getAll as unknown as (...r: unknown[]) => unknown).bind(tx)
        ;(tx as unknown as { getAll: unknown }).getAll = (...refs: Array<{ path?: string }>) => {
          if (fx.failPathPrefix && fx.failCount > 0 && refs.some(r => typeof r?.path === 'string' && r.path.startsWith(fx.failPathPrefix!))) { fx.failCount--; return Promise.reject(new Error('14 UNAVAILABLE: simulated transient read failure')) }
          return getAll(...refs)
        }
        return fn(tx)
      }, opts)) as never)
    // Phase 3.10B — and the post-release check is a PLAIN read: injected too
    const proto = FS.DocumentReference.prototype as unknown as { get: (...a: unknown[]) => unknown }
    const origGet = proto.get
    vi.spyOn(proto, 'get').mockImplementation(function (this: { path: string }, ...a: unknown[]) {
      if (fx.failPathPrefix && fx.failCount > 0 && this.path.startsWith(fx.failPathPrefix)) { fx.failCount--; return Promise.reject(new Error('14 UNAVAILABLE: simulated transient read failure')) }
      return origGet.apply(this, a)
    })
  })

  it('1 · repeated INSUFFICIENT refusals are recorded once per run (ledger row untouched); duplicate and concurrent recording is exact; the report CONFIRMS the repeated refusal', async () => {
    const uid = `p310-org-${P}-1`
    const id = await payment(uid, 5_000)
    await setPending(uid, 1_000)
    const before = await ptx(id)
    await release({ limit: 500 })
    expect(await attempt(id)).toMatchObject({ transactionId: id, organizerUid: uid, status: 'open', attempts: 1, lastCode: 'INSUFFICIENT', lastOutcome: 'refused',
      lastDetail: { pendingPaise: 1_000, amountPaise: 5_000 }, codeCounts: { INSUFFICIENT: 1 } })
    await release({ limit: 500 })
    expect(await attempt(id)).toMatchObject({ attempts: 2, codeCounts: { INSUFFICIENT: 2 } })
    expect(await ptx(id)).toEqual(before)                                               // the ledger row is never written
    // duplicate: the same run recorded twice counts once
    const runId = (await attempt(id))!.lastRunId as string
    expect(await att.recordReleaseFailure({ ptxId: id, organizerUid: uid, runId, message: 'INSUFFICIENT:1000:5000' })).toBe('duplicate')
    expect((await attempt(id))!.attempts).toBe(2)
    // concurrent: two different runs ⇒ exactly two; the same run twice at once ⇒ exactly one
    await Promise.all([
      att.recordReleaseFailure({ ptxId: id, organizerUid: uid, runId: `r-${P}-a`, message: 'INSUFFICIENT:1000:5000' }),
      att.recordReleaseFailure({ ptxId: id, organizerUid: uid, runId: `r-${P}-b`, message: 'INSUFFICIENT:1000:5000' }),
    ])
    expect((await attempt(id))!.attempts).toBe(4)
    await Promise.all([0, 1, 2].map(() => att.recordReleaseFailure({ ptxId: id, organizerUid: uid, runId: `r-${P}-c`, message: 'INSUFFICIENT:1000:5000' })))
    expect((await attempt(id))!.attempts).toBe(5)
    expect(await entryFor(id)).toMatchObject({ verdict: 'stuck', reason: 'repeated_refusal', evidence: { failureEvidencePersisted: true, attempt: { attempts: 5, lastCode: 'INSUFFICIENT' } } })
    // tidy: a permanently refused fixture would be refused (and counted) by every later suite's release run
    await db.doc(`platformTransactions/${id}`).delete()
  }, T)

  it('2 · a successful release after failures marks the record RESOLVED (kept as evidence) and the row leaves the report; a released row is never recorded as failing again', async () => {
    const uid = `p310-org-${P}-2`
    const id = await payment(uid, 3_000)
    await setPending(uid, 100)
    await release({ limit: 500 })
    expect(await attempt(id)).toMatchObject({ status: 'open', attempts: 1 })
    await setPending(uid, 3_000)
    await release({ limit: 500 })
    expect((await ptx(id)).releaseStatus).toBe('released')
    const rel = (await db.collection('settlementReleases').where('transactionId', '==', id).get()).docs
    expect(rel).toHaveLength(1)
    expect(await attempt(id)).toMatchObject({ status: 'resolved', lastOutcome: 'released', attempts: 1, resolvedByReleaseId: rel[0].id })
    expect(await entryFor(id)).toBeNull()
    expect(await att.recordReleaseFailure({ ptxId: id, organizerUid: uid, runId: `late-${P}`, message: 'INSUFFICIENT:0:3000' })).toBe('already_released')
    expect(await attempt(id)).toMatchObject({ status: 'resolved', attempts: 1 })
    // races and holds are not evidence
    expect(await att.recordReleaseFailure({ ptxId: `ptx_none_${P}`, organizerUid: uid, runId: 'x', message: 'ALREADY_RELEASED' })).toBe('not_recorded')
    expect(await att.recordReleaseFailure({ ptxId: `ptx_none_${P}`, organizerUid: uid, runId: 'x', message: 'REFUND_HOLD' })).toBe('not_recorded')
  }, T)

  it('3 · when the EVIDENCE cannot be written, releases are unaffected: the valid row releases, the refused row stays pending, the run completes', async () => {
    const uid = `p310-org-${P}-3`
    const ok = await payment(uid, 1_000, 41)
    const short = await payment(uid, 9_000, 40)
    await setPending(uid, 1_000 + 500)                                                    // covers ok, not short
    fx.failPathPrefix = 'settlementReleaseAttempts/'; fx.failCount = 1_000
    const r = await release({ limit: 500 })
    fx.failPathPrefix = null
    expect(r.failures).toBeGreaterThanOrEqual(1)
    expect((await ptx(ok)).releaseStatus).toBe('released')
    expect((await ptx(short)).releaseStatus).toBe('pending')
    expect(await attempt(short)).toBeNull()                                               // unrecorded — never invented
    expect(await att.recordReleaseFailure({ ptxId: short, organizerUid: uid, runId: `x-${P}`, message: 'INSUFFICIENT:500:9000' }).then(() => 'ok')).toBe('ok')   // recovers
    await db.doc(`platformTransactions/${short}`).delete()                                 // tidy (see test 1)
  }, T)

  it('4 · a transient failure INSIDE the release transaction is recorded as such — never as a confirmed refusal — and the next run releases and resolves it', async () => {
    const uid = `p310-org-${P}-4`
    const id = await payment(uid, 2_000)
    fx.failPathPrefix = `organizerRevenueWallets/${uid}`; fx.failCount = 100              // every retry of this run's wallet read fails
    await release({ limit: 500 })
    fx.failPathPrefix = null
    expect((await ptx(id)).releaseStatus).toBe('pending')
    expect(await attempt(id)).toMatchObject({ status: 'open', lastCode: 'TRANSIENT_OR_UNKNOWN', lastOutcome: 'error', lastDetail: null })
    expect(await entryFor(id)).toMatchObject({ verdict: 'unverifiable', reason: 'release_error:TRANSIENT_OR_UNKNOWN' })
    await release({ limit: 500 })
    expect((await ptx(id)).releaseStatus).toBe('released')
    expect(await attempt(id)).toMatchObject({ status: 'resolved' })
  }, T)

  it('5 · report: confirmed repeated refusal vs never attempted (predicted only) vs refused-but-now-coverable', async () => {
    const uid = `p310-org-${P}-5`
    const was = await payment(uid + 'w', 4_000)
    await setPending(uid + 'w', 10)
    await release({ limit: 500 })
    await setPending(uid + 'w', 4_000)                                                    // now coverable: the next run should release it
    // created AFTER the last release run, so no run has tried it (a run in between would record a real refusal)
    const never = await payment(uid + 'n', 4_000)
    await setPending(uid + 'n', 10)                                                       // short, but never attempted
    expect(await entryFor(never)).toMatchObject({ verdict: 'stuck', reason: 'pending_below_release', evidence: { failureEvidencePersisted: false, attempt: null } })
    expect(await entryFor(was)).toMatchObject({ verdict: 'unverifiable', reason: 'refused_before_now_coverable', evidence: { attempt: { lastCode: 'INSUFFICIENT' } } })
    const g = await stuck.reconcileStuckReleases()
    expect(g.mismatches.find(m => m.entityId === never)).toMatchObject({ field: 'stuckRelease:pending_below_release' })
    expect(g.unverifiable.find(u => u.entityId === was)).toMatchObject({ reason: 'refused_before_now_coverable' })
    // tidy: leave no permanently refused fixtures for later suites' release runs
    await setPending(uid + 'n', 4_000)
    await release({ limit: 500 })
  }, T)
})
