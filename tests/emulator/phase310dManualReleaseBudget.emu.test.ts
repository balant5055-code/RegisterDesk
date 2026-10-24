// Phase 3.10D — the REAL manual release route on REAL Firestore (synthetic emulator data only) when the job's
// time budget is spent mid-run: the in-flight row completes exactly, the rest are untouched and stay eligible,
// the response and audit say so, and a second run releases the rest exactly once.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const DAY = 86_400_000

const fx = vi.hoisted(() => ({ jumpOnPath: null as string | null, jumpMs: 0, offset: 0 }))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))
vi.mock('@/lib/admin/financialGuard', async orig => ({ ...(await orig<typeof import('@/lib/admin/financialGuard')>()), requireSuperAdmin: async () => ({ uid: `p310d-super-${process.pid}` }) }))

describeEmu('Phase 3.10D · manual release stopped by the time budget', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let POST: typeof import('@/app/api/admin/finance/release-funds/route').POST
  let n = 0

  async function payment(uid: string, net: number) {
    const id = `p310d-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: 'event_registration', category: 'ticketed', organizerUid: uid, entityId: 'e', entityType: 'event', sourceId: id, sourceType: 'registration',
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0,
      netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    // the OLDEST eligible rows (in creation order), so this run's batch starts with them
    await db.doc(`platformTransactions/ptx_${id}`).update({ paidAt: new Date(Date.now() - 7_000 * DAY + n * 1_000) })
    return `ptx_${id}`
  }
  const post = async (reason: string) => {
    const res = await POST(new NextRequest('http://localhost/api/admin/finance/release-funds', { method: 'POST', body: JSON.stringify({ reason }) }))
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const row = async (id: string) => (await db.doc(`platformTransactions/${id}`).get()).data()!
  const releasesOf = async (id: string) => (await db.collection('settlementReleases').where('transactionId', '==', id).get()).docs.map(d => d.get('amountPaise'))
  const audit = async (reason: string) => (await db.collection('adminAuditLogs').where('action', '==', 'finance.release_funds').where('reason', '==', reason).get()).docs.map(d => d.data())

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ recordPlatformTransactionAndCredit: credit } = await import('@/lib/firebase/firestore/platformTransactions'))
    ;({ POST } = await import('@/app/api/admin/finance/release-funds/route'))
  }, T)
  afterAll(async () => {
    vi.restoreAllMocks()
    const prefix = `ptx_p310d-${P}-`
    const s = await db.collection('platformTransactions').where(FS.FieldPath.documentId(), '>=', prefix).where(FS.FieldPath.documentId(), '<', `${prefix}`).get()
    for (const d of s.docs) if (d.get('releaseStatus') !== 'released') await d.ref.delete()
  }, T)
  beforeEach(() => {
    vi.restoreAllMocks()
    fx.jumpOnPath = null; fx.jumpMs = 0; fx.offset = 0
    // the clock as the release job reads it: jumps forward once a given row's transaction is IN FLIGHT
    const realNow = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + fx.offset)
    const orig = db.runTransaction.bind(db)
    vi.spyOn(db, 'runTransaction').mockImplementation((async (fn: (tx: FirebaseFirestore.Transaction) => unknown, opts?: never) =>
      orig(async tx => {
        const get = tx.get.bind(tx) as (q: unknown) => unknown
        ;(tx as unknown as { get: unknown }).get = (q: { path?: string }) => {
          if (fx.jumpOnPath && q?.path === fx.jumpOnPath) fx.offset = fx.jumpMs
          return get(q)
        }
        return fn(tx)
      }, opts)) as never)
  })

  it('stops early: the in-flight row completes exactly, the rest stay pending + eligible; response and audit say so; a second run releases them exactly once', async () => {
    const uid = `p310d-org-${P}`
    const [a, b, c] = [await payment(uid, 1_000), await payment(uid, 2_000), await payment(uid, 3_000)]
    const { RELEASE_RUN_BUDGET_MS } = await import('@/lib/settlements/releaseFunds')
    fx.jumpOnPath = `platformTransactions/${a}`; fx.jumpMs = RELEASE_RUN_BUDGET_MS + 60_000   // the budget is spent while row a is in flight
    const reason1 = `p310d stop ${P}`
    const r1 = await post(reason1)
    fx.jumpOnPath = null; fx.offset = 0
    expect(r1.status).toBe(200)
    expect(r1.body).toMatchObject({ releasedTransactions: 1, releasedAmountPaise: 1_000, skippedTransactions: 0, stoppedByBudget: true })
    expect(r1.body.notStartedForBudget).toBeGreaterThanOrEqual(2)
    expect(row(a)).resolves.toMatchObject({ releaseStatus: 'released' })
    expect(await releasesOf(a)).toEqual([1_000])
    for (const id of [b, c]) { expect(await row(id)).toMatchObject({ status: 'completed', releaseStatus: 'pending' }); expect(await releasesOf(id)).toEqual([]) }
    expect((await db.doc(`organizerRevenueWallets/${uid}`).get()).data()).toMatchObject({ pendingPaise: 5_000, availablePaise: 1_000 })
    const [audit1] = await audit(reason1)
    expect(audit1).toMatchObject({ actorRole: 'super_admin', metadata: { releasedTransactions: 1, releasedAmountPaise: 1_000, stoppedByBudget: true, notStartedForBudget: r1.body.notStartedForBudget } })

    const reason2 = `p310d continue ${P}`
    const r2 = await post(reason2)
    expect(r2.status).toBe(200)
    expect(r2.body.stoppedByBudget).toBeUndefined()
    expect(await releasesOf(a)).toEqual([1_000])                                       // exactly once each
    expect(await releasesOf(b)).toEqual([2_000])
    expect(await releasesOf(c)).toEqual([3_000])
    expect((await db.doc(`organizerRevenueWallets/${uid}`).get()).data()).toMatchObject({ pendingPaise: 0, availablePaise: 6_000 })
    const [audit2] = await audit(reason2)
    expect(audit2.metadata).not.toHaveProperty('stoppedByBudget')
  }, T)
})
