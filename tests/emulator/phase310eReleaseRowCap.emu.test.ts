// Phase 3.10E — ROW-CAP detection on REAL Firestore (synthetic emulator data only): the probe row past the cap is
// never processed; an exactly-full batch is not reported as capped; the cap and the time budget are reported
// independently. Amounts, wallet buckets and release records are asserted exactly.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const DAY = 86_400_000

vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('Phase 3.10E · release row-cap feedback', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let n = 0

  // the OLDEST eligible rows, in creation order, so a small-limit run's batch is exactly these
  async function payment(uid: string, net: number) {
    const id = `p310e-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: 'event_registration', category: 'ticketed', organizerUid: uid, entityId: 'e', entityType: 'event', sourceId: id, sourceType: 'registration',
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0,
      netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    await db.doc(`platformTransactions/ptx_${id}`).update({ paidAt: new Date(Date.now() - 8_000 * DAY + n * 1_000) })
    return `ptx_${id}`
  }
  const row = async (id: string) => (await db.doc(`platformTransactions/${id}`).get()).data()!
  const releasesOf = async (id: string) => (await db.collection('settlementReleases').where('transactionId', '==', id).get()).docs.map(d => d.get('amountPaise'))
  const wallet = async (uid: string) => (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!
  /** every eligible row right now (same filters as the job) — to size an EXACTLY-full batch */
  async function eligibleCount() {
    const { getSettlementConfig } = await import('@/lib/settlements/resolveSettlementConfig')
    const c = await getSettlementConfig()
    const cutoff = FS.Timestamp.fromMillis(Date.now() - c.holdHours * 3_600_000)
    const s = await db.collection('platformTransactions').where('status', '==', 'completed').where('releaseStatus', '==', 'pending').where('paidAt', '<=', cutoff).count().get()
    return { count: s.data().count, max: c.maximumSettlementsPerRun }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ recordPlatformTransactionAndCredit: credit } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
  }, T)
  afterAll(async () => {
    const prefix = `ptx_p310e-${P}-`
    const s = await db.collection('platformTransactions').where(FS.FieldPath.documentId(), '>=', prefix).where(FS.FieldPath.documentId(), '<', `${prefix}`).get()
    for (const d of s.docs) if (d.get('releaseStatus') !== 'released') await d.ref.delete()
  }, T)

  it('1 · row cap: the batch releases exactly; the probe row past the cap is NEVER processed; the run reports the cap', async () => {
    const uid = `p310e-org-${P}-1`
    const [a, b, probe] = [await payment(uid, 1_000), await payment(uid, 2_000), await payment(uid, 4_000)]
    const r = await release({ limit: 2 })
    expect(r).toMatchObject({ processed: 2, releasedAmountPaise: 3_000, failures: 0, stoppedByRowCap: true, rowCap: 2 })
    expect(r.stoppedByBudget).toBeUndefined()
    expect(await releasesOf(a)).toEqual([1_000])
    expect(await releasesOf(b)).toEqual([2_000])
    expect(await row(probe)).toMatchObject({ status: 'completed', releaseStatus: 'pending' })
    expect(await releasesOf(probe)).toEqual([])
    expect(await wallet(uid)).toMatchObject({ pendingPaise: 4_000, availablePaise: 3_000 })
    // the remaining row is still eligible: the next run takes it, exactly once
    await release({ limit: 500 })
    expect(await releasesOf(probe)).toEqual([4_000])
    expect(await wallet(uid)).toMatchObject({ pendingPaise: 0, availablePaise: 7_000 })
  }, T)

  it('2 · zero remaining: an EXACTLY-full batch (nothing after it) is not reported as capped', async () => {
    const uid = `p310e-org-${P}-2`
    await payment(uid, 1_500); await payment(uid, 2_500)
    const { count, max } = await eligibleCount()
    expect(count).toBeGreaterThanOrEqual(2)
    expect(count).toBeLessThanOrEqual(max)                                              // the requested limit is not lowered by config
    const r = await release({ limit: count })
    expect(r.stoppedByRowCap).toBeUndefined()
    expect(r.rowCap).toBeUndefined()
    expect(r.processed + r.failures + (r.held ?? 0)).toBe(count)                        // every row of the batch was started
    expect(await wallet(uid)).toMatchObject({ pendingPaise: 0, availablePaise: 4_000 })
  }, T)

  it('3 · time budget AND row cap in one run: both reported; nothing started, nothing released', async () => {
    const uid = `p310e-org-${P}-3`
    const ids = [await payment(uid, 100), await payment(uid, 200), await payment(uid, 300)]
    const r = await release({ limit: 2, budgetMs: 0 })
    expect(r).toMatchObject({ processed: 0, releasedAmountPaise: 0, failures: 0, stoppedByBudget: true, notStartedForBudget: 2, stoppedByRowCap: true, rowCap: 2 })
    for (const id of ids) { expect(await row(id)).toMatchObject({ releaseStatus: 'pending' }); expect(await releasesOf(id)).toEqual([]) }
    expect(await wallet(uid)).toMatchObject({ pendingPaise: 600, availablePaise: 0 })
  }, T)
})
