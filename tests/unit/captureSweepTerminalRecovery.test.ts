// RD-PAY-RECON-01 · the capture sweep now recovers orphaned `registration_failed` intents.
//
// ═══ THE TRAP THIS CLOSES ════════════════════════════════════════════════════
// A Razorpay ORDER accepts multiple payment ATTEMPTS, and every step below is individually
// correct — which is why it went unnoticed until a case was found by hand:
//
//   1. Attempt 1 fails → `payment.failed` → the intent is marked `registration_failed`.
//      (A misnomer: registration was never attempted. The PAYMENT attempt failed.)
//   2. The attendee retries THE SAME ORDER and succeeds → `payment.captured`.
//   3. The webhook sees a terminal intent, skips, and returns 200 — so Razorpay considers
//      delivery successful and never retries.
//   4. This sweep only looked at `created`, so nothing was left watching.
//
// Money captured · no registration · no refund · no alert.
//
// ═══ WHAT MATTERS MOST HERE ══════════════════════════════════════════════════
// This arm settles real money automatically, so the tests that matter are the REFUSALS and
// the boundaries: that selection stays deterministic, that the recovery authorization reaches
// ONLY terminal intents, that the `created` arm is untouched, and that nothing in this file
// can ever refund.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const RECON  = strip(read('lib/payments/registrationReconciliation.ts'))
const SETTLE = strip(read('lib/payments/settleCapturedRegistration.ts'))
const ORPHAN = strip(read('lib/payments/recoverOrphanedCapture.ts'))
const CRON   = strip(read('app/api/cron/registration-reconciliation/route.ts'))

/** Just the sweep — every claim below must hold inside it, not merely somewhere in the file. */
const SWEEP = RECON.slice(
  RECON.indexOf('export async function recoverCapturedPaymentIntents'),
  RECON.indexOf('export async function retryPendingRefundLedgerReversals'),
)

// ─── 1 · detection ───────────────────────────────────────────────────────────

describe('a registration_failed intent with a later capture is now detected', () => {
  it('the candidate filter includes terminal intents', () => {
    expect(SWEEP).toContain("i.status === 'registration_failed' && !i.registrationId")
  })

  it('a terminal intent that ALREADY has a registration is excluded', () => {
    // Settled by definition — re-examining it only spends a Razorpay call to reach
    // `already_settled`.
    expect(SWEEP).toMatch(/i\.status === 'registration_failed' && !i\.registrationId/)
  })

  it('11 · the original created-intent arm is still there', () => {
    expect(SWEEP).toContain("i.status === 'created'")
  })

  it('no other status becomes a candidate', () => {
    const filter = SWEEP.slice(SWEEP.indexOf('const candidates'), SWEEP.indexOf('out.candidates'))
    for (const bad of ["'paid'", "'failed'", "'attempt_failed'"]) {
      expect(filter, bad).not.toContain(bad)
    }
  })
})

// ─── 2-5 · payment selection stays deterministic ─────────────────────────────

describe('payment selection is deterministic and order-scoped', () => {
  it('3 · it is a predicate match, never "the first payment"', () => {
    expect(SWEEP).toContain("(p.status === 'captured' || p.status === 'authorized') &&")
    expect(SWEEP).toContain("p.currency === 'INR' && p.amount === intent.amount")
    // `.find(p => …)` with a predicate — not `items[0]`.
    expect(SWEEP).not.toMatch(/items\s*\)?\s*\[0\]/)
    expect(SWEEP).not.toContain('.find(p => p.status')
  })

  it('4 · the lookup is scoped to the intent’s OWN order', () => {
    expect(SWEEP).toContain('razorpay.orders.fetchPayments(intent.orderId)')
    // No cross-order search of any kind.
    expect(SWEEP).not.toContain('payments.all(')
    expect(SWEEP).not.toContain('orders.all(')
  })

  it('5+3 · amount and currency are both required', () => {
    expect(SWEEP).toContain('p.amount === intent.amount')
    expect(SWEEP).toContain("p.currency === 'INR'")
  })

  it('7 · no paymentId can arrive from a caller — the sweep takes only a limit', () => {
    expect(SWEEP).toContain('recoverCapturedPaymentIntents(limitN = 200)')
    expect(SWEEP).not.toContain('paymentId:  string')
    expect(CRON).toContain('recoverCapturedPaymentIntents(200)')
  })

  it('8 · no matching payment ⇒ the intent is left untouched', () => {
    // The no-payment branch now also records a not_captured case before continuing,
    // so the assertion pins the two facts that matter rather than one exact line.
    expect(SWEEP).toContain('if (!payment?.id) {')
    expect(SWEEP).toContain('out.unpaid++')
    const branch = SWEEP.slice(SWEEP.indexOf('if (!payment?.id) {'), SWEEP.indexOf('const isTerminalRecovery'))
    expect(branch).toContain('continue')
    expect(branch).not.toContain('settleCapturedRegistration')
  })
})

// ─── 6 · Razorpay unreachable ────────────────────────────────────────────────

describe('an unreachable Razorpay is never read as unpaid', () => {
  it('counts uncertain, mutates nothing, and moves on', () => {
    const c = SWEEP.slice(SWEEP.indexOf('} catch (err) {'), SWEEP.indexOf('if (!payment?.id)'))
    expect(c).toContain('out.uncertain++')
    expect(c).toContain('continue')
    expect(c).not.toContain('out.unpaid++')
    expect(c).not.toContain('settleCapturedRegistration')
  })
})

// ─── recovery authorization: terminal intents ONLY ───────────────────────────

describe('the recovery authorization reaches terminal intents only', () => {
  it('is bound to the payment this sweep just verified', () => {
    expect(SWEEP).toContain('recovery: { verifiedCapturedPaymentId: payment.id }')
    // The same id that was matched against Razorpay is the one settled.
    expect(SWEEP).toContain('paymentId: payment.id,')
  })

  it('is attached ONLY when the intent is terminal', () => {
    expect(SWEEP).toContain("const isTerminalRecovery = intent.status === 'registration_failed'")
    expect(SWEEP).toContain('...(isTerminalRecovery ? { recovery: { verifiedCapturedPaymentId: payment.id } } : {})')
  })

  it('the settlement re-checks the token against the payment being settled', () => {
    // So a recovery object can never authorise a different payment than the verified one.
    expect(SETTLE).toContain('const isRecovery = args.recovery?.verifiedCapturedPaymentId === paymentId')
  })

  it('8 · the terminal guard still stops every NON-recovery caller', () => {
    expect(SETTLE).toContain("if (!isRecovery && (intent.status === 'registration_failed' || intent.status === 'failed'))")
    expect(SETTLE).toContain("return { kind: 'deferred', reason: 'intent_terminal' }")
  })

  it('8 · only TIMING refusals are lifted; substantive ones are not', () => {
    expect(SETTLE).toContain("'REGISTRATION_NOT_OPEN', 'REGISTRATION_CLOSED', 'PASS_SALES_NOT_OPEN', 'PASS_SALES_ENDED',")
    const list = SETTLE.slice(SETTLE.indexOf('const TIMING_ONLY'), SETTLE.indexOf('const TIMING_ONLY') + 260)
    for (const substantive of [
      'EVENT_CANCELLED', 'EVENT_CAPACITY_FULL', 'PASS_CAPACITY_FULL', 'PASS_INACTIVE',
      'EVENT_NOT_PUBLISHED', 'INVITE_CODE_INVALID',
    ]) {
      expect(list, substantive).not.toContain(substantive)
    }
  })

  it('9 · a substantive refusal DEFERS and never refunds', () => {
    expect(SETTLE).toContain("return { kind: 'deferred', reason: `recovery_blocked:${gate.reason ?? 'gate_blocked'}` }")
    const guard  = SETTLE.indexOf('if (!(isRecovery && gate.reason && TIMING_ONLY.has(gate.reason)))')
    const refund = SETTLE.indexOf('await refundInFull(orderId, paymentId, intent.amount, `gate_blocked:')
    expect(guard).toBeGreaterThan(-1)
    expect(refund).toBeGreaterThan(guard)   // the refund branch sits INSIDE the non-recovery guard
  })
})

// ─── money safety ────────────────────────────────────────────────────────────

describe('the sweep can never move money on its own', () => {
  it('never refunds and never captures', () => {
    expect(SWEEP).not.toContain('payments.refund')
    expect(SWEEP).not.toContain('refundInFull')
    expect(SWEEP).not.toContain('.capture(')
  })

  it('never marks an intent failed', () => {
    expect(SWEEP).not.toContain('markPaymentIntentFailed')
  })

  it('the ONLY Razorpay call is a read', () => {
    const calls = SWEEP.match(/razorpay\.[a-zA-Z.]+\(/g) ?? []
    expect(calls).toEqual(['razorpay.orders.fetchPayments('])
  })
})

// ─── 10 · idempotency, reusing the one settlement ────────────────────────────

describe('repeated runs converge — no second implementation', () => {
  it('settlement goes through the SAME shared function', () => {
    expect(SWEEP).toContain('await settleCapturedRegistration({')
    expect(SWEEP.match(/settleCapturedRegistration\(/g) ?? []).toHaveLength(1)
  })

  it('a second run reaches already_settled rather than settling twice', () => {
    expect(SETTLE).toContain("if (intent.status === 'paid' && intent.registrationId)")
    expect(SETTLE).toContain("return { kind: 'already_settled', registrationId: intent.registrationId }")
    expect(SWEEP).toContain("outcome.kind === 'already_settled'")
  })

  it('the in-transaction re-check and the ticket claim still admit exactly one', () => {
    expect(SETTLE).toContain("if (intentData.status === 'paid' && intentData.registrationId)")
    expect(SETTLE).toContain('alreadySettled = true')
    expect(SETTLE).toContain('txn.set(ticketCodeClaimRef')
  })

  it('the ledger id stays deterministic, so the wallet cannot be credited twice', () => {
    expect(read('lib/firebase/firestore/platformTransactions.ts')).toContain('ptx_${sourceId}')
  })

  it('7 · duplicate protections are unchanged in the settlement', () => {
    expect(SETTLE).toContain("status: 'paid', registrationId, paymentId,")
    for (const guard of ['emailClaimRef', 'phoneClaimRef', 'ticketCodeClaimRef', 'counterRef']) {
      expect(SETTLE, guard).toContain(guard)
    }
  })
})

// ─── 12 · the strict operator-only service is untouched ──────────────────────

describe('recoverOrphanedCapture remains strict and unwired', () => {
  it('still demands all six fields', () => {
    for (const f of [
      'orderId:           string', 'paymentId:         string', 'expectedAmountPaise: number',
      'expectedEventSlug: string', 'expectedPassId:    string', 'expectedPhone:     string',
    ]) {
      expect(ORPHAN, f).toContain(f)
    }
  })

  it('still auto-selects nothing — the caller must name the payment', () => {
    expect(ORPHAN).toContain('const payment = payments.find(p => p.id === t.paymentId)')
    expect(ORPHAN).not.toContain("payments.find(p => p.status === 'captured')")
  })

  it('still never refunds or captures', () => {
    expect(ORPHAN).not.toMatch(/refund/i)
    expect(ORPHAN).not.toMatch(/\.capture\(/)
  })

  it('is still wired to no route and no cron', () => {
    expect(RECON).not.toContain('recoverOrphanedCapture')
    expect(CRON).not.toContain('recoverOrphanedCapture')
    for (const f of [
      'app/api/webhooks/razorpay/route.ts',
      'app/api/registrations/verify-payment/route.ts',
    ]) {
      expect(read(f), f).not.toContain('recoverOrphanedCapture')
    }
  })
})

// ─── the webhook is untouched in this phase ──────────────────────────────────

describe('the webhook is unchanged', () => {
  it('still skips a terminal intent and still writes the terminal status', () => {
    const wh = strip(read('app/api/webhooks/razorpay/route.ts'))
    expect(wh).toContain("if (intent.status === 'registration_failed')")
    expect(wh).toContain('await markPaymentIntentFailed(fOrderId, reason)')
    expect(wh).not.toContain('verifiedCapturedPaymentId')
  })
})
