// Cashfree production readiness — test and production must never touch.
//
// ═══ THE FAILURE THIS FILE EXISTS TO MAKE IMPOSSIBLE ═════════════════════════
// Not "no credentials" — that fails loudly and immediately. The dangerous one is SANDBOX
// CREDENTIALS SENT TO THE PRODUCTION ENDPOINT, or a production session opened against the
// sandbox SDK. Both are single-variable mistakes, both look like a gateway fault rather than
// a misconfiguration, and one of them involves real money.
//
// The design under test: `CASHFREE_ENV` selects the base URL AND which credential variables
// are read, production credentials live under their own names, and production is reachable
// only behind a flag that exists in no environment today.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const SANDBOX_CREDS = { CASHFREE_CLIENT_ID: 'TEST_APP_ID', CASHFREE_CLIENT_SECRET: 'TEST_SECRET' }
const PROD_CREDS    = { CASHFREE_PROD_CLIENT_ID: 'LIVE_APP_ID', CASHFREE_PROD_CLIENT_SECRET: 'LIVE_SECRET' }

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
}
const adapter   = () => import('@/lib/payments/providers/cashfreeAdapter')
const providers = () => import('@/lib/payments/providers')

/** Captures the URL and headers of the next fetch without performing one. */
function captureFetch(body: unknown = { order_id: 'o1', payment_session_id: 's1' }) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  vi.stubGlobal('fetch', spy)
  return spy
}

beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

// ─── Endpoint follows CASHFREE_ENV ────────────────────────────────────────────

describe('the endpoint is chosen by CASHFREE_ENV, and defaults to sandbox', () => {
  it('unset ENV is sandbox — a forgotten variable must never mean production', async () => {
    setEnv(SANDBOX_CREDS)
    const { cashfreeEnvironment } = await adapter()
    expect(cashfreeEnvironment()).toBe('sandbox')
  })

  it.each([['', 'sandbox'], ['sandbox', 'sandbox'], ['PRODUCTION', 'production'], ['production', 'production'],
           ['prod', 'sandbox'], ['live', 'sandbox'], ['Production ', 'production']])(
    'CASHFREE_ENV=%o → %s', async (value, expected) => {
      setEnv({ ...SANDBOX_CREDS, CASHFREE_ENV: value })
      const { cashfreeEnvironment } = await adapter()
      // Anything that is not exactly `production` (after trim/lowercase) is sandbox. `prod`
      // and `live` are NOT accepted spellings — a typo must fail safe, not go live.
      expect(cashfreeEnvironment()).toBe(expected)
    })

  it('sandbox calls hit the SANDBOX base with the SANDBOX key', async () => {
    setEnv({ ...SANDBOX_CREDS, ...PROD_CREDS, CASHFREE_ENV: 'sandbox' })
    const spy = captureFetch()
    const { cashfreeAdapter } = await adapter()
    await cashfreeAdapter.createOrder({
      amountPaise: 100, currency: 'INR', receipt: 'r1', customer: { id: 'c', phone: '9876543210' },
    })
    const [url, init] = spy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url).toContain('https://sandbox.cashfree.com/pg')
    expect(url).not.toContain('api.cashfree.com')
    expect(init.headers['x-client-id']).toBe('TEST_APP_ID')
    // The production key is PRESENT in the environment and must still not be used.
    expect(init.headers['x-client-secret']).toBe('TEST_SECRET')
  })

  it('production calls hit the PRODUCTION base with the PRODUCTION key', async () => {
    setEnv({ ...SANDBOX_CREDS, ...PROD_CREDS, CASHFREE_ENV: 'production' })
    const spy = captureFetch()
    const { cashfreeAdapter } = await adapter()
    await cashfreeAdapter.createOrder({
      amountPaise: 100, currency: 'INR', receipt: 'r1', customer: { id: 'c', phone: '9876543210' },
    })
    const [url, init] = spy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url).toContain('https://api.cashfree.com/pg')
    expect(url).not.toContain('sandbox.cashfree.com')
    expect(init.headers['x-client-id']).toBe('LIVE_APP_ID')
    expect(init.headers['x-client-secret']).toBe('LIVE_SECRET')
  })
})

// ─── Credentials cannot be mixed ──────────────────────────────────────────────

describe('credentials CANNOT cross environments', () => {
  it('production REFUSES to fall back to sandbox credentials', async () => {
    // The whole point of separate variable names. Sandbox keys are present and complete;
    // production must still refuse rather than send them to the live endpoint.
    setEnv({ ...SANDBOX_CREDS, CASHFREE_ENV: 'production' })
    const { cashfreeAdapter } = await adapter()
    await expect(cashfreeAdapter.createOrder({
      amountPaise: 100, currency: 'INR', receipt: 'r1', customer: { id: 'c', phone: '9876543210' },
    })).rejects.toThrow(/CASHFREE_PROD_CLIENT_ID/)
  })

  it('a machine holding ONLY sandbox keys cannot reach production', async () => {
    setEnv({ ...SANDBOX_CREDS, CASHFREE_ENV: 'production' })
    const { isCashfreeConfigured } = await adapter()
    expect(isCashfreeConfigured()).toBe(false)
  })

  it('sandbox does not read the production variables either', async () => {
    setEnv({ ...PROD_CREDS, CASHFREE_ENV: 'sandbox' })
    const { isCashfreeConfigured } = await adapter()
    expect(isCashfreeConfigured()).toBe(false)
  })

  it('the webhook secret follows the SAME environment as the API credentials', async () => {
    setEnv({ ...SANDBOX_CREDS, ...PROD_CREDS, CASHFREE_ENV: 'production' })
    const prod = await adapter()
    expect(prod.cashfreeWebhookSecret()).toBe('LIVE_SECRET')

    vi.resetModules(); vi.unstubAllEnvs()
    setEnv({ ...SANDBOX_CREDS, ...PROD_CREDS, CASHFREE_ENV: 'sandbox' })
    const sand = await adapter()
    expect(sand.cashfreeWebhookSecret()).toBe('TEST_SECRET')
  })
})

// ─── Production stays OFF ─────────────────────────────────────────────────────

describe('Cashfree PRODUCTION is prepared and disabled', () => {
  const ALL_ON = {
    ...PROD_CREDS,
    CASHFREE_ENV: 'production',
    CASHFREE_PRODUCTION_ENABLED: 'true',
    NODE_ENV: 'production',
  }

  it('is enabled ONLY when all four conditions hold', async () => {
    setEnv(ALL_ON)
    const { isCashfreeProductionEnabled } = await providers()
    expect(isCashfreeProductionEnabled()).toBe(true)
  })

  it.each([
    ['the flag is absent',        { CASHFREE_PRODUCTION_ENABLED: '' }],
    ['the flag is not "true"',    { CASHFREE_PRODUCTION_ENABLED: '1' }],
    ['ENV is still sandbox',      { CASHFREE_ENV: 'sandbox' }],
    ['credentials are missing',   { CASHFREE_PROD_CLIENT_ID: '', CASHFREE_PROD_CLIENT_SECRET: '' }],
    ['NODE_ENV is not production',{ NODE_ENV: 'development' }],
  ])('stays OFF when %s', async (_label, override) => {
    setEnv({ ...ALL_ON, ...override })
    const { isCashfreeProductionEnabled } = await providers()
    expect(isCashfreeProductionEnabled()).toBe(false)
  })

  it('TODAY it is off — no current environment satisfies it', async () => {
    // Nothing stubbed beyond sandbox credentials: this is the shape of every real
    // deployment right now.
    setEnv({ ...SANDBOX_CREDS, CASHFREE_SANDBOX_ENABLED: 'true', NODE_ENV: 'test' })
    const { isCashfreeProductionEnabled } = await providers()
    expect(isCashfreeProductionEnabled()).toBe(false)
  })

  it('sandbox and production are MUTUALLY EXCLUSIVE, so nothing must choose between them', async () => {
    setEnv({ ...SANDBOX_CREDS, ...ALL_ON, CASHFREE_SANDBOX_ENABLED: 'true' })
    const p = await providers()
    expect(p.isCashfreeSandboxEnabled()).toBe(false)   // NODE_ENV is production
    expect(p.isCashfreeProductionEnabled()).toBe(true)
    expect(p.isCashfreeEnabled()).toBe(true)
  })

  it('sandbox mode is refused once CASHFREE_ENV says production', async () => {
    // Otherwise "sandbox enabled" would be true while every API call went to the live base.
    setEnv({ ...SANDBOX_CREDS, CASHFREE_SANDBOX_ENABLED: 'true', CASHFREE_ENV: 'production', NODE_ENV: 'test' })
    const { isCashfreeSandboxEnabled } = await providers()
    expect(isCashfreeSandboxEnabled()).toBe(false)
  })

  it('production Cashfree still does not become the ACTIVE provider on its own', async () => {
    // Being reachable is not being chosen. PAYMENT_PROVIDER remains a separate decision.
    setEnv(ALL_ON)
    const { resolveActivePaymentProvider } = await providers()
    expect(resolveActivePaymentProvider()).toBe('razorpay')
  })
})

// ─── The browser is told which SDK to open ────────────────────────────────────

describe('the checkout handoff carries the environment, and nothing secret', () => {
  it('sandbox order → mode sandbox; production order → mode production', async () => {
    setEnv({ ...SANDBOX_CREDS, CASHFREE_ENV: 'sandbox' })
    captureFetch()
    const s = await adapter()
    const sandboxOrder = await s.cashfreeAdapter.createOrder({
      amountPaise: 100, currency: 'INR', receipt: 'r1', customer: { id: 'c', phone: '9876543210' },
    })
    expect(sandboxOrder.checkout).toEqual({ provider: 'cashfree', paymentSessionId: 's1', mode: 'sandbox' })

    vi.resetModules(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
    setEnv({ ...PROD_CREDS, CASHFREE_ENV: 'production' })
    captureFetch()
    const p = await adapter()
    const prodOrder = await p.cashfreeAdapter.createOrder({
      amountPaise: 100, currency: 'INR', receipt: 'r1', customer: { id: 'c', phone: '9876543210' },
    })
    expect(prodOrder.checkout).toEqual({ provider: 'cashfree', paymentSessionId: 's1', mode: 'production' })
  })

  it('no credential of either environment appears in the handoff', async () => {
    setEnv({ ...SANDBOX_CREDS, ...PROD_CREDS, CASHFREE_ENV: 'production' })
    captureFetch()
    const { cashfreeAdapter } = await adapter()
    const order = await cashfreeAdapter.createOrder({
      amountPaise: 100, currency: 'INR', receipt: 'r1', customer: { id: 'c', phone: '9876543210' },
    })
    const serialized = JSON.stringify(order)
    for (const secret of ['TEST_SECRET', 'LIVE_SECRET', 'TEST_APP_ID', 'LIVE_APP_ID']) {
      expect(serialized, `handoff leaked ${secret}`).not.toContain(secret)
    }
  })

  it('the client opens the SDK in the mode the server sent, never a literal', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('lib/payments/checkout/clientCheckout.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(src).toMatch(/factory\(\{ mode \}\)/)
    expect(src).not.toMatch(/factory\(\{ mode: 'sandbox' \}\)/)
    expect(src).not.toMatch(/factory\(\{ mode: 'production' \}\)/)
  })
})
