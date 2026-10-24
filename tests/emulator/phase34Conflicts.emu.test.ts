// Phase 3.4 — resolving CONTRADICTORY donation refund outcomes on authoritative evidence, on REAL Firestore,
// through the real donation webhook, the real Super Admin routes (refund reviews, refund holds), the real
// accounting, drain and release job. The gateway stub only LISTS refunds (read-only): no test path creates or
// retries a gateway refund.
//
//   every conflict type in its arrival order (failed→processed; processed→failed before and after accounting)
//   agreeing evidence closes it (audited, idempotent, concurrent-safe); disagreeing / ambiguous evidence never does
//   the compensating ledger entry: exact, same bucket, once; refused for full refunds and insolvent reversals
import crypto from 'crypto'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const WHSEC = 'p34_webhook_secret'
const SUPER = `p34-super-${P}`
const MIN = 60_000

const gw = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'timeout',
  lookup: 'real' as 'real' | 'throw',
  calls: 0,
  refunds: [] as Array<{ id: string; payment_id: string; amount: number; status: string; notes: Record<string, string> }>,
}))
const fx = vi.hoisted(() => ({
  /** Reject this many transactional reads of organizerRevenueWallets/* (the accounting transaction). */
  failApply: 0,
  /** Reject every transactional read of these document paths (a persistent transient fault). */
  failPaths: new Set<string>(),
}))
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), RAZORPAY_WEBHOOK_SECRET: WHSEC }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_p34', RAZORPAY_KEY_SECRET: 'p33',
  razorpay: { payments: {
    refund: async (paymentId: string, o: { amount: number; notes?: Record<string, string> }) => {
      gw.calls++
      if (gw.mode === 'timeout') throw new Error('timeout of 0ms exceeded (simulated: no response)')
      const r = { id: `rfnd_p33_${P}_${gw.calls}`, payment_id: paymentId, amount: o.amount, status: 'processed', notes: o.notes ?? {} }
      gw.refunds.push(r)
      return { id: r.id, status: r.status, amount: r.amount }
    },
    fetchMultipleRefund: async (paymentId: string) => {
      if (gw.lookup === 'throw') throw new Error('lookup unavailable')
      const items = gw.refunds.filter(r => r.payment_id === paymentId)
      return { entity: 'collection', count: items.length, items }
    },
  } },
}))
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async (hd: string | null) => (hd === 'Bearer super' ? SUPER : hd === 'Bearer admin' ? `p34-admin-${process.pid}` : null),
  resolveSuperAdminUid: async (hd: string | null) => (hd === 'Bearer super' ? SUPER : null),
  legacyAdminClaimOnly: async () => false,
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined, captureWebhookError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

type Json = Record<string, unknown>

describeEmu('Phase 3.4 · refund conflict resolution', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let svc: typeof import('@/lib/donations/refundService')
  let reconcileWallet: typeof import('@/lib/reconciliation/wallets').reconcileOneWallet
  let webhook: (r: NextRequest) => Promise<Response>
  let holdsPost: (r: NextRequest) => Promise<Response>
  let reviewsPost: (r: NextRequest) => Promise<Response>
  let n = 0
  let req = 0

  const org = () => `p34-org-${P}-${++n}`
  const wallet = async (uid: string) => {
    const w = (await db.doc(`organizerRevenueWallets/${uid}`).get()).data() ?? {}
    return { pending: w.pendingPaise as number, available: w.availablePaise as number, settled: (w.settledPaise ?? 0) as number }
  }
  const ptx = async (id: string) => (await db.doc(`platformTransactions/${id}`).get()).data() ?? {}
  const don = async (id: string) => (await db.doc(`donations/${id}`).get()).data() ?? {}
  const rec = async (id: string) => (await db.doc(`donationRefunds/${id}`).get()).data() ?? {}
  const reversals = async (donationId: string) => (await db.collection('platformTransactions').where('parentTransactionId', '==', `ptx_${donationId}`).get()).docs.map(d => d.data())
  const reversedNet = async (donationId: string) => (await reversals(donationId)).reduce((s, r) => s - Number(r.netSettlementPaise), 0)
  const clawbacksOf = async (uid: string) => (await db.collection('walletClawbacks').where('organizerUid', '==', uid).get()).docs.map(d => ({ id: d.id, ...d.data() })) as Array<Json & { id: string }>
  const reconClean = async (uid: string) => expect(await reconcileWallet(uid, (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!)).toEqual([])
  const backdate = (id: string, days = 10) => db.doc(`platformTransactions/${id}`).update({ paidAt: new Date(Date.now() - days * 86_400_000) })
  const audits = async (entityId: string, action: string) => (await db.collection('adminAuditLogs').where('entityId', '==', entityId).where('action', '==', action).get()).docs.map(d => d.data())

  /** A credited payment with an explicit gross / net (fees = gross − net). */
  async function payment(uid: string, gross: number, net: number, kind: 'donation' | 'registration', id = `p34-${P}-${++n}`) {
    await credit({
      id: `ptx_${id}`, type: kind === 'donation' ? 'donation' : 'event_registration', category: kind === 'donation' ? 'donation' : 'ticketed',
      organizerUid: uid, entityId: `p33-camp-${P}`, entityType: kind === 'donation' ? 'campaign' : 'event', sourceId: id, sourceType: kind,
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: gross, platformFeeBasePaise: gross - net, platformFeeGstPaise: 0, platformFeeTotalPaise: gross - net,
      gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x',
      currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: gross, feesTotalPaise: gross - net, netSettlementPaise: net } as never)
    return { id, ptxId: `ptx_${id}`, paymentId: `pay_${id}`, orderId: `order_${id}` }
  }
  async function donation(uid: string, gross: number, net = gross, id?: string) {
    const p = await payment(uid, gross, net, 'donation', id)
    await db.doc(`donations/${p.id}`).set({
      amountPaise: gross, campaignId: `p33-camp-${P}`, campaignSlug: `p33-camp-${P}`, organizerUid: uid, donorEmail: `d${n}@x.test`, donorName: 'D',
      isAnonymous: false, status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: p.orderId, razorpayPaymentId: p.paymentId,
    })
    return p
  }
  /** A signed refund webhook (the donation webhook's real payload shape). */
  function refundEvent(event: 'refund.processed' | 'refund.failed', eventId: string, d: { id: string; paymentId: string; orderId: string }, r: { id: string; amount: number; notes?: Record<string, string> }) {
    const body = JSON.stringify({ id: eventId, event, payload: {
      refund:  { entity: { id: r.id, payment_id: d.paymentId, amount: r.amount, status: event === 'refund.failed' ? 'failed' : 'processed', notes: r.notes ?? {} } },
      payment: { entity: { id: d.paymentId, order_id: d.orderId, amount: r.amount, currency: 'INR', status: 'captured', notes: { donationId: d.id } } },
    } })
    const sig = crypto.createHmac('sha256', WHSEC).update(body).digest('hex')
    return webhook(new NextRequest('http://x/api/razorpay/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body }))
  }
  const post = async (handler: (r: NextRequest) => Promise<Response>, url: string, body: Json, auth = 'Bearer super') => {
    const r = await handler(new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(body) }))
    return { status: r.status, body: await r.json() as Json }
  }
  const lift = (ptxId: string, refundIds: string[]) => post(holdsPost, 'http://x/api/admin/finance/refund-holds',
    { ptxId, outcome: 'lift_hold_no_refund', reason: 'reconciled against the Razorpay dashboard', confirm: true, expectedRefundIds: refundIds, requestId: `p34req${P}x${++req}` })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ recordPlatformTransactionAndCredit: credit } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    svc = await import('@/lib/donations/refundService')
    ;({ reconcileOneWallet: reconcileWallet } = await import('@/lib/reconciliation/wallets'))
    ;({ POST: webhook } = await import('@/app/api/razorpay/webhook/route'))
    ;({ POST: holdsPost } = await import('@/app/api/admin/finance/refund-holds/route') as never)
    ;({ POST: reviewsPost } = await import('@/app/api/admin/finance/refund-reviews/route') as never)
  }, T)
  beforeEach(() => {
    vi.restoreAllMocks()
    gw.mode = 'ok'; gw.lookup = 'real'
    fx.failApply = 0; fx.failPaths.clear()
    const orig = db.runTransaction.bind(db)
    vi.spyOn(db, 'runTransaction').mockImplementation((async (fn: (tx: FirebaseFirestore.Transaction) => unknown, opts?: never) =>
      orig(async tx => {
        const read = tx.get.bind(tx) as (q: unknown) => unknown
        ;(tx as unknown as { get: unknown }).get = (q: { path?: string }) => {
          const path = typeof q?.path === 'string' ? q.path : ''
          if (fx.failApply > 0 && path.startsWith('organizerRevenueWallets/')) { fx.failApply--; return Promise.reject(new Error('simulated transient accounting failure')) }
          if (fx.failPaths.has(path)) return Promise.reject(new Error('simulated transient failure'))   // async, like a real failed read
          return read(q)
        }
        return fn(tx)
      }, opts)) as never)
  })

  const resolve = (refundId: string, outcome: string, evidence: Json | undefined, opts: { requestId?: string; auth?: string; confirm?: boolean } = {}) =>
    post(reviewsPost, 'http://x/api/admin/finance/refund-reviews', {
      refundId, action: 'resolve_conflict', outcome, ...(evidence ? { evidence } : {}), reason: 'reconciled against the Razorpay dashboard and settlement report',
      ...(opts.confirm === false ? {} : { confirm: true }), requestId: opts.requestId ?? `p34res${P}x${++req}`,
    }, opts.auth)
  const NO_DEBIT = { source: 'razorpay_settlement_report', reference: 'setl_ref_0001', observation: 'no_refund_debit' }
  const DEBITED = { source: 'bank_statement', reference: 'UTR 4455 6677', observation: 'refund_debited' }
  const listed = (d: { paymentId: string }, id: string, amount: number, status: string, extra: Json = {}) =>
    gw.refunds.push({ id, payment_id: d.paymentId, amount, status, notes: {}, ...extra } as never)
  const failedEvt = (d: { id: string; paymentId: string; orderId: string }, id: string, amount: number, tag = 'f') => refundEvent('refund.failed', `evt_${tag}_${id}`, d, { id, amount })
  const processedEvt = (d: { id: string; paymentId: string; orderId: string }, id: string, amount: number, tag = 'p') => refundEvent('refund.processed', `evt_${tag}_${id}`, d, { id, amount })
  const backdateRefund = (id: string) => db.doc(`donationRefunds/${id}`).update({ createdAt: FS.Timestamp.fromMillis(Date.now() - 20 * MIN) })
  const resolutions = async (id: string) => Object.values((await rec(id)).conflictResolutions ?? {}) as Json[]

  // ═══ PROCESSED_EVENT_AFTER_FAILED — failed first, then processed ═══════════════════════════════════

  it('1 · failed → processed: held, never accounted/released/lifted; Razorpay "failed" + no settlement debit confirms failed (audited, idempotent, concurrent-safe); nothing moves; the hold then lifts on evidence', async () => {
    const uid = org()
    const d = await donation(uid, 2_000)
    const id = `rfnd_p34_1_${P}`
    expect((await failedEvt(d, id, 500)).status).toBe(200)
    expect((await processedEvt(d, id, 500)).status).toBe(200)
    expect((await processedEvt(d, id, 500, 'dup')).status).toBe(200)                 // a duplicate (new event id): still the same conflict
    expect(await rec(id)).toMatchObject({ status: 'failed', accountingRecovery: { state: 'needs_review', conflict: 'PROCESSED_EVENT_AFTER_FAILED' } })
    expect(await ptx(d.ptxId)).toMatchObject({ releaseStatus: 'held', releaseHold: { source: svc.DONATION_OUTCOME_CONFLICT_HOLD_SOURCE } })
    const w0 = await wallet(uid)
    await expect(svc.applyDonationRefundAccounting(id)).rejects.toThrow()
    await backdate(d.ptxId); await release({ limit: 500 })
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
    // authorization / input / no force action
    listed(d, id, 500, 'failed')
    expect((await resolve(id, 'failed', NO_DEBIT, { auth: 'Bearer admin' })).status).toBe(403)
    expect((await resolve(id, 'failed', undefined)).status).toBe(400)
    expect((await resolve(id, 'failed', NO_DEBIT, { confirm: false })).status).toBe(400)
    expect((await resolve(id, 'failed', { ...NO_DEBIT, reference: 'x' })).body).toMatchObject({ code: 'EVIDENCE_REQUIRED' })
    expect((await post(reviewsPost, 'http://x/api/admin/finance/refund-reviews', { refundId: id, action: 'force_resolve', reason: 'just do it please', confirm: true, requestId: `p34force${P}` })).status).toBe(400)
    expect((await post(holdsPost, 'http://x/api/admin/finance/refund-holds', { ptxId: d.ptxId, outcome: 'force_release', reason: 'just do it please', confirm: true, expectedRefundIds: [id], requestId: `p34force${P}h` })).status).toBe(400)
    expect(await rec(id)).toMatchObject({ accountingRecovery: { conflict: 'PROCESSED_EVENT_AFTER_FAILED' } })
    // two Super Admins at once (different requestIds): exactly one decision
    const rids = [`p34c1${P}a`, `p34c1${P}b`]
    const both = await Promise.all(rids.map(r => resolve(id, 'failed', NO_DEBIT, { requestId: r })))
    expect(both.filter(x => x.status === 200)).toHaveLength(1)
    expect(both.find(x => x.status !== 200)!.body.code).toMatch(/^(STATE_CHANGED|NOT_IN_CONFLICT)$/)
    expect(await rec(id)).toMatchObject({ status: 'failed', accountingRecovery: { state: 'gateway_failed' } })
    expect((await rec(id)).accountingRecovery.conflict).toBeUndefined()
    expect(await resolutions(id)).toEqual([expect.objectContaining({ conflict: 'PROCESSED_EVENT_AFTER_FAILED', outcome: 'failed', previousStatus: 'failed', previousState: 'needs_review', gatewayStatus: 'failed', evidenceSource: 'razorpay_settlement_report', evidenceReference: 'setl_ref_0001', by: SUPER })])
    // the same request again: answered from the audit
    const winner = rids[both.findIndex(x => x.status === 200)]
    expect(await resolve(id, 'failed', NO_DEBIT, { requestId: winner })).toMatchObject({ status: 200, body: { duplicate: true, outcome: 'confirmed_failed' } })
    expect(await audits(d.id, 'donation.refund_conflict_resolved')).toHaveLength(1)
    expect(await wallet(uid)).toEqual(w0)                                              // nothing moved
    expect((await reversals(d.id)).length).toBe(0)
    // the conflict hold is NOT removed by the decision — the evidence-gated lift does that
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
    expect((await lift(d.ptxId, [id])).status).toBe(200)
    expect((await ptx(d.ptxId)).releaseStatus).toBe('pending')
    expect(gw.calls).toBe(0)
  }, T)

  it('2 · failed → processed, confirmed PROCESSED by Razorpay + bank debit: accounted exactly once; the reservation released when it failed is never released twice (another open request keeps its own)', async () => {
    const uid = org()
    const d = await donation(uid, 3_000)
    const id = `rfnd_p34_2_${P}`
    expect(await svc.reserveRefund(d.id, 700)).toMatchObject({ ok: true })
    await svc.ensureRefundRecord({ refundId: id, donationId: d.id, campaignId: `p33-camp-${P}`, campaignSlug: `p33-camp-${P}`, organizerUid: uid, razorpayPaymentId: d.paymentId, amountPaise: 700, reason: 'organizer_initiated', initiatedBy: SUPER })
    expect((await failedEvt(d, id, 700)).status).toBe(200)
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 0 })                   // released when it failed
    expect(await rec(id)).toMatchObject({ status: 'failed', reservationReleased: true })
    expect(await svc.reserveRefund(d.id, 200)).toMatchObject({ ok: true })             // another request now holds 200
    expect((await processedEvt(d, id, 700)).status).toBe(200)
    expect(await rec(id)).toMatchObject({ accountingRecovery: { conflict: 'PROCESSED_EVENT_AFTER_FAILED' } })
    // Razorpay says processed but the claim is "failed": refused, nothing written
    listed(d, id, 700, 'processed')
    expect(await resolve(id, 'failed', NO_DEBIT)).toMatchObject({ status: 409, body: { code: 'GATEWAY_DISAGREES' } })
    const r = await resolve(id, 'processed', DEBITED)
    expect(r).toMatchObject({ status: 200, body: { outcome: 'confirmed_processed', detail: { accounted: true, reversedPaise: 700 } } })
    expect(await rec(id)).toMatchObject({ status: 'processed', ledgerReversedPaise: 700, accountingRecovery: { state: 'completed' } })
    expect(await don(d.id)).toMatchObject({ refundedAmountPaise: 700, pendingRefundPaise: 200 })   // the other reservation is untouched
    expect(await reversedNet(d.id)).toBe(700)
    expect(await wallet(uid)).toMatchObject({ pending: 2_300 })
    // a redelivery and a direct re-apply add nothing
    expect((await processedEvt(d, id, 700, 'again')).status).toBe(200)
    expect(await svc.applyDonationRefundAccounting(id)).toMatchObject({ applied: false })
    expect(await reversedNet(d.id)).toBe(700)
    await reconClean(uid)
  }, T)

  // ═══ FAILED_EVENT_AFTER_SUCCESS_EVIDENCE — processed (not yet accounted), then failed ═══════════════

  it('3 · processed (accounting deferred) → failed: reservation and hold kept; confirmed FAILED (PD-2 age) releases only the owned reservation; confirmed PROCESSED accounts it once', async () => {
    const uid = org()
    // (a) confirmed failed
    const d = await donation(uid, 2_000)
    const id = `rfnd_p34_3a_${P}`
    expect(await svc.reserveRefund(d.id, 600)).toMatchObject({ ok: true })
    await svc.ensureRefundRecord({ refundId: id, donationId: d.id, campaignId: `p33-camp-${P}`, campaignSlug: `p33-camp-${P}`, organizerUid: uid, razorpayPaymentId: d.paymentId, amountPaise: 600, reason: 'organizer_initiated', initiatedBy: SUPER })
    fx.failApply = 1
    expect((await processedEvt(d, id, 600)).status).toBe(200)
    expect(await rec(id)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'retry', gatewayEvidence: 'webhook_refund_processed' } })
    expect((await failedEvt(d, id, 600)).status).toBe(200)
    expect((await failedEvt(d, id, 600, 'dup')).status).toBe(200)
    expect(await rec(id)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'needs_review', conflict: 'FAILED_EVENT_AFTER_SUCCESS_EVIDENCE' } })
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 600 })                 // kept while contradictory
    await svc.retryDonationRefundAccounting(500)
    expect((await reversals(d.id)).length).toBe(0)
    listed(d, id, 600, 'failed')
    expect(await resolve(id, 'failed', NO_DEBIT)).toMatchObject({ status: 409, body: { code: 'TOO_RECENT' } })
    await backdateRefund(id)
    expect(await resolve(id, 'failed', NO_DEBIT)).toMatchObject({ status: 200, body: { outcome: 'confirmed_failed', detail: { reservationFreedPaise: 600 } } })
    expect(await rec(id)).toMatchObject({ status: 'failed', reservationReleased: true, accountingRecovery: { state: 'gateway_failed' } })
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 0, refundedAmountPaise: 0 })
    expect(await wallet(uid)).toMatchObject({ pending: 2_000 })
    // (b) confirmed processed
    const d2 = await donation(uid, 1_000)
    const id2 = `rfnd_p34_3b_${P}`
    fx.failApply = 1
    expect((await processedEvt(d2, id2, 400)).status).toBe(200)
    expect((await failedEvt(d2, id2, 400)).status).toBe(200)
    listed(d2, id2, 400, 'processed')
    expect(await resolve(id2, 'processed', DEBITED)).toMatchObject({ status: 200, body: { outcome: 'confirmed_processed', detail: { accounted: true } } })
    expect(await rec(id2)).toMatchObject({ status: 'processed', ledgerReversedPaise: 400 })
    expect(await reversedNet(d2.id)).toBe(400)
    await reconClean(uid)
  }, T)

  // ═══ FAILED_EVENT_AFTER_PROCESSED — accounted, then failed ════════════════════════════════════════

  it('4 · accounted → failed, confirmed failed with NO money out: an exact, idempotent compensating entry restores the SAME bucket (unreleased → pending); history is kept; buckets reconcile; later refunds stay exact', async () => {
    const uid = org()
    const d = await donation(uid, 10_000, 9_500)
    const id = `rfnd_p34_4_${P}`
    expect((await processedEvt(d, id, 4_000)).status).toBe(200)
    expect(await rec(id)).toMatchObject({ status: 'processed', ledgerReversedPaise: 3_800 })
    expect(await wallet(uid)).toMatchObject({ pending: 5_700 })
    expect((await failedEvt(d, id, 4_000)).status).toBe(200)
    expect(await rec(id)).toMatchObject({ status: 'processed', accountingRecovery: { state: 'needs_review', conflict: 'FAILED_EVENT_AFTER_PROCESSED' } })
    expect(await svc.applyDonationRefundAccounting(id)).toMatchObject({ applied: false })   // never re-accounted
    const reversalBefore = await ptx(`ptx_refund_${id}`)
    listed(d, id, 4_000, 'failed')
    const rid = `p34comp${P}a`
    const r = await resolve(id, 'failed', NO_DEBIT, { requestId: rid })
    expect(r).toMatchObject({ status: 200, body: { outcome: 'compensated', detail: { creditedPaise: 3_800, bucket: 'pending', ledgerId: `ptx_refundcomp_${id}` } } })
    expect(await wallet(uid)).toMatchObject({ pending: 9_500, available: 0 })           // exactly what the reversal debited
    const comp = await ptx(`ptx_refundcomp_${id}`)
    expect(comp).toMatchObject({ netSettlementPaise: 3_800, grossAmountPaise: 4_000, parentTransactionId: d.ptxId, compensatesTransactionId: `ptx_refund_${id}`, entryType: 'refund_reversal_compensation', refundId: id })
    expect(await ptx(`ptx_refund_${id}`)).toEqual(reversalBefore)                       // the reversal row is never rewritten
    expect(await reversedNet(d.id)).toBe(0)
    expect(await don(d.id)).toMatchObject({ refundedAmountPaise: 0, status: 'successful' })
    expect(await rec(id)).toMatchObject({ status: 'failed', ledgerReversedPaise: 3_800, accountingRecovery: { state: 'gateway_failed' },
      compensation: { ledgerId: `ptx_refundcomp_${id}`, creditedPaise: 3_800, bucket: 'pending', requestId: rid } })
    expect((await rec(id)).processedAt).toBeTruthy()                                    // the original accounting evidence is kept
    expect(await audits(d.id, 'donation.refund_reversal_compensated')).toHaveLength(1)
    await reconClean(uid)
    // duplicate (same requestId), a second decision, redelivered events: no second credit
    expect(await resolve(id, 'failed', NO_DEBIT, { requestId: rid })).toMatchObject({ status: 200, body: { duplicate: true, outcome: 'compensated' } })
    expect(await resolve(id, 'failed', NO_DEBIT)).toMatchObject({ status: 409, body: { code: 'NOT_IN_CONFLICT' } })
    expect((await failedEvt(d, id, 4_000, 'again')).status).toBe(200)
    expect(await wallet(uid)).toMatchObject({ pending: 9_500 })
    // a later "processed" contradicts the decision: re-flagged, never re-accounted, never auto-resolved
    expect((await processedEvt(d, id, 4_000, 'late')).status).toBe(200)
    expect(await rec(id)).toMatchObject({ status: 'failed', accountingRecovery: { conflict: 'PROCESSED_EVENT_AFTER_FAILED' } })
    await expect(svc.applyDonationRefundAccounting(id)).rejects.toThrow(/^REFUND_(FAILED_AT_GATEWAY|OUTCOME_CONFLICT|COMPENSATED)/)   // refused at the first gate it meets
    gw.refunds.find(x => x.id === id)!.status = 'processed'
    expect(await resolve(id, 'processed', DEBITED)).toMatchObject({ status: 409, body: { code: 'COMPENSATION_UNSUPPORTED', detail: { why: 'already_compensated' } } })
    expect(await wallet(uid)).toMatchObject({ pending: 9_500 })
    // a NEW refund of the whole gross afterwards reverses exactly the TRUE remainder (signed cumulative: the
    // compensated reversal no longer counts) — 9,500, not 9,500 − 3,800 − 3,800
    const id2 = `rfnd_p34_4b_${P}`
    expect((await processedEvt(d, id2, 10_000)).status).toBe(200)
    expect(await rec(id2)).toMatchObject({ ledgerReversedPaise: 9_500, isFullRefund: true })
    expect(await reversedNet(d.id)).toBe(9_500)
    expect(await wallet(uid)).toMatchObject({ pending: 0 })
    await reconClean(uid)
  }, T)

  it('5 · accounted → failed on a RELEASED donation: compensation credits AVAILABLE (the bucket the reversal debited); concurrent decisions compensate once', async () => {
    const uid = org()
    const d = await donation(uid, 5_000)
    await backdate(d.ptxId); await release({ limit: 500 })
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 5_000 })
    const id = `rfnd_p34_5_${P}`
    expect((await processedEvt(d, id, 2_000)).status).toBe(200)
    expect(await wallet(uid)).toMatchObject({ available: 3_000 })
    expect((await failedEvt(d, id, 2_000)).status).toBe(200)
    listed(d, id, 2_000, 'failed')
    const both = await Promise.all([resolve(id, 'failed', NO_DEBIT), resolve(id, 'failed', NO_DEBIT)])
    expect(both.filter(x => x.status === 200)).toHaveLength(1)
    expect(both.find(x => x.status === 200)!.body).toMatchObject({ outcome: 'compensated', detail: { bucket: 'available', creditedPaise: 2_000 } })
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 5_000 })            // credited once; never made available twice
    expect((await db.collection('platformTransactions').where('compensatesTransactionId', '==', `ptx_refund_${id}`).get()).size).toBe(1)
    expect((await ptx(d.ptxId)).releaseStatus).toBe('released')                         // the original is never re-released
    await reconClean(uid)
  }, T)

  it('6 · the customer WAS refunded despite a failed gateway status, or the evidence is ambiguous: never re-credited, the discrepancy is recorded and the conflict stays', async () => {
    const uid = org()
    const d = await donation(uid, 4_000)
    const id = `rfnd_p34_6_${P}`
    expect((await processedEvt(d, id, 1_000)).status).toBe(200)
    expect((await failedEvt(d, id, 1_000)).status).toBe(200)
    const w0 = await wallet(uid)
    const unchangedState = async () => {
      expect(await rec(id)).toMatchObject({ status: 'processed', accountingRecovery: { state: 'needs_review', conflict: 'FAILED_EVENT_AFTER_PROCESSED' } })
      expect(await wallet(uid)).toEqual(w0)
      expect((await ptx(`ptx_refundcomp_${id}`)).netSettlementPaise).toBeUndefined()
    }
    // ambiguous gateway evidence: unreadable, not listed, other amount, still pending — nothing written
    gw.lookup = 'throw'
    expect(await resolve(id, 'failed', NO_DEBIT)).toMatchObject({ status: 503, body: { code: 'GATEWAY_UNVERIFIED' } })
    gw.lookup = 'real'
    expect(await resolve(id, 'failed', NO_DEBIT)).toMatchObject({ status: 409, body: { code: 'REFUND_NOT_AT_GATEWAY' } })
    listed(d, id, 999, 'failed')
    expect(await resolve(id, 'failed', NO_DEBIT)).toMatchObject({ status: 409, body: { code: 'AMOUNT_MISMATCH' } })
    gw.refunds.pop(); listed(d, id, 1_000, 'pending')
    expect((await resolve(id, 'failed', NO_DEBIT)).body).toMatchObject({ code: 'GATEWAY_NOT_TERMINAL', investigation: expect.any(String) })
    await unchangedState()
    expect((await rec(id)).conflictInvestigations).toBeUndefined()
    // Razorpay "failed" but the bank shows the refund debited (customer refunded): recorded, never re-credited
    gw.refunds.pop(); listed(d, id, 1_000, 'failed')
    const rid = `p34disc${P}a`
    const disc = await resolve(id, 'failed', DEBITED, { requestId: rid })
    expect(disc).toMatchObject({ status: 409, body: { code: 'EVIDENCE_DISCREPANCY', investigation: expect.stringContaining('ARN') } })
    expect(await resolve(id, 'failed', DEBITED, { requestId: rid })).toMatchObject({ status: 409, body: { code: 'EVIDENCE_DISCREPANCY', detail: { duplicate: true } } })
    // Razorpay "failed" WITH an acquirer reference (ARN): money may have reached the customer — a discrepancy too
    gw.refunds.pop(); listed(d, id, 1_000, 'failed', { acquirer_data: { arn: '74332745678901234567890' } })
    expect(await resolve(id, 'failed', NO_DEBIT)).toMatchObject({ status: 409, body: { code: 'EVIDENCE_DISCREPANCY' } })
    await unchangedState()
    const inv = Object.values((await rec(id)).conflictInvestigations ?? {}) as Json[]
    expect(inv).toHaveLength(2)
    expect(inv).toEqual(expect.arrayContaining([
      expect.objectContaining({ finding: 'gateway_vs_evidence', gatewayStatus: 'failed', evidenceObservation: 'refund_debited', by: SUPER }),
      expect.objectContaining({ finding: 'failed_with_acquirer_reference', gatewayAcquirerRef: '74332745678901234567890' }),
    ]))
    expect(await audits(d.id, 'donation.refund_conflict_discrepancy')).toHaveLength(2)
    // Razorpay says processed: confirming PROCESSED closes it with nothing moved (the accounting stands)
    gw.refunds.pop(); listed(d, id, 1_000, 'processed')
    expect(await resolve(id, 'processed', DEBITED)).toMatchObject({ status: 200, body: { outcome: 'confirmed_processed' } })
    expect(await rec(id)).toMatchObject({ status: 'processed', accountingRecovery: { state: 'completed' } })
    expect(await wallet(uid)).toEqual(w0)
    await reconClean(uid)
  }, T)

  it('7 · compensation is refused — and the refund stays under review with the owner decision named — for a FULL refund and for an INSOLVENT reversal', async () => {
    const uid = org()
    // full refund
    const d = await donation(uid, 1_500)
    const id = `rfnd_p34_7a_${P}`
    expect((await processedEvt(d, id, 1_500)).status).toBe(200)
    expect(await rec(id)).toMatchObject({ isFullRefund: true })
    expect((await failedEvt(d, id, 1_500)).status).toBe(200)
    listed(d, id, 1_500, 'failed')
    const w0 = await wallet(uid)
    expect(await resolve(id, 'failed', NO_DEBIT)).toMatchObject({ status: 409, body: { code: 'COMPENSATION_UNSUPPORTED', detail: { why: 'full_refund' }, investigation: expect.stringContaining('owner decision') } })
    expect(await rec(id)).toMatchObject({ status: 'processed', accountingRecovery: { conflict: 'FAILED_EVENT_AFTER_PROCESSED' } })
    expect(await wallet(uid)).toEqual(w0)
    // insolvent reversal: released, paid out, then refunded → a clawback
    const uid2 = org()
    const d2 = await donation(uid2, 3_000)
    await backdate(d2.ptxId); await release({ limit: 500 })
    await db.doc(`organizerRevenueWallets/${uid2}`).update({ availablePaise: 0, settledPaise: 3_000 })
    await db.collection('settlementRequests').doc(`p34-sr-${P}-${++n}`).set({ organizerUid: uid2, amountPaise: 3_000, status: 'paid' })
    const id2 = `rfnd_p34_7b_${P}`
    expect((await processedEvt(d2, id2, 1_000)).status).toBe(200)
    expect(await rec(id2)).toMatchObject({ insolvent: true })
    expect((await failedEvt(d2, id2, 1_000)).status).toBe(200)
    listed(d2, id2, 1_000, 'failed')
    const w2 = await wallet(uid2)
    expect(await resolve(id2, 'failed', NO_DEBIT)).toMatchObject({ status: 409, body: { code: 'COMPENSATION_UNSUPPORTED', detail: { why: 'insolvent_reversal' } } })
    expect(await wallet(uid2)).toEqual(w2)
    expect((await clawbacksOf(uid2))[0]).toMatchObject({ outstandingAmountPaise: 1_000, status: 'open' })
    expect(await rec(id2)).toMatchObject({ accountingRecovery: { conflict: 'FAILED_EVENT_AFTER_PROCESSED' } })
  }, T)
})
