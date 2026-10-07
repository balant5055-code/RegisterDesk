// RD-PAYMENT-CASHFREE-CHECKOUT-06 — the provider-neutral checkout contract.
//
// ═══ WHAT THIS FILE DEFENDS ══════════════════════════════════════════════════
// The browser now learns which gateway its order belongs to. That is a new piece of trust,
// and three ways of getting it wrong would each be a money bug:
//
//   1. the CLIENT picking a provider (it must only ever be told);
//   2. a Cashfree order carrying Razorpay's key id, or anything secret riding along;
//   3. "checkout returned" being read as "payment succeeded" — which for Cashfree is false
//      for the ~30 seconds a real UPI collect spends PENDING.
//
// Each is asserted below against the real source, not a description of it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
/** Source with comments stripped — prose explaining a rule is not the rule. */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n')

const CLIENT   = 'lib/payments/checkout/clientCheckout.ts'
const REGISTRY = 'lib/payments/providers/index.ts'
const ORDER    = 'app/api/registrations/create-order/route.ts'
const STATUS   = 'app/api/registrations/payment-status/route.ts'
const VERIFY   = 'app/api/registrations/verify-payment/route.ts'

// ─── Provider selection is the SERVER's, and sandbox-only ─────────────────────

const ON = {
  CASHFREE_SANDBOX_ENABLED: 'true',
  CASHFREE_CLIENT_ID: 'TEST_APP_ID',
  CASHFREE_CLIENT_SECRET: 'TEST_SECRET',
  NODE_ENV: 'test',
}
const setEnv = (over: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries({ ...ON, ...over })) vi.stubEnv(k, v)
}
const providers = () => import('@/lib/payments/providers')

describe('provider selection is server-authoritative', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs() })

  it('defaults to Razorpay even with the Cashfree sandbox fully enabled', async () => {
    setEnv()   // flag + credentials + non-production, but no PAYMENT_PROVIDER
    const { resolveActivePaymentProvider } = await providers()
    expect(resolveActivePaymentProvider()).toBe('razorpay')
  })

  it('selects Cashfree only on an explicit deployment choice', async () => {
    setEnv({ PAYMENT_PROVIDER: 'cashfree' })
    const { resolveActivePaymentProvider } = await providers()
    expect(resolveActivePaymentProvider()).toBe('cashfree')
  })

  it('PRODUCTION refuses Cashfree however loudly it is asked for', async () => {
    // The whole safety story of this phase: Cashfree is sandbox-only, and a production
    // deployment cannot reach it by setting one more variable.
    setEnv({ PAYMENT_PROVIDER: 'cashfree', NODE_ENV: 'production' })
    const { resolveActivePaymentProvider, isProviderEnabled } = await providers()
    expect(resolveActivePaymentProvider()).toBe('razorpay')
    expect(isProviderEnabled('cashfree')).toBe(false)
  })

  it('the sandbox flag alone does not select it, and credentials alone do not either', async () => {
    setEnv({ PAYMENT_PROVIDER: 'cashfree', CASHFREE_SANDBOX_ENABLED: '' })
    const a = await providers()
    expect(a.resolveActivePaymentProvider()).toBe('razorpay')

    vi.resetModules(); vi.unstubAllEnvs()
    setEnv({ PAYMENT_PROVIDER: 'cashfree', CASHFREE_CLIENT_ID: '', CASHFREE_CLIENT_SECRET: '' })
    const b = await providers()
    expect(b.resolveActivePaymentProvider()).toBe('razorpay')
  })

  it('a misspelled or hostile value falls back to Razorpay, never throws a provider', async () => {
    for (const v of ['Cashfree ', 'cashfre', 'CASHFREE\n', 'razorpay;cashfree', '../cashfree']) {
      vi.resetModules(); vi.unstubAllEnvs()
      setEnv({ PAYMENT_PROVIDER: v })
      const { resolveActivePaymentProvider } = await providers()
      // 'Cashfree ' and 'CASHFREE\n' normalise (trim + lowercase) and ARE valid choices;
      // everything else must land on Razorpay rather than on an unknown adapter.
      const got = resolveActivePaymentProvider()
      expect(['razorpay', 'cashfree']).toContain(got)
      if (!['cashfree', 'Cashfree ', 'CASHFREE\n'].includes(v)) expect(got).toBe('razorpay')
    }
  })
})

// ─── The client is TOLD, never asks ───────────────────────────────────────────

describe('the browser cannot choose a provider', () => {
  it('create-order derives the provider from the server constant, not the request', () => {
    const src = code(ORDER)
    // Phase B — the provider now comes from the ADMIN setting layered over the deployment
    // variable. Still resolved SERVER-side, still never derived from the request.
    expect(src).toMatch(/const resolution = await resolveActivePaymentProviderForNewOrder\(\)/)
    expect(src).toMatch(/const provider\s*=\s*resolution\.provider/)
    // No request-derived provider anywhere: not from the body, the query or a header.
    expect(src).not.toMatch(/body\.provider/)
    expect(src).not.toMatch(/searchParams\.get\(['"]provider/)
    expect(src).not.toMatch(/headers\.get\(['"]x-provider/)
  })

  it('the client checkout switches ONLY on the handoff the server issued', () => {
    const src = code(CLIENT)
    expect(src).toMatch(/switch \(handoff\.provider\)/)
    // It must not read configuration of its own to decide.
    expect(src).not.toMatch(/process\.env\.PAYMENT_PROVIDER/)
    expect(src).not.toMatch(/CASHFREE_SANDBOX_ENABLED/)
    expect(src).not.toMatch(/searchParams/)
    expect(src).not.toMatch(/localStorage/)
  })

  it('the client never infers a provider from which fields are present', () => {
    const src = code(CLIENT)
    // The specific inferences the brief forbids: "has a session id ⇒ Cashfree",
    // "no key id ⇒ Cashfree".
    expect(src).not.toMatch(/if \([^)]*paymentSessionId[^)]*\)\s*\{[\s\S]{0,80}openCashfree/)
    expect(src).not.toMatch(/!\s*keyId/)
  })
})

// ─── Nothing secret crosses to the browser ────────────────────────────────────

describe('the handoff carries only safe checkout data', () => {
  it('CheckoutHandoff has exactly two members and no secret-shaped field', () => {
    const src = read('lib/payments/providers/types.ts')
    const block = src.slice(src.indexOf('export type CheckoutHandoff'))
      .slice(0, src.slice(src.indexOf('export type CheckoutHandoff')).indexOf('\n\n'))
    expect(block).toMatch(/provider: 'razorpay'; keyId: string/)
    expect(block).toMatch(/provider: 'cashfree'; paymentSessionId: string/)
    for (const forbidden of ['Secret', 'secret', 'clientSecret', 'webhook', 'CLIENT_ID', 'password', 'token']) {
      expect(block, `handoff must not carry ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('the Cashfree adapter returns the session id and NOTHING else from the raw response', async () => {
    vi.resetModules(); vi.unstubAllEnvs(); setEnv()
    const { cashfreeAdapter } = await import('@/lib/payments/providers/cashfreeAdapter')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      order_id: 'rd_1', cf_order_id: 'cf_secret_internal', payment_session_id: 'sess_1',
      order_status: 'ACTIVE', customer_details: { customer_phone: '9876543210' },
      order_meta: { notify_url: null },
    }), { status: 200 })))

    const order = await cashfreeAdapter.createOrder({
      amountPaise: 100, currency: 'INR', receipt: 'rd_1',
      customer: { id: 'c1', phone: '9876543210' },
    })

    expect(order.checkout).toEqual({ provider: 'cashfree', paymentSessionId: 'sess_1', mode: 'sandbox' })
    // The rest of Cashfree's response — including the attendee's phone and the internal
    // cf_order_id — must not ride along to the browser.
    const serialized = JSON.stringify(order)
    expect(serialized).not.toContain('cf_secret_internal')
    expect(serialized).not.toContain('9876543210')
    expect(serialized).not.toContain('TEST_SECRET')
    expect(serialized).not.toContain('TEST_APP_ID')
    vi.unstubAllGlobals()
  })

  it('a Cashfree order is never given a Razorpay key id', () => {
    const src = code(ORDER)
    // keyId is emitted only inside the razorpay branch of the handoff.
    expect(src).toMatch(/handoff\.provider === 'razorpay' \? \{ keyId: handoff\.keyId \}/)
    // And the route no longer imports the key at all.
    expect(src).not.toMatch(/import \{ RAZORPAY_KEY_ID \}/)
    expect(src).not.toMatch(/keyId:\s*RAZORPAY_KEY_ID/)
  })
})

// ─── PENDING is not success, and not a retry ──────────────────────────────────

describe('a payment in flight is neither paid nor absent', () => {
  it('payment-status reports payment_pending and refuses to call it retryable', () => {
    const src = code(STATUS)
    expect(src).toMatch(/state: 'payment_pending', canRetry: false/)
    expect(src).not.toMatch(/state: 'payment_pending', canRetry: true/)
  })

  it('the pending check runs BEFORE awaiting_payment, or it could never be reached', () => {
    const src = code(STATUS)
    const pending = src.indexOf("state: 'payment_pending'")
    const awaiting = src.indexOf("state: 'awaiting_payment'")
    expect(pending).toBeGreaterThan(-1)
    expect(awaiting).toBeGreaterThan(-1)
    expect(pending).toBeLessThan(awaiting)
  })

  it('the client checkout cannot express success at all', () => {
    const src = code(CLIENT)
    // The outcome union deliberately has no member meaning "paid". A Cashfree checkout that
    // closed is `submitted`, which the caller must take to the server.
    expect(src).not.toMatch(/kind: 'succeeded'/)
    expect(src).not.toMatch(/kind: 'paid'/)
    expect(src).toMatch(/kind: 'submitted'/)
  })

  it('a submitted Cashfree checkout does not settle anything in the browser', () => {
    const src = code('app/events/[slug]/register/RegisterClient.tsx')
    const branch = src.slice(src.indexOf("outcome.kind === 'submitted'"))
    const next = branch.slice(0, 700)
    // It parks the attempt and asks the SERVER. It must not call verify-payment (which is
    // Razorpay-signature-only) and must not push the success page on its own authority.
    expect(next).toMatch(/rememberPayment\(pending\)/)
    expect(next).toMatch(/awaitServerOutcome\(pending\)/)
    expect(next).not.toMatch(/verify-payment/)
    expect(next).not.toMatch(/router\.push/)
  })
})

// ─── Server verification stays authoritative ──────────────────────────────────

describe('the browser cannot bypass server verification', () => {
  it('verify-payment still refuses any intent that is not Razorpay', () => {
    const src = code(VERIFY)
    expect(src).toMatch(/intent\.provider !== 'razorpay'/)
    // The signature is checked as Razorpay's, explicitly — a Cashfree payload cannot be
    // presented here and verified as if it were signed.
    expect(src).toMatch(/verifyCheckoutSignature\('razorpay'/)
  })

  it('Cashfree has no browser signature, and the adapter says so rather than inventing one', async () => {
    vi.resetModules(); vi.unstubAllEnvs(); setEnv()
    const { cashfreeAdapter } = await import('@/lib/payments/providers/cashfreeAdapter')
    // False, not true and not a throw: asked "is this browser callback proof of payment?",
    // the honest answer is no, which forces the server-side check.
    await expect(cashfreeAdapter.verifyCheckoutSignature({
      providerOrderId: 'o', providerPaymentId: 'p', signature: 'anything',
    })).resolves.toBe(false)
  })

  it('the registry still refuses to fall back to another gateway', () => {
    const src = code(REGISTRY)
    expect(src).not.toMatch(/\?\?\s*razorpayAdapter/)
    expect(src).not.toMatch(/\|\|\s*razorpayAdapter/)
  })
})

// ─── Razorpay is untouched ────────────────────────────────────────────────────

describe('RAZORPAY REGRESSION', () => {
  it('the Razorpay checkout options are unchanged, field for field', () => {
    const src = code(CLIENT)
    const block = src.slice(src.indexOf('new window.Razorpay('))
    for (const field of [
      'key:', 'amount:', 'currency:', 'order_id:', 'name:', 'description:',
      'prefill:', 'handler:', 'ondismiss:', 'theme:',
    ]) {
      expect(block.slice(0, 900), field).toContain(field)
    }
    expect(block).toMatch(/#e5277e/)   // the same brand hex as before
  })

  it('a Razorpay order still carries keyId at the top level for the existing client', () => {
    const src = code(ORDER)
    expect(src).toMatch(/\{ keyId: handoff\.keyId \}/)
  })

  it('the Razorpay script URL is unchanged', () => {
    expect(code(CLIENT)).toMatch(/https:\/\/checkout\.razorpay\.com\/v1\/checkout\.js/)
  })
})
