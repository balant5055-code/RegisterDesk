// Phase 2.2 — a donation refund REQUEST whose gateway outcome is unknown, on REAL Firestore, through the
// real Super Admin refund route, the real donation webhook, the real reconciliation sweep, the real
// Super Admin refund-hold route (evidence-gated lift) and the real release job.
//
//   every request is recorded (attempt) and the unreleased donation HELD before Razorpay is called
//   structured 4xx            → rejected: reservation freed, this attempt's own hold removed
//   timeout / network / 5xx   → unknown: reservation KEPT, hold KEPT, no new request accepted
//   a refund carrying the attempt id in its notes (webhook or refund list) → linked; its outcome applies
//   "no refund" only via the Super Admin lift, ≥ 15 min old AND Razorpay showing no live refund (PD-2)
// Synthetic data only; the gateway stub counts every refund-creation call.

import crypto from 'crypto'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const WHSEC = 'dra_webhook_secret'
const SUPER = `dra-super-${P}`
const MIN = 60_000

const gw = vi.hoisted(() => ({
  /** ok · lost (created, then the call throws) · timeout (throws, nothing created) · reject (structured 400) */
  mode: 'ok' as 'ok' | 'lost' | 'timeout' | 'reject',
  status: 'processed' as string,
  lookup: 'real' as 'real' | 'throw',
  calls: 0,
  gate: null as null | Promise<void>,
  refunds: [] as Array<{ id: string; payment_id: string; amount: number; status: string; notes: Record<string, string> }>,
}))
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), RAZORPAY_WEBHOOK_SECRET: WHSEC }))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_dra', RAZORPAY_KEY_SECRET: 'dra',
  razorpay: { payments: {
    refund: async (paymentId: string, o: { amount: number; notes?: Record<string, string> }) => {
      gw.calls++
      if (gw.gate) await gw.gate
      if (gw.mode === 'reject') throw { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR', description: 'simulated rejection' } }
      if (gw.mode === 'timeout') throw new Error('timeout of 0ms exceeded (simulated: no response)')
      const r = { id: `rfnd_dra_${P}_${gw.calls}`, payment_id: paymentId, amount: o.amount, status: gw.status, notes: o.notes ?? {} }
      gw.refunds.push(r)
      if (gw.mode === 'lost') throw new Error('socket hang up (simulated: refund created, response lost)')
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
  resolveAdminUid:      async (hd: string | null) => (hd === 'Bearer super' ? SUPER : hd === 'Bearer admin' ? `dra-admin-${process.pid}` : null),
  resolveSuperAdminUid: async (hd: string | null) => (hd === 'Bearer super' ? SUPER : null),
  legacyAdminClaimOnly: async () => false,
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined, captureWebhookError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('Phase 2.2 · unknown gateway refund outcome safety', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let svc: typeof import('@/lib/donations/refundService')
  let webhook: (r: NextRequest) => Promise<Response>
  let orgRefund: (r: NextRequest, c: { params: Promise<{ donationId: string }> }) => Promise<Response>
  let holds: (r: NextRequest) => Promise<Response>
  let health: typeof import('@/lib/operations/healthMetrics').getOperationsHealth
  let n = 0
  let failBegin = 0

  const org = () => `dra-org-${P}-${++n}`
  const wallet = async (uid: string) => {
    const w = (await db.doc(`organizerRevenueWallets/${uid}`).get()).data() ?? {}
    return { pending: w.pendingPaise as number, available: w.availablePaise as number }
  }
  const ptx = async (id: string) => (await db.doc(`platformTransactions/${id}`).get()).data() ?? {}
  const don = async (id: string) => (await db.doc(`donations/${id}`).get()).data() ?? {}
  const rec = async (id: string) => (await db.doc(`donationRefunds/${id}`).get()).data() ?? {}
  const attemptsOf = async (id: string) => Object.entries((await don(id)).refundAttempts ?? {}) as Array<[string, Record<string, unknown>]>
  const reversalRows = async (donationId: string) => (await db.collection('platformTransactions').where('parentTransactionId', '==', `ptx_${donationId}`).get()).size
  const backdate = (id: string) => db.doc(`platformTransactions/${id}`).update({ paidAt: new Date(Date.now() - 10 * 86_400_000) })
  const releases = async (ptxId: string) => (await db.collection('settlementReleases').where('transactionId', '==', ptxId).get()).size
  const ageAttempt = (donationId: string, attemptId: string, minutes: number) =>
    db.doc(`donations/${donationId}`).update({ [`refundAttempts.${attemptId}.startedAt`]: FS.Timestamp.fromMillis(Date.now() - minutes * MIN) })

  async function payment(uid: string, net: number, kind: 'donation' | 'registration') {
    const id = `dra-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: kind === 'donation' ? 'donation' : 'event_registration', category: kind === 'donation' ? 'donation' : 'ticketed',
      organizerUid: uid, entityId: `dra-camp-${P}`, entityType: kind === 'donation' ? 'campaign' : 'event', sourceId: id, sourceType: kind,
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: net, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0,
      gatewayFeeEstimatePaise: 0, netSettlementPaise: net, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x',
      currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: net, feesTotalPaise: 0, netSettlementPaise: net } as never)
    return { id, ptxId: `ptx_${id}`, paymentId: `pay_${id}`, orderId: `order_${id}` }
  }
  async function donation(uid: string, gross: number) {
    const p = await payment(uid, gross, 'donation')
    await db.doc(`donations/${p.id}`).set({
      amountPaise: gross, campaignId: `dra-camp-${P}`, campaignSlug: `dra-camp-${P}`, organizerUid: uid, donorEmail: `d${n}@x.test`, donorName: 'D',
      isAnonymous: false, status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: p.orderId, razorpayPaymentId: p.paymentId,
    })
    return p
  }
  const organizerRefund = async (donationId: string, amountPaise: number) => {
    const res = await orgRefund(
      new NextRequest(`http://x/api/organizer/donations/${donationId}/refund`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer super' }, body: JSON.stringify({ amountPaise, reason: 'donor asked for a refund' }) }),
      { params: Promise.resolve({ donationId }) },
    )
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  function refundEvent(event: 'refund.processed' | 'refund.failed', eventId: string, d: { id: string; paymentId: string; orderId: string }, r: { id: string; amount: number; notes: Record<string, string> }) {
    const body = JSON.stringify({ id: eventId, event, payload: {
      refund:  { entity: { id: r.id, payment_id: d.paymentId, amount: r.amount, status: event === 'refund.failed' ? 'failed' : 'processed', notes: r.notes } },
      payment: { entity: { id: d.paymentId, order_id: d.orderId, amount: r.amount, currency: 'INR', status: 'captured', notes: { donationId: d.id } } },
    } })
    const sig = crypto.createHmac('sha256', WHSEC).update(body).digest('hex')
    return webhook(new NextRequest('http://x/api/razorpay/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body }))
  }
  let req = 0
  const lift = async (ptxId: string, refundIds: string[], auth = 'Bearer super') => {
    const r = await holds(new NextRequest('http://x/api/admin/finance/refund-holds', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ ptxId, outcome: 'lift_hold_no_refund', reason: 'reconciled against the Razorpay dashboard', confirm: true, expectedRefundIds: refundIds, requestId: `drareq${P}x${++req}` }),
    }))
    return { status: r.status, body: await r.json() as Record<string, unknown> }
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
    health = (await import('@/lib/operations/healthMetrics')).getOperationsHealth
  }, T)
  beforeEach(() => {
    vi.restoreAllMocks()
    gw.mode = 'ok'; gw.status = 'processed'; gw.lookup = 'real'; gw.gate = null; failBegin = 0
    // pre-submission failure injection: the attempt transaction's read of the ledger row throws
    const orig = db.runTransaction.bind(db)
    vi.spyOn(db, 'runTransaction').mockImplementation((async (fn: (tx: FirebaseFirestore.Transaction) => unknown, opts?: never) =>
      orig(async tx => {
        const get = tx.get.bind(tx) as (q: unknown) => unknown
        ;(tx as unknown as { get: unknown }).get = (q: { path?: string }) => {
          if (failBegin > 0 && typeof q?.path === 'string' && q.path.startsWith('platformTransactions/ptx_')) { failBegin--; return Promise.reject(new Error('simulated attempt write failure')) }   // async, like a real failed read (a sync throw strands the reads already issued)
          return get(q)
        }
        return fn(tx)
      }, opts)) as never)
  })

  it('1 · timeout AFTER Razorpay created the refund ⇒ durable unknown attempt, reservation kept, donation held, no new request; the sweep finds it by its notes and accounts it EXACTLY once', async () => {
    const uid = org()
    const d = await donation(uid, 2_000)
    const b = await payment(uid, 500, 'registration')
    const h0 = (await health()).financial.donationRefundAttemptsUnresolved
    gw.mode = 'lost'
    const calls0 = gw.calls
    const r = await organizerRefund(d.id, 800)
    expect(r).toMatchObject({ status: 502, body: { code: 'REFUND_OUTCOME_UNKNOWN' } })
    const [[attemptId, attempt]] = await attemptsOf(d.id)
    expect(attempt).toMatchObject({ status: 'unknown', amountPaise: 800, paymentId: d.paymentId, by: SUPER })
    expect(r.body.attemptId).toBe(attemptId)
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 800, hasOpenRefundAttempt: true })   // reservation KEPT
    expect(await ptx(d.ptxId)).toMatchObject({ releaseStatus: 'held', releaseHold: { source: svc.DONATION_OUTCOME_UNKNOWN_HOLD_SOURCE, attemptIds: [attemptId], refundIds: [] } })
    expect((await health()).financial.donationRefundAttemptsUnresolved).toBe(h0 + 1)
    // no release while unresolved; the unrelated payment releases from its own funds
    await backdate(d.ptxId); await backdate(b.ptxId)
    await release({ limit: 500 })
    expect(await releases(d.ptxId)).toBe(0)
    expect((await ptx(b.ptxId)).releaseStatus).toBe('released')
    expect(await wallet(uid)).toMatchObject({ pending: 2_000, available: 500 })
    // a repeated request is refused — never a second gateway refund
    expect(await organizerRefund(d.id, 800)).toMatchObject({ status: 409, body: { code: 'REFUND_ATTEMPT_UNRESOLVED' } })
    expect(gw.calls).toBe(calls0 + 1)
    // the sweep (read-only lookup; the attempt id is in the refund's notes) links and accounts it — 3 workers at once
    await ageAttempt(d.id, attemptId, 3)
    await Promise.all([0, 1, 2].map(() => svc.reconcileDonationRefundAttempts(500)))
    const refundId = gw.refunds.at(-1)!.id
    expect((await attemptsOf(d.id))[0][1]).toMatchObject({ status: 'linked', refundId })
    expect(await rec(refundId)).toMatchObject({ status: 'processed', initiatedBy: SUPER, ledgerReversedPaise: 800 })
    expect(await reversalRows(d.id)).toBe(1)
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 0, refundedAmountPaise: 800, hasOpenRefundAttempt: false })
    expect(await wallet(uid)).toMatchObject({ pending: 1_200, available: 500 })
    // a partial refund: the Phase 1 manual-review hold remains
    expect(await ptx(d.ptxId)).toMatchObject({ releaseStatus: 'held', releaseHold: { source: 'donation_partial_refund', refundIds: [refundId] } })
    expect(gw.calls).toBe(calls0 + 1)
  }, T)

  it('2 · timeout with NO refund created: inconclusive lookups keep it open; the lift is refused when too recent, unauthorized, or while money shows at Razorpay; after 15 min with none it is resolved, audited, and released', async () => {
    const uid = org()
    const d = await donation(uid, 1_500)
    gw.mode = 'timeout'
    expect((await organizerRefund(d.id, 500)).body).toMatchObject({ code: 'REFUND_OUTCOME_UNKNOWN' })
    const [[attemptId]] = await attemptsOf(d.id)
    await ageAttempt(d.id, attemptId, 3)
    await svc.reconcileDonationRefundAttempts(500)                         // empty list: inconclusive — stays open
    expect((await attemptsOf(d.id))[0][1]).toMatchObject({ status: 'unknown', checks: 1 })
    // Phase 3.3 — the miss backs the attempt off; make it due again (fixture clock) so the failing lookup really runs
    await db.doc(`donations/${d.id}`).update({ [`refundAttempts.${attemptId}.nextCheckAt`]: FS.Timestamp.fromMillis(Date.now() - 1_000) })
    gw.lookup = 'throw'
    const failed = await svc.reconcileDonationRefundAttempts(500)          // lookup failure: stays open
    expect(failed.linked).toBe(0)
    expect((await attemptsOf(d.id))[0][1]).toMatchObject({ status: 'unknown', checks: 2 })   // the lookup ran and failed
    expect((await attemptsOf(d.id))[0][1].refundId ?? null).toBeNull()      // never linked, never concluded
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 500, refundedAmountPaise: 0, hasOpenRefundAttempt: true })   // reservation kept
    expect((await db.collection('donationRefunds').where('donationId', '==', d.id).get()).size).toBe(0)   // no refund recorded (not failed, not none)
    expect((await attemptsOf(d.id))[0][1]).toMatchObject({ status: 'unknown' })
    expect((await ptx(d.ptxId)).releaseStatus).toBe('held')
    // the lift: gateway unreadable → 503; too recent → refused; not a Super Admin → 403
    expect((await lift(d.ptxId, [])).status).toBe(503)
    gw.lookup = 'real'
    expect(await lift(d.ptxId, [])).toMatchObject({ status: 409, body: { why: 'attempt_too_recent' } })
    expect((await lift(d.ptxId, [], 'Bearer admin')).status).toBe(403)
    await ageAttempt(d.id, attemptId, 16)
    // a live refund on the payment at Razorpay (not tied to the attempt) still refuses the lift
    gw.refunds.push({ id: `rfnd_dra_other_${P}`, payment_id: d.paymentId, amount: 100, status: 'processed', notes: {} })
    expect((await lift(d.ptxId, [])).status).toBe(409)
    gw.refunds.pop()
    // authoritative: ≥ 15 min AND Razorpay shows no live refund on the payment → resolved, in one audited decision
    const ok = await lift(d.ptxId, [])
    expect(ok.status).toBe(200)
    expect((await attemptsOf(d.id))[0][1]).toMatchObject({ status: 'resolved_none', resolvedBy: SUPER })
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 0, hasOpenRefundAttempt: false })
    const t = await ptx(d.ptxId)
    expect(t).toMatchObject({ status: 'completed', releaseStatus: 'pending' })
    expect(t.releaseHold).toBeUndefined()
    const audit = (await db.collection('adminAuditLogs').where('entityId', '==', d.ptxId).where('action', '==', 'settlement.refund_hold_lifted').get()).docs
    expect(audit).toHaveLength(1)
    expect(audit[0].data()).toMatchObject({ adminUid: SUPER, metadata: { attemptIds: [attemptId], attemptsResolvedNone: [attemptId], refundsAtGateway: 'none' } })
    await backdate(d.ptxId); await release({ limit: 500 })
    expect((await ptx(d.ptxId)).releaseStatus).toBe('released')
    expect(await wallet(uid)).toMatchObject({ pending: 0, available: 1_500 })
  }, T)

  it('3 · a structured 4xx proves no refund: rejected, reservation freed, its own hold removed (evidence kept); a failure BEFORE submission never calls Razorpay', async () => {
    const uid = org()
    const d = await donation(uid, 1_000)
    gw.mode = 'reject'
    expect(await organizerRefund(d.id, 400)).toMatchObject({ status: 502, body: { code: 'REFUND_REJECTED' } })
    const [[attemptId, a]] = await attemptsOf(d.id)
    expect(a).toMatchObject({ status: 'rejected' })
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 0, hasOpenRefundAttempt: false })
    const t = await ptx(d.ptxId)
    expect(t.releaseStatus).toBe('pending'); expect(t.releaseHold).toBeUndefined()
    expect(t.releaseHoldHistory?.[`attempt_rejected_${attemptId}`]).toMatchObject({ outcome: 'attempt_rejected' })
    // pre-submission: the attempt cannot be recorded ⇒ nothing sent, reservation freed, nothing held
    const d2 = await donation(uid, 1_000)
    gw.mode = 'ok'
    const calls0 = gw.calls
    failBegin = 1
    expect(await organizerRefund(d2.id, 300)).toMatchObject({ status: 503, body: { code: 'REFUND_NOT_SUBMITTED' } })
    expect(gw.calls).toBe(calls0)
    expect(await don(d2.id)).toMatchObject({ pendingRefundPaise: 0 })
    expect((await don(d2.id)).refundAttempts).toBeUndefined()
    expect((await ptx(d2.ptxId)).releaseStatus).toBe('pending')
  }, T)

  it('4 · signed webhooks resolve the right attempt: processed is accounted once (duplicates add nothing); failed frees the reservation and the hold stays until an authorized lift', async () => {
    const uid = org()
    const d = await donation(uid, 1_000)
    gw.mode = 'lost'; gw.status = 'pending'
    await organizerRefund(d.id, 1_000)
    const created = gw.refunds.at(-1)!
    expect(created.notes.attemptId).toMatch(/^att_/)
    for (const ev of [`evt_dra_4a_${P}`, `evt_dra_4a_${P}`, `evt_dra_4b_${P}`]) expect((await refundEvent('refund.processed', ev, d, created)).status).toBe(200)
    expect((await attemptsOf(d.id))[0][1]).toMatchObject({ status: 'linked', refundId: created.id })
    expect(await rec(created.id)).toMatchObject({ status: 'processed', isFullRefund: true, initiatedBy: SUPER })
    expect(await reversalRows(d.id)).toBe(1)
    expect(await don(d.id)).toMatchObject({ pendingRefundPaise: 0, refundedAmountPaise: 1_000 })
    const t = await ptx(d.ptxId)
    expect(t).toMatchObject({ status: 'refunded' }); expect(t.releaseHold).toBeUndefined()   // full refund: closed with evidence
    expect(Object.values(t.releaseHoldHistory ?? {})).toHaveLength(1)

    const d2 = await donation(uid, 900)
    gw.mode = 'timeout'
    await organizerRefund(d2.id, 300)
    const [[attemptId]] = await attemptsOf(d2.id)
    const failedRefund = { id: `rfnd_dra_f_${P}`, amount: 300, notes: { donationId: d2.id, attemptId } }
    gw.refunds.push({ ...failedRefund, payment_id: d2.paymentId, status: 'failed' })
    await refundEvent('refund.failed', `evt_dra_4f_${P}`, d2, failedRefund)
    expect((await attemptsOf(d2.id))[0][1]).toMatchObject({ status: 'linked', refundId: failedRefund.id })
    expect(await rec(failedRefund.id)).toMatchObject({ status: 'failed', initiatedBy: SUPER })
    expect(await don(d2.id)).toMatchObject({ pendingRefundPaise: 0, hasOpenRefundAttempt: false })
    expect(await reversalRows(d2.id)).toBe(0)
    expect((await ptx(d2.ptxId)).releaseStatus).toBe('held')               // never auto-lifted
    expect(await lift(d2.ptxId, [failedRefund.id])).toMatchObject({ status: 200 })   // authorized, evidence-gated
    expect((await ptx(d2.ptxId)).releaseStatus).toBe('pending')
  }, T)

  it('5 · a second request while the first is IN FLIGHT at the gateway is refused (no second gateway call); racing attempt creations admit exactly one', async () => {
    const uid = org()
    const d = await donation(uid, 1_000)
    let open!: () => void
    gw.gate = new Promise<void>(r => { open = r })
    const calls0 = gw.calls
    const a = organizerRefund(d.id, 300)
    for (let i = 0; i < 200 && gw.calls === calls0; i++) await new Promise(r => setTimeout(r, 25))   // A is now at the gateway
    expect(gw.calls).toBe(calls0 + 1)
    expect((await attemptsOf(d.id))[0][1]).toMatchObject({ status: 'submitting' })
    const b = await organizerRefund(d.id, 300)                              // B while A's outcome is open
    expect(b).toMatchObject({ status: 409, body: { code: 'REFUND_ATTEMPT_UNRESOLVED' } })
    expect((await don(d.id)).pendingRefundPaise).toBe(300)                  // B's reservation was not kept
    open()
    expect((await a).status).toBe(200)
    expect(gw.calls).toBe(calls0 + 1)
    expect((await attemptsOf(d.id)).map(([, x]) => x.status)).toEqual(['linked'])
    expect(await reversalRows(d.id)).toBe(1)
    // two attempt creations racing in transactions: exactly one is admitted
    const d2 = await donation(uid, 1_000)
    const rs = await Promise.all([0, 1, 2].map(i => svc.beginDonationRefundAttempt({ donationId: d2.id, attemptId: `att_race${P}x${i}abcdef`, amountPaise: 100, paymentId: d2.paymentId, by: SUPER })))
    expect(rs.filter(r => r.ok)).toHaveLength(1)
    expect(rs.filter(r => !r.ok).every(r => !r.ok && r.code === 'REFUND_ATTEMPT_UNRESOLVED')).toBe(true)
  }, T)
})
