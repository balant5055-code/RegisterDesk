// RD-PAYMENT-PROVIDER-CONTRACT-04 — the webhook signature check must be AWAITED.
//
// ═══ THE NEAR-MISS THIS PINS ═════════════════════════════════════════════════
// Moving signature verification behind the provider adapter made it async, because the
// adapter loads Razorpay's credentials lazily (a top-level import would demand live keys
// just to read a stored discriminator).
//
// The call site was `if (!verifyWebhookSignature(rawBody, signature))`. Once that returns a
// Promise, `!promise` is ALWAYS false — a Promise object is truthy. The guard reads exactly
// as before, compiles cleanly, and accepts every request including unsigned ones.
//
// TypeScript does not flag `!` applied to a Promise, and no behavioural test covers it
// either: a test that posts a valid webhook still passes, and one that posts an invalid
// signature is the only thing that fails — which is precisely the case nobody writes for a
// check they believe already exists. So it is asserted structurally here.
//
// This generalises: any boolean-returning security check that becomes async is one missing
// `await` away from being permanently open. The cases below cover every such check on the
// attendee payment surface.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

/** Source with comments removed — prose about a guard is not the guard. */
const code = (f: string) => read(f)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('RD-PAYMENT-PROVIDER-CONTRACT-04 · async security checks are awaited', () => {
  it('the Razorpay webhook awaits its signature verification', () => {
    const src = code('app/api/webhooks/razorpay/route.ts')
    expect(src).toMatch(/if \(!await verifyWebhookSignature\(/)
    // The un-awaited form must not exist anywhere in the file.
    expect(src).not.toMatch(/if \(!verifyWebhookSignature\(/)
  })

  it('verify-payment awaits its checkout signature verification', () => {
    const src = code('app/api/registrations/verify-payment/route.ts')
    expect(src).toMatch(/if \(!await verifyCheckoutSignature\(/)
    expect(src).not.toMatch(/if \(!verifyCheckoutSignature\(/)
  })

  it('both helpers really are async — otherwise the assertions above prove nothing', () => {
    // If someone made these sync again, `await` would still be valid and the cases above
    // would still pass while asserting something irrelevant. This keeps them honest.
    expect(code('app/api/webhooks/razorpay/route.ts'))
      .toMatch(/async function verifyWebhookSignature\([^)]*\): Promise<boolean>/)
    expect(code('app/api/registrations/verify-payment/route.ts'))
      .toMatch(/async function verifyCheckoutSignature\(/)
  })

  it('no boolean-looking provider check on the payment surface is left un-awaited', () => {
    // A `!someVerify…(` with no `await` between the `!` and the call is the shape of the bug.
    //
    // RD-PAYMENT-CASHFREE-SANDBOX-05 extends this to the Cashfree webhook. Its verifier is
    // SYNCHRONOUS today, so `!verifyCashfreeWebhook(…)` is correct as written — but the
    // whole point is that the day it gains a lazy dependency and becomes async, that exact
    // line silently starts accepting every request. This check catches that edit.
    const RISK = /!\s*(?!await\b)[A-Za-z_$][\w$]*(?:Signature|Verify|Verified|Webhook)\s*\(/
    for (const f of [
      'app/api/webhooks/razorpay/route.ts',
      'app/api/webhooks/cashfree/route.ts',
      'app/api/registrations/verify-payment/route.ts',
      'app/api/registrations/payment-status/route.ts',
      'app/api/registrations/create-order/route.ts',
    ]) {
      // Where a verifier might be declared: the route itself, or the adapters.
      const SEARCH = [f, 'lib/payments/providers/cashfreeAdapter.ts', 'lib/payments/providers/razorpayAdapter.ts']
        .map(code).join('\n')

      for (const line of code(f).split('\n')) {
        if (!RISK.test(line)) continue
        const fnName = /!\s*([A-Za-z_$][\w$]*)\s*\(/.exec(line)?.[1] ?? ''
        // The `!` is safe ONLY while the function is synchronous. If it is declared async
        // (or returns a Promise) anywhere it could be defined, `!promise` is always false
        // and the guard is a bypass.
        const isAsync = new RegExp(`async\\s+function\\s+${fnName}\\b`).test(SEARCH)
          || new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)\\s*:\\s*Promise<`).test(SEARCH)
        expect(
          isAsync,
          `${f}: '${fnName}' is called without await but is async — that is a signature bypass: ${line.trim()}`,
        ).toBe(false)
      }
    }
  })

  it('the Cashfree webhook verifier is synchronous — which is what makes its `!` safe', () => {
    // Pinned explicitly so the assumption above is stated rather than implied. If this
    // changes, the route must gain an `await` in the same edit.
    const adapter = code('lib/payments/providers/cashfreeAdapter.ts')
    expect(adapter).toMatch(/export function verifyCashfreeWebhook\(/)
    expect(adapter).not.toMatch(/export async function verifyCashfreeWebhook\(/)
  })

  it('the Cashfree webhook verifies before parsing, before any lookup, before any write', () => {
    const src = code('app/api/webhooks/cashfree/route.ts')
    const verify = src.indexOf('verifyCashfreeWebhook(')
    const parse  = src.indexOf('JSON.parse(rawBody)')
    const lookup = src.indexOf('getPaymentIntent(')
    const settle = src.indexOf('settleCapturedRegistration(')
    expect(verify).toBeGreaterThan(-1)
    for (const [name, at] of [['parse', parse], ['lookup', lookup], ['settle', settle]] as const) {
      expect(at, `${name} must come after signature verification`).toBeGreaterThan(verify)
    }
  })
})
