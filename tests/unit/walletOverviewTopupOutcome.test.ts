// RD-WALLET-W2.c — the Wallet page's Add Funds modal reads the verify response through the shared
// classifier and never promises a credit it cannot know about. Every verify outcome is driven
// through classifyTopupVerifyResponse → describeTopupHold (the exact path the modal takes), and the
// modal itself is pinned by source contract (the repo has no React test renderer).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  classifyTopupVerifyResponse, describeTopupHold, TOPUP_OUTCOME_MESSAGES, type TopupVerifyOutcome,
} from '@/lib/wallet/topupVerifyOutcome'

const PROMISE = /credited automatically|will be credited/i
const PAY_AGAIN_WARNING = /do not pay again|before paying again/i

type Body = Parameters<typeof classifyTopupVerifyResponse>[1]
function present(status: number, body: Body) {
  const o = classifyTopupVerifyResponse(status, body)
  if (o.kind === 'credited' || o.kind === 'failed') return { outcome: o, hold: null }
  return { outcome: o, hold: describeTopupHold(o as Exclude<TopupVerifyOutcome, { kind: 'credited' } | { kind: 'failed' }>) }
}

describe('every verify outcome, as the Wallet page shows it', () => {
  it('200 success → credited (no hold)', () => {
    expect(present(200, { success: true, newBalance: 50_000 })).toEqual({ outcome: { kind: 'credited', newBalance: 50_000 }, hold: null })
  })
  it('409 NEEDS_REVIEW (and the 400 recorded-mismatch form) → review: not credited, awaiting review, do not pay again', () => {
    for (const [status, body] of [[409, { success: false, code: 'NEEDS_REVIEW' }], [400, { success: false, code: 'NEEDS_REVIEW', error: 'x' }]] as const) {
      const { hold } = present(status, body)
      expect(hold).toMatchObject({ tone: 'review', autoRetry: false })
      expect(hold!.message).toMatch(/not been credited/i)
      expect(hold!.message).toMatch(/review/i)
      expect(hold!.message).toMatch(PAY_AGAIN_WARNING)
      expect(hold!.message).not.toMatch(PROMISE)
    }
  })
  it('503 REVIEW_UNRECORDED → review with support guidance, no promise', () => {
    const { hold } = present(503, { success: false, code: 'REVIEW_UNRECORDED' })
    expect(hold).toMatchObject({ tone: 'review', autoRetry: false, message: TOPUP_OUTCOME_MESSAGES.reviewUnrecorded })
    expect(hold!.message).toMatch(/contact support/i)
    expect(hold!.message).not.toMatch(PROMISE)
  })
  it('409 DUPLICATE_PAYMENT → review tone, not credited automatically', () => {
    const { hold } = present(409, { success: false, code: 'DUPLICATE_PAYMENT' })
    expect(hold).toMatchObject({ tone: 'review', autoRetry: false })
    expect(hold!.message).toMatch(PAY_AGAIN_WARNING)
  })
  it('503 CREDIT_DEFERRED, a bare 503 and a 502 → uncertain: no automatic-credit promise, do not pay again, support guidance', () => {
    for (const [status, body] of [[503, { success: false, pending: true, code: 'CREDIT_DEFERRED' }], [503, null], [502, { error: 'x' }]] as const) {
      const { hold } = present(status, body)
      expect(hold).toMatchObject({ tone: 'uncertain', autoRetry: false })
      expect(hold!.message).toMatch(/not been credited/i)
      expect(hold!.message).toMatch(/do not pay again/i)
      expect(hold!.message).toMatch(/contact support with your payment reference/i)
      expect(hold!.message).not.toMatch(PROMISE)
    }
  })
  it('202 PAYMENT_NOT_CAPTURED and 202 recorded pending → awaiting credit: the ONLY outcomes that may say the credit follows automatically', () => {
    const cap = present(202, { success: false, pending: true, code: 'PAYMENT_NOT_CAPTURED' }).hold!
    expect(cap).toMatchObject({ tone: 'awaiting_credit', autoRetry: true, message: TOPUP_OUTCOME_MESSAGES.pending })
    expect(cap.message).toMatch(/once the payment is captured/i)
    const rec = present(202, { success: false, pending: true }).hold!
    expect(rec).toMatchObject({ tone: 'awaiting_credit', autoRetry: true, message: TOPUP_OUTCOME_MESSAGES.pendingDeferred })
    for (const h of [cap, rec]) expect(h.message).toMatch(PAY_AGAIN_WARNING)
  })
  it('missing or unexpected fields are safe: a null / non-JSON body, a 200 without success, unknown codes', () => {
    expect(present(200, null).outcome.kind).not.toBe('credited')
    expect(present(200, { success: 'yes' as unknown as boolean }).outcome.kind).not.toBe('credited')
    expect(present(503, { code: 42 as unknown as string }).hold).toMatchObject({ tone: 'uncertain' })
    expect(present(418, undefined).outcome).toEqual({ kind: 'failed', message: 'Payment verification failed.' })
    expect(present(200, { success: true }).outcome).toEqual({ kind: 'credited', newBalance: 0 })
  })
  it('no hold message except the automatic-path ones ever promises a credit', () => {
    for (const [key, text] of Object.entries(TOPUP_OUTCOME_MESSAGES)) {
      if (key === 'pending' || key === 'pendingDeferred') continue
      expect(text, key).not.toMatch(PROMISE)
    }
  })
})

describe('Communication balance Add Funds modal — moved verbatim from the Wallet page, 2026-10-02 (source contract)', () => {
  const src = readFileSync('components/wallet/CommunicationBalanceCard.tsx', 'utf8')
  const submit = src.slice(src.indexOf('async function handleSubmit()'), src.indexOf('return (', src.indexOf('async function handleSubmit()')))

  it('reads verify through the shared classifier + describeTopupHold — not success / pending flags', () => {
    expect(submit).toContain('classifyTopupVerifyResponse(verifyRes.status, body)')
    expect(submit).toContain('describeTopupHold(outcome)')
    expect(submit).not.toMatch(/verify\.pending|verify\.success/)
  })
  it('an unreadable body or a network failure during verify is "unconfirmed", never a retryable error', () => {
    expect(submit).toContain('await verifyRes.json().catch(() => null)')
    expect(submit).toContain("outcome = { kind: 'unconfirmed', message: TOPUP_OUTCOME_MESSAGES.unconfirmed }")
  })
  it('only "credited" is success; only "failed" returns to the error state (where paying again is possible)', () => {
    expect(submit).toContain("if (outcome.kind === 'credited') {")
    expect(submit).toContain("if (outcome.kind === 'failed') throw new Error(outcome.message)")
    expect(submit.indexOf("setPhase('pending')")).toBeGreaterThan(submit.indexOf('describeTopupHold(outcome)'))
  })
  it('the hold panel shows the truthful message and the payment reference, and offers Close only', () => {
    expect(src).not.toContain('Your wallet will be credited shortly')
    const panel = src.slice(src.indexOf("phase === 'pending' && hold ?"), src.indexOf(') : (', src.indexOf("phase === 'pending' && hold ?")))
    expect(panel).toContain('{hold.message}')
    expect(panel).toContain('Payment reference:')
    expect(panel).toContain('{hold.paymentId}')
    expect(panel).not.toContain('handleSubmit')                               // no second payment from a hold
    expect(panel).toContain('onClick={onClose}')
  })
})
