// Phase 2.1 — donation refund OUTCOME safety, on REAL Firestore, through the real donation webhook
// (/api/razorpay/webhook: refund.processed + refund.failed), the real organizer/Super Admin refund route,
// the real accounting + recovery drain, the real release job and the real Super Admin refund-hold route.
//
//   accepted (gateway 'pending')  → awaiting_gateway + donation HELD (never accounted from this)
//   processed (signed event / API) → accounted exactly once
//   failed (signed refund.failed)  → status 'failed', never accounted, reservation freed, hold KEPT
//   contradictions (failed↔processed, either order) → never overwrite the recorded outcome; needs_review
//   a hold is lifted only by an authorized Super Admin, through the evidence-gated lift
// Synthetic data only; the gateway stub counts every refund it is asked to CREATE.

import crypto from 'crypto'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const WHSEC = 'dro_webhook_secret'
const SUPER = `dro-super-${P}`

const fx = vi.hoisted(() => ({
  failApply: 0,
  refundCalls: 0,
  gatewayStatus: 'pending' as string,
  /** What the read-only refund lookup returns (organizer pre-check + Super Admin lift evidence). */
  lookup: [] as Array<{ id: string; amount: number; status: string }>,
  created: [] as Array<{ id: string; amount: number; status: string }>,
}))
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), RAZORPAY_WEBHOOK_SECRET: WHSEC }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_dro', RAZORPAY_KEY_SECRET: 'dro',
  razorpay: { payments: {
    refund: async (_p: string, o: { amount: number }) => {
      fx.refundCalls++
      const r = { id: `rfnd_dro_org_${P}_${fx.refundCalls}`, amount: o.amount, status: fx.gatewayStatus }
      fx.created.push(r)
      return r
    },
    fetchMultipleRefund: async () => ({ entity: 'collection', count: fx.lookup.length, items: fx.lookup }),
  } },
}))
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async (hd: string | null) => (hd === 'Bearer super' ? SUPER : hd === 'Bearer admin' ? `dro-admin-${process.pid}` : null),
  resolveSuperAdminUid: async (hd: string | null) => (hd === 'Bearer super' ? SUPER : null),
  legacyAdminClaimOnly: async () => false,
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined, captureWebhookError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('Phase 2.1 · donation refund outcome safety', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let svc: typeof import('@/lib/donations/refundService')
  let webhook: (r: NextRequest) => Promise<Response>
  let orgRefund: (r: NextRequest, c: { params: Promise<{ donationId: string }> }) => Promise<Response>
  let holds: (r: NextRequest) => Promise<Response>
  let n = 0

  const org = () => `dro-org-${P}-${++n}`
  const wallet = async (uid: string) => {
    const w = (await db.doc(`organizerRevenueWallets/${uid}`).get()).data() ?? {}
    return { pending: w.pendingPaise as number, available: w.availablePaise as number }
  }
  const ptx = async (id: string) => (await db.doc(`platformTransactions/${id}`).get()).data() ?? {}
  const rec = async (id: string) => (await db.doc(`donationRefunds/${id}`).get()).data() ?? {}
  const don = async (id: string) => (await db.doc(`donations/${id}`).get()).data() ?? {}
  const reversalRows = async (donationId: string) => (await db.collection('platformTransactions').where('parentTransactionId', '==', `ptx_${donationId}`).get()).size
  const backdate = (id: string) => db.doc(`platformTransactions/${id}`).update({ paidAt: new Date(Date.now() - 10 * 86_400_000) })
  const releases = async (ptxId: string) => (await db.collection('settlementReleases').where('transactionId', '==', ptxId).get()).size

  async function payment(uid: string, net: number, kind: 'donation' | 'registration') {
    const id = `dro-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: kind === 'donation' ? 'donation' : 'event_registration', category: kind === 'donation' ? 'donation' : 'ticketed',
      organizerUid: uid, entityId: `dro-camp-${P}`, entityType: kind === 'donation' ? 'campaign' : 'event', sourceId: id, sourceType: kind,
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0,
      gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x',
      currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    return { id, ptxId: `ptx_${id}`, paymentId: `pay_${id}`, orderId: `order_${id}` }
  }
  async function donation(uid: string, gross: number) {
    const p = await payment(uid, gross, 'donation')
    await db.doc(`donations/${p.id}`).set({
      amountPaise: gross, campaignId: `dro-camp-${P}`, campaignSlug: `dro-camp-${P}`, organizerUid: uid, donorEmail: `d${n}@x.test`, donorName: 'D',
      isAnonymous: false, status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: p.orderId, razorpayPaymentId: p.paymentId,
    })
    return p
  }
  function refundEvent(event: 'refund.processed' | 'refund.failed', eventId: string, d: { id: string; paymentId: string; orderId: string }, refundId: string, amount: number) {
    const body = JSON.stringify({ id: eventId, event, payload: {
      refund:  { entity: { id: refundId, payment_id: d.paymentId, amount, status: event === 'refund.failed' ? 'failed' : 'processed', ...(event === 'refund.failed' ? { error_description: 'bank rejected' } : {}) } },
      payment: { entity: { id: d.paymentId, order_id: d.orderId, amount, currency: 'INR', status: 'captured', notes: { donationId: d.id } } },
    } })
    const sig = crypto.createHmac('sha256', WHSEC).update(body).digest('hex')
    return webhook(new NextRequest('http://x/api/razorpay/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body }))
  }
  const organizerRefund = async (donationId: string, amountPaise: number) => {
    const res = await orgRefund(
      new NextRequest(`http://x/api/organizer/donations/${donationId}/refund`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer super' }, body: JSON.stringify({ amountPaise, reason: 'donor asked for a refund' }) }),
      { params: Promise.resolve({ donationId }) },
    )
    expect(res.status).toBe(200)
    return fx.created.at(-1)!.id
  }
  let req = 0
  const lift = (ptxId: string, refundIds: string[], auth = 'Bearer super') => holds(new NextRequest('http://x/api/admin/finance/refund-holds', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ ptxId, outcome: 'lift_hold_no_refund', reason: 'verified with Razorpay dashboard', confirm: true, expectedRefundIds: refundIds, requestId: `droreq${P}x${++req}` }),
  }))

  function injectFailures() {
    const orig = db.runTransaction.bind(db)
    vi.spyOn(db, 'runTransaction').mockImplementation((async (fn: (tx: FirebaseFirestore.Transaction) => unknown, opts?: never) =>
      orig(async tx => {
        const get = tx.get.bind(tx) as (q: unknown) => unknown
        ;(tx as unknown as { get: unknown }).get = (q: { path?: string }) => {
          const path = typeof q?.path === 'string' ? q.path : ''
          if (fx.failApply > 0 && path.startsWith('organizerRevenueWallets/')) { fx.failApply--; return Promise.reject(new Error('simulated transient accounting failure')) }   // async, like a real failed read (a sync throw strands the reads already issued)
          return get(q)
        }
        return fn(tx)
      }, opts)) as never)
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    credit = (await import('@/lib/firebase/firestore/platformTransactions')).recordPlatformTransactionAndCredit
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    svc = await import('@/lib/donations/refundService')
    ;({ POST: webhook } = await import('@/app/api/razorpay/webhook/route'))
    ;({ POST: orgRefund } = await import('@/app/api/organizer/donations/[donationId]/refund/route') as never)
    ;({ POST: holds } = await import('@/app/api/admin/finance/refund-holds/route') as never)
  }, T)
  beforeEach(() => {
    vi.restoreAllMocks()
    fx.failApply = 0; fx.gatewayStatus = 'pending'; fx.lookup = []; fx.created.length = 0
    injectFailures()
  })

  it('1 · ACCEPTED but unresolved ⇒ donation held (never released, never accounted); the signed success then accounts it exactly once; duplicates add nothing', async () => {
    const uid = org()
    const d = await donation(uid, 2_000)
    const b = await payment(uid, 500, 'registration')
    const calls0 = fx.refundCalls
    const refundId = await organizerRefund(d.id, 800)
    expect(await rec(refundId)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'awaiting_gateway', gatewayStatus: 'pending' } })
    expect(await ptx(d.ptxId)).toMatchObject({ releaseStatus: 'held', releaseHold: { reason: 'refund_review', source: svc.DONATION_OUTCOME_PENDING_HOLD_SOURCE, refundIds: [refundId] } })
    await backdate(d.ptxId); await backdate(b.ptxId)
    await release({ limit: 500 })
    expect(await releases(d.ptxId)).toBe(0)
    expect((await ptx(b.ptxId)).releaseStatus).toBe('released')
    await svc.retryDonationRefundAccounting(500)                           // the drain never accounts awaiting_gateway
    expect((await rec(refundId)).status).toBe('pending')
    expect(await wallet(uid)).toMatchObject({ pending: 2_000, available: 500 })
    // the gateway's signed success: accounted once; the partial refund keeps the Phase 1 manual-review hold
    expect((await refundEvent('refund.processed', `evt_dro_1p_${P}`, d, refundId, 800)).status).toBe(200)
    expect(await rec(refundId)).toMatchObject({ status: 'processed', ledgerReversedPaise: 800, accountingRecovery: { state: 'completed' } })
    expect(await ptx(d.ptxId)).toMatchObject({ releaseStatus: 'held', releaseHold: { source: 'donation_partial_refund' } })
    for (const ev of [`evt_dro_1p_${P}`, `evt_dro_1p2_${P}`]) await refundEvent('refund.processed', ev, d, refundId, 800)   // same + new event id
    await svc.retryDonationRefundAccounting(500)
    expect(await reversalRows(d.id)).toBe(1)
    expect(await wallet(uid)).toMatchObject({ pending: 1_200, available: 500 })
    expect(fx.refundCalls).toBe(calls0 + 1)                                 // only the organizer's own request
  }, T)

  it('2 · a webhook and the recovery cron racing on one refund apply it once; a FULL refund closes the outcome hold with evidence', async () => {
    const uid = org()
    const d = await donation(uid, 1_000)
    fx.gatewayStatus = 'processed'; fx.failApply = 1
    const refundId = await organizerRefund(d.id, 1_000)
    expect((await rec(refundId)).accountingRecovery).toMatchObject({ state: 'retry', gatewayEvidence: 'api_refund_processed' })
    await db.doc(`donationRefunds/${refundId}`).update({ 'accountingRecovery.nextAttemptAt': FS.Timestamp.fromMillis(Date.now() - 1_000) })
    await Promise.all([
      refundEvent('refund.processed', `evt_dro_2a_${P}`, d, refundId, 1_000),
      svc.retryDonationRefundAccounting(500),
      refundEvent('refund.processed', `evt_dro_2b_${P}`, d, refundId, 1_000),
      svc.retryDonationRefundAccounting(500),
    ])
    expect(await rec(refundId)).toMatchObject({ status: 'processed', isFullRefund: true, accountingRecovery: { state: 'completed' } })
    expect(await reversalRows(d.id)).toBe(1)
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 0 })
    const t = await ptx(d.ptxId)
    expect(t).toMatchObject({ status: 'refunded', releaseStatus: 'pending' })
    expect(t.releaseHold).toBeUndefined()
    expect(Object.values(t.releaseHoldHistory ?? {})).toHaveLength(1)
  }, T)

  it('3 · a VERIFIED FAILED refund is never accounted: status failed, reservation freed, hold KEPT; duplicates and a late success cannot overwrite it', async () => {
    const uid = org()
    const d = await donation(uid, 2_000)
    const calls0 = fx.refundCalls
    const refundId = await organizerRefund(d.id, 600)
    expect((await don(d.id)).pendingRefundPaise).toBe(600)
    expect((await refundEvent('refund.failed', `evt_dro_3f_${P}`, d, refundId, 600)).status).toBe(200)
    expect(await rec(refundId)).toMatchObject({ status: 'failed', failureReason: 'bank rejected', accountingRecovery: { state: 'gateway_failed' } })
    expect((await don(d.id)).pendingRefundPaise).toBe(0)                    // no money left: refundable restored
    expect((await don(d.id)).refundedAmountPaise).toBe(0)
    expect(await reversalRows(d.id)).toBe(0)
    expect(await wallet(uid)).toMatchObject({ pending: 2_000 })
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')                // never auto-lifted
    await backdate(d.ptxId); await release({ limit: 500 })
    expect(await releases(d.ptxId)).toBe(0)
    // duplicates (same and new event id): nothing changes
    for (const ev of [`evt_dro_3f_${P}`, `evt_dro_3f2_${P}`]) await refundEvent('refund.failed', ev, d, refundId, 600)
    expect((await don(d.id)).pendingRefundPaise).toBe(0)
    // an out-of-order SUCCESS for the failed refund: NOT accounted, outcome not overwritten, flagged
    expect((await refundEvent('refund.processed', `evt_dro_3p_${P}`, d, refundId, 600)).status).toBe(200)
    expect(await rec(refundId)).toMatchObject({ status: 'failed', accountingRecovery: { state: 'needs_review' } })
    // Phase 3.1 — detected in the outcome transaction (before accounting is ever attempted), exactly labelled
    expect((await rec(refundId)).accountingRecovery).toMatchObject({ conflict: 'PROCESSED_EVENT_AFTER_FAILED', lastError: 'PROCESSED_EVENT_AFTER_FAILED' })
    await svc.retryDonationRefundAccounting(500)
    expect(await reversalRows(d.id)).toBe(0)
    expect(await wallet(uid)).toMatchObject({ pending: 2_000 })
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
    expect(fx.refundCalls).toBe(calls0 + 1)
  }, T)

  it('4 · a refund.failed arriving AFTER the refund was accounted never undoes it: flagged needs_review, nothing reversed; a refund made outside RegisterDesk that fails is recorded failed', async () => {
    const uid = org()
    const d = await donation(uid, 1_000)
    const r = `rfnd_dro_ok_${P}`
    await refundEvent('refund.processed', `evt_dro_4p_${P}`, d, r, 300)
    expect(await rec(r)).toMatchObject({ status: 'processed' })
    expect(await wallet(uid)).toMatchObject({ pending: 700 })
    await refundEvent('refund.failed', `evt_dro_4f_${P}`, d, r, 300)
    expect(await rec(r)).toMatchObject({ status: 'processed', accountingRecovery: { state: 'needs_review', conflict: 'FAILED_EVENT_AFTER_PROCESSED' } })
    expect(await reversalRows(d.id)).toBe(1)
    expect(await wallet(uid)).toMatchObject({ pending: 700 })
    // unknown refund (no record): recorded failed, no reservation touched, nothing accounted
    const x = `rfnd_dro_ext_${P}`
    await db.doc(`donations/${d.id}`).update({ pendingRefundPaise: 50 })    // another refund's in-flight reservation
    await refundEvent('refund.failed', `evt_dro_4x_${P}`, d, x, 200)
    expect(await rec(x)).toMatchObject({ status: 'failed', initiatedBy: 'webhook', accountingRecovery: { state: 'gateway_failed' } })
    expect((await don(d.id)).pendingRefundPaise).toBe(50)
    expect(await reversalRows(d.id)).toBe(1)
  }, T)

  it('5 · the hold is lifted ONLY by an authorized Super Admin, ONLY on evidence that no money left', async () => {
    const uid = org()
    const d = await donation(uid, 1_500)
    const r = await organizerRefund(d.id, 500)
    // unresolved (gateway outcome unknown): not liftable
    expect((await lift(d.ptxId, [r])).status).toBe(409)
    await refundEvent('refund.failed', `evt_dro_5f_${P}`, d, r, 500)
    // a non-Super-Admin cannot lift; nothing was lifted automatically
    expect((await lift(d.ptxId, [r], 'Bearer admin')).status).toBe(403)
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
    // Razorpay still shows money out for the payment: refused
    fx.lookup = [{ id: r, amount: 500, status: 'processed' }]
    const refused = await lift(d.ptxId, [r])
    expect(refused.status).toBe(409)
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
    // Razorpay confirms the refund failed and nothing else: the Super Admin lifts it, audited, evidence kept
    fx.lookup = [{ id: r, amount: 500, status: 'failed' }]
    const ok = await lift(d.ptxId, [r])
    expect(ok.status).toBe(200)
    const t = await ptx(d.ptxId)
    expect(t).toMatchObject({ status: 'completed', releaseStatus: 'pending' })
    expect(t.releaseHold).toBeUndefined()
    expect(Object.values(t.releaseHoldHistory ?? {})[0]).toMatchObject({ outcome: 'lift_hold_no_refund', by: SUPER, hold: { refundIds: [r] } })
    expect((await db.collection('adminAuditLogs').where('entityId', '==', d.ptxId).where('action', '==', 'settlement.refund_hold_lifted').get()).size).toBe(1)
    await backdate(d.ptxId); await release({ limit: 500 })
    expect((await ptx(d.ptxId)).releaseStatus).toBe('released')             // the original full net: nothing left
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 1_500 })
  }, T)

  it('6 · a PARTIALLY refunded donation is never liftable (money left) — the Phase 1 manual-review hold stays', async () => {
    const uid = org()
    const d = await donation(uid, 1_000)
    const r = `rfnd_dro_part_${P}`
    await refundEvent('refund.processed', `evt_dro_6p_${P}`, d, r, 400)
    expect(await ptx(d.ptxId)).toMatchObject({ releaseStatus: 'held', releaseHold: { source: 'donation_partial_refund' } })
    fx.lookup = []                                                          // even if the lookup shows nothing
    const res = await lift(d.ptxId, [r])
    expect(res.status).toBe(409)
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
  }, T)
})
