// F1 follow-up — Super Admin review of settlement holds caused by refunds, on REAL Firestore through the
// real route (/api/admin/finance/refund-holds), the real hold-creating path (accumulatePaymentRefund /
// recordRefundFailure), the real release job and the real wallet reconciliation.
// Razorpay is an in-memory stub: its refund-CREATE endpoint throws if ever called.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const SUPER = `rhr-super-${P}`
const ORG = `rhr-org-${P}`

const h = vi.hoisted(() => ({
  refundCalls: 0,
  lookupCalls: 0,
  /** paymentId → gateway refunds (read-only lookup) */
  gateway: new Map<string, Array<{ id: string; amount: number; status: string }>>(),
  lookupThrows: false,
  auditFail: false,
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_rhr', RAZORPAY_KEY_SECRET: 'rhr',
  razorpay: { payments: {
    refund: async () => { h.refundCalls++; throw new Error('the refund-hold workflow must never create a refund') },
    fetchMultipleRefund: async (paymentId: string) => {
      h.lookupCalls++
      if (h.lookupThrows) throw new Error('lookup down')
      const items = h.gateway.get(paymentId) ?? []
      return { entity: 'collection', count: items.length, items }
    },
  } },
}))
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async (hd: string | null) => (hd === 'Bearer super' ? SUPER : hd === 'Bearer admin' ? `rhr-admin-${process.pid}` : null),
  resolveSuperAdminUid: async (hd: string | null) => (hd === 'Bearer super' ? SUPER : null),
  legacyAdminClaimOnly: async () => false,
}))
vi.mock('@/lib/admin/audit', async orig => {
  const real = await orig<typeof import('@/lib/admin/audit')>()
  return { ...real, stageAdminAudit: (...a: Parameters<typeof real.stageAdminAudit>) => {
    if (h.auditFail) { h.auditFail = false; throw new Error('simulated audit write failure') }
    return real.stageAdminAudit(...a)
  } }
})
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('F1 follow-up · Super Admin settlement refund-hold review (real Firestore)', () => {
  let db: import('firebase-admin/firestore').Firestore
  let GET: (r: NextRequest) => Promise<Response>
  let POST: (r: NextRequest) => Promise<Response>
  let refunds: typeof import('@/lib/refunds/registrationRefunds')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let reconcileWallet: typeof import('@/lib/reconciliation/wallets').reconcileOneWallet
  let n = 0
  let req = 0

  const ptx = async (regId: string) => (await db.doc(`platformTransactions/ptx_${regId}`).get()).data() ?? {}
  const audits = async (regId: string) => (await db.collection('adminAuditLogs').where('entityId', '==', `ptx_${regId}`).get()).docs.map(d => d.data())
  const walletClean = async () => expect(await reconcileWallet(ORG, (await db.doc(`organizerRevenueWallets/${ORG}`).get()).data()!)).toEqual([])
  const rid = () => `rhrreq${P}x${++req}`

  /** A credited ₹10 registration payment (ledger + wallet via the real credit path) with its intent. */
  async function payment() {
    const id = `rhr-${P}-${++n}`
    await credit({ id: `ptx_${id}`, type: 'event_registration', category: 'ticketed', organizerUid: ORG, entityId: `rhr-ev-${P}`, entityType: 'event',
      sourceId: id, sourceType: 'registration', payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: 1_000, platformFeeBasePaise: 0, platformFeeGstPaise: 0,
      platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0, netSettlementPaise: 1_000, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x',
      currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `p_${id}`, gatewayOrderId: `o_${id}` } as never,
      { organizerUid: ORG, grossAmountPaise: 1_000, feesTotalPaise: 0, netSettlementPaise: 1_000 } as never)
    await db.doc(`paymentIntents/o_${id}`).set({ orderId: `o_${id}`, amount: 1_000, currency: 'INR', status: 'paid', paymentId: `p_${id}`, registrationId: id, organizerUid: ORG, eventSlug: `rhr-ev-${P}` })
    return { id, orderId: `o_${id}`, paymentId: `p_${id}` }
  }
  /** A partial refund recorded + counted the way the webhook does it (this creates the hold). */
  async function partialRefund(p: { id: string; orderId: string; paymentId: string }, refundId: string, amount = 400) {
    await refunds.ensureRegistrationRefundRecord({ razorpayRefundId: refundId, gatewayPaymentId: p.paymentId, gatewayOrderId: p.orderId, amountPaise: amount,
      origin: 'webhook', initiatedBy: 'webhook', reason: 'gateway_refund_processed', registrationId: p.id, eventSlug: `rhr-ev-${P}`, organizerUid: ORG })
    return refunds.accumulatePaymentRefund(p.orderId, refundId, amount)
  }
  const failRefund = (p: { id: string; orderId: string; paymentId: string }, refundId: string, amount = 400) => refunds.recordRefundFailure({
    razorpayRefundId: refundId, gatewayPaymentId: p.paymentId, gatewayOrderId: p.orderId, amountPaise: amount,
    origin: 'webhook', initiatedBy: 'webhook', reason: 'gateway_refund_failed', registrationId: p.id, eventSlug: `rhr-ev-${P}`, organizerUid: ORG, failureReason: 'bank rejected',
  })
  const post = (body: Record<string, unknown>, auth: string | null = 'Bearer super') =>
    POST(new NextRequest('http://x/api/admin/finance/refund-holds', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) }))
  const decide = (regId: string, outcome: string, expectedRefundIds: string[], extra: Record<string, unknown> = {}) =>
    post({ ptxId: `ptx_${regId}`, outcome, reason: 'reviewed with finance team', confirm: true, expectedRefundIds, requestId: rid(), ...extra })
  const getHold = async (regId: string) => {
    const r = await GET(new NextRequest(`http://x/api/admin/finance/refund-holds?id=ptx_${regId}`, { headers: { authorization: 'Bearer super' } }))
    return { status: r.status, body: await r.json() as Record<string, unknown> & { hold: Record<string, unknown>; audit: unknown[] } }
  }
  const backdate = (regId: string) => db.doc(`platformTransactions/ptx_${regId}`).update({ paidAt: new Date(Date.now() - 5 * 86_400_000) })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    ;({ GET, POST } = await import('@/app/api/admin/finance/refund-holds/route') as never)
    refunds = await import('@/lib/refunds/registrationRefunds')
    credit = (await import('@/lib/firebase/firestore/platformTransactions')).recordPlatformTransactionAndCredit
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    reconcileWallet = (await import('@/lib/reconciliation/wallets')).reconcileOneWallet
  }, T)
  beforeEach(() => { h.lookupThrows = false; h.auditFail = false; vi.restoreAllMocks() })

  it('1+2 · unauthorized callers, a missing/short reason, no confirmation or an unsupported outcome change NOTHING', async () => {
    const p = await payment(); await partialRefund(p, `rfnd_rhr_a_${P}`)
    const before = await ptx(p.id)
    expect((await post({ ptxId: `ptx_${p.id}`, outcome: 'record_review', reason: 'valid reason', confirm: true, expectedRefundIds: [`rfnd_rhr_a_${P}`], requestId: rid() }, null)).status).toBe(403)
    expect((await post({ ptxId: `ptx_${p.id}`, outcome: 'record_review', reason: 'valid reason', confirm: true, expectedRefundIds: [`rfnd_rhr_a_${P}`], requestId: rid() }, 'Bearer admin')).status).toBe(403)
    expect((await GET(new NextRequest('http://x/api/admin/finance/refund-holds', { headers: { authorization: 'Bearer admin' } }))).status).toBe(403)
    for (const bad of [{ reason: '' }, { reason: 'no' }, { confirm: false }, { confirm: 'yes' }]) {
      expect((await decide(p.id, 'record_review', [`rfnd_rhr_a_${P}`], bad)).status).toBe(400)
    }
    for (const outcome of ['release_anyway', 'debit_organizer', 'absorb_loss', 'force_release']) {
      const r = await decide(p.id, outcome, [`rfnd_rhr_a_${P}`])
      expect(r.status).toBe(400)
      expect((await r.json() as { code: string }).code).toBe('UNSUPPORTED_OUTCOME')
    }
    expect(await ptx(p.id)).toEqual(before)
    expect(await audits(p.id)).toHaveLength(0)
  }, T)

  it('3+6 · record_review keeps the funds held, is audited with before/after; a duplicate submission is idempotent; a reused requestId for another outcome is refused', async () => {
    const p = await payment(); await partialRefund(p, `rfnd_rhr_b_${P}`)
    const requestId = rid()
    const body = { ptxId: `ptx_${p.id}`, outcome: 'record_review', reason: 'customer partial refund confirmed by support', confirm: true, expectedRefundIds: [`rfnd_rhr_b_${P}`], requestId }
    const r1 = await post(body); expect(r1.status).toBe(200)
    const r2 = await post(body); expect(r2.status).toBe(200)
    expect(await r2.json()).toMatchObject({ duplicate: true, releaseStatus: 'held' })
    const t = await ptx(p.id)
    expect(t).toMatchObject({ releaseStatus: 'held', releaseHold: { refundIds: [`rfnd_rhr_b_${P}`] } })
    expect(Object.keys(t.releaseHoldReviews)).toEqual([requestId])
    const a = await audits(p.id)
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ action: 'settlement.refund_hold_reviewed', adminUid: SUPER, reason: 'customer partial refund confirmed by support', entityType: 'settlement' })
    expect(a[0].metadata).toMatchObject({ outcome: 'record_review', releaseStatusAfter: 'held' })
    expect((await post({ ...body, outcome: 'lift_hold_no_refund' })).status).toBe(409)       // same requestId, other outcome
    const d = await getHold(p.id)
    expect(d.status).toBe(200)
    expect(d.body.audit).toHaveLength(1)
    expect(d.body.hold).toMatchObject({ liftable: { ok: false, why: 'refund_not_failed' } })
    expect(h.refundCalls).toBe(0)
  }, T)

  it('4+9 · a partial refund that really moved money can NOT be lifted (gateway shows it, or records still count it); contradictory records keep it held', async () => {
    const p = await payment(); await partialRefund(p, `rfnd_rhr_c_${P}`)
    h.gateway.set(p.paymentId, [{ id: `rfnd_rhr_c_${P}`, amount: 400, status: 'processed' }])
    const r1 = await decide(p.id, 'lift_hold_no_refund', [`rfnd_rhr_c_${P}`])
    expect(r1.status).toBe(409); expect((await r1.json() as { code: string }).code).toBe('REFUND_FOUND_AT_GATEWAY')
    h.gateway.delete(p.paymentId)                                          // gateway now says none — records still say money out
    const r2 = await decide(p.id, 'lift_hold_no_refund', [`rfnd_rhr_c_${P}`])
    expect(r2.status).toBe(409); expect(await r2.json()).toMatchObject({ code: 'HOLD_NOT_LIFTABLE', why: 'refund_not_failed' })
    // the held refund FAILED, but ANOTHER refund of the same payment still counts as money out → still held
    await failRefund(p, `rfnd_rhr_c_${P}`)
    await refunds.ensureRegistrationRefundRecord({ razorpayRefundId: `rfnd_rhr_c2_${P}`, gatewayPaymentId: p.paymentId, gatewayOrderId: p.orderId, amountPaise: 100,
      origin: 'webhook', initiatedBy: 'webhook', reason: 'x', registrationId: p.id, eventSlug: null, organizerUid: ORG })
    const r3 = await decide(p.id, 'lift_hold_no_refund', [`rfnd_rhr_c_${P}`])
    expect(r3.status).toBe(409); expect(await r3.json()).toMatchObject({ why: 'other_refund_counts_as_money_out' })
    h.lookupThrows = true
    expect((await decide(p.id, 'lift_hold_no_refund', [`rfnd_rhr_c_${P}`])).status).toBe(503)
    expect((await ptx(p.id)).releaseStatus).toBe('held')
    expect(await audits(p.id)).toHaveLength(0)
    expect(h.refundCalls).toBe(0)
  }, T)

  it('7+8 · a stale screen and new refund evidence arriving during review are refused; the current hold must be reviewed again', async () => {
    const p = await payment(); await partialRefund(p, `rfnd_rhr_d_${P}`, 300)
    const seen = [`rfnd_rhr_d_${P}`]
    await partialRefund(p, `rfnd_rhr_d2_${P}`, 200)                        // new evidence while the screen is open
    const r = await decide(p.id, 'record_review', seen)
    expect(r.status).toBe(409); expect((await r.json() as { code: string }).code).toBe('STALE_HOLD')
    expect((await ptx(p.id)).releaseHoldReviews).toBeUndefined()
    expect((await decide(p.id, 'record_review', [`rfnd_rhr_d2_${P}`, `rfnd_rhr_d_${P}`])).status).toBe(200)
  }, T)

  it('5+12+13 · a refund that FAILED (no money left) is liftable once: two concurrent lifts ⇒ one; it then releases normally; unrelated settlements release; wallets reconcile', async () => {
    const p = await payment(); const other = await payment()
    await partialRefund(p, `rfnd_rhr_e_${P}`)
    await failRefund(p, `rfnd_rhr_e_${P}`)                                 // un-counted; record failed; hold kept
    expect((await ptx(p.id)).releaseStatus).toBe('held')
    await backdate(p.id); await backdate(other.id)
    await release({ limit: 500 })
    expect((await ptx(other.id)).releaseStatus).toBe('released')          // unrelated: released normally
    expect((await ptx(p.id)).releaseStatus).toBe('held')                  // held: not released
    const rs = await Promise.all([
      decide(p.id, 'lift_hold_no_refund', [`rfnd_rhr_e_${P}`]),
      decide(p.id, 'lift_hold_no_refund', [`rfnd_rhr_e_${P}`]),
    ])
    expect(rs.map(r => r.status).sort()).toEqual([200, 409])
    const t = await ptx(p.id)
    expect(t.releaseStatus).toBe('pending'); expect(t.releaseHold).toBeUndefined()
    const hist = Object.values(t.releaseHoldHistory as Record<string, Record<string, unknown>>)
    expect(hist).toHaveLength(1)
    expect(hist[0]).toMatchObject({ outcome: 'lift_hold_no_refund', by: SUPER, hold: { refundIds: [`rfnd_rhr_e_${P}`] } })   // evidence kept
    expect((await audits(p.id)).filter(a => a.action === 'settlement.refund_hold_lifted')).toHaveLength(1)
    expect((await db.doc(`registrationRefunds/rfnd_rhr_e_${P}`).get()).data()).toMatchObject({ status: 'failed', reviewReasons: expect.arrayContaining(['partial_refund', 'failed_after_counted']) })
    expect((await decide(p.id, 'lift_hold_no_refund', [`rfnd_rhr_e_${P}`])).status).toBe(409)   // already resolved
    await release({ limit: 500 })
    expect((await ptx(p.id)).releaseStatus).toBe('released')              // the ORIGINAL settlement, by the normal job
    await walletClean()
    expect(h.refundCalls).toBe(0)
  }, T)

  it('10 · a settlement released BEFORE the refund was seen: review only — never lifted, never pretended recalled', async () => {
    const p = await payment()
    await backdate(p.id); await release({ limit: 500 })
    expect((await ptx(p.id)).releaseStatus).toBe('released')
    await partialRefund(p, `rfnd_rhr_f_${P}`)
    expect(await ptx(p.id)).toMatchObject({ releaseStatus: 'released', releaseHold: { alreadyReleased: true } })
    await failRefund(p, `rfnd_rhr_f_${P}`)
    const r = await decide(p.id, 'lift_hold_no_refund', [`rfnd_rhr_f_${P}`])
    expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ why: 'settlement_already_released' })
    expect((await decide(p.id, 'record_review', [`rfnd_rhr_f_${P}`])).status).toBe(200)
    expect((await ptx(p.id)).releaseStatus).toBe('released')
    await walletClean()
  }, T)

  it('11 · an audit-write failure means nothing was decided (500), and the hold is unchanged', async () => {
    const p = await payment(); await partialRefund(p, `rfnd_rhr_g_${P}`)
    await failRefund(p, `rfnd_rhr_g_${P}`)
    const before = await ptx(p.id)
    h.auditFail = true
    const r1 = await decide(p.id, 'record_review', [`rfnd_rhr_g_${P}`])
    expect(r1.status).toBe(500); expect((await r1.json() as { code: string }).code).toBe('DECISION_FAILED')
    h.auditFail = true
    expect((await decide(p.id, 'lift_hold_no_refund', [`rfnd_rhr_g_${P}`])).status).toBe(500)
    expect(await ptx(p.id)).toEqual(before)
    expect(await audits(p.id)).toHaveLength(0)
    // the review state is part of the same all-or-nothing decision: still open, nothing closed
    const rec = (await db.doc(`registrationRefunds/rfnd_rhr_g_${P}`).get()).data()!
    expect(rec.reviewOpen).toBe(true); expect(rec.reviewClosed).toBeUndefined()
  }, T)

  // ═══ the review state after a successful lift ═══════════════════════════════════════════════════════
  const refundDoc = async (id: string) => (await db.doc(`registrationRefunds/${id}`).get()).data()!

  it('15 · a successful lift CLOSES the reviews its evidence explains (reasons, details and history kept, audited); health drops; an unrelated open review stays counted', async () => {
    const { getOperationsHealth } = await import('@/lib/operations/healthMetrics')
    const p = await payment(); const other = await payment()
    const a = `rfnd_rhr_l_${P}`, o = `rfnd_rhr_lo_${P}`
    await partialRefund(p, a); await failRefund(p, a)
    await partialRefund(other, o)                                          // a real, unrelated open review + hold
    const detailsBefore = (await refundDoc(a)).reviewDetails
    expect(await refundDoc(a)).toMatchObject({ reviewOpen: true, status: 'failed' })
    const h0 = (await getOperationsHealth()).financial
    const r = await decide(p.id, 'lift_hold_no_refund', [a])
    expect(r.status).toBe(200)
    const rec = await refundDoc(a)
    expect(rec).toMatchObject({
      status: 'failed', reviewOpen: false, reviewRequired: 'partial_refund',
      reviewClosed: { by: SUPER, reason: 'reviewed with finance team', evidence: { outcome: 'lift_hold_no_refund', ptxId: `ptx_${p.id}`, refundsAtGateway: 'none', countedRefundsPaise: 0 } },
    })
    expect([...rec.reviewReasons].sort()).toEqual(['failed_after_counted', 'partial_refund'])
    expect([...rec.reviewClosed.closedReasons].sort()).toEqual(['failed_after_counted', 'partial_refund'])
    expect(rec.reviewDetails).toEqual(detailsBefore)                       // details untouched
    const lifted = (await audits(p.id)).filter(x => x.action === 'settlement.refund_hold_lifted')
    expect(lifted).toHaveLength(1)
    expect(lifted[0].metadata).toMatchObject({ reviewsClosed: [a], reviewsLeftOpen: [] })
    expect(Object.values((await ptx(p.id)).releaseHoldHistory as Record<string, unknown>)).toHaveLength(1)
    // the unrelated review is untouched and still counted
    expect(await refundDoc(o)).toMatchObject({ reviewOpen: true })
    expect((await refundDoc(o)).reviewClosed).toBeUndefined()
    const h1 = (await getOperationsHealth()).financial
    expect(h1.registrationRefundsNeedingReview).toBe(h0.registrationRefundsNeedingReview - 1)
    expect(h1.settlementsHeldForRefundReview).toBe(h0.settlementsHeldForRefundReview - 1)
    expect(h1.registrationRefundsNeedingReview).toBeGreaterThanOrEqual(1)
    expect(h.refundCalls).toBe(0)
  }, T)

  it('16 · a contradiction on the SAME payment that the lift does not explain stays OPEN (named in the audit, still counted); a refused lift closes nothing', async () => {
    const { getOperationsHealth } = await import('@/lib/operations/healthMetrics')
    const p = await payment()
    const a = `rfnd_rhr_m_${P}`, b = `rfnd_rhr_mb_${P}`
    await partialRefund(p, a); await failRefund(p, a)
    await failRefund(p, b)                                                  // a second refund, failed (never counted)
    await refunds.flagRefundForReview(b, 'processed_after_failed', { note: 'test: success reported after failure' })
    expect(await refundDoc(b)).toMatchObject({ status: 'failed', reviewOpen: true, reviewRequired: 'processed_after_failed' })
    // a REFUSED lift (gateway shows money left) closes no review
    h.gateway.set(p.paymentId, [{ id: b, amount: 400, status: 'processed' }])
    expect((await decide(p.id, 'lift_hold_no_refund', [a])).status).toBe(409)
    expect(await refundDoc(a)).toMatchObject({ reviewOpen: true }); expect(await refundDoc(b)).toMatchObject({ reviewOpen: true })
    h.gateway.set(p.paymentId, [{ id: a, amount: 400, status: 'failed' }, { id: b, amount: 400, status: 'failed' }])
    const h0 = (await getOperationsHealth()).financial
    expect((await decide(p.id, 'lift_hold_no_refund', [a])).status).toBe(200)
    expect(await refundDoc(a)).toMatchObject({ reviewOpen: false })
    const rb = await refundDoc(b)
    expect(rb).toMatchObject({ reviewOpen: true, reviewRequired: 'processed_after_failed' })
    expect(rb.reviewClosed).toBeUndefined()
    const lifted = (await audits(p.id)).find(x => x.action === 'settlement.refund_hold_lifted')!
    expect(lifted.metadata).toMatchObject({ reviewsClosed: [a], reviewsLeftOpen: [b] })
    expect((await getOperationsHealth()).financial.registrationRefundsNeedingReview).toBe(h0.registrationRefundsNeedingReview - 1)
    h.gateway.delete(p.paymentId)
    expect(h.refundCalls).toBe(0)
  }, T)

  it('14 · list view: every hold is listed with its refunds; the workflow never called the gateway refund endpoint', async () => {
    const r = await GET(new NextRequest('http://x/api/admin/finance/refund-holds', { headers: { authorization: 'Bearer super' } }))
    expect(r.status).toBe(200)
    const d = await r.json() as { items: Array<{ ptxId: string; refunds: unknown[]; hold: { refundIds: string[] } }> }
    const mine = d.items.filter(i => i.ptxId.startsWith(`ptx_rhr-${P}-`))
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every(i => i.hold.refundIds.length > 0 && i.refunds.length > 0)).toBe(true)
    expect(h.refundCalls).toBe(0)
  }, T)
})
