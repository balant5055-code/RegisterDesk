// Phase B — the admin payment gateway switch.
//
// ═══ WHAT THE SWITCH IS, AND THE ONE THING IT MUST NEVER DO ═════════════════
// It selects the gateway for payment orders that DO NOT EXIST YET. It is never consulted to
// decide what an existing payment was taken through — that is `intent.provider`, persisted
// at creation. If the switch could influence an existing payment, flipping it would strand
// in-flight money: a Razorpay payment verified against Cashfree, or a refund routed to a
// gateway that never took the money.
//
// Selecting a gateway is also not the same as being granted one. The provider gates
// (credentials, sandbox flag, production activation) still decide, so an admin cannot click
// past them.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const SANDBOX_ON = {
  CASHFREE_SANDBOX_ENABLED: 'true',
  CASHFREE_CLIENT_ID: 'TEST_APP_ID',
  CASHFREE_CLIENT_SECRET: 'TEST_SECRET',
  CASHFREE_ENV: 'sandbox',
  NODE_ENV: 'test',
}
const setEnv = (over: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries({ ...SANDBOX_ON, ...over })) vi.stubEnv(k, v)
}

/** Stubs the stored admin setting; `null` = no setting saved. */
function stubStoredProvider(value: string | null) {
  vi.doMock('@/lib/config/businessConfigService', () => ({
    businessConfig: { getValue: async () => value },
  }))
}
const providers = () => import('@/lib/payments/providers')

beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs(); vi.doUnmock('@/lib/config/businessConfigService') })

// ─── Resolution for a NEW order ───────────────────────────────────────────────

describe('gateway selection for a new order', () => {
  it('RAZORPAY is the default when no setting exists', async () => {
    setEnv(); stubStoredProvider(null)
    const { resolveActivePaymentProviderForNewOrder } = await providers()
    expect(await resolveActivePaymentProviderForNewOrder()).toEqual({ ok: true, provider: 'razorpay' })
  })

  it('an explicit razorpay setting routes to Razorpay', async () => {
    setEnv(); stubStoredProvider('razorpay')
    const { resolveActivePaymentProviderForNewOrder } = await providers()
    expect(await resolveActivePaymentProviderForNewOrder()).toEqual({ ok: true, provider: 'razorpay' })
  })

  it('a cashfree setting routes to Cashfree when the sandbox gates are satisfied', async () => {
    setEnv(); stubStoredProvider('cashfree')
    const { resolveActivePaymentProviderForNewOrder } = await providers()
    expect(await resolveActivePaymentProviderForNewOrder()).toEqual({ ok: true, provider: 'cashfree' })
  })

  it('the admin setting OVERRIDES the deployment variable', async () => {
    // The stored setting is the authority; PAYMENT_PROVIDER is only the layer beneath it.
    setEnv({ PAYMENT_PROVIDER: 'cashfree' }); stubStoredProvider('razorpay')
    const { resolveActivePaymentProviderForNewOrder } = await providers()
    expect(await resolveActivePaymentProviderForNewOrder()).toEqual({ ok: true, provider: 'razorpay' })
  })

  it('falls back to the deployment variable when nothing is stored', async () => {
    setEnv({ PAYMENT_PROVIDER: 'cashfree' }); stubStoredProvider(null)
    const { resolveActivePaymentProviderForNewOrder } = await providers()
    expect(await resolveActivePaymentProviderForNewOrder()).toEqual({ ok: true, provider: 'cashfree' })
  })
})

// ─── The gates still decide ───────────────────────────────────────────────────

describe('selecting Cashfree does not GRANT Cashfree', () => {
  it('PRODUCTION stays blocked when it is not activated', async () => {
    // The whole safety story: an admin cannot click past production activation.
    setEnv({ NODE_ENV: 'production' }); stubStoredProvider('cashfree')
    const p = await providers()
    expect(p.isCashfreeProductionEnabled()).toBe(false)
    expect(await p.resolveActivePaymentProviderForNewOrder()).toEqual({ ok: false, reason: 'cashfree_not_ready' })
  })

  it('a stored cashfree preference is REFUSED when credentials are gone — not downgraded', async () => {
    // Fail-closed. An explicit choice that cannot be honoured stops the order; it does not
    // quietly become a Razorpay charge.
    setEnv({ CASHFREE_CLIENT_ID: '', CASHFREE_CLIENT_SECRET: '' })
    stubStoredProvider('cashfree')
    const { resolveActivePaymentProviderForNewOrder } = await providers()
    const r = await resolveActivePaymentProviderForNewOrder()
    expect(r).toEqual({ ok: false, reason: 'cashfree_not_ready' })
    expect(r).not.toHaveProperty('provider')
  })

  it('a refused preference is REPORTED — it is never silent', async () => {
    // The refusal blocks the payment, so someone must be told WHY — otherwise the symptom
    // is "checkout is broken" with no cause attached.
    const reported: string[] = []
    vi.doMock('@/lib/monitoring/sentry', () => ({
      captureFinancialError: (k: string) => { reported.push(k) },
      captureError: () => {}, captureWebhookError: () => {},
    }))
    setEnv({ CASHFREE_SANDBOX_ENABLED: '' }); stubStoredProvider('cashfree')
    const { resolveActivePaymentProviderForNewOrder } = await providers()
    // The resolver AWAITS the report, so no timing slack is needed here — the assertion is
    // deterministic rather than racing a fire-and-forget promise.
    expect(await resolveActivePaymentProviderForNewOrder()).toEqual({ ok: false, reason: 'cashfree_not_ready' })
    expect(reported).toContain('gateway_preference_refused')
  })

  it('an unreadable configuration does not stop payments', async () => {
    // A config outage must degrade to the env/Razorpay layers, never throw into checkout.
    vi.doMock('@/lib/config/businessConfigService', () => ({
      businessConfig: { getValue: async () => { throw new Error('firestore down') } },
    }))
    setEnv()
    const { resolveActivePaymentProviderForNewOrder } = await providers()
    expect(await resolveActivePaymentProviderForNewOrder()).toEqual({ ok: true, provider: 'razorpay' })
  })

  it('a corrupted stored value is not treated as cashfree', async () => {
    for (const bad of ['stripe', 'CASHFREE!', ' ', 'razorpay ']) {
      vi.resetModules(); vi.unstubAllEnvs()
      setEnv(); stubStoredProvider(bad)
      const { resolveActivePaymentProviderForNewOrder } = await providers()
      // A corrupted value is NOT an explicit Cashfree choice, so it is not a refusal — it
      // falls through to the incumbent gateway exactly as "no preference" does.
      expect(await resolveActivePaymentProviderForNewOrder(), `${bad} must not select cashfree`)
        .toEqual({ ok: true, provider: 'razorpay' })
    }
  })
})

// ─── Validation at the write ──────────────────────────────────────────────────

describe('the setting cannot be saved with an invalid provider', () => {
  it('accepts only the two supported providers', async () => {
    const { CONFIG_SECTION_REGISTRY } = await import('@/lib/config/businessConfig')
    const v = CONFIG_SECTION_REGISTRY.payments.validate
    expect(v({ activeProvider: 'razorpay' }).valid).toBe(true)
    expect(v({ activeProvider: 'cashfree' }).valid).toBe(true)
    for (const bad of [{ activeProvider: 'stripe' }, { activeProvider: '' }, { activeProvider: 1 }, {}, null]) {
      expect(v(bad).valid, `${JSON.stringify(bad)} must be rejected`).toBe(false)
    }
  })

  it('the default is razorpay', async () => {
    const { BUSINESS_CONFIG_DEFAULTS } = await import('@/lib/config/businessConfig')
    expect(BUSINESS_CONFIG_DEFAULTS.payments.activeProvider).toBe('razorpay')
  })
})

// ─── Authorization and audit come from the existing mechanism ────────────────

describe('authorization and audit reuse the config engine', () => {
  const routeSrc = readFileSync('app/api/admin/business-config/route.ts', 'utf8')

  it('both GET and POST require an admin', () => {
    const guards = routeSrc.match(/resolveAdminUid\(/g) ?? []
    expect(guards.length).toBeGreaterThanOrEqual(2)
    expect(routeSrc).toMatch(/if \(!adminUid\) return NextResponse\.json\(\{ error: 'Forbidden' \}/)
  })

  it('a write is audited with actor and reason by the service', () => {
    const svc = readFileSync('lib/config/businessConfigService.ts', 'utf8')
    expect(svc).toMatch(/updateSection requires ctx\.updatedBy and ctx\.reason/)
    expect(svc).toMatch(/CONFIG_SECTION_REGISTRY\[key\]\.validate\(candidate\)/)
  })

  it('readiness exposed to the client is booleans and an environment name only', () => {
    const block = routeSrc.slice(routeSrc.indexOf('export interface GatewayReadiness'))
      .slice(0, routeSrc.slice(routeSrc.indexOf('export interface GatewayReadiness')).indexOf('}\n'))
    for (const forbidden of ['Secret', 'secret', 'CLIENT_ID', 'credential', 'key', 'token']) {
      expect(block, `readiness must not carry ${forbidden}`).not.toContain(forbidden)
    }
  })
})

// ─── A refusal creates NOTHING ────────────────────────────────────────────────

describe('a refused Cashfree preference creates no order of any kind', () => {
  const src = readFileSync('app/api/registrations/create-order/route.ts', 'utf8')

  it('the route returns before ANY state is written', () => {
    // The guarantee is positional. Everything that creates state — the gateway order, the
    // payment intent, the attempt claim — must come AFTER the refusal returns, or a blocked
    // payment would still leave debris behind for the next attempt to trip over.
    const refusal = src.indexOf('if (!resolution.ok)')
    expect(refusal).toBeGreaterThan(-1)
    for (const later of ['.createOrder({', 'await createPaymentIntent({', 'await claimPaymentAttempt(']) {
      expect(src.indexOf(later), `${later} must come after the refusal`).toBeGreaterThan(refusal)
    }
  })

  it('NO Razorpay order is minted as a substitute', () => {
    // The specific thing the fail-closed change exists to prevent: the refusal block must
    // not fall through into order creation, and must not name a provider of its own.
    const block = src.slice(src.indexOf('if (!resolution.ok)'), src.indexOf('const provider    = resolution.provider'))
    expect(block).toMatch(/return NextResponse\.json\(/)
    expect(block).not.toMatch(/razorpay/i)
    expect(block).not.toMatch(/createOrder|createPaymentIntent|claimPaymentAttempt/)
  })

  it('the attendee is told plainly that nothing was charged', () => {
    const block = src.slice(src.indexOf('if (!resolution.ok)'), src.indexOf('const provider    = resolution.provider'))
    expect(block).toMatch(/status:\s*503/)
    expect(block).toMatch(/reason:\s*'GATEWAY_UNAVAILABLE'/)
    expect(block).toMatch(/Nothing was charged/i)
    // No gateway name leaks to the attendee — it is not their concern and not their fault.
    expect(block).not.toMatch(/cashfree/i)
  })
})

// ─── An existing payment is untouchable ───────────────────────────────────────

describe('switching the gateway cannot affect an EXISTING payment', () => {
  it('create-order persists the resolved provider onto the intent', () => {
    const src = readFileSync('app/api/registrations/create-order/route.ts', 'utf8')
    expect(src).toMatch(/const resolution = await resolveActivePaymentProviderForNewOrder\(\)/)
    expect(src).toMatch(/const provider\s+= resolution\.provider/)
    expect(src).toMatch(/provider,/)   // carried onto createPaymentIntent
  })

  it('verification, webhook and status read the PAYMENT\'s provider, not the setting', () => {
    for (const f of [
      'app/api/registrations/verify-payment/route.ts',
      'app/api/webhooks/cashfree/route.ts',
      'app/api/registrations/payment-status/route.ts',
    ]) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} must not consult the active-gateway setting`)
        .not.toContain('resolveActivePaymentProviderForNewOrder')
      expect(src, `${f} must not read the payments config section`)
        .not.toMatch(/getValue\('payments'/)
    }
  })

  it('refund routing is based on the original payment provider', () => {
    const src = readFileSync('app/api/organizer/registrations/[registrationId]/refund/route.ts', 'utf8')
    expect(src).toMatch(/readProvider\(pi\.provider\)/)
    expect(src).not.toContain('resolveActivePaymentProviderForNewOrder')
  })

  it('webhook provider ownership is still enforced', () => {
    const src = readFileSync('app/api/webhooks/cashfree/route.ts', 'utf8')
    expect(src).toMatch(/intent\.provider !== 'cashfree'/)
  })
})
