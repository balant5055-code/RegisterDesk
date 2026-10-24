// Phase 3.10C — the release job's TIME BUDGET and the CONFIRMED-release evidence sweep, through the REAL release
// job on REAL Firestore (synthetic emulator data only). Amounts, wallet buckets, holds and ledger rows are asserted
// exactly; the sweep is shown to write ONLY evidence documents and to resolve ONLY a definitively confirmed release.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const DAY = 86_400_000

const fx = vi.hoisted(() => ({
  failPathPrefix: null as string | null, failCount: 0,
  delayPath: null as string | null, delayMs: 0,
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))
vi.mock('@/lib/cron/auth', async orig => ({ ...(await orig<typeof import('@/lib/cron/auth')>()), isAuthorizedCron: () => true }))

describeEmu('Phase 3.10C · release time budget + confirmed-release evidence sweep', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let att: typeof import('@/lib/settlements/releaseAttempts')
  let n = 0

  // paidAt far in the past (and increasing per row) so these rows are the OLDEST eligible ones, in creation order
  async function payment(uid: string, net: number, ageDays = 5_000) {
    const id = `p310c-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: 'event_registration', category: 'ticketed', organizerUid: uid, entityId: 'e', entityType: 'event', sourceId: id, sourceType: 'registration',
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0,
      netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    await db.doc(`platformTransactions/ptx_${id}`).update({ paidAt: new Date(Date.now() - ageDays * DAY + n * 1_000) })
    return `ptx_${id}`
  }
  const setPending = (uid: string, v: number) => db.doc(`organizerRevenueWallets/${uid}`).update({ pendingPaise: v })
  const wallet = async (uid: string) => (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!
  const row = async (id: string) => (await db.doc(`platformTransactions/${id}`).get()).data() ?? null
  const attempt = async (id: string) => (await db.doc(`settlementReleaseAttempts/${id}`).get()).data() ?? null
  const releasesOf = async (id: string) => (await db.collection('settlementReleases').where('transactionId', '==', id).get()).docs
  /** an OPEN record on a row whose release then commits with the post-release evidence check failing ⇒ released_unresolved */
  async function releasedUnresolved(uid: string, net: number) {
    const id = await payment(uid, net)
    await setPending(uid, 0)
    await release({ limit: 500 })                                                       // refused ⇒ open record
    await setPending(uid, net)
    fx.failPathPrefix = 'settlementReleaseAttempts/'; fx.failCount = 1_000              // the resolve step fails (run "died" there)
    await release({ limit: 500 })
    fx.failPathPrefix = null
    expect(await attempt(id)).toMatchObject({ status: 'open', attempts: 1 })
    expect(await row(id)).toMatchObject({ status: 'completed', releaseStatus: 'released' })
    return id
  }
  const tidy = async (...ids: string[]) => { for (const id of ids) await db.doc(`platformTransactions/${id}`).delete() }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ recordPlatformTransactionAndCredit: credit, reversePlatformTransactionAndDebit: reverse } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    att = await import('@/lib/settlements/releaseAttempts')
  }, T)
  // even when a test fails before its own tidy: no row of this run is left refusable for later suites
  afterAll(async () => {
    vi.restoreAllMocks()
    const prefix = `ptx_p310c-${P}-`
    const s = await db.collection('platformTransactions').where(FS.FieldPath.documentId(), '>=', prefix).where(FS.FieldPath.documentId(), '<', `${prefix}`).get()
    for (const d of s.docs) if (d.get('releaseStatus') !== 'released') await d.ref.delete()
  }, T)
  beforeEach(() => {
    vi.restoreAllMocks()
    fx.failPathPrefix = null; fx.failCount = 0; fx.delayPath = null; fx.delayMs = 0
    // injected INSIDE transactions: a read of a matching path rejects, or is delayed (the transaction stays open)
    const orig = db.runTransaction.bind(db)
    vi.spyOn(db, 'runTransaction').mockImplementation((async (fn: (tx: FirebaseFirestore.Transaction) => unknown, opts?: never) =>
      orig(async tx => {
        const get = tx.get.bind(tx) as (q: unknown) => unknown
        ;(tx as unknown as { get: unknown }).get = async (q: { path?: string }) => {
          const path = typeof q?.path === 'string' ? q.path : ''
          if (fx.failPathPrefix && fx.failCount > 0 && path.startsWith(fx.failPathPrefix)) { fx.failCount--; throw new Error('14 UNAVAILABLE: simulated transient read failure') }
          if (fx.delayPath && path === fx.delayPath) await new Promise(r => setTimeout(r, fx.delayMs))
          return get(q)
        }
        const getAll = (tx.getAll as unknown as (...r: unknown[]) => unknown).bind(tx)
        ;(tx as unknown as { getAll: unknown }).getAll = (...refs: Array<{ path?: string }>) => {
          if (fx.failPathPrefix && fx.failCount > 0 && refs.some(r => typeof r?.path === 'string' && r.path.startsWith(fx.failPathPrefix!))) { fx.failCount--; return Promise.reject(new Error('14 UNAVAILABLE: simulated transient read failure')) }
          return getAll(...refs)
        }
        return fn(tx)
      }, opts)) as never)
    const proto = FS.DocumentReference.prototype as unknown as { get: (...a: unknown[]) => unknown }
    const origGet = proto.get
    vi.spyOn(proto, 'get').mockImplementation(function (this: { path: string }, ...a: unknown[]) {
      if (fx.failPathPrefix && fx.failCount > 0 && this.path.startsWith(fx.failPathPrefix)) { fx.failCount--; return Promise.reject(new Error('14 UNAVAILABLE: simulated transient read failure')) }
      return origGet.apply(this, a)
    })
  })

  // ═══ B · time budget ═════════════════════════════════════════════════════════════════════════
  it('1 · deadline reached before any row starts: nothing is touched, every row stays eligible; the next run releases them exactly once', async () => {
    const uid = `p310c-org-${P}-1`
    const ids = [await payment(uid, 1_000), await payment(uid, 2_000), await payment(uid, 3_000)]
    const before = await wallet(uid)
    expect(before).toMatchObject({ pendingPaise: 6_000, availablePaise: 0 })
    const r = await release({ limit: 500, budgetMs: 0 })
    expect(r).toMatchObject({ processed: 0, releasedAmountPaise: 0, failures: 0, stoppedByBudget: true })
    expect(r.notStartedForBudget).toBeGreaterThanOrEqual(3)
    expect(await wallet(uid)).toEqual(before)                                           // buckets byte-identical
    for (const id of ids) {
      expect(await row(id)).toMatchObject({ status: 'completed', releaseStatus: 'pending' })
      expect(await releasesOf(id)).toHaveLength(0)
      expect(await attempt(id)).toBeNull()                                              // a budget stop is not a refusal
    }
    const r2 = await release({ limit: 500 })
    expect(r2.stoppedByBudget).toBeUndefined()
    for (const [i, id] of ids.entries()) {
      expect(await row(id)).toMatchObject({ releaseStatus: 'released' })
      expect((await releasesOf(id)).map(d => d.get('amountPaise'))).toEqual([(i + 1) * 1_000])
    }
    expect(await wallet(uid)).toMatchObject({ pendingPaise: 0, availablePaise: 6_000 })
  }, T)

  it('2 · a release IN FLIGHT when the deadline passes completes exactly; no later row starts; the rest stay eligible, oldest first', async () => {
    const uid = `p310c-org-${P}-2`
    const [slow, b, c] = [await payment(uid, 4_000, 6_000), await payment(uid, 500, 6_000), await payment(uid, 700, 6_000)]
    fx.delayPath = `platformTransactions/${slow}`; fx.delayMs = 4_000                    // the first row's transaction outlives the budget
    const t0 = Date.now()
    const r = await release({ limit: 500, budgetMs: 2_000 })
    const ms = Date.now() - t0
    fx.delayPath = null
    expect(ms).toBeGreaterThanOrEqual(4_000)                                            // the in-flight row was waited for, not cut
    expect(r).toMatchObject({ processed: 1, releasedAmountPaise: 4_000, failures: 0, stoppedByBudget: true })
    expect(r.notStartedForBudget).toBeGreaterThanOrEqual(2)
    expect(await row(slow)).toMatchObject({ releaseStatus: 'released' })
    expect((await releasesOf(slow)).map(d => ({ a: d.get('amountPaise'), c: d.get('creditedAvailablePaise') }))).toEqual([{ a: 4_000, c: 4_000 }])
    for (const id of [b, c]) { expect(await row(id)).toMatchObject({ releaseStatus: 'pending' }); expect(await releasesOf(id)).toHaveLength(0) }
    expect(await wallet(uid)).toMatchObject({ pendingPaise: 1_200, availablePaise: 4_000 })
    await release({ limit: 500 })
    expect(await wallet(uid)).toMatchObject({ pendingPaise: 0, availablePaise: 5_200 })
    for (const id of [slow, b, c]) expect(await releasesOf(id)).toHaveLength(1)        // exactly once each
  }, T)

  it('3 · the budget never bypasses a refund hold, and an evidence-write failure never changes the financial outcome', async () => {
    const uid = `p310c-org-${P}-3`
    const heldRow = await payment(uid, 900)
    await db.doc(`platformTransactions/${heldRow}`).update({ releaseHold: { reason: 'refund_review', refundIds: [], heldAt: new Date() } })
    await release({ limit: 500, budgetMs: 0 })
    const r = await release({ limit: 500 })
    expect(r.held ?? 0).toBeGreaterThanOrEqual(1)
    expect(await row(heldRow)).toMatchObject({ releaseStatus: 'pending' })
    expect(await releasesOf(heldRow)).toHaveLength(0)
    expect(await wallet(uid)).toMatchObject({ pendingPaise: 900, availablePaise: 0 })
    await tidy(heldRow)
    // a refused row whose evidence cannot be written + a coverable row, in one budgeted run
    const uid2 = `p310c-org-${P}-3b`
    const refused = await payment(uid2, 8_000)
    const uid3 = `p310c-org-${P}-3c`
    const ok = await payment(uid3, 600)
    await setPending(uid2, 10)
    fx.failPathPrefix = 'settlementReleaseAttempts/'; fx.failCount = 1_000
    const r2 = await release({ limit: 500, budgetMs: 30_000 })
    fx.failPathPrefix = null
    expect(r2.failures).toBeGreaterThanOrEqual(1)
    expect(r2.stoppedByBudget).toBeUndefined()
    expect(await attempt(refused)).toBeNull()                                           // unrecorded, not thrown
    expect(await row(refused)).toMatchObject({ releaseStatus: 'pending' })
    expect(await wallet(uid2)).toMatchObject({ pendingPaise: 10, availablePaise: 0 })
    expect(await row(ok)).toMatchObject({ releaseStatus: 'released' })
    expect(await wallet(uid3)).toMatchObject({ pendingPaise: 0, availablePaise: 600 })
    await tidy(refused)
  }, T)

  // ═══ A · confirmed-release evidence sweep ════════════════════════════════════════════════════
  it('4 · a definitively confirmed release resolves its record (kept, history intact); duplicate and concurrent resolution is exact', async () => {
    const uid = `p310c-org-${P}-4`
    const id = await releasedUnresolved(uid, 2_500)
    const before = (await attempt(id))!
    const walletBefore = await wallet(uid)
    const rowBefore = await row(id)
    expect(await att.resolveConfirmedReleaseEvidence(id)).toBe('resolved')
    const after = (await attempt(id))!
    const [rel] = await releasesOf(id)
    expect(after).toMatchObject({ status: 'resolved', lastOutcome: 'released', resolution: 'confirmed_release', resolvedByReleaseId: rel.id })
    expect(after.resolvedAt).toBeTruthy()
    for (const k of ['attempts', 'codeCounts', 'firstAttemptAt', 'lastAttemptAt', 'lastCode', 'lastRunId', 'lastDetail', 'organizerUid', 'transactionId']) expect(after[k]).toEqual(before[k])
    expect(await att.resolveConfirmedReleaseEvidence(id)).toBe('not_open')            // duplicate: no second write
    expect((await attempt(id))!.resolvedAt).toEqual(after.resolvedAt)
    expect(await wallet(uid)).toEqual(walletBefore)                                     // evidence only
    expect(await row(id)).toEqual(rowBefore)
    // concurrent sweeps of one record: exactly one resolves
    const uid2 = `p310c-org-${P}-4b`
    const id2 = await releasedUnresolved(uid2, 1_700)
    const outs = await Promise.all([1, 2, 3].map(() => att.resolveConfirmedReleaseEvidence(id2)))
    expect(outs.filter(o => o === 'resolved')).toHaveLength(1)
    expect(outs.filter(o => o === 'not_open')).toHaveLength(2)
    expect(await attempt(id2)).toMatchObject({ status: 'resolved', attempts: 1 })
    expect(await releasesOf(id2)).toHaveLength(1)
  }, T)

  it('5 · held, reversed, deleted, unreadable and still-eligible rows are REPORTED, never resolved', async () => {
    const uid = `p310c-org-${P}-5`
    const [held, reversed, deleted, weird, eligible] = [await payment(uid, 1_000), await payment(uid, 1_100), await payment(uid, 1_200), await payment(uid, 1_300), await payment(uid, 1_400)]
    await setPending(uid, 0)
    await release({ limit: 500 })                                                       // five refusals ⇒ five open records
    await db.doc(`platformTransactions/${held}`).update({ releaseStatus: 'held', releaseHold: { reason: 'refund_review', refundIds: [], heldAt: new Date() } })
    await setPending(uid, 1_100); await reverse(reversed)
    await db.doc(`platformTransactions/${deleted}`).delete()
    await db.doc(`platformTransactions/${weird}`).update({ releaseStatus: 'mystery' })
    // a released row that later gained a refund hold (registration refund after release): reported held
    const uid2 = `p310c-org-${P}-5b`
    const releasedHeld = await releasedUnresolved(uid2, 900)
    await db.doc(`platformTransactions/${releasedHeld}`).update({ releaseHold: { reason: 'refund_review', refundIds: ['r'], heldAt: new Date(), alreadyReleased: true } })
    const cases: Array<[string, string]> = [[held, 'row_held'], [reversed, 'row_reversed'], [deleted, 'row_deleted'], [weird, 'row_unreadable'], [eligible, 'still_eligible'], [releasedHeld, 'row_held']]
    for (const [id, want] of cases) {
      const before = await attempt(id)
      expect(await att.resolveConfirmedReleaseEvidence(id)).toBe(want)
      expect(await attempt(id)).toEqual(before)                                         // nothing written
      expect(before).toMatchObject({ status: 'open' })
    }
    expect(await att.resolveConfirmedReleaseEvidence(`p310c-none-${P}`)).toBe('missing_record')
    await tidy(held, weird, eligible)
  }, T)

  it('6 · evidence and release state that DISAGREE are reported as inconsistencies, nothing written', async () => {
    const uid = `p310c-org-${P}-6`
    // released row with no release record
    const noRec = await releasedUnresolved(uid, 1_000)
    const [r1] = await releasesOf(noRec)
    const saved1 = r1.data(); await r1.ref.delete()
    // released row with TWO release records
    const multi = await releasedUnresolved(`${uid}-m`, 1_100)
    const extra = db.collection('settlementReleases').doc(`p310c-extra-${P}`)
    await extra.set({ ...(await releasesOf(multi))[0].data() })
    // released row whose release record carries a different amount
    const amt = await releasedUnresolved(`${uid}-a`, 1_200)
    const [r3] = await releasesOf(amt)
    await r3.ref.update({ amountPaise: 1_199 })
    // a still-pending row that already has a release record
    const pend = await payment(`${uid}-p`, 1_300)
    await setPending(`${uid}-p`, 0); await release({ limit: 500 })
    const fake = db.collection('settlementReleases').doc(`p310c-fake-${P}`)
    await fake.set({ transactionId: pend, organizerUid: `${uid}-p`, amountPaise: 1_300 })
    const cases: Array<[string, string]> = [[noRec, 'inconsistent_no_release_record'], [multi, 'inconsistent_multiple_release_records'], [amt, 'inconsistent_release_amount'], [pend, 'inconsistent_release_record_but_not_released']]
    for (const [id, want] of cases) {
      const before = await attempt(id)
      expect(await att.resolveConfirmedReleaseEvidence(id)).toBe(want)
      expect(await attempt(id)).toEqual(before)
    }
    // the page sweep reports them (and resolves only confirmed ones)
    const confirmed = await releasedUnresolved(`${uid}-ok`, 800)
    await db.doc(`reconciliationCursors/recon:release-evidence-sweep`).set({ after: null }, { merge: true })
    const s = await att.sweepConfirmedReleaseEvidence({ limit: 1_000 })
    expect(s.stoppedByBudget).toBe(false)
    for (const [id, want] of cases) expect(s.inconsistencies).toContainEqual({ ptxId: id, outcome: want })
    expect(await attempt(confirmed)).toMatchObject({ status: 'resolved', resolution: 'confirmed_release' })
    for (const [id] of cases) expect(await attempt(id)).toMatchObject({ status: 'open' })
    // tidy the synthetic disagreement so later suites see consistent data
    await r1.ref.set(saved1); await extra.delete(); await r3.ref.update({ amountPaise: 1_200 }); await fake.delete()
    await tidy(pend)
  }, T)

  it('7 · the sweep is bounded: a spent budget starts no record (cursor kept); a failing read is unrecorded, never thrown', async () => {
    const uid = `p310c-org-${P}-7`
    const id = await releasedUnresolved(uid, 650)
    const cur = db.doc(`reconciliationCursors/recon:release-evidence-sweep`)
    await cur.set({ after: 'p310c-marker' }, { merge: true })
    const s = await att.sweepConfirmedReleaseEvidence({ limit: 100, budgetMs: 0 })
    expect(s).toMatchObject({ scanned: 0, stoppedByBudget: true })
    expect((await cur.get()).get('after')).toBe('p310c-marker')
    expect(await attempt(id)).toMatchObject({ status: 'open' })
    fx.failPathPrefix = 'settlementReleaseAttempts/'; fx.failCount = 1_000
    expect(await att.resolveConfirmedReleaseEvidence(id)).toBe('unrecorded')
    fx.failPathPrefix = null
    expect(await attempt(id)).toMatchObject({ status: 'open' })
    expect(await att.resolveConfirmedReleaseEvidence(id)).toBe('resolved')
  }, T)

  it('8 · the cron: releases under its budget, THEN sweeps evidence (a confirmed release resolves); the budget is the explicit constant', async () => {
    const uid = `p310c-org-${P}-8`
    const id = await releasedUnresolved(uid, 1_250)
    const fresh = await payment(`${uid}-n`, 400)
    await db.doc('reconciliationCursors/recon:release-evidence-sweep').set({ after: null }, { merge: true })
    const { NextRequest } = await import('next/server')
    const cron = await import('@/app/api/cron/release-funds/route')
    const res = await cron.GET(new NextRequest('http://localhost/api/cron/release-funds', { method: 'GET' }))
    expect(res.status).toBe(200)
    expect(await row(fresh)).toMatchObject({ releaseStatus: 'released' })
    expect(await attempt(id)).toMatchObject({ status: 'resolved', resolution: 'confirmed_release' })
    // the route passes the budget explicitly, and it leaves a safety margin below maxDuration
    const { RELEASE_RUN_BUDGET_MS } = await import('@/lib/settlements/releaseFunds')
    expect(RELEASE_RUN_BUDGET_MS).toBeLessThanOrEqual(cron.maxDuration * 1_000 - 15_000)
    const src = (await import('node:fs')).readFileSync('app/api/cron/release-funds/route.ts', 'utf8')
    expect(src).toMatch(/releaseEligibleFunds\(\{ limit: 500, budgetMs: RELEASE_RUN_BUDGET_MS \}\)/)
  }, T)
})
