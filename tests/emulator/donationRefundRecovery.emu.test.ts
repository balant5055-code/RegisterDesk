// Phase 2 (N3) — durable recovery of donation-refund ACCOUNTING, on REAL Firestore, through the real
// donation webhook (/api/razorpay/webhook), the real organizer/Super Admin refund route, the real
// accounting (applyDonationRefundAccounting), the real drain (retryDonationRefundAccounting, run by the
// donation-reconciliation cron) and the real release job.
//
// Only the INTERNAL accounting is ever retried, and only for refunds whose success the gateway itself
// reported (signed refund.processed, or Razorpay's 'processed' API response). The gateway stub counts
// every refund it is asked to create: no test path may create one except the organizer request itself.
// Failures are injected INSIDE Firestore transactions (a read throws), so nothing partial can commit.

import crypto from 'crypto'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const WHSEC = 'drr_webhook_secret'
const SUPER = `drr-super-${P}`

const fx = vi.hoisted(() => ({
  /** Throw on this many transactional reads of organizerRevenueWallets/* (the accounting transaction). */
  failApply: 0,
  /** Throw on this many transactional reads of donationRefunds/* (the first one is ensureRefundRecord). */
  failRefundRead: 0,
  refundCalls: 0,
  gatewayStatus: 'processed' as string,
  gatewayRefunds: [] as Array<{ id: string; amount: number; status: string }>,
}))
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), RAZORPAY_WEBHOOK_SECRET: WHSEC }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_drr', RAZORPAY_KEY_SECRET: 'drr',
  razorpay: { payments: {
    refund: async (_paymentId: string, o: { amount: number }) => {
      fx.refundCalls++
      const r = { id: `rfnd_drr_org_${P}_${fx.refundCalls}`, amount: o.amount, status: fx.gatewayStatus }
      fx.gatewayRefunds.push(r)
      return r
    },
    fetchMultipleRefund: async () => ({ entity: 'collection', count: 0, items: [] }),
  } },
}))
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async (hd: string | null) => (hd === 'Bearer super' ? SUPER : null),
  resolveSuperAdminUid: async (hd: string | null) => (hd === 'Bearer super' ? SUPER : null),
  legacyAdminClaimOnly: async () => false,
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined, captureWebhookError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('Phase 2 · durable donation-refund accounting recovery', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let svc: typeof import('@/lib/donations/refundService')
  let webhook: (r: NextRequest) => Promise<Response>
  let orgRefund: (r: NextRequest, c: { params: Promise<{ donationId: string }> }) => Promise<Response>
  let health: typeof import('@/lib/operations/healthMetrics').getOperationsHealth
  let n = 0

  const org = () => `drr-org-${P}-${++n}`
  const wallet = async (uid: string) => {
    const w = (await db.doc(`organizerRevenueWallets/${uid}`).get()).data() ?? {}
    return { pending: w.pendingPaise as number, available: w.availablePaise as number }
  }
  const ptx = async (id: string) => (await db.doc(`platformTransactions/${id}`).get()).data() ?? {}
  const rec = async (refundId: string) => (await db.doc(`donationRefunds/${refundId}`).get()).data() ?? {}
  const reversalRows = async (donationId: string) => (await db.collection('platformTransactions').where('parentTransactionId', '==', `ptx_${donationId}`).get()).size
  const evt = async (eventId: string) => (await db.doc(`paymentEvents/${eventId}`).get()).data() ?? {}
  const backdate = (id: string) => db.doc(`platformTransactions/${id}`).update({ paidAt: new Date(Date.now() - 10 * 86_400_000) })
  const dueNow = (refundId: string) => db.doc(`donationRefunds/${refundId}`).update({ 'accountingRecovery.nextAttemptAt': FS.Timestamp.fromMillis(Date.now() - 1_000) })

  async function payment(uid: string, net: number, kind: 'donation' | 'registration') {
    const id = `drr-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: kind === 'donation' ? 'donation' : 'event_registration', category: kind === 'donation' ? 'donation' : 'ticketed',
      organizerUid: uid, entityId: `drr-camp-${P}`, entityType: kind === 'donation' ? 'campaign' : 'event', sourceId: id, sourceType: kind,
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0,
      gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x',
      currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    return { id, ptxId: `ptx_${id}`, paymentId: `pay_${id}`, orderId: `order_${id}` }
  }
  async function donation(uid: string, gross: number) {
    const p = await payment(uid, gross, 'donation')
    await db.doc(`donations/${p.id}`).set({
      amountPaise: gross, campaignId: `drr-camp-${P}`, campaignSlug: `drr-camp-${P}`, organizerUid: uid, donorEmail: `d${n}@x.test`, donorName: 'D',
      isAnonymous: false, status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: p.orderId, razorpayPaymentId: p.paymentId,
    })
    return p
  }
  /** A signed refund.processed delivery (the donation webhook's real payload shape). */
  function refundProcessed(eventId: string, d: { id: string; paymentId: string; orderId: string }, refundId: string, amount: number) {
    const body = JSON.stringify({ id: eventId, event: 'refund.processed', payload: {
      refund:  { entity: { id: refundId, payment_id: d.paymentId, amount, status: 'processed' } },
      payment: { entity: { id: d.paymentId, order_id: d.orderId, amount, currency: 'INR', status: 'captured', notes: { donationId: d.id } } },
    } })
    const sig = crypto.createHmac('sha256', WHSEC).update(body).digest('hex')
    return webhook(new NextRequest('http://x/api/razorpay/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body }))
  }
  const organizerRefund = (donationId: string, amountPaise: number) => orgRefund(
    new NextRequest(`http://x/api/organizer/donations/${donationId}/refund`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer super' }, body: JSON.stringify({ amountPaise, reason: 'donor asked for a refund' }) }),
    { params: Promise.resolve({ donationId }) },
  )

  /** Failures injected INSIDE transactions: a read throws, so the transaction commits nothing. */
  function injectFailures() {
    const orig = db.runTransaction.bind(db)
    vi.spyOn(db, 'runTransaction').mockImplementation((async (fn: (tx: FirebaseFirestore.Transaction) => unknown, opts?: never) =>
      orig(async tx => {
        const get = tx.get.bind(tx) as (q: unknown) => unknown
        ;(tx as unknown as { get: unknown }).get = (q: { path?: string }) => {
          const path = typeof q?.path === 'string' ? q.path : ''
          if (fx.failApply > 0 && path.startsWith('organizerRevenueWallets/')) { fx.failApply--; return Promise.reject(new Error('simulated transient accounting failure')) }   // async, like a real failed read (a sync throw strands the reads already issued)
          if (fx.failRefundRead > 0 && path.startsWith('donationRefunds/')) { fx.failRefundRead--; return Promise.reject(new Error('simulated refund-record write failure')) }   // async, like a real failed read (a sync throw strands the reads already issued)
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
    health = (await import('@/lib/operations/healthMetrics')).getOperationsHealth
  }, T)
  beforeEach(() => {
    vi.restoreAllMocks()
    fx.failApply = 0; fx.failRefundRead = 0; fx.gatewayStatus = 'processed'; fx.gatewayRefunds.length = 0
    injectFailures()
  })

  it('1 · webhook: accounting fails AFTER the event is claimed ⇒ durable retry state + donation held; duplicates change nothing; the drain applies it EXACTLY once; Phase 1 hold kept for the partial', async () => {
    const uid = org()
    const d = await donation(uid, 2_000)
    const b = await payment(uid, 500, 'registration')                     // unrelated, unreleased
    const refundId = `rfnd_drr_a_${P}`, ev = `evt_drr_a_${P}`
    const calls0 = fx.refundCalls
    fx.failApply = 1
    expect((await refundProcessed(ev, d, refundId, 800)).status).toBe(200)
    expect(await evt(ev)).toMatchObject({ result: 'failed', retryable: false })
    expect(String((await evt(ev)).resultDetail)).toContain('refund_accounting_retry')
    expect(await rec(refundId)).toMatchObject({ status: 'pending',
      accountingRecovery: { state: 'retry', attempts: 1, gatewayEvidence: 'webhook_refund_processed', lastSource: 'webhook', lastError: 'simulated transient accounting failure' } })
    expect((await rec(refundId)).accountingRecovery.nextAttemptAt).toBeTruthy()
    expect(await ptx(d.ptxId)).toMatchObject({ status: 'completed', releaseStatus: 'held', releaseHold: { reason: 'refund_review', source: svc.DONATION_ACCOUNTING_HOLD_SOURCE, refundIds: [refundId] } })
    expect(await wallet(uid)).toMatchObject({ pending: 2_500, available: 0 })   // nothing debited yet
    expect(await reversalRows(d.id)).toBe(0)
    // the awaiting donation is NEVER released; the unrelated payment still is, from its own funds
    await backdate(d.ptxId); await backdate(b.ptxId)
    await release({ limit: 500 })
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
    expect((await ptx(b.ptxId)).releaseStatus).toBe('released')
    expect(await wallet(uid)).toMatchObject({ pending: 2_000, available: 500 })
    // duplicate delivery of the SAME event: a duplicate — nothing changes
    expect((await refundProcessed(ev, d, refundId, 800)).status).toBe(200)
    expect((await rec(refundId)).accountingRecovery).toMatchObject({ state: 'retry', attempts: 1 })
    // the drain respects the backoff …
    expect(await svc.retryDonationRefundAccounting(500)).toMatchObject({ completed: 0 })
    expect((await rec(refundId)).status).toBe('pending')
    // … then applies it exactly once
    await dueNow(refundId)
    expect((await svc.retryDonationRefundAccounting(500)).completed).toBeGreaterThanOrEqual(1)
    expect(await rec(refundId)).toMatchObject({ status: 'processed', ledgerReversedPaise: 800, accountingRecovery: { state: 'completed', attempts: 1 } })
    expect((await rec(refundId)).accountingRecovery.completedAt).toBeTruthy()
    expect(await wallet(uid)).toMatchObject({ pending: 1_200, available: 500 })   // 2,000 − 800 from pending
    expect(await reversalRows(d.id)).toBe(1)
    // a partial refund: the Phase 1 manual-review hold remains (now marked as a partial refund)
    expect(await ptx(d.ptxId)).toMatchObject({ releaseStatus: 'held', releaseHold: { source: 'donation_partial_refund', refundIds: [refundId] } })
    // repeated drains, a redelivery under a NEW event id, a direct re-apply: nothing more moves
    await svc.retryDonationRefundAccounting(500)
    expect((await refundProcessed(`${ev}_b`, d, refundId, 800)).status).toBe(200)
    expect(await svc.applyDonationRefundAccounting(refundId)).toMatchObject({ applied: false })
    expect(await wallet(uid)).toMatchObject({ pending: 1_200, available: 500 })
    expect(await reversalRows(d.id)).toBe(1)
    expect(fx.refundCalls).toBe(calls0)                                    // never a gateway refund
  }, T)

  it('2 · concurrent recovery workers apply it once; a FULL refund recovered later closes the hold (Phase 1 evidence) and the row is never released', async () => {
    const uid = org()
    const d = await donation(uid, 1_000)
    const refundId = `rfnd_drr_c_${P}`
    fx.failApply = 1
    await refundProcessed(`evt_drr_c_${P}`, d, refundId, 1_000)
    expect((await rec(refundId)).accountingRecovery.state).toBe('retry')
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
    await dueNow(refundId)
    await Promise.all([0, 1, 2].map(() => svc.retryDonationRefundAccounting(500)))
    expect(await rec(refundId)).toMatchObject({ status: 'processed', isFullRefund: true, accountingRecovery: { state: 'completed' } })
    expect(await reversalRows(d.id)).toBe(1)
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 0 })     // debited exactly once
    const t = await ptx(d.ptxId)
    expect(t).toMatchObject({ status: 'refunded', releaseStatus: 'pending' })
    expect(t.releaseHold).toBeUndefined()
    expect(t.releaseHoldHistory?.[`full_refund_${refundId}`]).toMatchObject({ outcome: 'closed_full_refund', hold: { source: svc.DONATION_ACCOUNTING_HOLD_SOURCE } })
    await backdate(d.ptxId); await release({ limit: 500 })
    expect((await db.collection('settlementReleases').where('transactionId', '==', d.ptxId).get()).size).toBe(0)
  }, T)

  it('3 · bounded: transient failures reach needs_review after MAX attempts; a permanent failure goes there at once; both alerted in health and never auto-applied', async () => {
    const uid = org()
    const d = await donation(uid, 1_000)
    const refundId = `rfnd_drr_m_${P}`
    const h0 = (await health()).financial
    fx.failApply = 100
    await refundProcessed(`evt_drr_m_${P}`, d, refundId, 400)
    for (let i = 2; i <= svc.DONATION_REFUND_ACCOUNTING_MAX_ATTEMPTS; i++) {
      await dueNow(refundId)
      await svc.retryDonationRefundAccounting(500)
      expect((await rec(refundId)).accountingRecovery.attempts).toBe(i)
    }
    expect(await rec(refundId)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'needs_review', attempts: svc.DONATION_REFUND_ACCOUNTING_MAX_ATTEMPTS } })
    expect((await rec(refundId)).accountingRecovery.nextAttemptAt).toBeUndefined()
    fx.failApply = 0
    await svc.retryDonationRefundAccounting(500)                            // terminal: not picked up again
    expect((await rec(refundId)).status).toBe('pending')
    expect(await wallet(uid)).toMatchObject({ pending: 1_000 })
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')                 // still held for the human

    // a PERMANENT failure (unknown release state) goes straight to needs_review on the first attempt
    const d2 = await donation(uid, 600)
    await db.doc(`platformTransactions/${d2.ptxId}`).update({ releaseStatus: FS.FieldValue.delete() })
    const r2 = `rfnd_drr_p_${P}`
    await refundProcessed(`evt_drr_p_${P}`, d2, r2, 600)
    expect(await rec(r2)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'needs_review', attempts: 1 } })
    expect(String((await rec(r2)).accountingRecovery.lastError)).toMatch(/^REVERSAL_BUCKET_UNKNOWN/)
    const h1 = (await health()).financial
    expect(h1.donationRefundAccountingNeedsReview).toBe(h0.donationRefundAccountingNeedsReview + 2)
    expect(h1.donationRefundAccountingRetrying).toBe(h0.donationRefundAccountingRetrying)
  }, T)

  it('4 · nothing durable could be written (refund-record failure) ⇒ 500 and the event is released; the redelivery is re-claimed once and applies; a third delivery is a duplicate', async () => {
    const uid = org()
    const d = await donation(uid, 1_000)
    const refundId = `rfnd_drr_e_${P}`, ev = `evt_drr_e_${P}`
    fx.failRefundRead = 1
    expect((await refundProcessed(ev, d, refundId, 300)).status).toBe(500)
    expect(await evt(ev)).toMatchObject({ result: 'failed', retryable: true })
    expect((await db.doc(`donationRefunds/${refundId}`).get()).exists).toBe(false)
    expect((await refundProcessed(ev, d, refundId, 300)).status).toBe(200)  // Razorpay redelivers
    expect(await evt(ev)).toMatchObject({ result: 'processed', retryable: false, attempts: 1 })
    expect(await rec(refundId)).toMatchObject({ status: 'processed', ledgerReversedPaise: 300 })
    expect((await refundProcessed(ev, d, refundId, 300)).status).toBe(200)
    expect(await reversalRows(d.id)).toBe(1)
    expect(await wallet(uid)).toMatchObject({ pending: 700 })
  }, T)

  it('5 · organizer path: Razorpay says processed but accounting fails ⇒ same durable state (api evidence); the later webhook completes it once; the drain then has nothing to do', async () => {
    const uid = org()
    const d = await donation(uid, 1_000)
    const calls0 = fx.refundCalls
    fx.failApply = 1
    const res = await organizerRefund(d.id, 400)
    expect(res.status).toBe(200)                                            // the refund itself happened
    const refundId = fx.gatewayRefunds.at(-1)!.id
    expect(fx.refundCalls).toBe(calls0 + 1)
    expect(await rec(refundId)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'retry', attempts: 1, gatewayEvidence: 'api_refund_processed', lastSource: 'organizer' } })
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
    expect(await refundProcessed(`evt_drr_o_${P}`, d, refundId, 400)).toMatchObject({ status: 200 })
    expect(await rec(refundId)).toMatchObject({ status: 'processed', accountingRecovery: { state: 'completed' } })
    expect(await svc.retryDonationRefundAccounting(500)).toMatchObject({ completed: 0 })
    expect(await reversalRows(d.id)).toBe(1)
    expect(await wallet(uid)).toMatchObject({ pending: 600 })
    expect(fx.refundCalls).toBe(calls0 + 1)                                 // nothing retried at the gateway
  }, T)

  it('6 · ambiguous: a refund the gateway has NOT reported processed is never accounted (awaiting_gateway, visible when stale); a retry record without trusted evidence escalates instead of applying', async () => {
    const uid = org()
    const d = await donation(uid, 1_000)
    fx.gatewayStatus = 'pending'
    const h0 = (await health()).financial.donationRefundsAwaitingGatewayStale
    expect((await organizerRefund(d.id, 250)).status).toBe(200)
    const refundId = fx.gatewayRefunds.at(-1)!.id
    expect(await rec(refundId)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'awaiting_gateway', gatewayStatus: 'pending' } })
    await svc.retryDonationRefundAccounting(500)
    expect((await rec(refundId)).status).toBe('pending')                    // never accounted speculatively
    expect(await wallet(uid)).toMatchObject({ pending: 1_000 })
    await db.doc(`donationRefunds/${refundId}`).update({ createdAt: FS.Timestamp.fromMillis(Date.now() - 25 * 3_600_000) })
    expect((await health()).financial.donationRefundsAwaitingGatewayStale).toBe(h0 + 1)
    // the gateway reports it processed: accounted once, recovery completed
    await refundProcessed(`evt_drr_g_${P}`, d, refundId, 250)
    expect(await rec(refundId)).toMatchObject({ status: 'processed', accountingRecovery: { state: 'completed' } })
    expect(await wallet(uid)).toMatchObject({ pending: 750 })

    // a `retry` record carrying NO trusted gateway evidence is escalated, never applied
    const d2 = await donation(uid, 500)
    const r2 = `rfnd_drr_x_${P}`
    await svc.ensureRefundRecord({ refundId: r2, donationId: d2.id, campaignId: `drr-camp-${P}`, campaignSlug: `drr-camp-${P}`, organizerUid: uid, razorpayPaymentId: d2.paymentId, amountPaise: 500, reason: 'test', initiatedBy: 'webhook' })
    await db.doc(`donationRefunds/${r2}`).update({ accountingRecovery: { state: 'retry', attempts: 0, gatewayEvidence: null, nextAttemptAt: FS.Timestamp.fromMillis(Date.now() - 1_000) } })
    await svc.retryDonationRefundAccounting(500)
    expect(await rec(r2)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'needs_review' } })
    expect(String((await rec(r2)).accountingRecovery.lastError)).toMatch(/^GATEWAY_EVIDENCE_MISSING/)
    expect(await reversalRows(d2.id)).toBe(0)
    expect(await wallet(uid)).toMatchObject({ pending: 1_250 })
  }, T)
})
