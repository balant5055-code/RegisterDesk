// RD-WALLET-W2.a — wallet top-up reconciliation retry policy (pure rules + source contracts).
// Behaviour on real Firestore: tests/emulator/walletTopupW1.emu.test.ts (W2.a block).

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const MIN = 60_000
const code = (f: string) => readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('RETRY_POLICY / retryDelayMs — the approved settings', async () => {
  const { RETRY_POLICY, retryDelayMs } = await import('@/lib/wallet/topupReconciliation')

  it('10 min initial delay, factor 2, 6 h cap, 12 attempts', () => {
    expect(RETRY_POLICY).toEqual({ initialDelayMs: 10 * MIN, factor: 2, maxDelayMs: 360 * MIN, maxAttempts: 12 })
  })
  it('progression after 1..12 failed attempts: 10, 20, 40, 80, 160, 320, then capped at 360 minutes', () => {
    expect(Array.from({ length: 12 }, (_, i) => retryDelayMs(i + 1) / MIN))
      .toEqual([10, 20, 40, 80, 160, 320, 360, 360, 360, 360, 360, 360])
  })
  it('never exceeds the cap, and treats nonsense input as the first attempt', () => {
    expect(retryDelayMs(1000)).toBe(360 * MIN)
    expect(retryDelayMs(0)).toBe(10 * MIN)
    expect(retryDelayMs(-5)).toBe(10 * MIN)
  })
})

describe('source contracts', () => {
  const src = code('lib/wallet/topupReconciliation.ts')

  it('the due query is ordered (nextAttemptAt, then document id) and bounded', () => {
    expect(src).toMatch(/\.where\('status', '==', 'pending'\)\s*\.where\('nextAttemptAt', '<=', Timestamp\.now\(\)\)\s*\.orderBy\('nextAttemptAt', 'asc'\)\s*\.orderBy\(FieldPath\.documentId\(\), 'asc'\)\s*\.limit\(limitN\)/)
  })
  it('legacy records are normalized first, by a cursor-paged bounded pass', () => {
    expect(src.indexOf('await normalizeLegacyRecords(')).toBeLessThan(src.indexOf(".where('nextAttemptAt', '<=', Timestamp.now())"))
    expect(src).toContain('readCursor(LEGACY_CURSOR_KEY)')
    expect(src).toContain('writeCursor(LEGACY_CURSOR_KEY')
  })
  it('firstSeenAt is written only on create', () => {
    const create = src.slice(src.indexOf('if (!snap.exists) {'), src.indexOf('const cur = snap.data()'))
    expect(create).toContain('firstSeenAt:   FieldValue.serverTimestamp()')
    const rest = src.slice(src.indexOf('const cur = snap.data()'), src.indexOf('captureFinancialError(input.error'))
    expect(rest).not.toContain('firstSeenAt')
  })
  it('held statuses are never downgraded back to pending', () => {
    expect(src).toContain("const HELD_STATUSES = new Set(['needs_review', 'exhausted', 'duplicate_payment'])")
  })
  it('the guard treats exhausted as unresolved; the status endpoint reports it as awaiting review', () => {
    expect(code('lib/wallet/topupGuard.ts')).toMatch(/exhausted:\s*'retry_exhausted'/)
    expect(code('lib/wallet/topupStatus.ts')).toContain("orderRecon?.status === 'exhausted'")
  })
  it('the composite index for the ordered due query is declared locally', () => {
    const idx = JSON.parse(readFileSync('firestore.indexes.json', 'utf8')) as { indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order?: string }> }> }
    const hit = idx.indexes.find(i => i.collectionGroup === 'walletTopupReconciliation'
      && i.fields.map(f => `${f.fieldPath}:${f.order}`).join(',') === 'status:ASCENDING,nextAttemptAt:ASCENDING')
    expect(hit).toBeDefined()
  })
})

describe('RD-WALLET-W2.b · topupMismatchReason — the machine-readable reason', async () => {
  const { topupMismatchReason } = await import('@/lib/wallet/topupReconciliation')
  const base = { expectedAmountPaise: 500, expectedCurrency: 'INR' }
  it('amount / currency / both', () => {
    expect(topupMismatchReason({ ...base, observedAmountPaise: 10, observedCurrency: 'INR' })).toBe('amount_mismatch')
    expect(topupMismatchReason({ ...base, observedAmountPaise: 500, observedCurrency: 'USD' })).toBe('currency_mismatch')
    expect(topupMismatchReason({ ...base, observedAmountPaise: 10, observedCurrency: 'USD' })).toBe('amount_and_currency_mismatch')
    expect(topupMismatchReason({ ...base, observedAmountPaise: null, observedCurrency: null })).toBe('amount_and_currency_mismatch')
  })
  it('a mismatch record is needs_review with NO nextAttemptAt, so the due-query never retries it', () => {
    const body = code('lib/wallet/topupReconciliation.ts')
    const fn = body.slice(body.indexOf('export async function recordTopupPaymentMismatch'), body.indexOf('export interface WalletRetryResult'))
    expect(fn).toContain("status:              'needs_review'")
    expect(fn).not.toContain('nextAttemptAt')
    expect(fn).toContain('tx.create(ref, {')
  })
})

describe('RD-WALLET-W2.c · stale sweep — mode, thresholds and classification', async () => {
  const { resolveWalletTopupSweepMode, STALE_SWEEP, classifyStaleTopupPayments } = await import('@/lib/wallet/topupReconciliation')
  const order = { orderId: 'order_a', amountPaise: 50_000 }
  const pay = (over: Record<string, unknown> = {}) =>
    ({ providerPaymentId: 'pay_1', providerOrderId: 'order_a', status: 'captured', amountPaise: 50_000, currency: 'INR', ...over })

  it('D5 — only "enforce" enforces; missing, empty or unknown values are report-only', () => {
    expect(resolveWalletTopupSweepMode(undefined)).toBe('report')
    expect(resolveWalletTopupSweepMode('')).toBe('report')
    expect(resolveWalletTopupSweepMode('bogus')).toBe('report')
    expect(resolveWalletTopupSweepMode('enforced')).toBe('report')
    expect(resolveWalletTopupSweepMode('report')).toBe('report')
    expect(resolveWalletTopupSweepMode('enforce')).toBe('enforce')
    expect(resolveWalletTopupSweepMode(' ENFORCE ')).toBe('enforce')
  })
  it('the approved thresholds and budgets', () => {
    expect(STALE_SWEEP).toMatchObject({
      staleAfterMs: 30 * 60_000, abandonAfterMs: 7 * 24 * 3_600_000,
      pageSize: 200, maxGatewayCalls: 50, concurrency: 5, timeBudgetMs: 25_000, circuitBreakerFailures: 3,
    })
    expect(STALE_SWEEP.routeCutoffMs + 2 * STALE_SWEEP.gatewayCallTimeoutMs).toBeLessThan(60_000)
  })
  it('one matching capture → credit_one; two or more → multiple_captured (none chosen); order-independent', () => {
    expect(classifyStaleTopupPayments(order, [pay()])).toMatchObject({ verdict: 'credit_one', matchingCaptured: ['pay_1'] })
    const two = classifyStaleTopupPayments(order, [pay({ providerPaymentId: 'pay_b' }), pay({ providerPaymentId: 'pay_a' })])
    expect(two).toMatchObject({ verdict: 'multiple_captured', matchingCaptured: ['pay_a', 'pay_b'] })
  })
  it('mismatches are listed and never match; authorised outranks a mismatch; nothing captured → unpaid', () => {
    expect(classifyStaleTopupPayments(order, [pay({ amountPaise: 1_000 })])).toMatchObject({ verdict: 'mismatch_only', mismatchedCaptured: [{ paymentId: 'pay_1', amountPaise: 1_000, currency: 'INR' }] })
    expect(classifyStaleTopupPayments(order, [pay({ currency: 'USD' })]).verdict).toBe('mismatch_only')
    expect(classifyStaleTopupPayments(order, [pay({ currency: 'USD' }), pay({ providerPaymentId: 'pay_2', status: 'authorized' })]).verdict).toBe('authorized')
    expect(classifyStaleTopupPayments(order, [pay({ amountPaise: 1_000 }), pay({ providerPaymentId: 'pay_2' })])).toMatchObject({ verdict: 'credit_one', matchingCaptured: ['pay_2'] })
    for (const status of ['created', 'failed', 'refunded']) expect(classifyStaleTopupPayments(order, [pay({ status })]).verdict).toBe('unpaid')
    expect(classifyStaleTopupPayments(order, []).verdict).toBe('unpaid')
  })
  it('unusable data is malformed — never a match, never "unpaid"', () => {
    for (const over of [{ providerPaymentId: '' }, { providerOrderId: 'order_b' }, { providerOrderId: null }, { status: 'weird' },
      { amountPaise: 0 }, { amountPaise: 12.5 }, { amountPaise: '50000' }, { currency: '' }, { currency: undefined }]) {
      expect(classifyStaleTopupPayments(order, [pay(over)]).verdict).toBe('malformed')
      expect(classifyStaleTopupPayments(order, [pay({ providerPaymentId: 'pay_ok', status: 'failed' }), pay(over)]).verdict).toBe('malformed')
    }
  })
  it('report mode is enforced in code: every write in the sweep sits behind the enforce flag', () => {
    const body = code('lib/wallet/topupReconciliation.ts')
    // The sweep function only (the W2.c safety-fix section after it keeps the alert state with .set();
    // comment lines are stripped by code(), so the section is found by its first declaration).
    const from = body.indexOf('export async function sweepStaleWalletTopups')
    const sweep = body.slice(from, body.indexOf('interface SweepAlert', from))
    expect(sweep.length).toBeGreaterThan(1000)
    for (const call of ['abandonStaleTopup(o', 'holdTopupForMultipleCaptures(o', 'atomicTopupCredit(o.uid']) {
      const at = sweep.indexOf(call)
      expect(at).toBeGreaterThan(-1)
      expect(sweep.lastIndexOf('if (!enforce) return false', at)).toBeGreaterThan(-1)
    }
    expect(sweep).not.toMatch(/\.set\(|\.delete\(/)
  })
})
