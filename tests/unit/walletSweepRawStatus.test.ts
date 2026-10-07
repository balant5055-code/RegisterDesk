// RD-WALLET-W2.c safety fixes — unknown / missing Razorpay statuses, the abandoned-order watch
// classification and alert de-duplication.
//
// The first block drives the REAL razorpayAdapter (Razorpay SDK stubbed, as in
// providerContract.test.ts) with raw gateway payloads and feeds its output into the sweep's
// classifier and the raw abandonment check — the exact path the sweep takes. It also pins the
// emulator suite's adapter stub to the real mapping.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const sdk = vi.hoisted(() => ({
  orders:   { fetchPayments: vi.fn(async () => ({ items: [] as unknown[] })) },
  payments: { fetch: vi.fn(async () => null as unknown) },
}))
vi.mock('@/lib/razorpay/client', () => ({ razorpay: sdk, RAZORPAY_KEY_ID: 'rzp_test_stub', RAZORPAY_KEY_SECRET: 'stub_secret' }))
vi.mock('@/lib/env', async orig => ({ ...(await orig<typeof import('@/lib/env')>()), RAZORPAY_WEBHOOK_SECRET: 'stub_webhook_secret' }))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const ORDER = { orderId: 'order_a', amountPaise: 50_000 }
const raw = (over: Record<string, unknown>) => ({ id: 'pay_1', order_id: 'order_a', status: 'failed', amount: 50_000, currency: 'INR', ...over })

async function throughAdapter(rawItems: unknown[]) {
  const { razorpayAdapter } = await import('@/lib/payments/providers/razorpayAdapter')
  const { classifyStaleTopupPayments, assessRawPaymentsForAbandon } = await import('@/lib/wallet/topupReconciliation')
  sdk.orders.fetchPayments.mockResolvedValueOnce({ items: rawItems })
  const normalized = await razorpayAdapter.fetchOrderPayments('order_a')
  const verdict = classifyStaleTopupPayments(ORDER, normalized).verdict
  const proof = assessRawPaymentsForAbandon('order_a', { items: rawItems }, normalized.map(p => p.providerPaymentId))
  return { normalized, verdict, proof }
}

describe('FIX 1 · raw Razorpay statuses through the REAL adapter into the sweep', () => {
  it('an UNKNOWN raw status is read as "failed" by the adapter (unchanged, shared) — the raw check refuses abandonment', async () => {
    const t = await throughAdapter([raw({ status: 'mystery' })])
    expect(t.normalized[0].status).toBe('failed')                    // the adapter contract, unchanged
    expect(t.verdict).toBe('unpaid')                                  // the hazard the raw check exists for
    expect(t.proof).toEqual({ ok: false, reason: 'raw_status_unknown' })
  })
  it('a MISSING raw status: same — never abandoned', async () => {
    const t = await throughAdapter([raw({ status: undefined })])
    expect(t.normalized[0].status).toBe('failed')
    expect(t.verdict).toBe('unpaid')
    expect(t.proof).toEqual({ ok: false, reason: 'raw_status_missing' })
  })
  it('authorised and captured never reach abandonment, and the raw check refuses them too', async () => {
    expect((await throughAdapter([raw({ status: 'authorized' })])).verdict).toBe('authorized')
    expect((await throughAdapter([raw({ status: 'captured' })])).verdict).toBe('credit_one')
    const { assessRawPaymentsForAbandon } = await import('@/lib/wallet/topupReconciliation')
    expect(assessRawPaymentsForAbandon('order_a', { items: [raw({ status: 'authorized' })] }, ['pay_1'])).toEqual({ ok: false, reason: 'raw_status_authorized' })
    expect(assessRawPaymentsForAbandon('order_a', { items: [raw({ status: 'captured' })] }, ['pay_1'])).toEqual({ ok: false, reason: 'raw_status_captured' })
  })
  it('valid created / failed / refunded — and no payment at all — are provably unpaid', async () => {
    for (const status of ['created', 'failed', 'refunded']) {
      const t = await throughAdapter([raw({ status })])
      expect(t.verdict).toBe('unpaid')
      expect(t.proof).toEqual({ ok: true })
    }
    const none = await throughAdapter([])
    expect(none.verdict).toBe('unpaid')
    expect(none.proof).toEqual({ ok: true })
  })
  it('malformed raw fields are never provable (the adapter defaults a missing currency to INR — the raw check does not)', async () => {
    const cur = await throughAdapter([raw({ currency: undefined })])
    expect(cur.normalized[0].currency).toBe('INR')
    expect(cur.verdict).toBe('unpaid')
    expect(cur.proof).toEqual({ ok: false, reason: 'raw_currency_missing' })
    expect((await throughAdapter([raw({ amount: undefined })])).verdict).toBe('malformed')   // adapter 0 → malformed
    const { assessRawPaymentsForAbandon } = await import('@/lib/wallet/topupReconciliation')
    for (const [over, reason] of [
      [{ id: '' }, 'raw_payment_id_missing'], [{ order_id: 'order_b' }, 'raw_order_id_mismatch'],
      [{ amount: 0 }, 'raw_amount_invalid'], [{ amount: 1.5 }, 'raw_amount_invalid'],
    ] as const) {
      expect(assessRawPaymentsForAbandon('order_a', { items: [raw(over)] }, ['pay_1'])).toEqual({ ok: false, reason })
    }
    expect(assessRawPaymentsForAbandon('order_a', null, [])).toEqual({ ok: false, reason: 'raw_response_malformed' })
    expect(assessRawPaymentsForAbandon('order_a', { items: 'x' }, [])).toEqual({ ok: false, reason: 'raw_response_malformed' })
    expect(assessRawPaymentsForAbandon('order_a', { items: [null] }, [])).toEqual({ ok: false, reason: 'raw_payment_malformed' })
    // the raw view must be the same payments the adapter reported
    expect(assessRawPaymentsForAbandon('order_a', { items: [] }, ['pay_1'])).toEqual({ ok: false, reason: 'raw_adapter_disagree' })
  })
  it('the emulator suite stubs the adapter with a mirror of THIS mapping', () => {
    const emu = readFileSync('tests/emulator/walletTopupW1.emu.test.ts', 'utf8')
    expect(emu).toContain("const RAW_KNOWN = new Set(['created', 'authorized', 'captured', 'refunded', 'failed'])")
    expect(emu).toContain("RAW_KNOWN.has(p.status) ? p.status : 'failed'")
    expect(emu).toContain("currency: typeof p.currency === 'string' ? p.currency : 'INR'")
    expect(emu).toContain('amountPaise: typeof p.amount === \'number\' ? p.amount : Number(p.amount ?? 0)')
  })
})

describe('FIX 2 · late payments on abandoned orders (raw)', async () => {
  const { classifyLatePayments, ABANDONED_WATCH } = await import('@/lib/wallet/topupReconciliation')
  it('the approved window and budget', () => {
    expect(ABANDONED_WATCH).toMatchObject({ windowMs: 30 * 24 * 3_600_000, maxGatewayCalls: 10, pageSize: 200, circuitBreakerFailures: 3 })
  })
  it('captured (matching) / authorised / unknown / missing status / mismatch are findings; created / failed / refunded are not', () => {
    const r = classifyLatePayments(ORDER, { items: [
      raw({ id: 'p_cap', status: 'captured' }),
      raw({ id: 'p_auth', status: 'authorized' }),
      raw({ id: 'p_unk', status: 'mystery' }),
      raw({ id: 'p_none', status: undefined }),
      raw({ id: 'p_mis', status: 'captured', amount: 1_000 }),
      raw({ id: 'p_cur', status: 'captured', currency: undefined }),
      raw({ id: 'p_c', status: 'created' }), raw({ id: 'p_f', status: 'failed' }), raw({ id: 'p_r', status: 'refunded' }),
    ] })
    expect(r.ok).toBe(true)
    expect(r.ok && r.findings.map(f => [f.paymentId, f.kind])).toEqual([
      ['p_cap', 'captured'], ['p_auth', 'authorized'], ['p_unk', 'unknown_status'], ['p_none', 'unknown_status'],
      ['p_mis', 'mismatch'], ['p_cur', 'mismatch'],
    ])
  })
  it('unusable data is uncertain (never "nothing to see")', () => {
    expect(classifyLatePayments(ORDER, null)).toEqual({ ok: false, reason: 'raw_response_malformed' })
    expect(classifyLatePayments(ORDER, { items: [raw({ id: '' })] })).toEqual({ ok: false, reason: 'raw_payment_id_missing' })
    expect(classifyLatePayments(ORDER, { items: [raw({ order_id: 'x' })] })).toEqual({ ok: false, reason: 'raw_order_id_mismatch' })
  })
  it('the watch never credits and never changes the order (source contract)', () => {
    const body = readFileSync('lib/wallet/topupReconciliation.ts', 'utf8')
    const from = body.indexOf('export async function watchAbandonedWalletTopups')
    const watch = body.slice(from)
    expect(from).toBeGreaterThan(-1)
    expect(watch).not.toContain('atomicTopupCredit(')
    expect(watch).not.toContain("collection('walletTopups').doc(")
    expect(watch).not.toMatch(/tx\.(update|set|create)\(/)
    expect(watch).toContain("status: 'needs_review'")
    expect(watch.indexOf('if (!enforce) continue')).toBeLessThan(watch.indexOf('await recordWalletTopupReconciliation('))
  })
})

describe('FIX 3 · planSweepAlerts — alert once, again only on a change', async () => {
  const { planSweepAlerts, ALERT_DEDUPE } = await import('@/lib/wallet/topupReconciliation')
  const T0 = 1_000_000_000_000
  it('first detection fires; the same observation again does not', () => {
    const a = planSweepAlerts({}, [{ key: 'mismatch:p1', fingerprint: '1000|INR' }], T0)
    expect([...a.emitKeys]).toEqual(['mismatch:p1'])
    const b = planSweepAlerts(a.next, [{ key: 'mismatch:p1', fingerprint: '1000|INR' }], T0 + 60_000)
    expect(b.emitKeys.size).toBe(0)
    expect(b.changed).toBe(false)
  })
  it('a new payment id (new key) or a changed fingerprint fires', () => {
    const a = planSweepAlerts({}, [{ key: 'multi:o1', fingerprint: 'p1,p2' }], T0)
    const b = planSweepAlerts(a.next, [{ key: 'multi:o1', fingerprint: 'p1,p2,p3' }, { key: 'mismatch:p9', fingerprint: '5|INR' }], T0 + 1)
    expect([...b.emitKeys].sort()).toEqual(['mismatch:p9', 'multi:o1'])
  })
  it('still-present issues are kept alive; stale ones are pruned and would alert again; the state is capped', () => {
    const a = planSweepAlerts({}, [{ key: 'k', fingerprint: 'f' }], T0)
    const kept = planSweepAlerts(a.next, [{ key: 'k', fingerprint: 'f' }], T0 + ALERT_DEDUPE.refreshMs + 1)
    expect(kept.emitKeys.size).toBe(0)
    expect(kept.next.k.at).toBe(T0 + ALERT_DEDUPE.refreshMs + 1)
    const pruned = planSweepAlerts(a.next, [], T0 + ALERT_DEDUPE.retentionMs + 1)
    expect(pruned.next).toEqual({})
    expect(pruned.changed).toBe(true)
    const big: Record<string, { fp: string; at: number }> = {}
    for (let i = 0; i < ALERT_DEDUPE.maxEntries + 5; i++) big[`k${i}`] = { fp: 'f', at: T0 + i }
    const capped = planSweepAlerts(big, [], T0 + ALERT_DEDUPE.maxEntries + 10)
    expect(Object.keys(capped.next)).toHaveLength(ALERT_DEDUPE.maxEntries)
    expect(capped.next.k0).toBeUndefined()                              // the oldest go first
  })
  it('malformed stored state is ignored, never thrown on', () => {
    expect(planSweepAlerts('garbage', [{ key: 'k', fingerprint: 'f' }], T0).emitKeys.has('k')).toBe(true)
    expect(planSweepAlerts({ k: { fp: 1 } }, [{ key: 'k', fingerprint: 'f' }], T0).emitKeys.has('k')).toBe(true)
  })
})

describe('RAW credit guard · a single capture must not hide another payment (REAL adapter → classifier → raw check)', () => {
  const cap = (over: Record<string, unknown> = {}) => raw({ id: 'pay_c', status: 'captured', ...over })
  async function creditPath(rawItems: unknown[], rawForCheck: unknown = { items: rawItems }) {
    const { razorpayAdapter } = await import('@/lib/payments/providers/razorpayAdapter')
    const { classifyStaleTopupPayments, assessRawPaymentsForCredit } = await import('@/lib/wallet/topupReconciliation')
    sdk.orders.fetchPayments.mockResolvedValueOnce({ items: rawItems })
    const normalized = await razorpayAdapter.fetchOrderPayments('order_a')
    const c = classifyStaleTopupPayments(ORDER, normalized)
    return { c, check: assessRawPaymentsForCredit(ORDER, rawForCheck, 'pay_c', normalized.map(p => p.providerPaymentId)) }
  }

  it('captured + an UNKNOWN raw status: the adapter sees exactly one capture — the raw check withholds the credit', async () => {
    const t = await creditPath([cap(), raw({ id: 'pay_x', status: 'partially_captured' })])
    expect(t.c.verdict).toBe('credit_one')                                       // the concealment
    expect(t.check).toEqual({ ok: false, action: 'review', reason: 'raw_status_unknown', paymentIds: ['pay_c', 'pay_x'] })
  })
  it('captured + a MISSING raw status: withheld', async () => {
    const t = await creditPath([cap(), raw({ id: 'pay_x', status: undefined })])
    expect(t.c.verdict).toBe('credit_one')
    expect(t.check).toMatchObject({ ok: false, action: 'review', reason: 'raw_status_missing' })
  })
  it('another MATCHING capture in the raw view (the adapter disagreeing) → review, never a credit', async () => {
    const { assessRawPaymentsForCredit } = await import('@/lib/wallet/topupReconciliation')
    const r = assessRawPaymentsForCredit(ORDER, { items: [cap(), cap({ id: 'pay_d' })] }, 'pay_c', ['pay_c', 'pay_d'])
    expect(r).toEqual({ ok: false, action: 'review', reason: 'raw_multiple_captured', paymentIds: ['pay_c', 'pay_d'] })
  })
  it('malformed, incomplete or inconsistent raw responses → review', async () => {
    const { assessRawPaymentsForCredit } = await import('@/lib/wallet/topupReconciliation')
    const f = (rawResp: unknown, ids = ['pay_c']) => assessRawPaymentsForCredit(ORDER, rawResp, 'pay_c', ids)
    expect(f(null)).toMatchObject({ action: 'review', reason: 'raw_response_malformed' })
    expect(f({ items: {} })).toMatchObject({ action: 'review', reason: 'raw_response_malformed' })
    expect(f({ items: [cap(), null] })).toMatchObject({ action: 'review', reason: 'raw_payment_malformed' })
    expect(f({ items: [cap(), raw({ id: '' })] })).toMatchObject({ action: 'review', reason: 'raw_payment_id_missing' })
    expect(f({ items: [cap({ order_id: 'order_z' })] })).toMatchObject({ action: 'review', reason: 'raw_order_id_mismatch' })
    expect(f({ items: [cap()] }, ['pay_c', 'pay_f'])).toMatchObject({ action: 'review', reason: 'raw_adapter_disagree', paymentIds: ['pay_c', 'pay_f'] })
    expect(f({ items: [cap(), raw({ id: 'pay_f' })] })).toMatchObject({ action: 'review', reason: 'raw_adapter_disagree' })
    expect(f({ items: [cap({ status: 'authorized' })] })).toMatchObject({ action: 'review', reason: 'raw_target_not_captured' })
    expect(f({ items: [] }, [])).toMatchObject({ action: 'review', reason: 'raw_target_not_captured' })   // agree, but the capture is absent
    expect(f({ items: [] })).toMatchObject({ action: 'review', reason: 'raw_adapter_disagree' })
  })
  it("this payment's own raw amount / currency not matching → the W2.b mismatch path (adapter default INR hides a missing currency)", async () => {
    const t = await creditPath([cap({ currency: undefined })])
    expect(t.c.verdict).toBe('credit_one')
    expect(t.check).toEqual({ ok: false, action: 'mismatch', observedAmountPaise: 50_000, observedCurrency: null })
  })
  it('a valid single capture — alone, or with created / failed / refunded / authorised / mismatched others — may be credited', async () => {
    expect((await creditPath([cap()])).check).toEqual({ ok: true })
    const t = await creditPath([
      cap(), raw({ id: 'p2', status: 'created' }), raw({ id: 'p3', status: 'failed' }), raw({ id: 'p4', status: 'refunded' }),
      raw({ id: 'p5', status: 'authorized' }), raw({ id: 'p6', status: 'captured', amount: 1_000 }),
    ])
    expect(t.c.verdict).toBe('credit_one')
    expect(t.check).toEqual({ ok: true })
  })
  it('the sweep reads the order\'s RAW payments before every credit, in both modes, within the 2-call reservation', () => {
    const body = readFileSync('lib/wallet/topupReconciliation.ts', 'utf8')
    const from = body.indexOf("case 'credit_one': {")
    const branch = body.slice(from, body.indexOf('atomicTopupCredit(o.uid', from))
    expect(branch).toContain("razorpay.orders.fetchPayments(o.id)")
    expect(branch).toContain('assessRawPaymentsForCredit(')
    expect(branch).not.toContain('razorpay.payments.fetch(')                   // replaced, not added (budget)
    expect(branch.indexOf('assessRawPaymentsForCredit(')).toBeLessThan(branch.lastIndexOf('if (!enforce) return false'))
    expect(body).toContain('Math.floor((STALE_SWEEP.maxGatewayCalls - r.gatewayCalls) / 2)')
  })
})
