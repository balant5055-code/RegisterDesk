// Phase 3.1 — G9 / refund-outcome INTERRUPTION safety, on REAL Firestore through the real webhook, the
// real refund route, the real sweep + drain and the real G9 resolution.
//
// One transaction now links the attempt, writes the refund record and (for a processed refund) an
// ACCOUNTING-PENDING marker carrying the trusted gateway evidence. A process that dies at any point after it
// leaves something the existing drain finishes exactly once; one that dies before it changed nothing durable
// (the webhook's claim is re-claimable once stale; the route's attempt stays open and held for the sweep).
// "Crash after step N" is reproduced by running the real code exactly up to step N.

import crypto from 'crypto'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const WHSEC = 'oro_webhook_secret'
const SUPER = `oro-super-${P}`
const MIN = 60_000

const gw = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'lost' | 'timeout',
  status: 'processed' as string,
  calls: 0,
  refunds: [] as Array<{ id: string; payment_id: string; amount: number; status: string; notes: Record<string, string> }>,
}))
const fx = vi.hoisted(() => ({ failOutcome: 0 }))
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), RAZORPAY_WEBHOOK_SECRET: WHSEC }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_oro', RAZORPAY_KEY_SECRET: 'oro',
  razorpay: { payments: {
    refund: async (paymentId: string, o: { amount: number; notes?: Record<string, string> }) => {
      gw.calls++
      if (gw.mode === 'timeout') throw new Error('timeout (simulated)')
      const r = { id: `rfnd_oro_${P}_${gw.calls}`, payment_id: paymentId, amount: o.amount, status: gw.status, notes: o.notes ?? {} }
      gw.refunds.push(r)
      if (gw.mode === 'lost') throw new Error('socket hang up (simulated: created, response lost)')
      return { id: r.id, status: r.status }
    },
    fetchMultipleRefund: async (paymentId: string) => {
      const items = gw.refunds.filter(r => r.payment_id === paymentId)
      return { entity: 'collection', count: items.length, items }
    },
  } },
}))
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async (hd: string | null) => (hd === 'Bearer super' ? SUPER : null),
  resolveSuperAdminUid: async (hd: string | null) => (hd === 'Bearer super' ? SUPER : null),
  legacyAdminClaimOnly: async () => false,
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined, captureWebhookError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('Phase 3.1 · refund outcome interruption safety', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let svc: typeof import('@/lib/donations/refundService')
  let webhook: (r: NextRequest) => Promise<Response>
  let orgRefund: (r: NextRequest, c: { params: Promise<{ donationId: string }> }) => Promise<Response>
  let n = 0

  const don = async (id: string) => (await db.doc(`donations/${id}`).get()).data() ?? {}
  const rec = async (id: string) => (await db.doc(`donationRefunds/${id}`).get()).data() ?? {}
  const ptx = async (id: string) => (await db.doc(`platformTransactions/${id}`).get()).data() ?? {}
  const wallet = async (uid: string) => { const w = (await db.doc(`organizerRevenueWallets/${uid}`).get()).data() ?? {}; return { pending: w.pendingPaise as number, available: w.availablePaise as number } }
  const reversalRows = async (donationId: string) => (await db.collection('platformTransactions').where('parentTransactionId', '==', `ptx_${donationId}`).get()).size
  const due = (refundId: string) => db.doc(`donationRefunds/${refundId}`).update({ 'accountingRecovery.nextAttemptAt': FS.Timestamp.fromMillis(Date.now() - 1_000) })

  async function donation(gross = 1_000) {
    const uid = `oro-org-${P}-${++n}`
    const id = `oro-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: 'donation', category: 'donation', organizerUid: uid, entityId: 'oro-camp', entityType: 'campaign', sourceId: id, sourceType: 'donation',
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: gross, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0,
      netSettlementPaise: gross, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: gross, feesTotalPaise: 0, netSettlementPaise: gross } as never)
    await db.doc(`donations/${id}`).set({ amountPaise: gross, campaignId: 'oro-camp', campaignSlug: 'oro-camp', organizerUid: uid, donorEmail: `d${n}@x.test`, donorName: 'D',
      isAnonymous: false, status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: `order_${id}`, razorpayPaymentId: `pay_${id}` })
    return { uid, id, ptxId: `ptx_${id}`, paymentId: `pay_${id}`, orderId: `order_${id}` }
  }
  function refundEvent(event: 'refund.processed' | 'refund.failed', eventId: string, d: { id: string; paymentId: string; orderId: string }, r: { id: string; amount: number; notes?: Record<string, string> }) {
    const body = JSON.stringify({ id: eventId, event, payload: {
      refund:  { entity: { id: r.id, payment_id: d.paymentId, amount: r.amount, status: event === 'refund.failed' ? 'failed' : 'processed', notes: r.notes ?? {} } },
      payment: { entity: { id: d.paymentId, order_id: d.orderId, amount: r.amount, currency: 'INR', status: 'captured', notes: { donationId: d.id } } },
    } })
    const sig = crypto.createHmac('sha256', WHSEC).update(body).digest('hex')
    return webhook(new NextRequest('http://x/api/razorpay/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body }))
  }
  const organizerRefund = (donationId: string, amountPaise: number) => orgRefund(
    new NextRequest(`http://x/api/organizer/donations/${donationId}/refund`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer super' }, body: JSON.stringify({ amountPaise, reason: 'donor asked for a refund' }) }),
    { params: Promise.resolve({ donationId }) },
  )

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    credit = (await import('@/lib/firebase/firestore/platformTransactions')).recordPlatformTransactionAndCredit
    svc = await import('@/lib/donations/refundService')
    ;({ POST: webhook } = await import('@/app/api/razorpay/webhook/route'))
    ;({ POST: orgRefund } = await import('@/app/api/organizer/donations/[donationId]/refund/route') as never)
  }, T)
  beforeEach(() => {
    vi.restoreAllMocks()
    gw.mode = 'ok'; gw.status = 'processed'; fx.failOutcome = 0
    // a failure inside the OUTCOME transaction (the only transaction reading donation + refund record + ledger row together)
    const orig = db.runTransaction.bind(db)
    vi.spyOn(db, 'runTransaction').mockImplementation((async (fn: (tx: FirebaseFirestore.Transaction) => unknown, opts?: never) =>
      orig(async tx => {
        const get = tx.get.bind(tx) as (q: unknown) => unknown
        const seen = new Set<string>()
        ;(tx as unknown as { get: unknown }).get = (q: { path?: string }) => {
          const path = typeof q?.path === 'string' ? q.path : ''
          if (path) seen.add(path.split('/')[0])
          if (fx.failOutcome > 0 && path.startsWith('platformTransactions/') && seen.has('donationRefunds') && seen.has('donations')) { fx.failOutcome--; return Promise.reject(new Error('simulated outcome-transaction failure')) }   // async, like a real failed read
          return get(q)
        }
        return fn(tx)
      }, opts)) as never)
  })

  it('1 · crash AFTER the outcome is recorded, BEFORE accounting (every source): the drain finishes it exactly once from the recorded evidence', async () => {
    for (const [source, evidence] of [['organizer', 'api_refund_processed'], ['webhook', 'webhook_refund_processed'], ['recovery', 'api_refund_processed']] as const) {
      const d = await donation()
      const refundId = `rfnd_oro_crash_${source}_${P}`
      const r = await svc.recordDonationRefundGatewayOutcome({ donationId: d.id, refundId, paymentId: d.paymentId, amountPaise: 400, gatewayStatus: 'processed', evidence, source, initiatedBy: source === 'webhook' ? 'webhook' : SUPER })
      expect(r).toMatchObject({ record: 'created', kind: 'processed' })
      // …the process dies here. The record is discoverable as accounting-pending, with its evidence:
      expect(await rec(refundId)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'retry', attempts: 0, gatewayEvidence: evidence } })
      expect(await reversalRows(d.id)).toBe(0)
      expect((await svc.retryDonationRefundAccounting(500)).completed).toBe(0)                 // within the grace: left alone
      await due(refundId)
      await Promise.all([svc.retryDonationRefundAccounting(500), svc.retryDonationRefundAccounting(500)])
      expect(await rec(refundId)).toMatchObject({ status: 'processed', ledgerReversedPaise: 400, accountingRecovery: { state: 'completed' } })
      expect(await reversalRows(d.id)).toBe(1)
      expect(await wallet(d.uid)).toMatchObject({ pending: 600 })
    }
  }, T)

  it('2 · crash BEFORE the outcome is recorded (route): nothing durable but the open attempt — held, then linked by the sweep from Razorpay and accounted once; no second gateway refund', async () => {
    const d = await donation()
    const calls0 = gw.calls
    fx.failOutcome = 1
    const res = await organizerRefund(d.id, 300).catch(e => ({ status: 500, e }))
    expect([500]).toContain((res as { status: number }).status)
    const created = gw.refunds.at(-1)!
    expect(created.notes.attemptId).toMatch(/^att_/)
    expect((await db.doc(`donationRefunds/${created.id}`).get()).exists).toBe(false)           // the refund record was never written
    const [[attemptId, a]] = Object.entries((await don(d.id)).refundAttempts ?? {}) as Array<[string, Record<string, unknown>]>
    expect(a.status).toBe('submitting')                                                         // still open …
    expect(await ptx(d.ptxId)).toMatchObject({ releaseStatus: 'held', releaseHold: { attemptIds: [attemptId] } })   // … and held
    await db.doc(`donations/${d.id}`).update({ [`refundAttempts.${attemptId}.startedAt`]: FS.Timestamp.fromMillis(Date.now() - 3 * MIN) })
    await Promise.all([svc.reconcileDonationRefundAttempts(500), svc.reconcileDonationRefundAttempts(500)])
    expect((await don(d.id)).refundAttempts[attemptId]).toMatchObject({ status: 'linked', refundId: created.id })
    expect(await rec(created.id)).toMatchObject({ status: 'processed', initiatedBy: SUPER })
    expect(await reversalRows(d.id)).toBe(1)
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 0, refundedAmountPaise: 300, hasOpenRefundAttempt: false })
    expect(gw.calls).toBe(calls0 + 1)
  }, T)

  it('3 · webhook crash before ANY durable write: a stale "processing" claim is re-claimed once and processed; a fresh one stays a duplicate', async () => {
    const d = await donation()
    const r = { id: `rfnd_oro_stale_${P}`, amount: 250 }
    const ev = `evt_oro_stale_${P}`
    await db.doc(`paymentEvents/${ev}`).set({ id: ev, eventType: 'refund.processed', donationId: d.id, paymentId: d.paymentId, orderId: d.orderId, rawPayload: {}, receivedAt: FS.Timestamp.fromMillis(Date.now() - 20 * MIN), result: 'processing', resultDetail: '' })
    const fresh = `evt_oro_fresh_${P}`
    await db.doc(`paymentEvents/${fresh}`).set({ id: fresh, eventType: 'refund.processed', donationId: d.id, paymentId: d.paymentId, orderId: d.orderId, rawPayload: {}, receivedAt: FS.Timestamp.now(), result: 'processing', resultDetail: '' })
    expect((await refundEvent('refund.processed', fresh, d, r)).status).toBe(200)               // in flight elsewhere: a duplicate
    expect((await db.doc(`donationRefunds/${r.id}`).get()).exists).toBe(false)
    const deliveries = await Promise.all([0, 1].map(() => refundEvent('refund.processed', ev, d, r)))   // Razorpay redelivers (twice, concurrently)
    expect(deliveries.every(x => x.status === 200)).toBe(true)
    expect(await rec(r.id)).toMatchObject({ status: 'processed', ledgerReversedPaise: 250 })
    expect(await reversalRows(d.id)).toBe(1)
    expect((await db.doc(`paymentEvents/${ev}`).get()).data()).toMatchObject({ result: 'processed' })
  }, T)

  it('4 · duplicate + concurrent recovery: webhook redeliveries, the drain and the sweep together account it ONCE', async () => {
    const d = await donation()
    gw.mode = 'lost'
    await organizerRefund(d.id, 500)                                                           // created at Razorpay, response lost: attempt unknown
    const created = gw.refunds.at(-1)!
    const [[attemptId]] = Object.entries((await don(d.id)).refundAttempts ?? {})
    await db.doc(`donations/${d.id}`).update({ [`refundAttempts.${attemptId}.startedAt`]: FS.Timestamp.fromMillis(Date.now() - 3 * MIN) })
    await Promise.all([
      refundEvent('refund.processed', `evt_oro_c1_${P}`, d, created),
      refundEvent('refund.processed', `evt_oro_c2_${P}`, d, created),
      svc.reconcileDonationRefundAttempts(500),
      svc.retryDonationRefundAccounting(500),
      svc.reconcileDonationRefundAttempts(500),
    ])
    await due(created.id).catch(() => undefined)
    await svc.retryDonationRefundAccounting(500)
    expect(await rec(created.id)).toMatchObject({ status: 'processed', ledgerReversedPaise: 500 })
    expect(await reversalRows(d.id)).toBe(1)
    expect(await don(d.id)).toMatchObject({ refundedAmountPaise: 500, pendingRefundPaise: 0, hasOpenRefundAttempt: false })
    expect((await don(d.id)).refundAttempts[attemptId]).toMatchObject({ status: 'linked', refundId: created.id })
  }, T)

  it('5 · a FAILED refund is never accounted (drain, late success); contradictions stay held for review', async () => {
    const d = await donation()
    const f = `rfnd_oro_failed_${P}`
    await svc.recordDonationRefundGatewayOutcome({ donationId: d.id, refundId: f, paymentId: d.paymentId, amountPaise: 300, gatewayStatus: 'failed', evidence: 'webhook_refund_processed', source: 'webhook' })
    expect(await rec(f)).toMatchObject({ status: 'failed', accountingRecovery: { state: 'gateway_failed' } })
    await svc.retryDonationRefundAccounting(500)
    expect(await svc.recordDonationRefundGatewayOutcome({ donationId: d.id, refundId: f, paymentId: d.paymentId, amountPaise: 300, gatewayStatus: 'processed', evidence: 'webhook_refund_processed', source: 'webhook' }))
      .toMatchObject({ record: 'conflict' })
    expect(await rec(f)).toMatchObject({ status: 'failed', accountingRecovery: { state: 'needs_review', conflict: 'PROCESSED_EVENT_AFTER_FAILED' } })
    expect(await reversalRows(d.id)).toBe(0)
    // processed then (crash) then failed: the accounting-pending refund is NOT overwritten; held for review
    const p = `rfnd_oro_pf_${P}`
    await svc.recordDonationRefundGatewayOutcome({ donationId: d.id, refundId: p, paymentId: d.paymentId, amountPaise: 200, gatewayStatus: 'processed', evidence: 'webhook_refund_processed', source: 'webhook' })
    expect(await svc.recordDonationRefundGatewayOutcome({ donationId: d.id, refundId: p, paymentId: d.paymentId, amountPaise: 200, gatewayStatus: 'failed', evidence: 'webhook_refund_processed', source: 'webhook' }))
      .toMatchObject({ record: 'conflict' })
    expect(await rec(p)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'needs_review', conflict: 'FAILED_EVENT_AFTER_SUCCESS_EVIDENCE' } })
    await due(p).catch(() => undefined)
    await svc.retryDonationRefundAccounting(500)                                               // needs_review is never drained
    expect(await reversalRows(d.id)).toBe(0)
    expect(await wallet(d.uid)).toMatchObject({ pending: 1_000 })
  }, T)

  it('6 · missing webhook entirely: the G9 resolution links from Razorpay and a crash before accounting is still finished by the drain', async () => {
    const d = await donation()
    // release the donation first (G9 is for released donations)
    await db.doc(`platformTransactions/${d.ptxId}`).update({ paidAt: new Date(Date.now() - 10 * 86_400_000) })
    await (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds({ limit: 500 })
    gw.mode = 'lost'
    await organizerRefund(d.id, 350)
    const created = gw.refunds.at(-1)!
    const [[attemptId]] = Object.entries((await don(d.id)).refundAttempts ?? {})
    await db.doc(`donations/${d.id}`).update({ [`refundAttempts.${attemptId}.startedAt`]: FS.Timestamp.fromMillis(Date.now() - 16 * MIN) })
    // the G9 step's outcome transaction runs; simulate the process dying right after it (accounting never runs)
    const r = await svc.recordDonationRefundGatewayOutcome({ donationId: d.id, refundId: created.id, paymentId: d.paymentId, amountPaise: 350, gatewayStatus: 'processed', evidence: 'api_refund_processed', source: 'recovery', attemptId, reason: 'organizer_initiated' })
    expect(r).toMatchObject({ record: 'created', attempt: 'linked' })
    await due(created.id)
    await svc.retryDonationRefundAccounting(500)
    expect(await rec(created.id)).toMatchObject({ status: 'processed', initiatedBy: SUPER, ledgerReversedPaise: 350 })
    expect(await wallet(d.uid)).toMatchObject({ pending: 0, available: 650 })                   // released ⇒ from available
    expect(await don(d.id)).toMatchObject({ refundedAmountPaise: 350, pendingRefundPaise: 0, hasOpenRefundAttempt: false })
  }, T)
})
