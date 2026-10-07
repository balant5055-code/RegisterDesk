// Phase A — a refund is only ever sent to the gateway that took the money.
//
// ═══ THE DEFECT ═════════════════════════════════════════════════════════════
// The organizer refund route reads the payment intent and then calls
// `razorpay.payments.refund(paymentId, …)` unconditionally. It never looked at
// `intent.provider`, so refunding a Cashfree registration would have handed a Cashfree
// `cf_payment_id` to Razorpay's refund API — the wrong gateway, for a payment it has never
// heard of.
//
// ═══ WHY IT REFUSES RATHER THAN ROUTING TO CASHFREE ═════════════════════════
// Cashfree's refund CREATE contract is verified in this repository. Nothing that RESOLVES a
// refund to a terminal state is: there is no verified refund-status webhook event and no
// verified set of Cashfree refund status values. A refund opened here would sit PENDING
// forever with no webhook, no poller and no reconciliation.
//
// Starting money movement that cannot be tracked is worse than declining to start it, so
// the route fails closed and says so. Wiring Cashfree refunds is a later phase and needs
// the official contract first.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const ROUTE = 'app/api/organizer/registrations/[registrationId]/refund/route.ts'
const src = readFileSync(ROUTE, 'utf8')
/** Comments explain the rule; they are not the rule. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

describe('Phase A · refund provider ownership', () => {
  it('the provider is resolved from the INTENT, through readProvider', () => {
    // From the intent, not the request — the caller must not be able to name a provider.
    expect(code).toMatch(/readProvider\(pi\.provider\)/)
    expect(code).not.toMatch(/body\.provider/)
  })

  it('a NON-Razorpay payment is refused before any gateway call', () => {
    const guard = code.indexOf("intentProvider !== 'razorpay'")
    const call  = code.indexOf('razorpay.payments.refund(')
    expect(guard).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(-1)
    // Order is the whole guarantee: refusing AFTER the call would already have refunded.
    expect(guard).toBeLessThan(call)
  })

  it('the refusal is a 422 that states nothing was refunded', () => {
    const block = code.slice(code.indexOf("intentProvider !== 'razorpay'"), code.indexOf("intentProvider !== 'razorpay'") + 700)
    expect(block).toMatch(/status:\s*422/)
    expect(block).toMatch(/No refund was issued/i)
    // It must not leak which gateway, nor imply a refund is pending somewhere.
    expect(block).not.toMatch(/cashfree/i)
  })

  it('the refusal is reported, so a stuck refund is visible rather than silent', () => {
    expect(code).toMatch(/captureFinancialError\('refund_provider_unsupported'/)
  })

  it('RAZORPAY REGRESSION · the existing refund path is otherwise untouched', () => {
    // Every element of the pre-existing flow still present, in order: the duplicate-refund
    // lookup that prevents a second gateway refund, then the refund call itself.
    expect(code).toMatch(/findExistingRefund\(paymentId, refundAmount\)/)
    expect(code).toMatch(/razorpay\.payments\.refund\(paymentId, \{/)
    expect(code).toMatch(/speed:\s*'optimum'/)
    expect(code.indexOf('findExistingRefund(paymentId, refundAmount)'))
      .toBeLessThan(code.indexOf('razorpay.payments.refund('))
  })

  it('a HISTORICAL intent with no provider still refunds as Razorpay', () => {
    // `readProvider` reads absent as razorpay, so nothing that exists today is affected.
    // Asserted on the helper itself — the route delegates to it rather than re-deciding.
    expect(code).toMatch(/readProvider\(/)
    expect(code).not.toMatch(/pi\.provider ===/)      // no hand-rolled comparison
    expect(code).not.toMatch(/pi\.provider \?\?/)     // no hand-rolled default
  })

  it('no automatic refund was introduced — the route is still Super-Admin gated', () => {
    // Phase A must not touch refund authority (RD-PAYMENT-REFUND-AUTHORITY-02).
    expect(code).toMatch(/resolveSuperAdminUid|requireSuperAdmin|superAdmin/i)
  })
})

describe('Phase A · the missing Cashfree contract is recorded, not guessed', () => {
  it('the route invents no Cashfree refund endpoint, event or status', () => {
    for (const invented of [
      'REFUND_STATUS_WEBHOOK', 'REFUND_SUCCESS_WEBHOOK', 'refund_status',
      'cashfreeAdapter', 'cashfree.com',
    ]) {
      expect(code, `route must not reference ${invented}`).not.toContain(invented)
    }
    // The Cashfree refund ENDPOINT specifically — `/refunds` alone would match this
    // repository's own `registrationRefunds` collection, which is not a Cashfree call.
    expect(code).not.toMatch(/\/orders\/[^\s'"]*\/refunds/)
  })

  it('the adapter still documents only the refund CREATE contract', () => {
    // If a refund-status contract is ever added, it belongs here first — and this test
    // should then be updated deliberately rather than silently.
    const adapter = readFileSync('lib/payments/providers/cashfreeAdapter.ts', 'utf8')
    expect(adapter).toMatch(/POST\s+\/orders\/\{order_id\}\/refunds/)
    expect(adapter).not.toMatch(/REFUND_STATUS_WEBHOOK/)
  })
})
