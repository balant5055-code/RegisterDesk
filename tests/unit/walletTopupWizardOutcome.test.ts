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

// RD-COMMS-P1 — the event wizard no longer offers a communication-balance top-up at all (capacity is
// bought on its own License & Services step), so there is no second payment path to guard. The
// classifier above keeps reading verify answers for top-up orders created before retirement.
describe('the event wizard starts no communication-balance top-up (RD-COMMS-P1)', () => {
  const src = readFileSync('app/(dashboard)/dashboard/events/new/page.tsx', 'utf8')
  it('no top-up / verify / status call, no hold state and no Add Funds modal', () => {
    for (const banned of ['/api/organizer/wallet/topup', 'handleTopupWallet', 'setTopupHold', 'showAddFundsModal', 'Add to communication balance', 'Top up balance']) {
      expect(src, banned).not.toContain(banned)
    }
  })
  it('a missing WhatsApp capacity is an advisory hint pointing to License & Services, never a payment', () => {
    expect(src).toContain('needsWhatsappCapacity')
    expect(src).toContain('WhatsApp messages are sent only from WhatsApp capacity')
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
