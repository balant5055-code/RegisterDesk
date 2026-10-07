// RD-WALLET-W2.d · S3 — gateway evidence (mock-only). Pure classifiers + bounded orchestration
// driven by typed fixtures; plus the structural boundary (no live provider, no mutation imports).

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  classifyGatewayEvidence, collectGatewayEvidence, createMockGatewayProvider, DISABLED_GATEWAY, GATEWAY_REPORT_LIMITS,
  type GatewayTopupInput, type GatewayTopupEvidence, type RawPayment,
} from '@/lib/reconciliation/walletTopupsGateway'

const pay = (over: Partial<RawPayment> & Record<string, unknown> = {}): RawPayment =>
  ({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 50_000, currency: 'INR', ...over })
const topup = (over: Partial<GatewayTopupInput> = {}): GatewayTopupInput =>
  ({ orderId: 'order_1', uid: 'u1', amountPaise: 50_000, currency: 'INR', status: 'pending', paymentId: null, knownPaymentIds: [], ...over })
const ev = (items: unknown, extra: Partial<GatewayTopupEvidence> = {}): GatewayTopupEvidence =>
  ({ orderPayments: { ok: true, data: { items } }, creditedPayment: null, ...extra })
const codes = (r: ReturnType<typeof classifyGatewayEvidence>) => r.findings.map(f => `${f.code}:${f.confidence}`).sort()

describe('classifyGatewayEvidence', () => {
  it('1 · a matching captured payment on a credited top-up verifies the credit (no findings)', () => {
    const r = classifyGatewayEvidence(topup({ status: 'credited', paymentId: 'pay_1' }),
      ev([pay()], { creditedPayment: { ok: true, data: pay() } }))
    expect(r).toEqual({ findings: [], creditVerified: true })
  })
  it('… and on a NOT-credited top-up it is positive evidence of a captured payment without credit', () => {
    expect(codes(classifyGatewayEvidence(topup(), ev([pay()])))).toEqual(['gateway_captured_without_credit:confirmed'])
  })
  it('2 · amount mismatch (both amounts valid) → confirmed', () => {
    const r = classifyGatewayEvidence(topup(), ev([pay({ amount: 1_000 })]))
    expect(codes(r)).toEqual(['gateway_amount_mismatch:confirmed'])
    expect(r.findings[0].detail).toMatchObject({ expectedPaise: 50_000, gatewayPaise: 1_000 })
  })
  it('… but no amount claim when the ORDER amount is unknown — the gap is reported, not assumed', () => {
    expect(codes(classifyGatewayEvidence(topup({ amountPaise: null }), ev([pay({ amount: 1_000 })])))).toEqual(['gateway_order_evidence_incomplete:inconclusive'])
  })
  it('S4 · a missing ORDER currency is never assumed to be INR: no currency mismatch, no match, no captured-without-credit', () => {
    const r = classifyGatewayEvidence(topup({ currency: null }), ev([pay({ currency: 'USD' }), pay({ id: 'pay_2' })]))
    expect(codes(r)).toEqual(['gateway_order_evidence_incomplete:inconclusive'])
    expect(r.findings[0].detail).toEqual({ amountRecorded: true, currencyRecorded: false })
    const credited = classifyGatewayEvidence(topup({ currency: null, status: 'credited', paymentId: 'pay_1' }),
      ev([pay()], { creditedPayment: { ok: true, data: pay() } }))
    expect(credited.creditVerified).toBe(false)                                                // nothing verified on an assumption
    expect(codes(credited)).toEqual(['gateway_order_evidence_incomplete:inconclusive'])
  })
  it('3 · currency mismatch → confirmed', () => {
    expect(codes(classifyGatewayEvidence(topup(), ev([pay({ currency: 'USD' })])))).toEqual(['gateway_currency_mismatch:confirmed'])
  })
  it('4 · order / payment-reference mismatch → confirmed (listed or credited payment naming another order)', () => {
    expect(codes(classifyGatewayEvidence(topup(), ev([pay({ order_id: 'order_9' })])))).toEqual(['gateway_absence_not_proof:inconclusive', 'gateway_order_mismatch:confirmed'])
    expect(codes(classifyGatewayEvidence(topup({ status: 'credited', paymentId: 'pay_1' }),
      ev([pay()], { creditedPayment: { ok: true, data: pay({ order_id: 'order_9' }) } })))).toEqual(['gateway_order_mismatch:confirmed'])
  })
  it('5 · D4 — no ownership evidence is collected, so no owner finding is ever made (never a false mismatch)', () => {
    const credited = { creditedPayment: { ok: true as const, data: pay() } }
    for (const uid of ['u1', 'u2', null]) {
      const r = classifyGatewayEvidence(topup({ uid, status: 'credited', paymentId: 'pay_1' }), ev([pay()], credited))
      expect(r).toEqual({ findings: [], creditVerified: true })                                 // uid plays no part
    }
    expect(codes(classifyGatewayEvidence(topup({ uid: null }), ev([])))).toEqual(['gateway_absence_not_proof:inconclusive'])
    for (const f of classifyGatewayEvidence(topup({ uid: null }), ev([pay({ order_id: 'order_9' }), pay({ status: 'mystery' })])).findings) {
      expect(f.code).not.toMatch(/owner/)
    }
  })
  it('6 · two or more matching captured payments → multiple captured, confirmed', () => {
    const r = classifyGatewayEvidence(topup(), ev([pay(), pay({ id: 'pay_2' })]))
    expect(codes(r)).toEqual(['gateway_captured_without_credit:confirmed', 'gateway_multiple_captured:confirmed'])
    expect(r.findings.find(f => f.code === 'gateway_multiple_captured')!.detail).toMatchObject({ payments: 2, paymentIds: 'pay_1,pay_2' })
  })
  it('7 · an EMPTY list is inconclusive — absence is not proof of non-payment', () => {
    expect(codes(classifyGatewayEvidence(topup(), ev([])))).toEqual(['gateway_absence_not_proof:inconclusive'])
    expect(codes(classifyGatewayEvidence(topup(), ev([pay({ status: 'failed' })])))).toEqual(['gateway_absence_not_proof:inconclusive'])
    // an order the gateway does not find is ALSO only absence
    expect(codes(classifyGatewayEvidence(topup(), { orderPayments: { ok: false, error: 'not_found' }, creditedPayment: null })))
      .toEqual(['gateway_absence_not_proof:inconclusive'])
  })
  it('8 · a known payment id missing from the list → list incomplete (inconclusive); a recorded id the gateway cannot find → probable, never confirmed', () => {
    const r = classifyGatewayEvidence(topup({ status: 'credited', paymentId: 'pay_1', knownPaymentIds: ['pay_7'] }),
      ev([pay()], { creditedPayment: { ok: false, error: 'not_found' } }))
    expect(codes(r)).toEqual(['gateway_list_incomplete:inconclusive', 'gateway_payment_not_found:probable'])
    expect(r.creditVerified).toBe(false)
  })
  it('9 · missing or malformed fields → inconclusive, never a match or mismatch', () => {
    for (const bad of [{ id: '' }, { order_id: undefined }, { amount: 0 }, { amount: 12.5 }, { amount: '50000' }, { currency: '' }, { status: undefined }]) {
      expect(codes(classifyGatewayEvidence(topup(), ev([pay(bad)])))).toEqual(['gateway_absence_not_proof:inconclusive', 'gateway_evidence_malformed:inconclusive'])
    }
    expect(codes(classifyGatewayEvidence(topup(), ev('not-a-list')))).toEqual(['gateway_evidence_malformed:inconclusive'])
    expect(codes(classifyGatewayEvidence(topup(), ev([null])))).toEqual(['gateway_absence_not_proof:inconclusive', 'gateway_evidence_malformed:inconclusive'])
  })
  it('10 · unknown payment statuses → inconclusive (never read as failed or captured)', () => {
    expect(codes(classifyGatewayEvidence(topup(), ev([pay({ status: 'partially_captured' })])))).toEqual(['gateway_absence_not_proof:inconclusive', 'gateway_status_unknown:inconclusive'])
    expect(codes(classifyGatewayEvidence(topup({ status: 'credited', paymentId: 'pay_1' }),
      ev([pay()], { creditedPayment: { ok: true, data: pay({ status: 'mystery' }) } })))).toEqual(['gateway_status_unknown:inconclusive'])
  })
  it('a credited payment the gateway shows as not captured → confirmed; refunded → probable', () => {
    const credited = topup({ status: 'credited', paymentId: 'pay_1' })
    expect(codes(classifyGatewayEvidence(credited, ev([pay()], { creditedPayment: { ok: true, data: pay({ status: 'failed' }) } }))))
      .toEqual(['gateway_credited_payment_not_captured:confirmed'])
    expect(codes(classifyGatewayEvidence(credited, ev([pay()], { creditedPayment: { ok: true, data: pay({ status: 'refunded' }) } }))))
      .toEqual(['gateway_credited_payment_refunded:probable'])
  })
  it('11 · timeouts and provider errors → gateway_unavailable, inconclusive', () => {
    for (const error of ['timeout', 'provider_error'] as const) {
      expect(codes(classifyGatewayEvidence(topup(), { orderPayments: { ok: false, error }, creditedPayment: null })))
        .toEqual(['gateway_unavailable:inconclusive'])
    }
  })
  it('13 · every finding is labelled mock evidence', () => {
    const r = classifyGatewayEvidence(topup(), ev([pay(), pay({ id: 'pay_2' })]))
    expect(r.findings.length).toBeGreaterThan(0)
    for (const f of r.findings) expect(f.source).toBe('mock')
  })
})

describe('collectGatewayEvidence — bounded, on demand', () => {
  it('the DISABLED provider (production) calls nothing and reports "not enabled"', async () => {
    const r = await collectGatewayEvidence([topup(), topup({ orderId: 'order_2' })], DISABLED_GATEWAY)
    expect(r).toEqual({ enabled: false, source: 'disabled', reason: 'gateway_verification_not_enabled', findings: [], checked: 0, creditsVerified: 0, deferred: 2, calls: 0, circuitOpen: false })
  })
  it('a mock run: ≤ 2 calls per order (payment list + credited payment), findings labelled mock, credits verified counted', async () => {
    const mock = createMockGatewayProvider({
      orderPayments: { order_1: { items: [pay()] } },
      payments: { pay_1: pay() },
    })
    const r = await collectGatewayEvidence([topup({ status: 'credited', paymentId: 'pay_1' })], mock)
    expect(r).toMatchObject({ enabled: true, source: 'mock', checked: 1, creditsVerified: 1, calls: 2, findings: [] })
    expect(mock.calls).toEqual(['orderPayments:order_1', 'payment:pay_1'])
  })
  it('D4 · the order / owner is never fetched — one call for a pending top-up, two for a credited one', async () => {
    const mock = createMockGatewayProvider({ orderPayments: { order_1: { items: [] }, order_2: { items: [pay({ order_id: 'order_2' })] } }, payments: { pay_1: pay({ order_id: 'order_2' }) } })
    const r = await collectGatewayEvidence([topup(), topup({ orderId: 'order_2', status: 'credited', paymentId: 'pay_1' })], mock)
    expect(mock.calls).toEqual(['orderPayments:order_1', 'orderPayments:order_2', 'payment:pay_1'])
    expect(r).toMatchObject({ checked: 2, calls: 3, creditsVerified: 1, deferred: 0 })
    expect(Object.keys(mock).sort()).toEqual(['calls', 'orderPayments', 'payment', 'source'])          // no order lookup exists
    expect(Object.keys(DISABLED_GATEWAY).sort()).toEqual(['orderPayments', 'payment', 'source'])
  })
  it('D4 · the call budget is 1 per order + 1 per credited payment: 10 credited orders fit (20 ≤ maxCalls)', async () => {
    const orders = Array.from({ length: 10 }, (_, i) => topup({ orderId: `o${i}`, status: 'credited', paymentId: `p${i}` }))
    const r = await collectGatewayEvidence(orders, createMockGatewayProvider({}))
    expect(r).toMatchObject({ checked: 10, calls: 20, deferred: 0, circuitOpen: false })
  })
  it('11 · a hanging call times out (inconclusive), errors count toward the circuit breaker, which stops the run', async () => {
    const orders = Array.from({ length: 5 }, (_, i) => topup({ orderId: `o${i}` }))
    const failing = createMockGatewayProvider({ orderPayments: Object.fromEntries(orders.map(o => [o.orderId, 'provider_error'])) })
    const r = await collectGatewayEvidence(orders, failing)
    expect(r.circuitOpen).toBe(true)
    expect(r.calls).toBe(GATEWAY_REPORT_LIMITS.circuitBreakerFailures)
    expect(r.deferred).toBeGreaterThan(0)
    for (const f of r.findings) expect(f.confidence).toBe('inconclusive')
  }, 30_000)
  it('11 · a call that never answers is cut off by the per-call timeout and reported as unavailable', async () => {
    const hanging = createMockGatewayProvider({ orderPayments: { order_1: 'hang' } })
    const started = Date.now()
    const r = await collectGatewayEvidence([topup()], hanging)
    expect(Date.now() - started).toBeLessThan(GATEWAY_REPORT_LIMITS.callTimeoutMs + 3_000)
    expect(r.findings).toContainEqual(expect.objectContaining({ code: 'gateway_unavailable', confidence: 'inconclusive', detail: { error: 'timeout', lookup: 'order_payments' } }))
  }, 30_000)
  it('respects the call budget and the per-request order cap', async () => {
    const orders = Array.from({ length: 20 }, (_, i) => topup({ orderId: `o${i}`, status: 'credited', paymentId: `p${i}` }))
    const mock = createMockGatewayProvider({})
    const r = await collectGatewayEvidence(orders, mock)
    expect(r.calls).toBeLessThanOrEqual(GATEWAY_REPORT_LIMITS.maxCalls)
    expect(r.checked).toBeLessThanOrEqual(GATEWAY_REPORT_LIMITS.maxOrders)
    expect(r.deferred).toBe(20 - r.checked)
  })
  it('S4 · candidates capped away before the call still count as deferred (not silently dropped)', async () => {
    const mock = createMockGatewayProvider({ orderPayments: { order_1: { items: [] } } })
    const r = await collectGatewayEvidence([topup()], mock, { totalCandidates: 14 })
    expect(r).toMatchObject({ checked: 1, deferred: 13 })
    expect((await collectGatewayEvidence([topup()], DISABLED_GATEWAY, { totalCandidates: 14 })).deferred).toBe(14)
  })
  it('G3 · with 5 s left before the shared deadline no gateway call is started (less than one 8 s timeout)', async () => {
    const mock = createMockGatewayProvider({ orderPayments: { order_1: { items: [] } } })
    const r = await collectGatewayEvidence([topup(), topup({ orderId: 'order_2' })], mock, { deadlineAtMs: Date.now() + 5_000 })
    expect(mock.calls).toEqual([])
    expect(r).toMatchObject({ enabled: true, checked: 0, calls: 0, deferred: 2, findings: [] })
  })
  it('G3 · with 3 s left, a call is cut off at 3 s — never the full 8 s past the deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })                                  // the clock moves only when a call "takes" time
    try {
      const deadlineAtMs = Date.now() + GATEWAY_REPORT_LIMITS.callTimeoutMs  // exactly one full timeout left: the order starts
      const base = createMockGatewayProvider({ payments: { pay_1: 'hang' } })
      const slow = { ...base, orderPayments: async () => { vi.setSystemTime(Date.now() + 5_000); return { ok: true as const, data: { items: [pay()] } } } }
      const started = performance.now()
      const r = await collectGatewayEvidence([topup({ status: 'credited', paymentId: 'pay_1' })], slow, { deadlineAtMs })
      const took = performance.now() - started
      expect(took).toBeGreaterThan(2_500)
      expect(took).toBeLessThan(5_000)                                       // capped at the 3 s left, not 8 s
      expect(r.findings).toContainEqual(expect.objectContaining({ code: 'gateway_unavailable', detail: { error: 'timeout', lookup: 'credited_payment' } }))
      expect(r.creditsVerified).toBe(0)
    } finally { vi.useRealTimers() }
  }, 30_000)
  it('G3 · with no time left, the credited-payment lookup is not made — reported as a timeout, never as evidence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const deadlineAtMs = Date.now() + GATEWAY_REPORT_LIMITS.callTimeoutMs
      const base = createMockGatewayProvider({ payments: { pay_1: pay() } })
      const slow = { ...base, orderPayments: async () => { vi.setSystemTime(Date.now() + 9_000); return { ok: true as const, data: { items: [pay()] } } } }
      const r = await collectGatewayEvidence([topup({ status: 'credited', paymentId: 'pay_1' })], slow, { deadlineAtMs })
      expect(base.calls).toEqual([])                                         // payment() never invoked
      expect(r).toMatchObject({ calls: 1, checked: 1, creditsVerified: 0 })
      expect(r.findings).toContainEqual(expect.objectContaining({ code: 'gateway_unavailable', confidence: 'inconclusive', detail: { error: 'timeout', lookup: 'credited_payment' } }))
    } finally { vi.useRealTimers() }
  })
  it('the request limits are unchanged', () => {
    expect(GATEWAY_REPORT_LIMITS).toEqual({ maxOrders: 10, maxCalls: 25, callTimeoutMs: 8_000, circuitBreakerFailures: 3, deadlineMs: 20_000 })
  })
  it('a provider that throws is a provider error, never an exception escaping the report', async () => {
    const throwing = { ...createMockGatewayProvider({}), orderPayments: async () => { throw new Error('boom') } }
    const r = await collectGatewayEvidence([topup()], throwing)
    expect(r.findings.map(f => f.code)).toContain('gateway_unavailable')
  })
})

describe('the mock-only boundary (structural)', () => {
  const strip = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const mod = strip('lib/reconciliation/walletTopupsGateway.ts')
  it('14 · the gateway module imports nothing but S2 types — no SDK, provider, Firebase, wallet or payment code', () => {
    const imports = mod.split('\n').filter(l => /^\s*import\b/.test(l))
    expect(imports).toEqual(["import type { ReconConfidence, ReconDetail } from '@/lib/reconciliation/walletTopups'"])
    expect(mod).not.toMatch(/razorpay|cashfree|resolvePaymentProvider|firebase|adminDb|fetch\(/i)
    // The real mutation entry points of the codebase (and none can be reached: the only import is types).
    expect(mod).not.toMatch(/atomicTopupCredit|atomicWalletCredit|txnDeductWallet|recordWalletTopupReconciliation|persistWalletTopupReconciliation|recordDuplicateTopupPayment|recordTopupPaymentMismatch|flagSuspiciousPayment|holdTopupForMultipleCaptures|abandonStaleTopup|recoverOrphanedCapture|settleCapturedRegistration|refundPayment|payments\.refund/)
    expect(mod).not.toMatch(/process\.env/)                                                       // no switch to a live source
    expect(mod).not.toMatch(/paymentEvents/)
  })
  it('D4 · no order / owner lookup or owner finding remains in the module', () => {
    expect(mod).not.toMatch(/\.order\(|RawOrder\b|gateway_owner_|notes\.uid/)
  })
  it('the service passes no provider from the request: production is always DISABLED_GATEWAY', () => {
    const svc = strip('lib/admin/walletManagementService.ts')
    expect(svc).toContain('deps.gatewayProvider ?? DISABLED_GATEWAY')
    expect(svc).not.toContain('createMockGatewayProvider')
    expect(svc).not.toMatch(/paymentEvents/)
    const route = strip('app/api/admin/wallet-management/route.ts')
    expect(route).toContain("gateway: p.get('gateway') === '1'")
    expect(route).not.toMatch(/gatewayProvider|createMockGatewayProvider|walletTopupsGateway/)
  })
  it('the console labels gateway evidence: not-enabled in production, MOCK when present', () => {
    const ui = strip('app/(admin)/admin/wallet-management/PageClient.tsx')
    expect(ui).toContain('Gateway verification unavailable')
    expect(ui).toContain('No payment provider was contacted')
    expect(ui).toContain('MOCK EVIDENCE — not production payment data.')
  })
})
