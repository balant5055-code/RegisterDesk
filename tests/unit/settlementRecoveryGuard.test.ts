// RD-RECOVER-01 · the two recovery bypasses inside settleCapturedRegistration.
//
// The recovery option lifts exactly two behaviours and nothing else. These tests exist to pin
// the "nothing else" half, because that is where a mistake would be expensive:
//
//   1. TERMINAL GUARD — without `recovery`, a `registration_failed` intent is still refused,
//      exactly as it is today. Weakening that globally would let every skipped capture settle
//      itself, including ones nobody verified at Razorpay.
//   2. GATE REFUND — without `recovery`, a gate-blocked capture is still refunded. With it, a
//      TIMING block proceeds (the money was taken while the window was open) but any
//      substantive block — cancelled, taken down, capacity — still stops, and stops WITHOUT
//      refunding, because handing back a legitimate capture is an operator decision.
//
// These are asserted against the source rather than by executing the full settlement, which
// needs Firestore, Razorpay, wallet, email and WhatsApp. The behaviours pinned are structural
// — which condition guards which branch — and that is what the source states unambiguously.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const SETTLE = strip(read('lib/payments/settleCapturedRegistration.ts'))

describe('the terminal guard still stops every non-recovery caller', () => {
  it('is gated on `!isRecovery`, not removed', () => {
    expect(SETTLE).toContain("if (!isRecovery && (intent.status === 'registration_failed' || intent.status === 'failed'))")
    expect(SETTLE).toContain("return { kind: 'deferred', reason: 'intent_terminal' }")
  })

  it('recovery is recognised ONLY when the authorization names this exact payment', () => {
    // Not a boolean flag: the token must match the paymentId being settled, so a recovery
    // object cannot authorise a different payment than the one it was minted for.
    expect(SETTLE).toContain('const isRecovery = args.recovery?.verifiedCapturedPaymentId === paymentId')
  })

  it('the option is optional, so every existing caller is unchanged', () => {
    expect(SETTLE).toContain('recovery?: { verifiedCapturedPaymentId: string }')
  })
})

describe('the gate refund is lifted for timing only', () => {
  it('the timing allow-list is exactly the four window reasons', () => {
    expect(SETTLE).toContain("'REGISTRATION_NOT_OPEN', 'REGISTRATION_CLOSED', 'PASS_SALES_NOT_OPEN', 'PASS_SALES_ENDED',")
  })

  it('substantive blocks are NOT in the allow-list', () => {
    const list = SETTLE.slice(SETTLE.indexOf('const TIMING_ONLY'), SETTLE.indexOf('const TIMING_ONLY') + 260)
    for (const reason of [
      'EVENT_CANCELLED', 'EVENT_POSTPONED', 'EVENT_UNAVAILABLE', 'EVENT_CAPACITY_FULL',
      'PASS_CAPACITY_FULL', 'PASS_INACTIVE', 'INVITE_CODE_INVALID', 'EVENT_NOT_PUBLISHED',
    ]) {
      expect(list, reason).not.toContain(reason)
    }
  })

  it('a recovery blocked for a substantive reason is REPORTED, never refunded', () => {
    expect(SETTLE).toContain("return { kind: 'deferred', reason: `recovery_blocked:${gate.reason ?? 'gate_blocked'}` }")
    // The refund branch is reachable only when this is NOT a recovery.
    const guard = SETTLE.indexOf('if (!(isRecovery && gate.reason && TIMING_ONLY.has(gate.reason)))')
    const refund = SETTLE.indexOf('await refundInFull(orderId, paymentId, intent.amount, `gate_blocked:')
    expect(guard).toBeGreaterThan(-1)
    expect(refund).toBeGreaterThan(guard)
  })

  it('the non-recovery refund path is untouched', () => {
    expect(SETTLE).toContain("await markPaymentIntentFailed(orderId, gate.reason)")
    expect(SETTLE).toContain("return { kind: 'refunded', reason: gate.reason ?? 'gate_blocked', gateBlocked: true }")
  })
})

describe('duplicate protection is unchanged', () => {
  it('the fast already-settled path still short-circuits', () => {
    expect(SETTLE).toContain("if (intent.status === 'paid' && intent.registrationId)")
    expect(SETTLE).toContain("return { kind: 'already_settled', registrationId: intent.registrationId }")
  })

  it('the in-transaction re-check still guards against a concurrent settle', () => {
    expect(SETTLE).toContain("if (intentData.status === 'paid' && intentData.registrationId)")
    expect(SETTLE).toContain('alreadySettled = true')
  })

  it('the ticket claim is still written inside the transaction', () => {
    expect(SETTLE).toContain('txn.set(ticketCodeClaimRef')
  })

  it('the intent update still records status, registrationId AND paymentId together', () => {
    expect(SETTLE).toContain("status: 'paid', registrationId, paymentId,")
  })
})

describe('the untouched systems stay untouched', () => {
  it('the webhook still skips a terminal intent — payment.failed handling is unchanged', () => {
    const wh = strip(read('app/api/webhooks/razorpay/route.ts'))
    expect(wh).toContain("if (intent.status === 'registration_failed')")
    expect(wh).toContain('await markPaymentIntentFailed(fOrderId, reason)')
    expect(wh).not.toContain('recoverOrphanedCapture')
    expect(wh).not.toContain('verifiedCapturedPaymentId')
  })

  it('the reconciliation sweep still scans only `created` intents', () => {
    const rec = strip(read('lib/payments/registrationReconciliation.ts'))
    expect(rec).toContain("i.status === 'created'")
    expect(rec).not.toContain('recoverOrphanedCapture')
    expect(rec).not.toContain('verifiedCapturedPaymentId')
  })

  it('no route or cron wires the recovery path — it is operator-invoked only', () => {
    const recovery = 'recoverOrphanedCapture'
    for (const f of [
      'app/api/webhooks/razorpay/route.ts',
      'app/api/registrations/verify-payment/route.ts',
      'app/api/cron/registration-reconciliation/route.ts',
    ]) {
      expect(read(f), f).not.toContain(recovery)
    }
  })
})
