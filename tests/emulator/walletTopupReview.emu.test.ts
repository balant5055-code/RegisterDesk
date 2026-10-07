// RD-WALLET-W2.f — Super Admin review of HELD wallet top-ups on REAL Firestore (private emulator),
// through the REAL route, the REAL requireSuperAdmin gate, the REAL credit transaction, guard and
// audit. Identity is stubbed at the token boundary only (lib/admin/auth): 'super' is in ADMIN_UIDS,
// 'plain' holds only the legacy admin claim. Razorpay is an in-memory stub — no request leaves the
// process (.env.local holds LIVE keys).

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const T = 120_000
const P = `w2f_${process.pid}`

const h = vi.hoisted(() => ({
  payments: new Map<string, Record<string, unknown>>(),
  failFetch: new Set<string>(),
  fetches: [] as string[],
  gatewayDelayMs: 0,
  who: '',
}))
// W2.f.1 — the organizer status route's identity, at its token boundary (as the W1 suite does).
vi.mock('@/lib/team/access', async orig => ({
  ...(await orig<typeof import('@/lib/team/access')>()),
  verifyCaller: async () => (h.who ? { uid: h.who, email: null } : null),
}))
// RD-SEC-01 · two roles only: resolveAdminUid = ADMIN_UIDS; the legacy claim selects the refusal message.
vi.mock('@/lib/admin/auth', async orig => ({
  ...(await orig<typeof import('@/lib/admin/auth')>()),
  resolveAdminUid: async (header: string | null) => (header === 'Bearer super' ? 'super-uid' : null),
  legacyAdminClaimOnly: async (header: string | null) => header === 'Bearer plain',
  resolveSuperAdminUid: async (header: string | null) => (header === 'Bearer super' ? 'super-uid' : null),
}))
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_w2f', RAZORPAY_KEY_SECRET: 'w2f-test-secret',
  razorpay: {
    payments: {
      fetch: async (id: string) => {
        h.fetches.push(id)
        if (h.gatewayDelayMs) await new Promise(r => setTimeout(r, h.gatewayDelayMs))
        if (h.failFetch.has(id)) throw new Error('simulated gateway outage')
        const p = h.payments.get(id)
        if (!p) throw Object.assign(new Error('not found'), { statusCode: 400 })
        return p
      },
    },
    orders: { fetchPayments: async (orderId: string) => ({ items: [...h.payments.values()].filter(p => p.order_id === orderId) }) },
  },
}))
// The top-up guard asks the provider adapter about pending orders; answer from the same stub.
vi.mock('@/lib/payments/providers', async orig => {
  const actual = await orig<typeof import('@/lib/payments/providers')>()
  return {
    ...actual,
    resolvePaymentProvider: (id: 'razorpay' | 'cashfree') => ({
      ...actual.resolvePaymentProvider(id),
      fetchOrderPayments: async (orderId: string) => [...h.payments.values()]
        .filter(p => p.order_id === orderId)
        .map(p => ({ provider: 'razorpay', providerPaymentId: String(p.id), providerOrderId: orderId, status: p.status, amountPaise: p.amount, currency: p.currency, capturedAtMs: null })),
    }),
  }
})

describeEmu('RD-WALLET-W2.f · Super Admin review of held wallet top-ups (real Firestore)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let FS: typeof import('firebase-admin/firestore')
  let GET: (req: NextRequest) => Promise<Response>
  let POST: (req: NextRequest) => Promise<Response>
  let findUnresolvedTopup: typeof import('@/lib/wallet/topupGuard').findUnresolvedTopup
  let atomicTopupCredit: typeof import('@/lib/firebase/firestore/wallet').atomicTopupCredit
  const cleanup: string[] = []
  let n = 0
  const id = (s: string) => `${P}_${s}_${++n}`
  const put = async (path: string, data: Record<string, unknown>) => { await adminDb.doc(path).set(data); cleanup.push(path) }
  const read = async (path: string) => { const s = await adminDb.doc(path).get(); return s.exists ? s.data() as Record<string, unknown> : null }
  const capturedPayment = (paymentId: string, orderId: string, amount: number, over: Record<string, unknown> = {}) =>
    ({ id: paymentId, order_id: orderId, status: 'captured', amount, currency: 'INR', amount_refunded: 0, refund_status: null, ...over })

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    FS = await import('firebase-admin/firestore')
    ;({ GET, POST } = await import('@/app/api/admin/wallet-topups/review/route'))
    ;({ findUnresolvedTopup } = await import('@/lib/wallet/topupGuard'))
    ;({ atomicTopupCredit } = await import('@/lib/firebase/firestore/wallet'))
  }, T)
  afterAll(async () => {
    for (const p of cleanup) await adminDb.doc(p).delete().catch(() => null)
    const audits = await adminDb.collection('adminAuditLogs').where('adminUid', '==', 'super-uid').get()
    for (const d of audits.docs) if (String((d.data() as { entityId?: unknown }).entityId ?? '').includes(P)) await d.ref.delete()
  }, T)
  afterEach(() => { vi.restoreAllMocks(); h.failFetch.clear(); h.gatewayDelayMs = 0 })

  const post = (auth: string | null, body: unknown) => POST(new NextRequest('http://localhost/api/admin/wallet-topups/review', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body),
  }))
  const get = (auth: string | null, qs = '') => GET(new NextRequest(`http://localhost/api/admin/wallet-topups/review${qs}`, { headers: auth ? { authorization: auth } : {} }))
  const decide = async (body: Record<string, unknown>) => { const r = await post('Bearer super', body); return { status: r.status, body: await r.json() as Record<string, unknown> } }
  const audits = async (recordId: string) => (await adminDb.collection('adminAuditLogs').where('entityId', '==', recordId).get()).docs.map(d => d.data() as Record<string, unknown>)

  /** One organizer with a wallet and one top-up order (and its payment at the stub gateway). */
  async function organizerWithOrder(o: { orderStatus: string; amount?: number; balance?: number; orderExtra?: Record<string, unknown> }) {
    const uid = id('org'), orderId = id('order'), paymentId = id('pay'), amount = o.amount ?? 50_000
    await put(`organizerWallets/${uid}`, { balancePaise: o.balance ?? 10_000, currency: 'INR' })
    await put(`walletTopups/${orderId}`, { orderId, uid, amountPaise: amount, currency: 'INR', status: o.orderStatus, ...(o.orderStatus === 'credited' ? { paymentId } : {}), ...o.orderExtra })
    h.payments.set(paymentId, capturedPayment(paymentId, orderId, amount))
    cleanup.push(`walletTransactions/topup_${orderId}`)
    return { uid, orderId, paymentId, amount }
  }
  const state = async (x: { uid: string; orderId: string }, recordId: string) => JSON.stringify({
    wallet: await read(`organizerWallets/${x.uid}`), order: await read(`walletTopups/${x.orderId}`),
    record: await read(`walletTopupReconciliation/${recordId}`), ledger: await read(`walletTransactions/topup_${x.orderId}`),
    audits: (await audits(recordId)).length,
  })

  // ═══ authorization ═══════════════════════════════════════════════════════════════════════════
  it('only a Super Admin (ADMIN_UIDS) can list or decide — a legacy admin:true caller gets 403 SUPER_ADMIN_REQUIRED, and nothing changes', async () => {
    const x = await organizerWithOrder({ orderStatus: 'pending' })
    await put(`walletTopupReconciliation/${x.orderId}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: x.paymentId, status: 'exhausted', attempts: 12 })
    const before = await state(x, x.orderId)
    for (const auth of [null, 'Bearer plain', 'Bearer organizer']) {
      const g = await get(auth)
      expect(g.status, `GET ${auth}`).toBe(403)
      for (const action of ['credit', 'resolve']) {
        const r = await post(auth, { recordId: x.orderId, action, reason: 'should not apply' })
        expect(r.status, `${action} ${auth}`).toBe(403)
        if (auth === 'Bearer plain') expect((await r.json() as { code?: string }).code).toBe('SUPER_ADMIN_REQUIRED')
      }
    }
    expect(h.fetches).not.toContain(x.paymentId)                                    // the gateway was never asked
    expect(await state(x, x.orderId)).toBe(before)
  }, T)

  it('inputs are validated server-side: action, record id, reason, refund reference — 400 / 404, nothing changes', async () => {
    const x = await organizerWithOrder({ orderStatus: 'pending' })
    await put(`walletTopupReconciliation/${x.orderId}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: x.paymentId, status: 'exhausted' })
    const before = await state(x, x.orderId)
    expect((await decide({ recordId: x.orderId, action: 'refund', reason: 'nope' })).body.code).toBe('INVALID_ACTION')
    expect((await decide({ recordId: 'a/b', action: 'credit', reason: 'nope' })).body.code).toBe('INVALID_RECORD_ID')
    expect((await decide({ recordId: x.orderId, action: 'credit' })).body.code).toBe('REASON_REQUIRED')
    expect((await decide({ recordId: x.orderId, action: 'resolve', reason: 'ab' })).body.code).toBe('REASON_TOO_SHORT')
    expect((await decide({ recordId: x.orderId, action: 'credit', reason: 'valid reason', refundReference: 'rfnd_abc' })).body.code).toBe('REFUND_REFERENCE_NOT_ALLOWED')
    expect((await decide({ recordId: x.orderId, action: 'resolve', reason: 'valid reason', refundReference: 'bad ref!' })).body.code).toBe('REFUND_REFERENCE_INVALID')
    const missing = await decide({ recordId: `${P}_nope`, action: 'resolve', reason: 'valid reason' })
    expect(missing.status).toBe(404)
    expect(await state(x, x.orderId)).toBe(before)
  }, T)

  // ═══ credit ══════════════════════════════════════════════════════════════════════════════════
  it('credit: the exact captured payment re-verified → credited ONCE (wallet, order, ledger, record, audit in one commit) — and the organizer is unblocked', async () => {
    const x = await organizerWithOrder({ orderStatus: 'pending', balance: 10_000 })
    await put(`walletTopupReconciliation/${x.orderId}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: x.paymentId, status: 'exhausted', attempts: 12 })
    expect(await findUnresolvedTopup(x.uid)).toEqual({ orderId: x.orderId, reason: 'retry_exhausted' })

    const r = await decide({ recordId: x.orderId, action: 'credit', reason: 'Gateway shows the payment captured; retries exhausted on a Firestore outage.' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ outcome: 'credited', orderId: x.orderId, paymentId: x.paymentId, amountPaise: 50_000, newBalancePaise: 60_000, otherOpenRecords: 0 })
    expect(h.fetches).toContain(x.paymentId)

    expect((await read(`organizerWallets/${x.uid}`))!.balancePaise).toBe(60_000)
    expect(await read(`walletTopups/${x.orderId}`)).toMatchObject({ status: 'credited', paymentId: x.paymentId, reviewCredit: { by: 'super-uid', recordId: x.orderId } })
    expect(await read(`walletTransactions/topup_${x.orderId}`)).toMatchObject({
      organizerUid: x.uid, type: 'fund_added', amountPaise: 50_000, balancePaise: 60_000, orderId: x.orderId, paymentId: x.paymentId,
      metadata: { reviewedBy: 'super-uid', reviewRecordId: x.orderId },
    })
    expect(await read(`walletTopupReconciliation/${x.orderId}`)).toMatchObject({
      status: 'resolved', resolvedBy: 'super-uid',
      review: { action: 'credited', by: 'super-uid', previousStatus: 'exhausted', evidence: { paymentId: x.paymentId, orderId: x.orderId, amountPaise: 50_000, currency: 'INR', status: 'captured', amountRefundedPaise: 0 } },
    })
    const [audit] = await audits(x.orderId)
    expect(audit).toMatchObject({
      adminUid: 'super-uid', actorRole: 'super_admin', action: 'wallet_topup.review_credited', entityType: 'wallet_topup', entityId: x.orderId,
      reason: 'Gateway shows the payment captured; retries exhausted on a Firestore outage.',
      correlation: { recordId: x.orderId, orderId: x.orderId, paymentId: x.paymentId, uid: x.uid },
    })
    expect(await findUnresolvedTopup(x.uid)).toBeNull()

    // idempotent: a repeat is a 409, never a second credit
    const again = await decide({ recordId: x.orderId, action: 'credit', reason: 'clicked twice by mistake' })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('NOT_HELD')
    expect((await read(`organizerWallets/${x.uid}`))!.balancePaise).toBe(60_000)
    expect(await audits(x.orderId)).toHaveLength(1)
  }, T)

  it('two Super Admins crediting the same record at once → exactly ONE credit', async () => {
    const x = await organizerWithOrder({ orderStatus: 'abandoned', balance: 0 })   // a late payment on an abandoned order
    await put(`walletTopupReconciliation/${x.orderId}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: x.paymentId, status: 'needs_review', lastError: 'TOPUP_NOT_CREDITABLE' })
    h.gatewayDelayMs = 50
    const results = await Promise.all([1, 2, 3].map(i => decide({ recordId: x.orderId, action: 'credit', reason: `concurrent reviewer ${i}` })))
    expect(results.filter(r => r.status === 200)).toHaveLength(1)
    expect(results.filter(r => r.status === 409)).toHaveLength(2)
    expect((await read(`organizerWallets/${x.uid}`))!.balancePaise).toBe(50_000)
    expect(await audits(x.orderId)).toHaveLength(1)
    expect((await read(`walletTopups/${x.orderId}`))!.status).toBe('credited')
  }, T)

  it.each([
    ['another amount',          { amount: 49_000 },            'amount_mismatch'],
    ['another currency',        { currency: 'USD' },           'currency_mismatch'],
    ['another order',           { order_id: 'order_other' },   'order_mismatch'],
    ['authorized, not captured', { status: 'authorized' },     'not_captured:authorized'],
    ['partly refunded',         { amount_refunded: 1_000 },    'refunded_at_gateway'],
    ['no refund state',         { amount_refunded: undefined }, 'refund_state_unknown'],
  ])('credit refused when the gateway shows %s — nothing changes', async (_l, over, why) => {
    const x = await organizerWithOrder({ orderStatus: 'pending' })
    await put(`walletTopupReconciliation/${x.orderId}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: x.paymentId, status: 'exhausted' })
    h.payments.set(x.paymentId, capturedPayment(x.paymentId, x.orderId, x.amount, over))
    const before = await state(x, x.orderId)
    const r = await decide({ recordId: x.orderId, action: 'credit', reason: 'trying to credit' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'PAYMENT_NOT_VERIFIED', detail: { why } })
    expect(await state(x, x.orderId)).toBe(before)
  }, T)

  it('credit refused when the gateway cannot be asked (503) — nothing changes, and a later retry can still succeed', async () => {
    const x = await organizerWithOrder({ orderStatus: 'pending' })
    await put(`walletTopupReconciliation/${x.orderId}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: x.paymentId, status: 'exhausted' })
    const before = await state(x, x.orderId)
    h.failFetch.add(x.paymentId)
    const r = await decide({ recordId: x.orderId, action: 'credit', reason: 'trying during an outage' })
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('GATEWAY_UNAVAILABLE')
    expect(await state(x, x.orderId)).toBe(before)
    h.failFetch.clear()
    expect((await decide({ recordId: x.orderId, action: 'credit', reason: 'retry after the outage' })).status).toBe(200)
  }, T)

  it('an order already credited is never credited again — not with the same payment, not with another', async () => {
    const x = await organizerWithOrder({ orderStatus: 'credited' })
    await put(`walletTopupReconciliation/${x.orderId}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: x.paymentId, status: 'needs_review' })
    const dupPay = id('pay')
    h.payments.set(dupPay, capturedPayment(dupPay, x.orderId, x.amount))
    await put(`walletTopupReconciliation/dup_${dupPay}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: dupPay, creditedPaymentId: x.paymentId, status: 'duplicate_payment' })
    for (const recordId of [x.orderId, `dup_${dupPay}`]) {
      const before = await state(x, recordId)
      const r = await decide({ recordId, action: 'credit', reason: 'should be refused' })
      expect(r.status, recordId).toBe(409)
      expect(r.body.code, recordId).toBe('ALREADY_CREDITED')
      expect(await state(x, recordId)).toBe(before)
    }
  }, T)

  it('a record whose organizer differs from the order owner is never credited', async () => {
    const x = await organizerWithOrder({ orderStatus: 'pending' })
    await put(`walletTopupReconciliation/${x.orderId}`, { orderId: x.orderId, uid: `${P}_someone_else`, amountPaise: x.amount, paymentId: x.paymentId, status: 'needs_review' })
    const before = await state(x, x.orderId)
    const r = await decide({ recordId: x.orderId, action: 'credit', reason: 'should be refused' })
    expect(r.body.code).toBe('OWNER_MISMATCH')
    expect(await state(x, x.orderId)).toBe(before)
  }, T)

  // ═══ resolve without credit ══════════════════════════════════════════════════════════════════
  it('resolve without credit: reason + audit; the pending order is frozen (no automated path can credit it later) and the organizer is unblocked', async () => {
    const x = await organizerWithOrder({ orderStatus: 'pending', balance: 10_000 })
    await put(`walletTopupReconciliation/${x.orderId}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: x.paymentId, status: 'needs_review', lastError: 'payment does not match the top-up order' })
    expect(await findUnresolvedTopup(x.uid)).toMatchObject({ reason: 'needs_review' })

    const r = await decide({ recordId: x.orderId, action: 'resolve', reason: 'Organizer confirmed the payment was refunded by their bank; no credit owed.' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ outcome: 'resolved_without_credit', refundReference: null, orderHoldResolved: true, otherOpenRecords: 0 })
    expect(h.fetches).not.toContain(x.paymentId)                                     // resolve never calls the gateway
    expect(await read(`walletTopupReconciliation/${x.orderId}`)).toMatchObject({ status: 'resolved', review: { action: 'resolved_without_credit', previousStatus: 'needs_review', refundReference: null } })
    expect(await read(`walletTopups/${x.orderId}`)).toMatchObject({ status: 'needs_review', holdReason: 'resolved_without_credit', holdResolvedBy: 'super-uid', holdResolvedRecordId: x.orderId })
    expect((await read(`organizerWallets/${x.uid}`))!.balancePaise).toBe(10_000)    // no credit
    expect(await read(`walletTransactions/topup_${x.orderId}`)).toBeNull()
    expect((await audits(x.orderId))[0]).toMatchObject({ action: 'wallet_topup.review_resolved', entityType: 'wallet_topup', reason: expect.stringContaining('refunded by their bank') })
    expect(await findUnresolvedTopup(x.uid)).toBeNull()

    // A later webhook / verify / retry credit attempt is refused by the unchanged automated path.
    await expect(atomicTopupCredit(x.uid, x.amount, adminDb.collection('walletTopups').doc(x.orderId), x.paymentId))
      .rejects.toMatchObject({ code: 'TOPUP_NOT_CREDITABLE' })
    expect((await read(`organizerWallets/${x.uid}`))!.balancePaise).toBe(10_000)

    expect((await decide({ recordId: x.orderId, action: 'resolve', reason: 'again' })).body.code).toBe('NOT_HELD')
  }, T)

  // ═══ duplicates ══════════════════════════════════════════════════════════════════════════════
  it('a duplicate captured payment: never credited; resolved only WITH the external refund reference, which is recorded', async () => {
    const x = await organizerWithOrder({ orderStatus: 'credited' })
    const dupPay = id('pay'), recordId = `dup_${dupPay}`
    h.payments.set(dupPay, capturedPayment(dupPay, x.orderId, x.amount))
    await put(`walletTopupReconciliation/${recordId}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: dupPay, creditedPaymentId: x.paymentId, status: 'duplicate_payment' })
    expect(await findUnresolvedTopup(x.uid)).toMatchObject({ reason: 'duplicate_payment' })

    const before = await state(x, recordId)
    const noRef = await decide({ recordId, action: 'resolve', reason: 'refunded' })
    expect(noRef.status).toBe(400)
    expect(noRef.body.code).toBe('REFUND_REFERENCE_REQUIRED')
    expect(await state(x, recordId)).toBe(before)

    const ok = await decide({ recordId, action: 'resolve', reason: 'Duplicate refunded in the Razorpay dashboard on 1 Oct.', refundReference: 'rfnd_W2fTest0001' })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ outcome: 'duplicate_refunded_externally', refundReference: 'rfnd_W2fTest0001' })
    expect(await read(`walletTopupReconciliation/${recordId}`)).toMatchObject({ status: 'resolved', review: { action: 'duplicate_refunded_externally', refundReference: 'rfnd_W2fTest0001', previousStatus: 'duplicate_payment' } })
    expect((await audits(recordId))[0]).toMatchObject({ action: 'wallet_topup.review_resolved', correlation: { refundReference: 'rfnd_W2fTest0001', paymentId: dupPay, orderId: x.orderId } })
    expect(await read(`walletTopups/${x.orderId}`)).toMatchObject({ status: 'credited', paymentId: x.paymentId })   // untouched
    expect(await findUnresolvedTopup(x.uid)).toBeNull()
  }, T)

  it('several captures on one order: credit ONE after verification; the other is a duplicate that needs its refund reference; then the organizer is unblocked', async () => {
    const x = await organizerWithOrder({ orderStatus: 'needs_review', balance: 0 })
    const payB = id('pay')
    h.payments.set(payB, capturedPayment(payB, x.orderId, x.amount))
    await adminDb.doc(`walletTopups/${x.orderId}`).update({ holdReason: 'multiple_captured_payments', heldPaymentIds: [x.paymentId, payB] })
    for (const p of [x.paymentId, payB]) {
      await put(`walletTopupReconciliation/dup_${p}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: p, creditedPaymentId: null, status: 'needs_review', reason: 'multiple_captured_payments', capturedPaymentIds: [x.paymentId, payB] })
    }
    expect(await findUnresolvedTopup(x.uid)).toMatchObject({ reason: 'needs_review' })

    const credit = await decide({ recordId: `dup_${x.paymentId}`, action: 'credit', reason: 'Credit the first capture; the second is refunded separately.' })
    expect(credit.status).toBe(200)
    expect(credit.body).toMatchObject({ outcome: 'credited', otherOpenRecords: 1 })
    expect((await read(`organizerWallets/${x.uid}`))!.balancePaise).toBe(50_000)
    expect(await findUnresolvedTopup(x.uid)).toMatchObject({ orderId: x.orderId, reason: 'needs_review' })   // payB still open

    expect((await decide({ recordId: `dup_${payB}`, action: 'credit', reason: 'credit the second too?' })).body.code).toBe('ALREADY_CREDITED')
    expect((await decide({ recordId: `dup_${payB}`, action: 'resolve', reason: 'refunded' })).body.code).toBe('REFUND_REFERENCE_REQUIRED')
    const resolved = await decide({ recordId: `dup_${payB}`, action: 'resolve', reason: 'Second capture refunded at the gateway.', refundReference: 'rfnd_W2fTest0002' })
    expect(resolved.status).toBe(200)
    expect((await read(`organizerWallets/${x.uid}`))!.balancePaise).toBe(50_000)   // still one credit
    expect(await findUnresolvedTopup(x.uid)).toBeNull()
  }, T)

  it('several captures, none credited: each resolved with its refund reference; the order hold closes with the LAST one and stays uncreditable', async () => {
    const x = await organizerWithOrder({ orderStatus: 'needs_review', balance: 5_000 })
    const payB = id('pay')
    h.payments.set(payB, capturedPayment(payB, x.orderId, x.amount))
    await adminDb.doc(`walletTopups/${x.orderId}`).update({ holdReason: 'multiple_captured_payments', heldPaymentIds: [x.paymentId, payB] })
    for (const p of [x.paymentId, payB]) {
      await put(`walletTopupReconciliation/dup_${p}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: p, status: 'needs_review', reason: 'multiple_captured_payments' })
    }
    const first = await decide({ recordId: `dup_${x.paymentId}`, action: 'resolve', reason: 'Both captures refunded; organizer will pay again.', refundReference: 'rfnd_W2fTest0003' })
    expect(first.body).toMatchObject({ orderHoldResolved: false, otherOpenRecords: 1 })
    expect((await read(`walletTopups/${x.orderId}`))!.holdResolvedAt).toBeUndefined()
    expect(await findUnresolvedTopup(x.uid)).not.toBeNull()

    const last = await decide({ recordId: `dup_${payB}`, action: 'resolve', reason: 'Both captures refunded; organizer will pay again.', refundReference: 'rfnd_W2fTest0004' })
    expect(last.body).toMatchObject({ orderHoldResolved: true, otherOpenRecords: 0 })
    expect(await read(`walletTopups/${x.orderId}`)).toMatchObject({ status: 'needs_review', holdResolvedBy: 'super-uid' })
    expect(await findUnresolvedTopup(x.uid)).toBeNull()
    await expect(atomicTopupCredit(x.uid, x.amount, adminDb.collection('walletTopups').doc(x.orderId), payB)).rejects.toMatchObject({ code: 'TOPUP_NOT_CREDITABLE' })
    expect((await read(`organizerWallets/${x.uid}`))!.balancePaise).toBe(5_000)
  }, T)

  it("a mismatched payment is resolved on its own record — the order's legitimate credit path is left alone", async () => {
    const x = await organizerWithOrder({ orderStatus: 'pending' })
    const payM = id('pay')
    await put(`walletTopupReconciliation/mismatch_${payM}`, { orderId: x.orderId, uid: x.uid, paymentId: payM, amountPaise: x.amount, status: 'needs_review', reason: 'amount_mismatch', observedAmountPaise: 1_000 })
    const r = await decide({ recordId: `mismatch_${payM}`, action: 'resolve', reason: 'Wrong-amount payment refunded at the gateway.', refundReference: 'rfnd_W2fTest0005' })
    expect(r.status).toBe(200)
    expect(await read(`walletTopups/${x.orderId}`)).toMatchObject({ status: 'pending' })     // not frozen
    expect((await read(`walletTopups/${x.orderId}`))!.holdResolvedAt).toBeUndefined()
    // the order's real payment can still be credited by the automated path
    const credited = await atomicTopupCredit(x.uid, x.amount, adminDb.collection('walletTopups').doc(x.orderId), x.paymentId)
    expect(credited.credited).toBe(true)
  }, T)

  // ═══ atomicity + listing ═════════════════════════════════════════════════════════════════════
  it('if the audit row cannot be written, NOTHING is written (the decision and its audit commit together)', async () => {
    const x = await organizerWithOrder({ orderStatus: 'pending', balance: 10_000 })
    await put(`walletTopupReconciliation/${x.orderId}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: x.paymentId, status: 'exhausted' })
    const before = await state(x, x.orderId)
    const realCreate = FS.Transaction.prototype.create
    vi.spyOn(FS.Transaction.prototype, 'create').mockImplementation(function (this: FirebaseFirestore.Transaction, ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) {
      if (ref.path.startsWith('adminAuditLogs/')) throw new Error('simulated audit write failure')
      return realCreate.call(this, ref, data)
    } as typeof realCreate)
    for (const action of ['credit', 'resolve']) {
      const r = await decide({ recordId: x.orderId, action, reason: 'audit must commit with the decision' })
      expect(r.status, action).toBe(500)
      expect(r.body.code).toBe('REVIEW_FAILED')
      expect(await state(x, x.orderId)).toBe(before)
    }
  }, T)

  it('the review list (Super Admin) shows held records with advisory flags, and reads only', async () => {
    const x = await organizerWithOrder({ orderStatus: 'credited' })
    const dupPay = id('pay')
    await put(`walletTopupReconciliation/dup_${dupPay}`, { orderId: x.orderId, uid: x.uid, amountPaise: x.amount, paymentId: dupPay, creditedPaymentId: x.paymentId, status: 'duplicate_payment', firstSeenAt: FS.Timestamp.now() })
    const y = await organizerWithOrder({ orderStatus: 'pending' })
    await put(`walletTopupReconciliation/${y.orderId}`, { orderId: y.orderId, uid: y.uid, amountPaise: y.amount, paymentId: y.paymentId, status: 'exhausted', attempts: 12 })

    const writes: string[] = []
    for (const [proto, names] of [[FS.DocumentReference.prototype, ['set', 'update', 'delete', 'create']], [FS.Firestore.prototype, ['runTransaction', 'batch']]] as const) {
      for (const name of names) vi.spyOn(proto as unknown as Record<string, () => unknown>, name).mockImplementation(() => { writes.push(name); throw new Error('write in a list') })
    }
    const rows: Array<Record<string, unknown>> = []
    let cursor: string | null = null
    for (let i = 0; i < 100; i++) {
      const res = await get('Bearer super', cursor ? `?cursor=${cursor}` : '')
      expect(res.status).toBe(200)
      const body = await res.json() as { rows: Array<Record<string, unknown>>; nextCursor: string | null }
      rows.push(...body.rows)
      cursor = body.nextCursor
      if (!cursor) break
    }
    vi.restoreAllMocks()
    expect(writes).toEqual([])
    expect(rows.find(r => r.recordId === `dup_${dupPay}`)).toMatchObject({ kind: 'duplicate', status: 'duplicate_payment', creditPossible: false, refundReferenceRequired: true, orderStatus: 'credited' })
    expect(rows.find(r => r.recordId === y.orderId)).toMatchObject({ kind: 'order', status: 'exhausted', creditPossible: true, refundReferenceRequired: false, orderStatus: 'pending', attempts: 12 })
    expect(rows.every(r => ['needs_review', 'exhausted', 'duplicate_payment'].includes(String(r.status)))).toBe(true)
  }, T)

  // ═══ W2.f.1 · the Admin Wallet Top-ups list is Super Admin only ════════════════════════════════
  it('W2.f.1 · the admin top-ups list (amounts, payments, organizers): 403 without a Super Admin — a legacy admin:true caller gets SUPER_ADMIN_REQUIRED and no data; a Super Admin gets the list', async () => {
    const x = await organizerWithOrder({ orderStatus: 'credited' })
    await adminDb.doc(`walletTopups/${x.orderId}`).update({ createdAt: FS.Timestamp.now() })   // newest → first page
    const { GET: LIST } = await import('@/app/api/admin/wallet-topups/route')
    const list = (auth: string | null) => LIST(new NextRequest('http://localhost/api/admin/wallet-topups?pageSize=100', { headers: auth ? { authorization: auth } : {} }))
    for (const auth of [null, 'Bearer organizer', 'Bearer plain']) {
      const r = await list(auth)
      expect(r.status, String(auth)).toBe(403)
      const body = await r.json() as Record<string, unknown>
      expect(body, String(auth)).not.toHaveProperty('items')
      if (auth === 'Bearer plain') expect(body.code).toBe('SUPER_ADMIN_REQUIRED')
    }
    const ok = await list('Bearer super')
    expect(ok.status).toBe(200)
    const body = await ok.json() as { items: Array<{ orderId: string; amountPaise: number }> }
    expect(body.items.find(i => i.orderId === x.orderId)).toMatchObject({ amountPaise: 50_000 })
  }, T)

  // ═══ W2.g · Operations Center counts on real Firestore count() ═══════════════════════════════
  it('W2.g · Operations health and the recovery queue count each held status once (deltas over a shared emulator)', async () => {
    const { getOperationsHealth, heldWalletTopupCount } = await import('@/lib/operations/healthMetrics')
    const { getRecoveryHealth } = await import('@/lib/operations/recovery')
    const snap = async () => {
      const [h0, r0] = await Promise.all([getOperationsHealth(), getRecoveryHealth()])
      return { f: h0.financial, held: heldWalletTopupCount(h0.financial), dlqHeld: r0.deadLetter.walletTopupsHeld.count, dlqRecon: r0.deadLetter.reconciliations.count }
    }
    const before = await snap()
    const seedRec = async (status: string) => { const r = id('rec'); await put(`walletTopupReconciliation/${r}`, { orderId: id('order'), uid: id('org'), status }) }
    for (const s of ['needs_review', 'exhausted', 'exhausted', 'duplicate_payment', 'pending', 'resolved', 'skipped']) await seedRec(s)
    const after = await snap()
    expect(after.f.walletTopupsNeedsReview - before.f.walletTopupsNeedsReview).toBe(1)
    expect(after.f.walletTopupsExhausted - before.f.walletTopupsExhausted).toBe(2)
    expect(after.f.walletTopupDuplicatePayments - before.f.walletTopupDuplicatePayments).toBe(1)
    expect(after.f.pendingWalletTopups - before.f.pendingWalletTopups).toBe(1)           // meaning unchanged
    expect(after.held - before.held).toBe(4)                                               // resolved / skipped never counted
    expect(after.dlqHeld - before.dlqHeld).toBe(4)
    expect(after.dlqRecon - before.dlqRecon).toBe(1)                                       // only the auto-draining 'pending'
  }, T)

  // ═══ W2.f.1 · organizer status after a review ════════════════════════════════════════════════
  it('W2.f.1 · organizer status: resolved without credit → "not_credited" (never under review), credited after review → "credited"; nothing internal is returned', async () => {
    const statusOf = async (uid: string, orderId: string, paymentId: string) => {
      const { GET: STATUS } = await import('@/app/api/organizer/wallet/topup/status/route')
      h.who = uid
      const r = await STATUS(new NextRequest(`http://localhost/api/organizer/wallet/topup/status?${new URLSearchParams({ orderId, paymentId })}`, { headers: { authorization: 'Bearer t' } }))
      h.who = ''
      return { status: r.status, body: await r.json() as Record<string, unknown> }
    }
    const owner = async (uid: string) => put(`users/${uid}`, { uid, role: 'organizer', accountStatus: 'active', emailVerified: true, workspaceOwner: true })

    // A · the order's own payment, resolved without credit
    const a = await organizerWithOrder({ orderStatus: 'pending' }); await owner(a.uid)
    await put(`walletTopupReconciliation/${a.orderId}`, { orderId: a.orderId, uid: a.uid, amountPaise: a.amount, paymentId: a.paymentId, paymentIds: [a.paymentId], status: 'needs_review' })
    expect((await statusOf(a.uid, a.orderId, a.paymentId)).body).toEqual({ state: 'needs_review' })
    expect((await decide({ recordId: a.orderId, action: 'resolve', reason: 'Refunded by the bank; nothing owed.' })).status).toBe(200)
    const sa = await statusOf(a.uid, a.orderId, a.paymentId)
    expect(sa.status).toBe(200)
    expect(sa.body).toEqual({ state: 'not_credited' })                                   // the state only — no reviewer, reason or reference

    // B · a duplicate payment resolved with its refund reference; the credited payment is unaffected
    const b = await organizerWithOrder({ orderStatus: 'credited' }); await owner(b.uid)
    const dupPay = id('pay')
    await put(`walletTopupReconciliation/dup_${dupPay}`, { orderId: b.orderId, uid: b.uid, amountPaise: b.amount, paymentId: dupPay, creditedPaymentId: b.paymentId, status: 'duplicate_payment' })
    expect((await statusOf(b.uid, b.orderId, dupPay)).body).toEqual({ state: 'duplicate_payment' })
    expect((await decide({ recordId: `dup_${dupPay}`, action: 'resolve', reason: 'Refunded at the gateway.', refundReference: 'rfnd_W2f1Status01' })).status).toBe(200)
    expect((await statusOf(b.uid, b.orderId, dupPay)).body).toEqual({ state: 'not_credited' })
    expect((await statusOf(b.uid, b.orderId, b.paymentId)).body).toMatchObject({ state: 'credited' })

    // C · credited after review reads credited (with the organizer's own balance only)
    const c = await organizerWithOrder({ orderStatus: 'pending', balance: 1_000 }); await owner(c.uid)
    await put(`walletTopupReconciliation/${c.orderId}`, { orderId: c.orderId, uid: c.uid, amountPaise: c.amount, paymentId: c.paymentId, status: 'exhausted' })
    expect((await decide({ recordId: c.orderId, action: 'credit', reason: 'Verified captured at the gateway.' })).status).toBe(200)
    expect((await statusOf(c.uid, c.orderId, c.paymentId)).body).toEqual({ state: 'credited', balancePaise: 51_000 })
  }, T)
})
