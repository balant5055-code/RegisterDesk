// Phase 3.3 — residual financial-integrity fixes, on REAL Firestore, through the real donation webhook
// (/api/razorpay/webhook), the real organizer refund route, the real Super Admin routes (refund holds,
// refund reviews, refund attempts, clawbacks), the real accounting, drains, sweeps and release job.
//
//   B · cumulative partial-refund reversal: integer paise, never over the remaining net, exact on completion
//   C · off-platform clawback recovery kept apart from wallet recovery; reconciliation stays clean
//   D · the lift never records "no refund" for an attempt Razorpay shows a (failed) refund for; a gateway-
//       originated refund never consumes another request's reservation
//   E · needs_review resolved only on fresh authoritative gateway evidence, audited, idempotent
//   F · bounded queues: backoff, attempt cap → needs_review, paging past backed-off records, health metrics
//   G · stable document-id cursor paging of the hold / attempt / review lists
//
// The gateway stub only LISTS refunds (read-only) or simulates the organizer's own refund request; no test
// path creates or retries a gateway refund on its own. Failures are injected inside transactions (a read
// rejects), so nothing partial can commit.

import crypto from 'crypto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 240_000
const P = process.pid
const WHSEC = 'p33_webhook_secret'
const SUPER = `p33-super-${P}`
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
  RAZORPAY_KEY_ID: 'rzp_test_p33', RAZORPAY_KEY_SECRET: 'p33',
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
  resolveAdminUid:      async (hd: string | null) => (hd === 'Bearer super' ? SUPER : hd === 'Bearer admin' ? `p33-admin-${process.pid}` : null),
  resolveSuperAdminUid: async (hd: string | null) => (hd === 'Bearer super' ? SUPER : null),
  legacyAdminClaimOnly: async () => false,
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined, captureWebhookError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

type Json = Record<string, unknown>

describeEmu('Phase 3.3 · residual financial integrity', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let reverse: typeof import('@/lib/firebase/firestore/platformTransactions').reversePlatformTransactionAndDebit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let svc: typeof import('@/lib/donations/refundService')
  let claw: typeof import('@/lib/clawbacks/clawbackService')
  let recon: typeof import('@/lib/payments/registrationReconciliation')
  let reconcileWallet: typeof import('@/lib/reconciliation/wallets').reconcileOneWallet
  let reconcileBuckets: typeof import('@/lib/reconciliation/wallets').reconcileWalletBuckets
  let health: typeof import('@/lib/operations/healthMetrics').getOperationsHealth
  let listRefundHolds: typeof import('@/lib/settlements/refundHoldReview').listRefundHolds
  let webhook: (r: NextRequest) => Promise<Response>
  let orgRefund: (r: NextRequest, c: { params: Promise<{ donationId: string }> }) => Promise<Response>
  let holdsPost: (r: NextRequest) => Promise<Response>
  let holdsGet: (r: NextRequest) => Promise<Response>
  let reviewsPost: (r: NextRequest) => Promise<Response>
  let reviewsGet: (r: NextRequest) => Promise<Response>
  let attemptsGet: (r: NextRequest) => Promise<Response>
  let clawPatch: (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>
  let n = 0
  let req = 0

  const org = () => `p33-org-${P}-${++n}`
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
  const dueNow = (refundId: string) => db.doc(`donationRefunds/${refundId}`).update({ 'accountingRecovery.nextAttemptAt': FS.Timestamp.fromMillis(Date.now() - 1_000) })
  const ageAttempt = (donationId: string, attemptId: string, minutes: number) =>
    db.doc(`donations/${donationId}`).update({ [`refundAttempts.${attemptId}.startedAt`]: FS.Timestamp.fromMillis(Date.now() - minutes * MIN) })
  const audits = async (entityId: string, action: string) => (await db.collection('adminAuditLogs').where('entityId', '==', entityId).where('action', '==', action).get()).docs.map(d => d.data())

  /** A credited payment with an explicit gross / net (fees = gross − net). */
  async function payment(uid: string, gross: number, net: number, kind: 'donation' | 'registration', id = `p33-${P}-${++n}`) {
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
  const processed = (d: { id: string; paymentId: string; orderId: string }, refundId: string, amount: number) =>
    refundEvent('refund.processed', `evt_${refundId}`, d, { id: refundId, amount })
  const organizerRefund = async (donationId: string, amountPaise: number) => {
    const res = await orgRefund(
      new NextRequest(`http://x/api/organizer/donations/${donationId}/refund`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer super' }, body: JSON.stringify({ amountPaise, reason: 'donor asked for a refund' }) }),
      { params: Promise.resolve({ donationId }) },
    )
    return { status: res.status, body: await res.json() as Json }
  }
  const post = async (handler: (r: NextRequest) => Promise<Response>, url: string, body: Json, auth = 'Bearer super') => {
    const r = await handler(new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(body) }))
    return { status: r.status, body: await r.json() as Json }
  }
  const get = async (handler: (r: NextRequest) => Promise<Response>, url: string, auth = 'Bearer super') => {
    const r = await handler(new NextRequest(url, { method: 'GET', headers: { authorization: auth } }))
    return { status: r.status, body: await r.json() as Json }
  }
  const lift = (ptxId: string, refundIds: string[]) => post(holdsPost, 'http://x/api/admin/finance/refund-holds',
    { ptxId, outcome: 'lift_hold_no_refund', reason: 'reconciled against the Razorpay dashboard', confirm: true, expectedRefundIds: refundIds, requestId: `p33req${P}x${++req}` })
  const review = (refundId: string, action: string, extra: Json = {}, auth = 'Bearer super') => post(reviewsPost, 'http://x/api/admin/finance/refund-reviews',
    { refundId, action, reason: 'verified against Razorpay', confirm: true, requestId: `p33rev${P}x${++req}`, ...extra }, auth)
  const clawAction = async (id: string, body: Json, auth = 'Bearer super') => {
    const r = await clawPatch(new NextRequest(`http://x/api/admin/clawbacks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
    return { status: r.status, body: await r.json() as Json }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ recordPlatformTransactionAndCredit: credit, reversePlatformTransactionAndDebit: reverse } = await import('@/lib/firebase/firestore/platformTransactions'))
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    svc = await import('@/lib/donations/refundService')
    claw = await import('@/lib/clawbacks/clawbackService')
    recon = await import('@/lib/payments/registrationReconciliation')
    ;({ reconcileOneWallet: reconcileWallet, reconcileWalletBuckets: reconcileBuckets } = await import('@/lib/reconciliation/wallets'))
    health = (await import('@/lib/operations/healthMetrics')).getOperationsHealth
    listRefundHolds = (await import('@/lib/settlements/refundHoldReview')).listRefundHolds
    ;({ POST: webhook } = await import('@/app/api/razorpay/webhook/route'))
    ;({ POST: orgRefund } = await import('@/app/api/organizer/donations/[donationId]/refund/route') as never)
    ;({ POST: holdsPost, GET: holdsGet } = await import('@/app/api/admin/finance/refund-holds/route') as never)
    ;({ POST: reviewsPost, GET: reviewsGet } = await import('@/app/api/admin/finance/refund-reviews/route') as never)
    ;({ GET: attemptsGet } = await import('@/app/api/admin/finance/refund-attempts/route') as never)
    ;({ PATCH: clawPatch } = await import('@/app/api/admin/clawbacks/[id]/route') as never)
  }, T)
  // Synthetic fixtures that sit in SHARED lists (open refund attempts, held settlements, closure records) are
  // removed, so they never crowd other suites' first pages on the same emulator.
  afterAll(async () => {
    if (!db) return
    const refs: FirebaseFirestore.DocumentReference[] = []
    for (let i = 0; i < 30; i++) {
      const id = `00p33${P}s${String(i).padStart(2, '0')}`
      refs.push(db.doc(`donations/${id}`), db.doc(`platformTransactions/ptx_${id}`))
    }
    for (let i = 0; i < 7; i++) refs.push(db.doc(`platformTransactions/ptx_00p33g${P}_${i}`))
    for (const tag of ['wait', 'ref']) {
      const reg = `0p33${P}${tag}`
      refs.push(db.doc(`platformTransactions/ptx_${reg}`), db.doc(`paymentIntents/order_${reg}`), db.doc(`refundHoldClosureReconciliation/${reg}`))
    }
    const batch = db.batch()
    for (const r of refs) batch.delete(r)
    await batch.commit()
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

  // ═══ B · cumulative reversal ═══════════════════════════════════════════════════════════════════════

  it('B1 · 100,000 / 95,000 refunded 33,333 + 33,333 + 33,334: exactly 95,000 reversed (31,666 + 31,666 + 31,668); wallet and ledger agree; duplicates add nothing', async () => {
    const uid = org()
    const d = await donation(uid, 100_000, 95_000)
    const ids = [`rfnd_p33_b1a_${P}`, `rfnd_p33_b1b_${P}`, `rfnd_p33_b1c_${P}`]
    for (const [i, amount] of [33_333, 33_333, 33_334].entries()) expect((await processed(d, ids[i], amount)).status).toBe(200)
    expect(await Promise.all(ids.map(async id => (await rec(id)).ledgerReversedPaise))).toEqual([31_666, 31_666, 31_668])
    expect(await reversedNet(d.id)).toBe(95_000)
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 0 })
    expect(await don(d.id)).toMatchObject({ refundedAmountPaise: 100_000, status: 'refunded' })
    // a redelivery (new event id, same refund) and a direct re-apply change nothing
    expect((await refundEvent('refund.processed', `evt_dup_${ids[2]}`, d, { id: ids[2], amount: 33_334 })).status).toBe(200)
    expect(await svc.applyDonationRefundAccounting(ids[0])).toMatchObject({ applied: false })
    expect(await reversedNet(d.id)).toBe(95_000)
    expect((await reversals(d.id)).length).toBe(3)
    expect(await clawbacksOf(uid)).toEqual([])
    await reconClean(uid)
  }, T)

  it('B2 · the one-paisa payout blocker: a RELEASED 100,000 / 95,000 donation refunded 10 + 99,990 reverses exactly 95,000 — no clawback, available exactly 0', async () => {
    const uid = org()
    const d = await donation(uid, 100_000, 95_000)
    await backdate(d.ptxId); await release({ limit: 500 })
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 95_000 })
    expect((await processed(d, `rfnd_p33_b2a_${P}`, 10)).status).toBe(200)
    expect((await processed(d, `rfnd_p33_b2b_${P}`, 99_990)).status).toBe(200)
    expect((await rec(`rfnd_p33_b2a_${P}`)).ledgerReversedPaise).toBe(10)
    expect(await rec(`rfnd_p33_b2b_${P}`)).toMatchObject({ ledgerReversedPaise: 94_990, insolvent: false })   // per-refund rounding gave 94,991
    expect(await reversedNet(d.id)).toBe(95_000)
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 0 })
    expect(await clawbacksOf(uid)).toEqual([])                                   // no 1-paisa debt holding back the next payout
    await reconClean(uid)
  }, T)

  it('B3 · 999 / 950 refunded 333 × 3, two of them CONCURRENTLY: exactly 950 reversed; an over-refund attempt afterwards reverses nothing', async () => {
    const uid = org()
    const d = await donation(uid, 999, 950)
    const [a, b, c] = [`rfnd_p33_b3a_${P}`, `rfnd_p33_b3b_${P}`, `rfnd_p33_b3c_${P}`]
    const r = await Promise.all([processed(d, a, 333), processed(d, b, 333)])
    expect(r.map(x => x.status)).toEqual([200, 200])
    expect([(await rec(a)).ledgerReversedPaise, (await rec(b)).ledgerReversedPaise]).toEqual([317, 317])
    expect((await processed(d, c, 333)).status).toBe(200)
    expect((await rec(c)).ledgerReversedPaise).toBe(316)                         // the completing refund takes EXACTLY the remainder
    expect(await reversedNet(d.id)).toBe(950)
    expect(await wallet(uid)).toMatchObject({ pending: 0 })
    // a further refund reported for the same payment (already fully refunded): no net left to reverse
    expect((await processed(d, `rfnd_p33_b3d_${P}`, 100)).status).toBe(200)
    expect((await rec(`rfnd_p33_b3d_${P}`)).ledgerReversedPaise ?? 0).toBe(0)
    expect(await reversedNet(d.id)).toBe(950)
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 0 })
    expect(await clawbacksOf(uid)).toEqual([])
  }, T)

  // ═══ D2 · reservation ownership ════════════════════════════════════════════════════════════════════

  it('D2 · a dashboard (webhook-only) refund while an organizer reservation is open never consumes it; refundable stays exact, also under concurrent accounting', async () => {
    const uid = org()
    const d = await donation(uid, 50_000)
    expect(await svc.reserveRefund(d.id, 30_000)).toMatchObject({ ok: true })     // an organizer request in flight
    expect((await processed(d, `rfnd_p33_d2a_${P}`, 10_000)).status).toBe(200)    // a Razorpay dashboard refund
    expect(await don(d.id)).toMatchObject({ refundedAmountPaise: 10_000, pendingRefundPaise: 30_000 })
    const refundable = async () => { const x = await don(d.id); return x.amountPaise - x.refundedAmountPaise - x.pendingRefundPaise }
    expect(await refundable()).toBe(10_000)                                       // the old decrement showed 40,000
    // the organizer's own refund is accounted while another dashboard refund lands, concurrently
    const orgId = `rfnd_p33_d2org_${P}`
    await svc.ensureRefundRecord({ refundId: orgId, donationId: d.id, campaignId: `p33-camp-${P}`, campaignSlug: `p33-camp-${P}`, organizerUid: uid, razorpayPaymentId: d.paymentId, amountPaise: 30_000, reason: 'organizer_initiated', initiatedBy: SUPER })
    await Promise.all([svc.applyDonationRefundAccounting(orgId), processed(d, `rfnd_p33_d2b_${P}`, 5_000)])
    expect(await don(d.id)).toMatchObject({ refundedAmountPaise: 45_000, pendingRefundPaise: 0 })
    expect(await refundable()).toBe(5_000)
    expect(await wallet(uid)).toMatchObject({ pending: 5_000 })
  }, T)

  // ═══ D1 · the lift checks every open attempt against Razorpay's refunds ════════════════════════════

  it('D1 · a FAILED refund created by the open attempt refuses the lift (never resolved_none); an unrecorded failed refund refuses it too; with none at all the lift resolves it', async () => {
    const uid = org()
    const d = await donation(uid, 1_500)
    gw.mode = 'timeout'
    expect((await organizerRefund(d.id, 500)).body).toMatchObject({ code: 'REFUND_OUTCOME_UNKNOWN' })
    const [[attemptId]] = Object.entries((await don(d.id)).refundAttempts ?? {})
    await ageAttempt(d.id, attemptId, 16)
    // Razorpay shows a FAILED refund carrying this attempt's id: it must be linked, not called "no refund"
    gw.refunds.push({ id: `rfnd_p33_d1f_${P}`, payment_id: d.paymentId, amount: 500, status: 'failed', notes: { attemptId } })
    expect(await lift(d.ptxId, [])).toMatchObject({ status: 409, body: { code: 'ATTEMPT_REFUND_AT_GATEWAY' } })
    expect((await don(d.id)).refundAttempts[attemptId]).toMatchObject({ status: 'unknown' })
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 500, hasOpenRefundAttempt: true })
    expect(await ptx(d.ptxId)).toMatchObject({ releaseStatus: 'held', releaseHold: { attemptIds: [attemptId] } })
    gw.refunds.pop()
    // a failed refund with no notes that RegisterDesk never recorded: could be this attempt's — refused
    gw.refunds.push({ id: `rfnd_p33_d1u_${P}`, payment_id: d.paymentId, amount: 500, status: 'failed', notes: {} })
    expect(await lift(d.ptxId, [])).toMatchObject({ status: 409, body: { code: 'ATTEMPT_EVIDENCE_UNCLEAR' } })
    expect((await don(d.id)).refundAttempts[attemptId]).toMatchObject({ status: 'unknown' })
    gw.refunds.pop()
    // nothing at Razorpay, ≥ 15 min: resolved_none, reservation freed (PD-2 unchanged)
    expect((await lift(d.ptxId, [])).status).toBe(200)
    expect((await don(d.id)).refundAttempts[attemptId]).toMatchObject({ status: 'resolved_none' })
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 0, hasOpenRefundAttempt: false })
  }, T)

  // ═══ C · off-platform clawback recovery ════════════════════════════════════════════════════════════

  it('C · partial then full off-platform recovery: kept apart from wallet recovery, idempotent, authorized; reconciliation stays clean; a later release recovers only what is still owed', async () => {
    const uid = org()
    const A = await payment(uid, 100_000, 100_000, 'registration')
    await backdate(A.ptxId, 40); await release({ limit: 500 })
    await db.doc(`organizerRevenueWallets/${uid}`).update({ availablePaise: 0, settledPaise: 100_000 })
    await db.collection('settlementRequests').doc(`p33-sr-${P}-${++n}`).set({ organizerUid: uid, amountPaise: 100_000, status: 'paid' })
    expect(await reverse(A.ptxId)).toMatchObject({ reversed: true, debited: 0, insolvent: true })
    const id = claw.clawbackId(A.ptxId)
    await reconClean(uid)
    // authorization and validation — nothing changes
    expect((await clawAction(id, { action: 'mark_recovered', reason: 'collected by bank transfer', amountPaise: 40_000, requestId: `p33cb${P}a` }, 'Bearer admin')).status).toBe(403)
    expect((await clawAction(id, { action: 'mark_recovered', reason: 'collected by bank transfer', amountPaise: 40_000 })).status).toBe(400)          // partial needs a requestId
    expect((await clawAction(id, { action: 'mark_recovered', reason: 'collected by bank transfer', amountPaise: 400.5, requestId: `p33cb${P}a` })).status).toBe(400)
    expect((await clawAction(id, { action: 'mark_recovered', reason: 'collected by bank transfer', amountPaise: 100_001, requestId: `p33cb${P}a` })).status).toBe(400)
    expect((await clawAction(id, { action: 'waive', reason: 'forgiven', amountPaise: 1 })).status).toBe(400)
    expect((await clawAction(id, { action: 'mark_recovered', reason: 'x', amountPaise: 1, requestId: `p33cb${P}a` })).status).toBe(400)               // reason too short
    expect((await clawbacksOf(uid))[0]).toMatchObject({ outstandingAmountPaise: 100_000, status: 'open' })
    // partial: 40,000 collected off-platform
    const p1 = await clawAction(id, { action: 'mark_recovered', reason: 'collected by bank transfer', amountPaise: 40_000, requestId: `p33cb${P}a` })
    expect(p1).toMatchObject({ status: 200, body: { clawback: { status: 'partially_recovered', outstandingAmountPaise: 60_000, offPlatformRecoveredAmountPaise: 40_000, recoveredAmountPaise: 0 } } })
    // repeated: the same requestId changes nothing; a different amount under it is refused
    expect((await clawAction(id, { action: 'mark_recovered', reason: 'collected by bank transfer', amountPaise: 40_000, requestId: `p33cb${P}a` })).status).toBe(200)
    expect((await clawAction(id, { action: 'mark_recovered', reason: 'collected by bank transfer', amountPaise: 30_000, requestId: `p33cb${P}a` })).status).toBe(409)
    expect((await clawbacksOf(uid))[0]).toMatchObject({ outstandingAmountPaise: 60_000, offPlatformRecoveredAmountPaise: 40_000, recoveredAmountPaise: 0, reversalAmountPaise: 100_000 })
    expect(await audits(id, 'clawback.recovered')).toHaveLength(1)
    await reconClean(uid)                                                        // the old reconciliation reported a 40,000 mismatch
    expect(await wallet(uid)).toMatchObject({ available: 0, settled: 100_000 })  // no wallet balance changed
    // a release recovers only the 60,000 still owed — never the off-platform part
    const B = await payment(uid, 70_000, 70_000, 'registration')
    await backdate(B.ptxId, 3); await release({ limit: 500 })
    expect((await clawbacksOf(uid))[0]).toMatchObject({ status: 'recovered', outstandingAmountPaise: 0, recoveredAmountPaise: 60_000, offPlatformRecoveredAmountPaise: 40_000 })
    expect(await wallet(uid)).toMatchObject({ available: 10_000 })
    await reconClean(uid)
    // a fully recovered clawback refuses further recovery
    expect((await clawAction(id, { action: 'mark_recovered', reason: 'collected by bank transfer' })).status).toBe(409)

    // full off-platform recovery of a second debt (no amount): the whole outstanding, resolved
    const uid2 = org()
    const C = await payment(uid2, 25_000, 25_000, 'registration')
    await backdate(C.ptxId, 40); await release({ limit: 500 })
    await db.doc(`organizerRevenueWallets/${uid2}`).update({ availablePaise: 0, settledPaise: 25_000 })
    await db.collection('settlementRequests').doc(`p33-sr-${P}-${++n}`).set({ organizerUid: uid2, amountPaise: 25_000, status: 'paid' })
    await reverse(C.ptxId)
    const id2 = claw.clawbackId(C.ptxId)
    const full = await clawAction(id2, { action: 'mark_recovered', reason: 'collected by bank transfer' })
    expect(full).toMatchObject({ status: 200, body: { clawback: { status: 'recovered', outstandingAmountPaise: 0, offPlatformRecoveredAmountPaise: 25_000, recoveredAmountPaise: 0, resolvedBy: SUPER } } })
    expect((await clawAction(id2, { action: 'mark_recovered', reason: 'collected by bank transfer' })).status).toBe(409)
    await reconClean(uid2)
  }, T)

  it('C2 · exact accounting example: released → paid out → refunded (clawback) → partial off-platform → wallet-funded rest; external money never enters the wallet, no paisa is counted twice, unrelated and tampered discrepancies still surface', async () => {
    const uid = org()
    const bucketsOf = async () => (await reconcileBuckets(uid, (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!)).expectedTotal
    const mism = async () => (await reconcileWallet(uid, (await db.doc(`organizerRevenueWallets/${uid}`).get()).data()!)).map(m => ({ field: m.field, expected: m.expected, actual: m.actual }))
    const cb = async () => { const c = (await clawbacksOf(uid))[0]; return { reversal: c.reversalAmountPaise, recovered: c.recoveredAmountPaise, outstanding: c.outstandingAmountPaise, off: c.offPlatformRecoveredAmountPaise ?? 0, status: c.status } }
    // 1 · a released transaction of 100,000, paid out in full
    const A = await payment(uid, 100_000, 100_000, 'registration')
    await backdate(A.ptxId, 40); await release({ limit: 500 })
    expect(await wallet(uid)).toEqual({ pending: 0, available: 100_000, settled: 0 })
    await db.doc(`organizerRevenueWallets/${uid}`).update({ availablePaise: 0, settledPaise: 100_000 })
    await db.collection('settlementRequests').doc(`p33-sr-${P}-${++n}`).set({ organizerUid: uid, amountPaise: 100_000, status: 'paid' })
    expect(await wallet(uid)).toEqual({ pending: 0, available: 0, settled: 100_000 })
    // 2 · the refund: nothing left to debit → the whole 100,000 is a clawback; no wallet bucket moves
    expect(await reverse(A.ptxId)).toMatchObject({ reversed: true, debited: 0, insolvent: true })
    expect(await wallet(uid)).toEqual({ pending: 0, available: 0, settled: 100_000 })
    expect(await cb()).toEqual({ reversal: 100_000, recovered: 0, outstanding: 100_000, off: 0, status: 'open' })
    expect(await bucketsOf()).toBe(100_000)                   // Σnet 100,000 − in-place reversed 100,000 + (outstanding 100,000 + off 0)
    expect(await mism()).toEqual([])
    // 3 · 40,000 collected OFF-PLATFORM: no wallet bucket moves; the paisa moves outstanding → off-platform
    const id = claw.clawbackId(A.ptxId)
    expect((await clawAction(id, { action: 'mark_recovered', reason: 'bank transfer UTR 123', amountPaise: 40_000, requestId: `p33c2${P}a` })).status).toBe(200)
    expect(await wallet(uid)).toEqual({ pending: 0, available: 0, settled: 100_000 })
    expect(await cb()).toEqual({ reversal: 100_000, recovered: 0, outstanding: 60_000, off: 40_000, status: 'partially_recovered' })
    expect(await bucketsOf()).toBe(100_000)                   // 0 + (60,000 + 40,000)
    expect(await mism()).toEqual([])
    // the same collection submitted again: recorded once
    expect((await clawAction(id, { action: 'mark_recovered', reason: 'bank transfer UTR 123', amountPaise: 40_000, requestId: `p33c2${P}a` })).body).toMatchObject({ clawback: { offPlatformRecoveredAmountPaise: 40_000 } })
    expect(await cb()).toMatchObject({ outstanding: 60_000, off: 40_000 })
    // 4 · a later release of 70,000 recovers ONLY the 60,000 still owed, from the wallet; 10,000 is credited
    const B = await payment(uid, 70_000, 70_000, 'registration')
    expect(await wallet(uid)).toEqual({ pending: 70_000, available: 0, settled: 100_000 })
    await backdate(B.ptxId, 3); await release({ limit: 500 })
    expect(await wallet(uid)).toEqual({ pending: 0, available: 10_000, settled: 100_000 })
    expect(await cb()).toEqual({ reversal: 100_000, recovered: 60_000, outstanding: 0, off: 40_000, status: 'recovered' })   // 60,000 + 0 + 40,000 = 100,000: each paisa once
    expect(await bucketsOf()).toBe(110_000)                   // Σnet 170,000 − 100,000 + (0 + 40,000)
    expect(await mism()).toEqual([])
    // an UNRELATED discrepancy (one stray paisa in available) is still reported
    await db.doc(`organizerRevenueWallets/${uid}`).update({ availablePaise: 10_001 })
    expect(await mism()).toEqual(expect.arrayContaining([{ field: 'balanceSum', expected: 110_000, actual: 110_001 }]))
    await db.doc(`organizerRevenueWallets/${uid}`).update({ availablePaise: 10_000 })
    // a tampered clawback (off-platform inflated by hand) cannot vouch for itself: reported
    await db.doc(`walletClawbacks/${id}`).update({ offPlatformRecoveredAmountPaise: 41_000 })
    expect(await mism()).toEqual(expect.arrayContaining([{ field: `clawbackArithmetic:${id}`, expected: 100_000, actual: 101_000 }]))
    await db.doc(`walletClawbacks/${id}`).update({ offPlatformRecoveredAmountPaise: 40_000 })
    expect(await mism()).toEqual([])

    // LIMITATION (no backfill): a clawback marked recovered BEFORE Phase 3.3 stored recovered = reversal and no
    // off-platform amount, so the split is lost. Reconciliation reports it — it is never silently cleaned.
    const uid2 = org()
    const C = await payment(uid2, 25_000, 25_000, 'registration')
    await backdate(C.ptxId, 40); await release({ limit: 500 })
    await db.doc(`organizerRevenueWallets/${uid2}`).update({ availablePaise: 0, settledPaise: 25_000 })
    await db.collection('settlementRequests').doc(`p33-sr-${P}-${++n}`).set({ organizerUid: uid2, amountPaise: 25_000, status: 'paid' })
    await reverse(C.ptxId)
    await db.doc(`walletClawbacks/${claw.clawbackId(C.ptxId)}`).update({ recoveredAmountPaise: 25_000, outstandingAmountPaise: 0, status: 'recovered' })   // the legacy shape
    const legacy = (await reconcileWallet(uid2, (await db.doc(`organizerRevenueWallets/${uid2}`).get()).data()!)).map(m => ({ field: m.field, expected: m.expected, actual: m.actual }))
    expect(legacy).toEqual(expect.arrayContaining([{ field: 'balanceSum', expected: 0, actual: 25_000 }]))
  }, T)

  // ═══ E · needs_review resolution ═══════════════════════════════════════════════════════════════════

  it('E1 · retry_accounting: only on a fresh "processed" lookup; a still-broken cause returns to needs_review (bounded); once fixed it is accounted ONCE; audited and idempotent', async () => {
    const uid = org()
    const d = await donation(uid, 2_000)
    const refundId = `rfnd_p33_e1_${P}`
    const calls0 = gw.calls
    await db.doc(`platformTransactions/${d.ptxId}`).update({ releaseStatus: FS.FieldValue.delete() })   // permanent: unknown bucket
    expect((await processed(d, refundId, 800)).status).toBe(200)
    expect(await rec(refundId)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'needs_review' } })
    // authorization / input
    expect((await review(refundId, 'retry_accounting', {}, 'Bearer admin')).status).toBe(403)
    expect((await post(reviewsPost, 'http://x/api/admin/finance/refund-reviews', { refundId, action: 'retry_accounting', reason: 'verified against Razorpay', requestId: `p33rev${P}nc` })).status).toBe(400)   // no confirm
    expect((await review(refundId, 'force_release')).status).toBe(400)
    // evidence: unreadable → 503; not listed → 409; listed failed → 409 (success was recorded: contradiction)
    gw.lookup = 'throw'
    expect(await review(refundId, 'retry_accounting')).toMatchObject({ status: 503, body: { code: 'GATEWAY_UNVERIFIED' } })
    gw.lookup = 'real'
    expect(await review(refundId, 'retry_accounting')).toMatchObject({ status: 409, body: { code: 'REFUND_NOT_AT_GATEWAY' } })
    gw.refunds.push({ id: refundId, payment_id: d.paymentId, amount: 800, status: 'failed', notes: {} })
    expect(await review(refundId, 'retry_accounting')).toMatchObject({ status: 409, body: { code: 'NOT_PROCESSED_AT_GATEWAY' } })
    expect(await review(refundId, 'record_failed')).toMatchObject({ status: 409, body: { code: 'CONTRADICTORY_OUTCOME' } })
    gw.refunds.at(-1)!.status = 'processed'
    gw.refunds.at(-1)!.amount = 700
    expect(await review(refundId, 'retry_accounting')).toMatchObject({ status: 409, body: { code: 'AMOUNT_MISMATCH' } })
    gw.refunds.at(-1)!.amount = 800
    // still broken: one run, back to needs_review — never a loop
    const attempts0 = (await rec(refundId)).accountingRecovery.attempts
    const still = await review(refundId, 'retry_accounting')
    expect(still).toMatchObject({ status: 200, body: { outcome: 'still_failing' } })
    expect(await rec(refundId)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'needs_review', attempts: attempts0 + 1 } })
    expect((await reversals(d.id)).length).toBe(0)
    // fixed: accounted exactly once
    await db.doc(`platformTransactions/${d.ptxId}`).update({ releaseStatus: 'pending' })
    const rid = `p33rev${P}fix`
    const ok = await post(reviewsPost, 'http://x/api/admin/finance/refund-reviews', { refundId, action: 'retry_accounting', reason: 'bucket repaired; verified against Razorpay', confirm: true, requestId: rid })
    expect(ok).toMatchObject({ status: 200, body: { outcome: 'accounted', duplicate: false } })
    expect(await rec(refundId)).toMatchObject({ status: 'processed', ledgerReversedPaise: 800, accountingRecovery: { state: 'completed' } })
    expect((await rec(refundId)).reviewResolutions[rid]).toMatchObject({ action: 'retry_accounting', by: SUPER, gatewayStatus: 'processed' })
    expect(await wallet(uid)).toMatchObject({ pending: 1_200 })
    // the same request again: answered from the audit, nothing moves
    expect(await post(reviewsPost, 'http://x/api/admin/finance/refund-reviews', { refundId, action: 'retry_accounting', reason: 'bucket repaired; verified against Razorpay', confirm: true, requestId: rid }))
      .toMatchObject({ status: 200, body: { duplicate: true } })
    expect(await review(refundId, 'retry_accounting')).toMatchObject({ status: 409, body: { code: 'NOT_IN_REVIEW' } })
    expect((await reversals(d.id)).length).toBe(1)
    expect(await audits(d.id, 'donation.refund_review_accounting_retried')).toHaveLength(2)
    expect(gw.calls).toBe(calls0)                                                // never a gateway refund
  }, T)

  it('E2 · a contradictory record stays held; record_failed needs a failed lookup, no success evidence and PD-2 age, and frees only an OWNED reservation', async () => {
    const uid = org()
    const d = await donation(uid, 3_000)
    const base = { donationId: d.id, campaignId: `p33-camp-${P}`, campaignSlug: `p33-camp-${P}`, organizerUid: uid, razorpayPaymentId: d.paymentId, reason: 'organizer_initiated' }
    // contradictory
    const cId = `rfnd_p33_e2c_${P}`
    await svc.ensureRefundRecord({ ...base, refundId: cId, amountPaise: 100, initiatedBy: SUPER })
    await db.doc(`donationRefunds/${cId}`).update({ accountingRecovery: { state: 'needs_review', conflict: 'PROCESSED_EVENT_AFTER_FAILED', attempts: 1 } })
    gw.refunds.push({ id: cId, payment_id: d.paymentId, amount: 100, status: 'failed', notes: {} })
    for (const action of ['retry_accounting', 'record_failed', 'link_attempt']) {
      expect(await review(cId, action, action === 'link_attempt' ? { attemptId: 'att_p33nonexistent' } : {})).toMatchObject({ status: 409, body: { code: 'CONTRADICTORY_OUTCOME' } })
    }
    expect(await rec(cId)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'needs_review', conflict: 'PROCESSED_EVENT_AFTER_FAILED' } })
    // no trusted success evidence: the drain escalates it (never accounts it)
    const fId = `rfnd_p33_e2f_${P}`
    expect(await svc.reserveRefund(d.id, 500)).toMatchObject({ ok: true })
    await svc.ensureRefundRecord({ ...base, refundId: fId, amountPaise: 500, initiatedBy: SUPER })
    await db.doc(`donationRefunds/${fId}`).update({ accountingRecovery: { state: 'retry', attempts: 0, nextAttemptAt: FS.Timestamp.fromMillis(Date.now() - 1_000) } })
    await svc.retryDonationRefundAccounting(500)
    expect(await rec(fId)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'needs_review' } })
    gw.refunds.push({ id: fId, payment_id: d.paymentId, amount: 500, status: 'processed', notes: {} })
    expect(await review(fId, 'record_failed')).toMatchObject({ status: 409, body: { code: 'NOT_FAILED_AT_GATEWAY' } })
    gw.refunds.at(-1)!.status = 'failed'
    expect(await review(fId, 'record_failed')).toMatchObject({ status: 409, body: { code: 'TOO_RECENT' } })          // PD-2
    await db.doc(`donationRefunds/${fId}`).update({ createdAt: FS.Timestamp.fromMillis(Date.now() - 20 * MIN) })
    expect(await review(fId, 'retry_accounting')).toMatchObject({ status: 409, body: { code: 'NOT_PROCESSED_AT_GATEWAY' } })
    const ok = await review(fId, 'record_failed')
    expect(ok).toMatchObject({ status: 200, body: { outcome: 'recorded_failed', detail: { reservationFreedPaise: 500 } } })
    expect(await rec(fId)).toMatchObject({ status: 'failed', accountingRecovery: { state: 'gateway_failed' } })
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 0, refundedAmountPaise: 0 })
    expect(await wallet(uid)).toMatchObject({ pending: 3_000 })                  // nothing reversed
    expect(await audits(d.id, 'donation.refund_review_recorded_failed')).toHaveLength(1)
  }, T)

  it('E3 · link_attempt: only when Razorpay\'s own notes prove the attempt created THIS refund (PD-2 age); ownership follows, so the later accounting consumes that reservation exactly', async () => {
    const uid = org()
    const d = await donation(uid, 1_500)
    const calls0 = gw.calls
    gw.mode = 'timeout'
    expect((await organizerRefund(d.id, 500)).body).toMatchObject({ code: 'REFUND_OUTCOME_UNKNOWN' })
    const [[attemptId]] = Object.entries((await don(d.id)).refundAttempts ?? {})
    // the refund arrives by webhook WITHOUT its notes, and its accounting fails permanently
    const refundId = `rfnd_p33_e3_${P}`
    await db.doc(`platformTransactions/${d.ptxId}`).update({ releaseStatus: FS.FieldValue.delete() })
    expect((await processed(d, refundId, 500)).status).toBe(200)
    expect(await rec(refundId)).toMatchObject({ initiatedBy: 'webhook', accountingRecovery: { state: 'needs_review' } })
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 500 })
    // Razorpay's list carries the attempt id in the refund's notes
    gw.refunds.push({ id: refundId, payment_id: d.paymentId, amount: 500, status: 'processed', notes: { attemptId } })
    expect(await review(refundId, 'link_attempt')).toMatchObject({ status: 400, body: { code: 'INVALID_ATTEMPT_ID' } })
    expect(await review(refundId, 'link_attempt', { attemptId: 'att_p33someotherattempt' })).toMatchObject({ status: 409, body: { code: 'ATTEMPT_NOT_PROVEN' } })
    expect(await review(refundId, 'link_attempt', { attemptId })).toMatchObject({ status: 409, body: { code: 'TOO_RECENT' } })
    await ageAttempt(d.id, attemptId, 16)
    const rid = `p33rev${P}link`
    const linked = await post(reviewsPost, 'http://x/api/admin/finance/refund-reviews', { refundId, action: 'link_attempt', attemptId, reason: 'notes match on the Razorpay dashboard', confirm: true, requestId: rid })
    expect(linked).toMatchObject({ status: 200, body: { outcome: 'linked', detail: { reservationFreedPaise: 0 } } })
    expect((await don(d.id)).refundAttempts[attemptId]).toMatchObject({ status: 'linked', refundId, resolvedBy: SUPER })
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 500, hasOpenRefundAttempt: false })
    expect(await rec(refundId)).toMatchObject({ initiatedBy: SUPER, accountingRecovery: { state: 'needs_review' } })
    expect(await post(reviewsPost, 'http://x/api/admin/finance/refund-reviews', { refundId, action: 'link_attempt', attemptId, reason: 'notes match on the Razorpay dashboard', confirm: true, requestId: rid }))
      .toMatchObject({ status: 200, body: { duplicate: true } })
    // the cause is fixed and the accounting retried: the reservation is consumed by THIS refund, exactly
    await db.doc(`platformTransactions/${d.ptxId}`).update({ releaseStatus: 'held' })
    expect(await review(refundId, 'retry_accounting')).toMatchObject({ status: 200, body: { outcome: 'accounted' } })
    expect(await don(d.id)).toMatchObject({ refundedAmountPaise: 500, pendingRefundPaise: 0 })
    expect(await reversedNet(d.id)).toBe(500)
    expect(gw.calls).toBe(calls0 + 1)                                            // only the organizer's own (timed-out) request
  }, T)

  it('E4 · contradictory outcomes are never accounted, completed, released or lifted automatically — in all three conflict states — and every review action refuses them', async () => {
    const uid = org()
    const refusedEverywhere = async (refundId: string, d: { ptxId: string }, liftWhy?: string) => {
      for (const action of ['retry_accounting', 'record_failed', 'link_attempt']) {
        expect(await review(refundId, action, action === 'link_attempt' ? { attemptId: 'att_p33nonexistent' } : {})).toMatchObject({ status: 409, body: { code: 'CONTRADICTORY_OUTCOME' } })
      }
      const t = await ptx(d.ptxId)
      if (t.status === 'completed') {
        const l = await lift(d.ptxId, (t.releaseHold?.refundIds ?? []) as string[])
        expect(l.status).toBe(409)
        if (liftWhy) expect(l.body).toMatchObject({ why: liftWhy })
        expect(await ptx(d.ptxId)).toMatchObject({ releaseStatus: 'held' })
      }
    }

    // (1) FAILED_EVENT_AFTER_SUCCESS_EVIDENCE — processed (accounting deferred), then failed, then processed again
    const d1 = await donation(uid, 2_000)
    const r1 = `rfnd_p33_e4a_${P}`
    fx.failApply = 1
    expect((await processed(d1, r1, 800)).status).toBe(200)
    expect(await rec(r1)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'retry', gatewayEvidence: 'webhook_refund_processed' } })
    expect((await refundEvent('refund.failed', `evt_f_${r1}`, d1, { id: r1, amount: 800 })).status).toBe(200)
    expect(await rec(r1)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'needs_review', conflict: 'FAILED_EVENT_AFTER_SUCCESS_EVIDENCE' } })
    const w1 = await wallet(uid)
    // a redelivered refund.processed (new event id) must NOT account it (it used to: debit + "completed")
    expect((await refundEvent('refund.processed', `evt_again_${r1}`, d1, { id: r1, amount: 800 })).status).toBe(200)
    expect(await rec(r1)).toMatchObject({ status: 'pending', accountingRecovery: { state: 'needs_review', conflict: 'FAILED_EVENT_AFTER_SUCCESS_EVIDENCE' } })
    await expect(svc.applyDonationRefundAccounting(r1)).rejects.toThrow(/^REFUND_OUTCOME_CONFLICT/)
    await svc.retryDonationRefundAccounting(500)
    expect((await reversals(d1.id)).length).toBe(0)
    expect(await wallet(uid)).toEqual(w1)
    expect(await don(d1.id)).toMatchObject({ refundedAmountPaise: 0 })
    expect((await ptx(d1.ptxId)).releaseStatus).toBe('held')
    await backdate(d1.ptxId); await release({ limit: 500 })
    expect((await ptx(d1.ptxId)).releaseStatus).toBe('held')                     // never released by the job
    gw.refunds.push({ id: r1, payment_id: d1.paymentId, amount: 800, status: 'processed', notes: {} })
    await refusedEverywhere(r1, d1)

    // (2) PROCESSED_EVENT_AFTER_FAILED — a dashboard refund reported failed, then processed: the unreleased donation is HELD
    const d2 = await donation(uid, 1_000)
    const r2 = `rfnd_p33_e4b_${P}`
    expect((await refundEvent('refund.failed', `evt_f_${r2}`, d2, { id: r2, amount: 300 })).status).toBe(200)
    expect(await rec(r2)).toMatchObject({ status: 'failed' })
    expect((await ptx(d2.ptxId)).releaseStatus).toBe('pending')
    expect((await refundEvent('refund.processed', `evt_p_${r2}`, d2, { id: r2, amount: 300 })).status).toBe(200)
    expect(await rec(r2)).toMatchObject({ status: 'failed', accountingRecovery: { state: 'needs_review', conflict: 'PROCESSED_EVENT_AFTER_FAILED' } })
    expect(await ptx(d2.ptxId)).toMatchObject({ releaseStatus: 'held', releaseHold: { source: svc.DONATION_OUTCOME_CONFLICT_HOLD_SOURCE, refundIds: [r2] } })
    expect((await reversals(d2.id)).length).toBe(0)
    await backdate(d2.ptxId); await release({ limit: 500 })
    expect((await ptx(d2.ptxId)).releaseStatus).toBe('held')
    gw.refunds.push({ id: r2, payment_id: d2.paymentId, amount: 300, status: 'failed', notes: {} })   // even a "failed" list never lifts it
    await refusedEverywhere(r2, d2, 'refund_outcome_conflict')         // Razorpay lists it failed: only the conflict rule refuses

    // (3) FAILED_EVENT_AFTER_PROCESSED — accounted once (full refund), then failed: stays reviewed; a repeat never re-completes or re-accounts it
    const d3 = await donation(uid, 600)
    const r3 = `rfnd_p33_e4c_${P}`
    expect((await processed(d3, r3, 600)).status).toBe(200)
    expect(await rec(r3)).toMatchObject({ status: 'processed', ledgerReversedPaise: 600 })
    expect((await refundEvent('refund.failed', `evt_f_${r3}`, d3, { id: r3, amount: 600 })).status).toBe(200)
    expect(await rec(r3)).toMatchObject({ status: 'processed', accountingRecovery: { state: 'needs_review', conflict: 'FAILED_EVENT_AFTER_PROCESSED' } })
    expect((await refundEvent('refund.processed', `evt_again_${r3}`, d3, { id: r3, amount: 600 })).status).toBe(200)
    expect(await svc.applyDonationRefundAccounting(r3)).toMatchObject({ applied: false })
    expect(await rec(r3)).toMatchObject({ status: 'processed', accountingRecovery: { state: 'needs_review', conflict: 'FAILED_EVENT_AFTER_PROCESSED' } })
    expect(await reversedNet(d3.id)).toBe(600)                                    // accounted exactly once
    gw.refunds.push({ id: r3, payment_id: d3.paymentId, amount: 600, status: 'failed', notes: {} })
    await refusedEverywhere(r3, d3)
    const h = (await health()).financial
    expect(h.donationRefundAccountingNeedsReview).toBeGreaterThanOrEqual(3)      // all three stay visible
  }, T)

  // ═══ F · bounded queues ════════════════════════════════════════════════════════════════════════════

  it('F1 · donation drain: 60 backed-off retry records ahead in order never fill the batch — the due ones behind them are accounted', async () => {
    const uid = org()
    const backedOff = Array.from({ length: 60 }, (_, i) => `0p33${P}a${String(i).padStart(3, '0')}`)
    const batch = db.batch()
    for (const id of backedOff) batch.set(db.doc(`donationRefunds/${id}`), { donationId: 'none', status: 'pending', amountPaise: 1, accountingRecovery: { state: 'retry', attempts: 1, gatewayEvidence: 'webhook_refund_processed', nextAttemptAt: FS.Timestamp.fromMillis(Date.now() + 3 * 3_600_000) } })
    await batch.commit()
    const due: string[] = []
    for (let i = 0; i < 3; i++) {
      const d = await donation(uid, 1_000)
      const id = `0p33${P}z${i}`
      fx.failApply = 1
      expect((await processed(d, id, 1_000)).status).toBe(200)
      expect((await rec(id)).accountingRecovery.state).toBe('retry')
      await dueNow(id)
      due.push(id)
    }
    const r = await svc.retryDonationRefundAccounting(3)
    expect(r.completed).toBe(3)
    expect(r.deferred).toBeGreaterThanOrEqual(60)
    for (const id of due) expect(await rec(id)).toMatchObject({ status: 'processed', accountingRecovery: { state: 'completed' } })
    for (const id of backedOff) expect((await rec(id)).accountingRecovery.attempts).toBe(1)   // untouched
    const clean = db.batch()
    for (const id of backedOff) clean.delete(db.doc(`donationRefunds/${id}`))
    await clean.commit()
  }, T)

  it('F2 · ledger-reversal queue: paging past 60 backed-off records, duplicate drains run a record once, interruption recovery, permanent → needs_review at once, transient → needs_review after the cap; health counts them', async () => {
    const uid = org()
    const col = db.collection('refundLedgerReconciliation')
    const backedOff = Array.from({ length: 60 }, (_, i) => `0p33${P}a${String(i).padStart(3, '0')}`)
    const b = db.batch()
    for (const id of backedOff) b.set(col.doc(id), { registrationId: id, ptxId: 'ptx_none', status: 'pending', attempts: 1, nextAttemptAt: FS.Timestamp.fromMillis(Date.now() + 3 * 3_600_000) })
    await b.commit()
    const h0 = (await health()).financial
    // three due reversals behind them
    const due: Array<{ id: string; ptxId: string }> = []
    for (let i = 0; i < 3; i++) {
      const p = await payment(uid, 1_000, 1_000, 'registration')
      const id = `0p33${P}z${i}`
      await col.doc(id).set({ registrationId: id, ptxId: p.ptxId, status: 'pending', attempts: 1 })
      due.push({ id, ptxId: p.ptxId })
    }
    expect((await wallet(uid)).pending).toBe(3_000)
    const r = await recon.retryPendingRefundLedgerReversals(3)
    expect(r).toMatchObject({ resolved: 3 })
    expect(r.deferred).toBeGreaterThanOrEqual(60)
    for (const x of due) { expect((await col.doc(x.id).get()).data()).toMatchObject({ status: 'resolved' }); expect((await ptx(x.ptxId)).status).toBe('refunded') }
    expect((await wallet(uid)).pending).toBe(0)

    // duplicate drains at once: the record is run by exactly one of them
    const p4 = await payment(uid, 700, 700, 'registration')
    const dupId = `0p33${P}zdup`
    await col.doc(dupId).set({ registrationId: dupId, ptxId: p4.ptxId, status: 'pending', attempts: 1 })
    const both = await Promise.all([recon.retryPendingRefundLedgerReversals(500), recon.retryPendingRefundLedgerReversals(500)])
    expect(both.reduce((s, x) => s + x.resolved, 0)).toBe(1)
    expect((await wallet(uid)).pending).toBe(0)

    // interruption: a drain that claimed the record and died leaves a lease — skipped until it ends, then run once
    const p5 = await payment(uid, 300, 300, 'registration')
    const intId = `0p33${P}zint`
    await col.doc(intId).set({ registrationId: intId, ptxId: p5.ptxId, status: 'pending', attempts: 2, nextAttemptAt: FS.Timestamp.fromMillis(Date.now() + 90_000) })
    await recon.retryPendingRefundLedgerReversals(500)
    expect((await col.doc(intId).get()).data()).toMatchObject({ status: 'pending', attempts: 2 })
    await col.doc(intId).update({ nextAttemptAt: FS.Timestamp.fromMillis(Date.now() - 1_000) })
    await recon.retryPendingRefundLedgerReversals(500)
    expect((await col.doc(intId).get()).data()).toMatchObject({ status: 'resolved', attempts: 2 })

    // permanent failure (unknown release state) → needs_review on the first run, with evidence
    const p6 = await payment(uid, 400, 400, 'registration')
    await db.doc(`platformTransactions/${p6.ptxId}`).update({ releaseStatus: FS.FieldValue.delete() })
    const permId = `0p33${P}zperm`
    await col.doc(permId).set({ registrationId: permId, ptxId: p6.ptxId, status: 'pending', attempts: 0 })
    await recon.retryPendingRefundLedgerReversals(500)
    expect((await col.doc(permId).get()).data()).toMatchObject({ status: 'needs_review', attempts: 1, escalationReason: 'permanent_error' })
    expect(String((await col.doc(permId).get()).data()!.lastError)).toMatch(/^REVERSAL_BUCKET_UNKNOWN/)

    // transient failure every run → counted once per run (due again next run), needs_review at the cap (never dropped, never forced)
    const p7 = await payment(uid, 600, 600, 'registration')
    const trId = `0p33${P}ztr`
    await col.doc(trId).set({ registrationId: trId, ptxId: p7.ptxId, status: 'pending', attempts: 0 })
    fx.failPaths.add(`platformTransactions/${p7.ptxId}`)
    for (let i = 1; i <= recon.REFUND_QUEUE_MAX_ATTEMPTS; i++) {
      await recon.retryPendingRefundLedgerReversals(500)
      const s = (await col.doc(trId).get()).data()!
      expect(s.attempts).toBe(i)
      if (i < recon.REFUND_QUEUE_MAX_ATTEMPTS) {
        expect(s.status).toBe('pending')
        expect(s.nextAttemptAt).toBeUndefined()                                // lease released: due on the next run
      } else {
        expect(s).toMatchObject({ status: 'needs_review', escalationReason: 'max_attempts' })
        expect(s.nextAttemptAt).toBeUndefined()
      }
    }
    await recon.retryPendingRefundLedgerReversals(500)                         // terminal: never picked up again
    expect((await col.doc(trId).get()).data()!.attempts).toBe(recon.REFUND_QUEUE_MAX_ATTEMPTS)
    expect((await ptx(p7.ptxId)).status).toBe('completed')                     // nothing partial committed
    const h1 = (await health()).financial
    expect(h1.refundLedgerReversalsNeedsReview).toBe(h0.refundLedgerReversalsNeedsReview + 2)
    expect(h1.refundLedgerReversalsPending).toBeGreaterThanOrEqual(60)
    const clean = db.batch()
    for (const id of backedOff) clean.delete(col.doc(id))
    await clean.commit()
  }, T)

  it('F3 · hold-closure queue: waiting on the reversal counts bounded attempts → needs_review; a refused closure stays refused; health counts both', async () => {
    const col = db.collection('refundHoldClosureReconciliation')
    const h0 = (await health()).financial
    const mk = async (tag: string, ptxStatus: string) => {
      const reg = `0p33${P}${tag}`
      await db.doc(`platformTransactions/ptx_${reg}`).set({ organizerUid: `p33-o-${P}`, sourceId: reg, sourceType: 'registration', status: ptxStatus, releaseStatus: 'held', netSettlementPaise: 0,
        releaseHold: { reason: 'refund_review', refundIds: [], heldAt: FS.Timestamp.now() }, gatewayPaymentId: `pay_${reg}`, gatewayOrderId: `order_${reg}` })
      await db.doc(`paymentIntents/order_${reg}`).set({ orderId: `order_${reg}`, registrationId: reg })
      await col.doc(reg).set({ registrationId: reg, orderId: `order_${reg}`, ptxId: `ptx_${reg}`, refundId: 'r', status: 'pending', attempts: 0 })
      return reg
    }
    const wait = await mk('wait', 'completed')          // the ledger reversal has not landed: not_reversed
    const refused = await mk('ref', 'refunded')         // reversed, but the intent is not fully refunded: refused
    for (let i = 1; i <= recon.REFUND_QUEUE_MAX_ATTEMPTS; i++) {
      await recon.retryPendingRefundHoldClosures(500)
      expect((await col.doc(wait).get()).data()!.attempts).toBe(i)
    }
    expect((await col.doc(wait).get()).data()).toMatchObject({ status: 'needs_review', escalationReason: 'max_attempts', lastError: 'waiting: not_reversed' })
    expect((await col.doc(refused).get()).data()).toMatchObject({ status: 'refused', outcome: 'not_fully_refunded' })
    expect((await ptx(`ptx_${wait}`)).releaseHold).toBeTruthy()                // holds stay
    expect((await ptx(`ptx_${refused}`)).releaseHold).toBeTruthy()
    const h1 = (await health()).financial
    expect(h1.refundHoldClosuresNeedsReview).toBe(h0.refundHoldClosuresNeedsReview + 1)
    expect(h1.refundHoldClosuresRefused).toBe(h0.refundHoldClosuresRefused + 1)
  }, T)

  it('F4 · attempt sweep: 30 unresolved attempts never starve each other — each run looks up at most limitN, a miss backs off, the rest are reached next run', async () => {
    const uid = org()
    const ds: Array<{ id: string; attemptId: string }> = []
    for (let i = 0; i < 30; i++) {
      const id = `00p33${P}s${String(i).padStart(2, '0')}`
      await donation(uid, 1_000, 1_000, id)
      const attemptId = `att_p33sweep${P}x${i}`
      await db.doc(`donations/${id}`).update({ [`refundAttempts.${attemptId}`]: { status: 'unknown', amountPaise: 100, paymentId: `pay_${id}`, by: SUPER, startedAt: FS.Timestamp.fromMillis(Date.now() - 5 * MIN) }, hasOpenRefundAttempt: true })
      ds.push({ id, attemptId })
    }
    const checks = async () => Promise.all(ds.map(async x => ((await don(x.id)).refundAttempts[x.attemptId].checks ?? 0) as number))
    const r1 = await svc.reconcileDonationRefundAttempts(25)
    expect(r1.linked).toBe(0)
    expect((await checks()).filter(c => c === 1)).toHaveLength(25)
    const r2 = await svc.reconcileDonationRefundAttempts(25)
    expect(r2.deferred).toBeGreaterThanOrEqual(25)
    expect(await checks()).toEqual(Array(30).fill(1))                           // every attempt reached within two runs
    for (const x of ds) expect((await don(x.id)).refundAttempts[x.attemptId].status).toBe('unknown')   // never concluded by the sweep
  }, T)

  // ═══ G · cursor paging ═════════════════════════════════════════════════════════════════════════════

  it('G · the hold list, the attempt list and the review list page by a stable id cursor: every row exactly once, in order, also when a row leaves between pages', async () => {
    const ours: string[] = []
    for (let i = 0; i < 7; i++) {
      const id = `ptx_00p33g${P}_${i}`
      await db.doc(`platformTransactions/${id}`).set({ organizerUid: `p33-g-${P}`, sourceId: `00p33g${P}_${i}`, sourceType: 'registration', status: 'completed', releaseStatus: 'held', netSettlementPaise: 100,
        releaseHold: { reason: 'refund_review', refundIds: [], heldAt: FS.Timestamp.now() }, gatewayPaymentId: `pay_g${i}`, gatewayOrderId: `order_g${i}` })
      ours.push(id)
    }
    const walk = async (limit: number, mutate?: (page: number) => Promise<void>) => {
      const seen: string[] = []
      let cursor: string | null = null
      for (let page = 0; page < 1_000; page++) {
        const r = await listRefundHolds(limit, cursor)
        seen.push(...r.items.map(x => x.ptxId))
        if (mutate) await mutate(page)
        if (!r.nextCursor) { expect(r.truncated).toBe(false); break }
        expect(r.truncated).toBe(true)
        cursor = r.nextCursor
      }
      return seen
    }
    const all = await walk(3)
    expect(new Set(all).size).toBe(all.length)                                  // no duplicates
    expect(all).toEqual([...all].sort())                                        // stable id order
    expect(all.filter(x => ours.includes(x))).toEqual(ours)
    // a hold resolved between pages (one already shown) does not shift the next page
    const shifted = await walk(3, async page => { if (page === 0) await db.doc(`platformTransactions/${all[0]}`).update({ releaseHold: FS.FieldValue.delete() }) })
    expect(shifted).toEqual(all)
    // holds ARRIVING mid-walk: one sorting behind the cursor, one ahead. Existing rows: each exactly once;
    // the one ahead is shown; the one behind is not shown in THIS walk (it is on the next walk from the start)
    const mkHold = (id: string) => db.doc(`platformTransactions/${id}`).set({ organizerUid: `p33-g-${P}`, sourceId: id, sourceType: 'registration', status: 'completed', releaseStatus: 'held', netSettlementPaise: 1,
      releaseHold: { reason: 'refund_review', refundIds: [], heldAt: FS.Timestamp.now() }, gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}` })
    const before = await walk(1_000)
    const behind = `ptx_00p33g${P}_0a`, ahead = `ptx_zzzz_p33g${P}`
    const arrived = await walk(2, async page => { if (page === 1) { await mkHold(behind); await mkHold(ahead) } })
    expect(new Set(arrived).size).toBe(arrived.length)
    expect(arrived.filter(x => x !== ahead)).toEqual(before)
    expect(arrived).toContain(ahead)
    expect(arrived).not.toContain(behind)
    expect(await walk(1_000)).toEqual([...before, behind, ahead].sort())
    for (const id of [behind, ahead]) await db.doc(`platformTransactions/${id}`).delete()
    // through the route
    let cursor: string | null = null, viaRoute: string[] = []
    do {
      const r = await get(holdsGet, `http://x/api/admin/finance/refund-holds?limit=4${cursor ? `&cursor=${cursor}` : ''}`)
      expect(r.status).toBe(200)
      viaRoute = viaRoute.concat((r.body.items as Array<{ ptxId: string }>).map(x => x.ptxId))
      cursor = r.body.nextCursor as string | null
    } while (cursor)
    expect(viaRoute).toEqual(all.slice(1))                                      // everything but the hold resolved above, once each, in order
    expect((await get(holdsGet, 'http://x/api/admin/finance/refund-holds?cursor=bad cursor')).status).toBe(400)
    expect((await get(holdsGet, 'http://x/api/admin/finance/refund-holds', 'Bearer admin')).status).toBe(403)

    // the refund-attempt list (F4's 30 donations with open attempts are in it)
    let ac: string | null = null, attemptDonations: string[] = []
    do {
      const r = await get(attemptsGet, `http://x/api/admin/finance/refund-attempts?limit=7${ac ? `&cursor=${ac}` : ''}`)
      expect(r.status).toBe(200)
      attemptDonations = attemptDonations.concat((r.body.items as Array<{ donationId: string }>).map(x => x.donationId))
      ac = r.body.nextCursor as string | null
    } while (ac)
    const sweepIds = Array.from({ length: 30 }, (_, i) => `00p33${P}s${String(i).padStart(2, '0')}`)
    expect(attemptDonations.filter(x => sweepIds.includes(x))).toEqual(sweepIds)
    expect(new Set(attemptDonations).size).toBe(attemptDonations.length)

    // the needs_review list
    let rc: string | null = null, reviewIds: string[] = []
    do {
      const r = await get(reviewsGet, `http://x/api/admin/finance/refund-reviews?limit=1${rc ? `&cursor=${rc}` : ''}`)
      expect(r.status).toBe(200)
      reviewIds = reviewIds.concat((r.body.items as Array<{ refundId: string }>).map(x => x.refundId))
      rc = r.body.nextCursor as string | null
    } while (rc)
    expect(new Set(reviewIds).size).toBe(reviewIds.length)
    expect(reviewIds).toEqual([...reviewIds].sort())
    expect(reviewIds).toContain(`rfnd_p33_e2c_${P}`)                            // the contradictory record stays listed
    expect((await get(reviewsGet, 'http://x/api/admin/finance/refund-reviews', 'Bearer admin')).status).toBe(403)
  }, T)
})
