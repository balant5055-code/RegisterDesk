// RD-WALLET-W1.1 — the event wizard reads the wallet top-up verify response correctly: only an
// explicit success is "credited", and every uncertain outcome after payment blocks paying again.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { classifyTopupVerifyResponse, TOPUP_OUTCOME_MESSAGES } from '@/lib/wallet/topupVerifyOutcome'

describe('classifyTopupVerifyResponse — every verify outcome', () => {
  it('200 success → credited with the server balance', () => {
    expect(classifyTopupVerifyResponse(200, { success: true, newBalance: 50_000 })).toEqual({ kind: 'credited', newBalance: 50_000 })
  })

  it('202 PAYMENT_NOT_CAPTURED → pending (not credited, not failed); says do not pay again', () => {
    const o = classifyTopupVerifyResponse(202, { success: false, pending: true, code: 'PAYMENT_NOT_CAPTURED', error: 'x' })
    expect(o.kind).toBe('pending')
    expect(o.kind !== 'credited' && o.message).toMatch(/do not pay again/i)
    expect(o.kind !== 'credited' && o.message).toMatch(/not been credited yet/i)
  })

  it('202 pending without a code (credit deferred to a recorded reconciliation) → pending', () => {
    expect(classifyTopupVerifyResponse(202, { success: false, pending: true }).kind).toBe('pending')
  })

  it('409 DUPLICATE_PAYMENT → duplicate: no extra credit, no automatic refund, do not pay again', () => {
    const o = classifyTopupVerifyResponse(409, { success: false, code: 'DUPLICATE_PAYMENT' })
    expect(o.kind).toBe('duplicate')
    const m = o.kind === 'duplicate' ? o.message : ''
    expect(m).toMatch(/NOT added to your wallet/)
    expect(m).toMatch(/NOT been refunded automatically/)
    expect(m).toMatch(/do not pay again/i)
  })

  it('409 NEEDS_REVIEW → review (payment received, not credited)', () => {
    expect(classifyTopupVerifyResponse(409, { success: false, code: 'NEEDS_REVIEW' }).kind).toBe('review')
  })

  it('503 CREDIT_DEFERRED → deferred: never claims a credit, never asks to pay again', () => {
    for (const body of [{ success: false, pending: true, code: 'CREDIT_DEFERRED' }, {}]) {
      const o = classifyTopupVerifyResponse(503, body)
      expect(o.kind).toBe('deferred')
      const m = o.kind === 'deferred' ? o.message : ''
      expect(m).toMatch(/not been credited yet/i)
      expect(m).toMatch(/do not pay again/i)
      expect(m).not.toMatch(/successfully|has been credited/i)
    }
  })

  it('other 5xx after payment (e.g. 502 could-not-verify) → unconfirmed, never an invitation to pay again', () => {
    const o = classifyTopupVerifyResponse(502, { success: false, error: 'Could not verify payment. Please try again.' })
    expect(o.kind).toBe('unconfirmed')
    expect(o.kind === 'unconfirmed' && o.message).toBe(TOPUP_OUTCOME_MESSAGES.unconfirmed)
  })

  it('existing client errors keep their existing message (failed)', () => {
    expect(classifyTopupVerifyResponse(400, { success: false, error: 'Payment verification failed.' }))
      .toEqual({ kind: 'failed', message: 'Payment verification failed.' })
    expect(classifyTopupVerifyResponse(403, { success: false, error: 'Unauthorized' }))
      .toEqual({ kind: 'failed', message: 'Unauthorized' })
    expect(classifyTopupVerifyResponse(404, null)).toEqual({ kind: 'failed', message: 'Payment verification failed.' })
  })

  it('a 200 without success:true is NOT treated as credited', () => {
    expect(classifyTopupVerifyResponse(200, { success: false }).kind).not.toBe('credited')
  })
})

describe('the event wizard uses it and cannot start a second payment on an uncertain outcome', () => {
  const src = readFileSync('app/(dashboard)/dashboard/events/new/page.tsx', 'utf8')
  const handler = src.slice(src.indexOf('const handleTopupWallet = useCallback('), src.indexOf('}, [topupLoading, topupHold, showToast])'))

  it('classifies the verify response instead of trusting `success` alone', () => {
    expect(handler).toContain('classifyTopupVerifyResponse(vRes.status, vJson)')
    expect(handler).not.toContain("showToast(vJson.error ?? 'Payment verification failed.', 'error')")
  })
  it('a hold blocks a NEW payment before any order is created', () => {
    const guard = handler.indexOf('if (topupHold) {')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(handler.indexOf("fetch('/api/organizer/wallet/topup'"))
  })
  it('pending / duplicate / review / deferred / unconfirmed set the hold — never the success path', () => {
    expect(handler).toContain("if (outcome.kind === 'credited') {")
    expect(handler).toContain("} else if (outcome.kind === 'failed') {")
    // the hold is tied to THIS payment (order + payment id), not to a balance snapshot
    expect(handler).toContain('setTopupHold({ kind: outcome.kind, message: outcome.message, orderId: resp.razorpay_order_id, paymentId: resp.razorpay_payment_id })')
    expect(handler).not.toContain('balanceAtHold')
    // only the credited branch closes the modal / reports success
    expect((handler.match(/Wallet funded successfully!/g) ?? []).length).toBe(1)
  })
  it('a network failure during verify is "unconfirmed", not a prompt to retry by paying', () => {
    expect(handler).toContain("outcome = { kind: 'unconfirmed', message: TOPUP_OUTCOME_MESSAGES.unconfirmed }")
    expect(handler).not.toContain('Network error during verification. Please contact support.')
  })
  it('the pay button is disabled while loading or on hold, and the hold is shown in the modal', () => {
    expect(src).toContain('disabled={topupLoading || topupHold !== null}')
    expect(src).toMatch(/\{topupHold && \([\s\S]{0,400}topupHold\.message/)
  })
  it('the pending poll asks about THIS payment, is READ-ONLY, and never trusts a balance rise', () => {
    const poll = src.slice(src.indexOf('while a payment is pending / deferred / unconfirmed'), src.indexOf('}, [topupHold, showToast])'))
    expect(poll).toContain('/api/organizer/wallet/topup/status?')
    expect(poll).toContain('new URLSearchParams({ orderId, paymentId })')
    // read-only: no POST, no verify, no order creation
    expect(poll).not.toMatch(/method:\s*'POST'/)
    expect(poll).not.toContain('/topup/verify')
    expect(poll).not.toContain("fetch('/api/organizer/wallet/topup'")
    // success only on the server's 'credited' for this payment; no balance comparison
    expect(poll).toContain("if (d.state === 'credited') {")
    expect(poll).not.toMatch(/balancePaise\s*>/)
    // review / duplicate become their own holds; they are never polled
    expect(poll).toContain("d.state === 'needs_review' || d.state === 'duplicate_payment'")
    expect(poll).toContain("topupHold.kind === 'duplicate' || topupHold.kind === 'review'")
  })
  it('a server refusal (earlier top-up unresolved) is explained, not reported as a generic failure', () => {
    expect(handler).toContain("order.code === 'TOPUP_UNRESOLVED' && order.error ? order.error")
  })
})

describe('resolveTopupPaymentState — credited only for THIS order AND THIS payment', async () => {
  const { resolveTopupPaymentState } = await import('@/lib/wallet/topupStatus')
  it('credited with this payment → credited', () => {
    expect(resolveTopupPaymentState({ status: 'credited', paymentId: 'pay_a' }, 'pay_a', null, null)).toBe('credited')
  })
  it('credited with ANOTHER payment → this one is a duplicate, never "credited"', () => {
    expect(resolveTopupPaymentState({ status: 'credited', paymentId: 'pay_a' }, 'pay_b', null, null)).toBe('duplicate_payment')
  })
  it('a recorded duplicate stays a duplicate even if the order is credited', () => {
    expect(resolveTopupPaymentState({ status: 'credited', paymentId: 'pay_b' }, 'pay_b', null, { status: 'duplicate_payment' })).toBe('duplicate_payment')
  })
  it('pending stays pending; needs_review stays review (nothing about the balance is consulted)', () => {
    expect(resolveTopupPaymentState({ status: 'pending' }, 'pay_a', null, null)).toBe('pending')
    expect(resolveTopupPaymentState({ status: 'pending' }, 'pay_a', { status: 'pending' }, null)).toBe('pending')
    expect(resolveTopupPaymentState({ status: 'pending' }, 'pay_a', { status: 'needs_review' }, null)).toBe('needs_review')
  })
})

describe('RD-WALLET-W2.b · a mismatched payment reads as needs_review', async () => {
  const { resolveTopupPaymentState } = await import('@/lib/wallet/topupStatus')
  it('a recorded mismatch for THIS payment → needs_review, even if the order is pending', () => {
    expect(resolveTopupPaymentState({ status: 'pending' }, 'pay_b', null, null, { status: 'needs_review' })).toBe('needs_review')
    expect(resolveTopupPaymentState({ status: 'pending' }, 'pay_b', null, null, null)).toBe('pending')
  })
})

describe('RD-WALLET-W2.c · held and abandoned orders never read as pending or credited', async () => {
  const { resolveTopupPaymentState } = await import('@/lib/wallet/topupStatus')
  it('an order held by the sweep (several captures) or abandoned (a late payment) → needs_review', () => {
    expect(resolveTopupPaymentState({ status: 'needs_review' }, 'pay_a', null, null)).toBe('needs_review')
    expect(resolveTopupPaymentState({ status: 'abandoned' }, 'pay_late', null, null)).toBe('needs_review')
    // a per-payment D1 record is 'needs_review', NOT 'duplicate_payment' (nothing was credited)
    expect(resolveTopupPaymentState({ status: 'needs_review' }, 'pay_a', null, { status: 'needs_review' })).toBe('needs_review')
  })
})

describe('RD-WALLET-W2.c fix 4 · a payment held for review never promises an automatic credit', () => {
  it('400 NEEDS_REVIEW (a recorded mismatch) → review, not "failed"', () => {
    const o = classifyTopupVerifyResponse(400, { success: false, code: 'NEEDS_REVIEW', error: 'x' })
    expect(o).toEqual({ kind: 'review', message: TOPUP_OUTCOME_MESSAGES.review })
  })
  it('503 REVIEW_UNRECORDED → review with a truthful message (no auto-credit, do not pay again, contact support)', () => {
    const o = classifyTopupVerifyResponse(503, { success: false, code: 'REVIEW_UNRECORDED' })
    expect(o.kind).toBe('review')
    const m = o.kind === 'review' ? o.message : ''
    expect(m).toBe(TOPUP_OUTCOME_MESSAGES.reviewUnrecorded)
    expect(m).not.toMatch(/credited automatically|will be credited/i)
    expect(m).toMatch(/NOT been\s+added to your wallet/)
    expect(m).toMatch(/do not pay again/i)
    expect(m).toMatch(/contact support/i)
  })
  it('the genuinely transient 503 (CREDIT_DEFERRED, or no code) is unchanged', () => {
    expect(classifyTopupVerifyResponse(503, { code: 'CREDIT_DEFERRED' }).kind).toBe('deferred')
    expect(classifyTopupVerifyResponse(503, {}).kind).toBe('deferred')
  })
  it('the verify route uses REVIEW_UNRECORDED for BOTH unrecorded review paths, and never the deferred wording there', () => {
    const src = readFileSync('app/api/organizer/wallet/topup/verify/route.ts', 'utf8')
    expect((src.match(/code: 'REVIEW_UNRECORDED'/g) ?? []).length).toBe(2)
    expect(src).toContain("success: false, code: 'NEEDS_REVIEW',")
  })
})

describe('RD-WALLET-W2.c · the 503 "could not confirm" outcome never promises an automatic credit', () => {
  it('the deferred message: not credited yet, do not pay again, support guidance — no "credited automatically"', () => {
    const m = TOPUP_OUTCOME_MESSAGES.deferred
    expect(m).toMatch(/not been credited yet/i)
    expect(m).toMatch(/do not pay again/i)
    expect(m).toMatch(/contact support with your payment reference/i)
    expect(m).not.toMatch(/credited automatically|will be credited/i)
  })
  it('the verify route: its CREDIT_DEFERRED text says the same, and a held record reads as review', () => {
    const src = readFileSync('app/api/organizer/wallet/topup/verify/route.ts', 'utf8')
    const deferred = src.slice(src.indexOf("code: 'CREDIT_DEFERRED', error:"))
    expect(deferred.slice(0, 400)).not.toMatch(/credited automatically|will be credited/i)
    expect(src).toContain('isHeldReconciliationStatus(rec.status)')
  })
})
