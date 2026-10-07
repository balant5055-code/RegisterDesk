// RD-WALLET-W2.f — Super Admin review of held wallet top-ups: the pure rules and the structural
// contracts (authorization, gateway-before-credit, no refunds, ledger written only by the wallet
// transaction). The behaviour on real Firestore is tests/emulator/walletTopupReview.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const {
  checkPaymentForReviewedCredit, requiresRefundReference, parseRefundReference, heldRecordKind, isReviewRecordId,
} = await import('@/lib/wallet/topupReview')
const { REVIEW_CREDITABLE_TOPUP_STATUSES } = await import('@/lib/firebase/firestore/wallet')
const { resolveTopupPaymentState } = await import('@/lib/wallet/topupStatus')
const { TOPUP_OUTCOME_MESSAGES } = await import('@/lib/wallet/topupVerifyOutcome')

const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const EXPECT = { paymentId: 'pay_1', orderId: 'order_1', amountPaise: 50_000 }
const captured = (over: Record<string, unknown> = {}) =>
  ({ id: 'pay_1', order_id: 'order_1', status: 'captured', amount: 50_000, currency: 'INR', amount_refunded: 0, refund_status: null, ...over })

describe('checkPaymentForReviewedCredit — the exact captured payment, or no credit', () => {
  it('captured, this payment, this order, this amount, INR, nothing refunded → verified', () => {
    expect(checkPaymentForReviewedCredit(captured(), EXPECT)).toEqual({
      ok: true, evidence: { paymentId: 'pay_1', orderId: 'order_1', amountPaise: 50_000, currency: 'INR', status: 'captured', amountRefundedPaise: 0 },
    })
  })
  it.each([
    ['a different payment id',         { id: 'pay_2' },              'payment_id_differs'],
    ['another order',                  { order_id: 'order_9' },      'order_mismatch'],
    ['authorized only',                { status: 'authorized' },     'not_captured:authorized'],
    ['refunded',                       { status: 'refunded' },       'not_captured:refunded'],
    ['failed',                         { status: 'failed' },         'not_captured:failed'],
    ['no status',                      { status: undefined },        'not_captured:unknown'],
    ['another currency',               { currency: 'USD' },          'currency_mismatch'],
    ['a missing currency (never assumed INR)', { currency: undefined }, 'currency_mismatch'],
    ['another amount',                 { amount: 49_999 },           'amount_mismatch'],
    ['a missing amount (never assumed)', { amount: undefined },      'amount_mismatch'],
    ['a string amount',                { amount: '50000' },          'amount_mismatch'],
    ['a partial refund',               { amount_refunded: 100 },     'refunded_at_gateway'],
    ['a refund in progress',           { refund_status: 'partial' }, 'refunded_at_gateway'],
    ['an unknown refund state',        { amount_refunded: undefined }, 'refund_state_unknown'],
  ])('%s → refused', (_l, over, reason) => {
    expect(checkPaymentForReviewedCredit(captured(over), EXPECT)).toEqual({ ok: false, reason })
  })
  it('a malformed gateway response → refused', () => {
    for (const raw of [null, undefined, 'captured', 42]) {
      expect(checkPaymentForReviewedCredit(raw, EXPECT)).toEqual({ ok: false, reason: 'gateway_response_malformed' })
    }
  })
})

describe('requiresRefundReference — a duplicate captured payment needs its external refund reference', () => {
  it('a recorded duplicate, or one of several captures held together', () => {
    expect(requiresRefundReference('dup_pay_2', { status: 'duplicate_payment', paymentId: 'pay_2' }, { status: 'credited', paymentId: 'pay_1' })).toBe(true)
    expect(requiresRefundReference('dup_pay_2', { status: 'needs_review', reason: 'multiple_captured_payments', paymentId: 'pay_2' }, { status: 'needs_review' })).toBe(true)
  })
  it("the order's own payment when the order was credited with ANOTHER payment", () => {
    expect(requiresRefundReference('order_1', { status: 'needs_review', paymentId: 'pay_2' }, { status: 'credited', paymentId: 'pay_1' })).toBe(true)
  })
  it('not a duplicate: the credited payment itself, a pending order, a missing order, a mismatched payment', () => {
    expect(requiresRefundReference('order_1', { status: 'needs_review', paymentId: 'pay_1' }, { status: 'credited', paymentId: 'pay_1' })).toBe(false)
    expect(requiresRefundReference('order_1', { status: 'exhausted', paymentId: 'pay_1' }, { status: 'pending' })).toBe(false)
    expect(requiresRefundReference('order_1', { status: 'needs_review', paymentId: 'pay_1' }, null)).toBe(false)
    expect(requiresRefundReference('mismatch_pay_3', { status: 'needs_review', paymentId: 'pay_3' }, { status: 'credited', paymentId: 'pay_1' })).toBe(false)
  })
})

describe('inputs', () => {
  it('refund reference: blank → none; a gateway / bank reference → kept; anything else refused', () => {
    expect(parseRefundReference(undefined)).toEqual({ ok: true, value: null })
    expect(parseRefundReference('   ')).toEqual({ ok: true, value: null })
    expect(parseRefundReference(' rfnd_ABC123xyz ')).toEqual({ ok: true, value: 'rfnd_ABC123xyz' })
    expect(parseRefundReference('UTR/2026/0001-A')).toEqual({ ok: true, value: 'UTR/2026/0001-A' })
    for (const bad of ['ab', 'x'.repeat(101), 'rfnd <script>', '_leading', 42, {}]) {
      expect(parseRefundReference(bad).ok, String(bad)).toBe(false)
    }
  })
  it('record kinds and ids', () => {
    expect(heldRecordKind('order_1')).toBe('order')
    expect(heldRecordKind('dup_pay_1')).toBe('duplicate')
    expect(heldRecordKind('mismatch_pay_1')).toBe('mismatch')
    expect(isReviewRecordId('dup_pay_1')).toBe(true)
    for (const bad of ['', 'a/b', 'a b', 'x'.repeat(161), null, 3]) expect(isReviewRecordId(bad)).toBe(false)
  })
  it('a reviewed credit is possible from pending / needs_review / abandoned — never from credited', () => {
    expect([...REVIEW_CREDITABLE_TOPUP_STATUSES].sort()).toEqual(['abandoned', 'needs_review', 'pending'])
  })
})

describe('W2.f.1 · organizer status after a review', () => {
  const closed  = (over: Record<string, unknown> = {}) => ({ status: 'resolved', review: { action: 'resolved_without_credit' }, ...over })
  const dupClosed = closed({ review: { action: 'duplicate_refunded_externally' } })
  it('a payment whose own record was closed without credit → not_credited', () => {
    expect(resolveTopupPaymentState({ status: 'credited', paymentId: 'pay_1' }, 'pay_2', null, dupClosed)).toBe('not_credited')
    expect(resolveTopupPaymentState({ status: 'pending' }, 'pay_3', null, null, closed())).toBe('not_credited')
  })
  it("an order whose review was closed (holdResolvedAt), or the order's own record for THIS payment → not_credited", () => {
    expect(resolveTopupPaymentState({ status: 'needs_review', holdResolvedAt: { seconds: 1 } }, 'pay_1', closed({ paymentId: 'pay_1' }), null)).toBe('not_credited')
    expect(resolveTopupPaymentState({ status: 'needs_review', holdResolvedAt: { seconds: 1 } }, 'pay_1', null, dupClosed)).toBe('not_credited')
    expect(resolveTopupPaymentState({ status: 'abandoned' }, 'pay_1', closed({ paymentId: 'pay_0', paymentIds: ['pay_0', 'pay_1'] }), null)).toBe('not_credited')
  })
  it('still under review when THIS payment has an open record, or the closed record concerns another payment', () => {
    expect(resolveTopupPaymentState({ status: 'needs_review', holdResolvedAt: { seconds: 1 } }, 'pay_9', null, { status: 'needs_review' })).toBe('needs_review')
    expect(resolveTopupPaymentState({ status: 'abandoned' }, 'pay_9', closed({ paymentId: 'pay_1', paymentIds: ['pay_1'] }), null)).toBe('needs_review')
    expect(resolveTopupPaymentState({ status: 'needs_review' }, 'pay_1', { status: 'exhausted' }, null)).toBe('needs_review')
  })
  it("unchanged: credited after review, a retry's own 'resolved', open duplicates and mismatches", () => {
    expect(resolveTopupPaymentState({ status: 'credited', paymentId: 'pay_1' }, 'pay_1', { status: 'resolved', review: { action: 'credited' } }, null)).toBe('credited')
    expect(resolveTopupPaymentState({ status: 'pending' }, 'pay_1', { status: 'resolved' }, null)).toBe('pending')       // no review → not a closure
    expect(resolveTopupPaymentState({ status: 'credited', paymentId: 'pay_1' }, 'pay_2', null, { status: 'duplicate_payment' })).toBe('duplicate_payment')
    expect(resolveTopupPaymentState({ status: 'pending' }, 'pay_3', null, null, { status: 'needs_review' })).toBe('needs_review')
    expect(resolveTopupPaymentState({ status: 'credited', paymentId: 'pay_1' }, 'pay_2', null, null)).toBe('duplicate_payment')
  })
  it('the organizer wording is final and friendly — never "review", no internal detail', () => {
    const m = TOPUP_OUTCOME_MESSAGES.notCredited
    expect(m).toContain('not added to your wallet')
    expect(m).not.toMatch(/review|reviewed|super admin|refund reference|rfnd_|reason/i)
    expect(m).toMatch(/contact support/i)
  })
  it('the event wizard treats not_credited as final (clears the hold, says so) instead of leaving a review hold', () => {
    const wizard = code('app/(dashboard)/dashboard/events/new/page.tsx')
    const branch = wizard.slice(wizard.indexOf("d.state === 'not_credited'"))
    expect(branch).toContain('setTopupHold(null)')
    expect(branch).toContain('TOPUP_OUTCOME_MESSAGES.notCredited')
  })
})

describe('W2.f.1 · the Admin Wallet Top-ups page and its data are Super Admin only', () => {
  const list = code('app/api/admin/wallet-topups/route.ts')
  const page = code('app/(admin)/admin/wallet-topups/PageClient.tsx')
  it('the list API uses requireSuperAdmin (ADMIN_UIDS) — never the legacy admin check — before any read', () => {
    expect(list).toContain("import { requireSuperAdmin }         from '@/lib/admin/financialGuard'")
    expect(list).not.toContain('resolveAdminUid')
    const gate = list.indexOf('await requireSuperAdmin(req)')
    expect(gate).toBeGreaterThan(-1)
    expect(list.indexOf("adminDb.collection('walletTopups')")).toBeGreaterThan(gate)
    expect(list).toContain('if (gate.response) return gate.response')
  })
  it('the page renders no financial data and no review queue until access is confirmed; a 403 shows only a notice', () => {
    expect(page).toContain("{access === 'granted' && <HeldTopupsReview")
    expect(page).toContain("{access === 'denied' ? (")
    expect(page).toContain("'Wallet Top-ups is available to Super Admins only.'")
    expect(page).toMatch(/if \(res\.status === 403\) \{\s*setAccess\('denied'\)/)
  })
})

describe('structural safety', () => {
  const route  = code('app/api/admin/wallet-topups/review/route.ts')
  const review = code('lib/wallet/topupReview.ts')
  const wallet = code('lib/firebase/firestore/wallet.ts')
  const guard  = code('lib/wallet/topupGuard.ts')
  const ui     = code('app/(admin)/admin/wallet-topups/HeldTopupsReview.tsx')

  it('the review API is Super Admin only on BOTH methods, before anything is read or decided', () => {
    expect(route).toMatch(/export async function GET\(/)
    expect(route).toMatch(/export async function POST\(/)
    expect(route).not.toMatch(/export async function (PUT|PATCH|DELETE)\(/)
    expect(route).not.toContain('resolveAdminUid')
    expect((route.match(/await requireSuperAdmin\(req\)/g) ?? []).length).toBe(2)
    const post = route.slice(route.indexOf('export async function POST('))
    const gate = post.indexOf('await requireSuperAdmin(req)')
    for (const step of ['parseFinancialReason(body.reason)', 'parseRefundReference(body.refundReference)', 'creditHeldTopup(', 'resolveHeldTopup(']) {
      expect(post.indexOf(step), step).toBeGreaterThan(gate)
    }
    expect(post.indexOf('parseFinancialReason(')).toBeLessThan(post.indexOf('creditHeldTopup('))
    expect(route).toContain('export const maxDuration = 60')
  })
  it('credit: the gateway is asked BEFORE the credit transaction, and the credit goes through the wallet transaction', () => {
    const credit = review.slice(review.indexOf('export async function creditHeldTopup('), review.indexOf('export async function resolveHeldTopup('))
    const fetchAt = credit.indexOf('await fetchGatewayPayment(')
    const checkAt = credit.indexOf('checkPaymentForReviewedCredit(')
    const txnAt   = credit.indexOf('await creditTopupUnderReview(')
    expect(fetchAt).toBeGreaterThan(-1)
    expect(checkAt).toBeGreaterThan(-1)
    expect(fetchAt).toBeLessThan(txnAt)
    expect(checkAt).toBeLessThan(txnAt)
    expect(credit).toContain("stageAdminAudit(txn, {")
  })
  it('resolve: one transaction with the audit row staged in it', () => {
    const resolve = review.slice(review.indexOf('export async function resolveHeldTopup('), review.indexOf('export async function listHeldTopupRecords('))
    expect(resolve).toContain('adminDb.runTransaction(')
    expect(resolve).toContain('stageAdminAudit(txn, {')
    expect(resolve).toContain("'REFUND_REFERENCE_REQUIRED'")
  })
  it('no in-app refund, no W2.d provider, no paymentEvents, no second ledger writer', () => {
    for (const [f, src] of [['review', review], ['route', route], ['ui', ui]] as const) {
      expect(src, f).not.toMatch(/payments\.refund|\.refund\(|fetchMultipleRefund|refundPayment/)
      expect(src, f).not.toMatch(/walletTopupsGateway|paymentEvents/)
      expect(src, f).not.toMatch(/collection\('walletTransactions'\)/)
    }
    // the ledger row is still written only in the wallet module (create-only)
    expect(wallet).toMatch(/txn\.create\(ledgerRef,/g)
    const reviewed = wallet.slice(wallet.indexOf('export async function creditTopupUnderReview'))
    expect(reviewed).toContain('txn.create(ledgerRef,')
    expect(reviewed).toContain("new TopupCreditError('TOPUP_LEDGER_CONFLICT')")
    expect(reviewed).not.toContain('txn.set(ledgerRef')
  })
  it('the automated credit path is untouched: atomicTopupCredit still refuses every non-pending order and every hold', () => {
    const atomic = wallet.slice(wallet.indexOf('export async function atomicTopupCredit'), wallet.indexOf('export const REVIEW_CREDITABLE_TOPUP_STATUSES'))
    expect(atomic).toContain("if (topup.status !== 'pending') throw new TopupCreditError('TOPUP_NOT_CREDITABLE')")
    expect(atomic).toContain("holdStatus === 'needs_review' || holdStatus === 'exhausted'")
  })
  it('the guard stops blocking ONLY an order whose review was closed', () => {
    expect(guard).toContain("return o.status === 'needs_review' && !o.holdResolvedAt")
  })
  it('the console sends a reason with every decision and talks only to the review API', () => {
    expect(ui).toContain("fetch(`/api/admin/wallet-topups/review")
    expect((ui.match(/fetch\(/g) ?? []).length).toBe(1)
    expect(ui).toMatch(/required: true, multiline: true/)
    expect(ui).toContain('if (!reason) return')
  })
})
