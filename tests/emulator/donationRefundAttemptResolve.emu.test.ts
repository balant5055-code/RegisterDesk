// Phase 3 · G9 — Super Admin resolution of an UNKNOWN refund attempt on an already-RELEASED donation (no
// settlement hold), on REAL Firestore through the real refund route (to create the attempt), the real
// resolution route (/api/admin/finance/refund-attempts) and the real refund accounting.
// Synthetic data only; the gateway stub counts every refund-CREATION call and serves a read-only list.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 180_000
const P = process.pid
const SUPER = `g9-super-${P}`
const MIN = 60_000

const gw = vi.hoisted(() => ({
  mode: 'timeout' as 'ok' | 'lost' | 'timeout',
  status: 'processed' as string,
  lookup: 'real' as 'real' | 'throw' | 'malformed',
  calls: 0,
  refunds: [] as Array<{ id: string; payment_id: string; amount: number; status: string; notes: Record<string, string> }>,
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_g9', RAZORPAY_KEY_SECRET: 'g9',
  razorpay: { payments: {
    refund: async (paymentId: string, o: { amount: number; notes?: Record<string, string> }) => {
      gw.calls++
      if (gw.mode === 'timeout') throw new Error('timeout (simulated: no response, nothing created)')
      const r = { id: `rfnd_g9_${P}_${gw.calls}`, payment_id: paymentId, amount: o.amount, status: gw.status, notes: o.notes ?? {} }
      gw.refunds.push(r)
      if (gw.mode === 'lost') throw new Error('socket hang up (simulated: created, response lost)')
      return { id: r.id, status: r.status }
    },
    fetchMultipleRefund: async (paymentId: string) => {
      if (gw.lookup === 'throw') throw new Error('lookup unavailable')
      if (gw.lookup === 'malformed') return { entity: 'collection', items: [{ amount: 1 }] }
      const items = gw.refunds.filter(r => r.payment_id === paymentId)
      return { entity: 'collection', count: items.length, items }
    },
  } },
}))
vi.mock('@/lib/admin/auth', () => ({
  resolveAdminUid:      async (hd: string | null) => (hd === 'Bearer super' ? SUPER : hd === 'Bearer admin' ? `g9-admin-${process.pid}` : null),
  resolveSuperAdminUid: async (hd: string | null) => (hd === 'Bearer super' ? SUPER : null),
  legacyAdminClaimOnly: async () => false,
}))
vi.mock('@/lib/monitoring/sentry', async orig => ({ ...(await orig<typeof import('@/lib/monitoring/sentry')>()), captureFinancialError: () => undefined, captureError: () => undefined, captureWebhookError: () => undefined }))
vi.mock('@/lib/notifications/inbox/notify', async orig => ({ ...(await orig<typeof import('@/lib/notifications/inbox/notify')>()), notifySettlement: async () => undefined }))

describeEmu('Phase 3 · G9 — resolving an unknown refund attempt on a released donation', () => {
  let db: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let credit: typeof import('@/lib/firebase/firestore/platformTransactions').recordPlatformTransactionAndCredit
  let release: typeof import('@/lib/settlements/releaseFunds').releaseEligibleFunds
  let orgRefund: (r: NextRequest, c: { params: Promise<{ donationId: string }> }) => Promise<Response>
  let resolveRoute: (r: NextRequest) => Promise<Response>
  let listRoute: (r: NextRequest) => Promise<Response>
  let n = 0

  const org = () => `g9-org-${P}-${++n}`
  const don = async (id: string) => (await db.doc(`donations/${id}`).get()).data() ?? {}
  const rec = async (id: string) => (await db.doc(`donationRefunds/${id}`).get()).data() ?? {}
  const wallet = async (uid: string) => { const w = (await db.doc(`organizerRevenueWallets/${uid}`).get()).data() ?? {}; return { pending: w.pendingPaise as number, available: w.availablePaise as number } }
  const reversalRows = async (donationId: string) => (await db.collection('platformTransactions').where('parentTransactionId', '==', `ptx_${donationId}`).get()).size
  const audits = async (donationId: string, action: string) => (await db.collection('adminAuditLogs').where('entityId', '==', donationId).where('action', '==', action).get()).docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown>))

  /** A donation whose settlement is ALREADY released, with one unknown-outcome refund attempt on it. */
  async function releasedWithUnknownAttempt(amount = 300, mode: 'lost' | 'timeout' = 'timeout') {
    const uid = org()
    const id = `g9-${P}-${++n}`
    await credit({
      id: `ptx_${id}`, type: 'donation', category: 'donation', organizerUid: uid, entityId: `g9-camp-${P}`, entityType: 'campaign', sourceId: id, sourceType: 'donation',
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: 1_000, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0,
      netSettlementPaise: 1_000, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: 1_000, feesTotalPaise: 0, netSettlementPaise: 1_000 } as never)
    await db.doc(`donations/${id}`).set({ amountPaise: 1_000, campaignId: `g9-camp-${P}`, campaignSlug: `g9-camp-${P}`, organizerUid: uid, donorEmail: `d${n}@x.test`, donorName: 'D',
      isAnonymous: false, status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: `order_${id}`, razorpayPaymentId: `pay_${id}` })
    await db.doc(`platformTransactions/ptx_${id}`).update({ paidAt: new Date(Date.now() - 10 * 86_400_000) })
    await release({ limit: 500 })
    expect((await db.doc(`platformTransactions/ptx_${id}`).get()).get('releaseStatus')).toBe('released')
    gw.mode = mode
    const res = await orgRefund(new NextRequest(`http://x/api/organizer/donations/${id}/refund`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer super' }, body: JSON.stringify({ amountPaise: amount, reason: 'donor asked for a refund' }) }), { params: Promise.resolve({ donationId: id }) })
    expect(res.status).toBe(502)
    const [[attemptId, a]] = Object.entries((await don(id)).refundAttempts ?? {}) as Array<[string, Record<string, unknown>]>
    expect(a.status).toBe('unknown')
    expect(await don(id)).toMatchObject({ pendingRefundPaise: amount, hasOpenRefundAttempt: true })
    expect((await db.doc(`platformTransactions/ptx_${id}`).get()).get('releaseHold')).toBeUndefined()   // released: no hold
    return { uid, id, attemptId, paymentId: `pay_${id}` }
  }
  const ageAttempt = (id: string, attemptId: string, minutes: number) =>
    db.doc(`donations/${id}`).update({ [`refundAttempts.${attemptId}.startedAt`]: FS.Timestamp.fromMillis(Date.now() - minutes * MIN) })
  let req = 0
  const resolve = async (donationId: string, attemptId: string, o: { auth?: string; reason?: unknown; confirm?: unknown; requestId?: string } = {}) => {
    const r = await resolveRoute(new NextRequest('http://x/api/admin/finance/refund-attempts', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: o.auth ?? 'Bearer super' },
      body: JSON.stringify({ donationId, attemptId, reason: o.reason ?? 'verified against the Razorpay dashboard', confirm: o.confirm ?? true, requestId: o.requestId ?? `g9req${P}x${++req}` }),
    }))
    return { status: r.status, body: await r.json() as Record<string, unknown> }
  }

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb: db } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    credit = (await import('@/lib/firebase/firestore/platformTransactions')).recordPlatformTransactionAndCredit
    release = (await import('@/lib/settlements/releaseFunds')).releaseEligibleFunds
    ;({ POST: orgRefund } = await import('@/app/api/organizer/donations/[donationId]/refund/route') as never)
    ;({ POST: resolveRoute, GET: listRoute } = await import('@/app/api/admin/finance/refund-attempts/route') as never)
  }, T)
  beforeEach(() => { gw.mode = 'timeout'; gw.status = 'processed'; gw.lookup = 'real' })

  it('1 · authorization, reason and confirmation are enforced server-side; nothing changes on refusal', async () => {
    const x = await releasedWithUnknownAttempt()
    await ageAttempt(x.id, x.attemptId, 16)
    expect((await resolve(x.id, x.attemptId, { auth: 'Bearer admin' })).status).toBe(403)
    expect((await resolve(x.id, x.attemptId, { auth: 'none' })).status).toBe(403)
    expect((await resolve(x.id, x.attemptId, { reason: '' })).body).toMatchObject({ code: 'REASON_REQUIRED' })
    expect((await resolve(x.id, x.attemptId, { reason: 'no' })).body).toMatchObject({ code: 'REASON_TOO_SHORT' })
    expect((await resolve(x.id, x.attemptId, { confirm: false })).body).toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    expect((await resolve(x.id, 'not-an-attempt')).body).toMatchObject({ code: 'INVALID_INPUT' })
    const list = await listRoute(new NextRequest('http://x/api/admin/finance/refund-attempts', { headers: { authorization: 'Bearer admin' } }))
    expect(list.status).toBe(403)
    expect((await don(x.id)).refundAttempts[x.attemptId].status).toBe('unknown')
    expect(await don(x.id)).toMatchObject({ pendingRefundPaise: 300 })
  }, T)

  it('2 · too young, unreadable, malformed or contradictory evidence changes NOTHING; authoritative "none" after 15 min resolves it once, audited', async () => {
    const x = await releasedWithUnknownAttempt()
    const listed = await listRoute(new NextRequest('http://x', { headers: { authorization: 'Bearer super' } }))
    expect(((await listed.json()) as { items: Array<{ attemptId: string }> }).items.map(i => i.attemptId)).toContain(x.attemptId)
    expect((await resolve(x.id, x.attemptId)).body).toMatchObject({ code: 'ATTEMPT_TOO_RECENT' })      // age alone is checked first…
    await ageAttempt(x.id, x.attemptId, 16)
    gw.lookup = 'throw'
    expect(await resolve(x.id, x.attemptId)).toMatchObject({ status: 503, body: { code: 'GATEWAY_UNVERIFIED' } })   // …and is never sufficient
    gw.lookup = 'malformed'
    expect(await resolve(x.id, x.attemptId)).toMatchObject({ status: 503, body: { code: 'GATEWAY_UNVERIFIED' } })
    gw.lookup = 'real'
    gw.refunds.push({ id: `rfnd_g9_dash_${P}`, payment_id: x.paymentId, amount: 100, status: 'processed', notes: {} })   // an unrecorded refund
    expect(await resolve(x.id, x.attemptId)).toMatchObject({ status: 409, body: { code: 'CONTRADICTORY_EVIDENCE' } })
    gw.refunds.pop()
    expect((await don(x.id)).refundAttempts[x.attemptId].status).toBe('unknown')
    expect(await don(x.id)).toMatchObject({ pendingRefundPaise: 300, hasOpenRefundAttempt: true })
    expect(await audits(x.id, 'donation.refund_attempt_resolved_none')).toHaveLength(0)
    // authoritative: listed successfully, nothing carries the attempt, nothing unrecorded → resolved_none
    const ok = await resolve(x.id, x.attemptId)
    expect(ok).toMatchObject({ status: 200, body: { ok: true, outcome: 'resolved_none', duplicate: false } })
    const a = (await don(x.id)).refundAttempts[x.attemptId]
    expect(a).toMatchObject({ status: 'resolved_none', resolvedBy: SUPER, evidence: { refundsAtGateway: 'none_for_attempt', listedRefunds: 0, path: 'g9_released_donation' } })
    expect(await don(x.id)).toMatchObject({ pendingRefundPaise: 0, hasOpenRefundAttempt: false })
    const rows = await audits(x.id, 'donation.refund_attempt_resolved_none')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: `donation_refund_attempt_${x.attemptId}`, adminUid: SUPER, actorRole: 'super_admin', reason: 'verified against the Razorpay dashboard',
      metadata: { attemptId: x.attemptId, amountPaise: 300, reservationFreedPaise: 300 } })
    // duplicate and concurrent repeats: idempotent, one audit row, nothing more freed
    const rs = await Promise.all([0, 1, 2].map(() => resolve(x.id, x.attemptId)))
    expect(rs.every(r => r.status === 200 && r.body.duplicate === true)).toBe(true)
    expect(await audits(x.id, 'donation.refund_attempt_resolved_none')).toHaveLength(1)
    expect(await don(x.id)).toMatchObject({ pendingRefundPaise: 0 })
  }, T)

  it('3 · concurrent first resolutions: exactly one decision and one audit row', async () => {
    const x = await releasedWithUnknownAttempt()
    await ageAttempt(x.id, x.attemptId, 16)
    const rs = await Promise.all([0, 1, 2].map(() => resolve(x.id, x.attemptId)))
    expect(rs.every(r => r.status === 200)).toBe(true)
    expect(rs.filter(r => r.body.duplicate === false)).toHaveLength(1)
    expect(await audits(x.id, 'donation.refund_attempt_resolved_none')).toHaveLength(1)
    expect(await don(x.id)).toMatchObject({ pendingRefundPaise: 0, hasOpenRefundAttempt: false })
  }, T)

  it('4 · a LIVE refund carrying the attempt id is linked to exactly that refund and accounted once (from available: the donation was released); never resolved_none', async () => {
    const x = await releasedWithUnknownAttempt(400, 'lost')
    const created = gw.refunds.at(-1)!
    expect(created.notes.attemptId).toBe(x.attemptId)
    await ageAttempt(x.id, x.attemptId, 16)
    const calls0 = gw.calls
    const r = await resolve(x.id, x.attemptId)
    expect(r).toMatchObject({ status: 200, body: { outcome: 'linked', refundId: created.id, gatewayStatus: 'processed' } })
    expect((await don(x.id)).refundAttempts[x.attemptId]).toMatchObject({ status: 'linked', refundId: created.id })
    expect(await rec(created.id)).toMatchObject({ status: 'processed', initiatedBy: SUPER, ledgerReversedPaise: 400 })
    expect(await reversalRows(x.id)).toBe(1)
    expect(await wallet(x.uid)).toMatchObject({ pending: 0, available: 600 })        // 1,000 released − 400 refunded
    expect(await don(x.id)).toMatchObject({ pendingRefundPaise: 0, refundedAmountPaise: 400, hasOpenRefundAttempt: false })
    expect(await audits(x.id, 'donation.refund_attempt_linked')).toHaveLength(1)
    expect(await audits(x.id, 'donation.refund_attempt_resolved_none')).toHaveLength(0)
    expect(await resolve(x.id, x.attemptId)).toMatchObject({ status: 200, body: { outcome: 'linked', duplicate: true } })
    expect(await reversalRows(x.id)).toBe(1)
    expect(gw.calls).toBe(calls0)                                                     // read-only: no refund created
  }, T)

  it('5 · a FAILED refund carrying the attempt id is linked as failed: reservation freed, nothing accounted, never resolved_none; two refunds claiming the attempt are contradictory', async () => {
    const x = await releasedWithUnknownAttempt(250)
    await ageAttempt(x.id, x.attemptId, 16)
    gw.refunds.push({ id: `rfnd_g9_failed_${P}`, payment_id: x.paymentId, amount: 250, status: 'failed', notes: { donationId: x.id, attemptId: x.attemptId } })
    expect(await resolve(x.id, x.attemptId)).toMatchObject({ status: 200, body: { outcome: 'linked', gatewayStatus: 'failed' } })
    expect(await rec(`rfnd_g9_failed_${P}`)).toMatchObject({ status: 'failed', initiatedBy: SUPER, accountingRecovery: { state: 'gateway_failed' } })
    expect(await don(x.id)).toMatchObject({ pendingRefundPaise: 0, refundedAmountPaise: 0, hasOpenRefundAttempt: false })
    expect(await reversalRows(x.id)).toBe(0)
    expect(await wallet(x.uid)).toMatchObject({ available: 1_000 })

    const y = await releasedWithUnknownAttempt(200)
    await ageAttempt(y.id, y.attemptId, 16)
    gw.refunds.push({ id: `rfnd_g9_c1_${P}`, payment_id: y.paymentId, amount: 200, status: 'processed', notes: { attemptId: y.attemptId } },
                    { id: `rfnd_g9_c2_${P}`, payment_id: y.paymentId, amount: 200, status: 'processed', notes: { attemptId: y.attemptId } })
    expect(await resolve(y.id, y.attemptId)).toMatchObject({ status: 409, body: { code: 'CONTRADICTORY_EVIDENCE', detail: { why: 'multiple_refunds_for_attempt' } } })
    expect((await don(y.id)).refundAttempts[y.attemptId].status).toBe('unknown')
    expect(await don(y.id)).toMatchObject({ pendingRefundPaise: 200 })
    expect(await reversalRows(y.id)).toBe(0)
  }, T)

  it('6 · an attempt on a HELD (unreleased) donation is refused here — it belongs to the refund-hold review', async () => {
    const uid = org()
    const id = `g9-held-${P}`
    await credit({
      id: `ptx_${id}`, type: 'donation', category: 'donation', organizerUid: uid, entityId: 'c', entityType: 'campaign', sourceId: id, sourceType: 'donation',
      payerName: 'x', payerEmail: 'x@x.test', grossAmountPaise: 1_000, platformFeeBasePaise: 0, platformFeeGstPaise: 0, platformFeeTotalPaise: 0, gatewayFeeEstimatePaise: 0,
      netSettlementPaise: 1_000, feeModel: 'organizer_pays', planTier: 'starter', feeConfigId: 'x', currency: 'INR', gateway: 'razorpay', gatewayPaymentId: `pay_${id}`, gatewayOrderId: `order_${id}`,
    } as never, { organizerUid: uid, grossAmountPaise: 1_000, feesTotalPaise: 0, netSettlementPaise: 1_000 } as never)
    await db.doc(`donations/${id}`).set({ amountPaise: 1_000, campaignId: 'c', campaignSlug: 'c', organizerUid: uid, donorEmail: 'h@x.test', donorName: 'D', isAnonymous: false, status: 'successful', refundedAmountPaise: 0, pendingRefundPaise: 0, razorpayOrderId: `order_${id}`, razorpayPaymentId: `pay_${id}` })
    gw.mode = 'timeout'
    await orgRefund(new NextRequest('http://x', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer super' }, body: JSON.stringify({ amountPaise: 100, reason: 'donor asked' }) }), { params: Promise.resolve({ donationId: id }) })
    const [[attemptId]] = Object.entries((await don(id)).refundAttempts ?? {})
    await ageAttempt(id, attemptId, 16)
    expect(await resolve(id, attemptId)).toMatchObject({ status: 409, body: { code: 'USE_REFUND_HOLD_REVIEW' } })
    expect((await don(id)).refundAttempts[attemptId].status).toBe('unknown')
  }, T)
})
