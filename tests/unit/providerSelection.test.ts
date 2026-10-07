// RD-PAYMENT-CASHFREE-SANDBOX-05A — which provider a payment is allowed to reach.
//
// ═══ THE TWO RULES THAT MUST NEVER BE TRUE ═══════════════════════════════════
//   missing provider   → Cashfree      (a historical record is Razorpay, always)
//   credentials exist  → Cashfree      (having keys is not the same as choosing a gateway)
//
// Both are the kind of convenience that looks harmless and routes real money somewhere
// nobody chose. Cashfree is reachable only when THREE independent conditions hold: an
// explicit flag, credentials, and a non-production environment. Each is asserted separately
// below, because a gate that passes only when all three are tested together would still be
// open if one were quietly dropped.

import { describe, it, expect, vi, beforeEach } from 'vitest'

async function providers() {
  return import('@/lib/payments/providers')
}

const ON = {
  CASHFREE_SANDBOX_ENABLED: 'true',
  CASHFREE_CLIENT_ID: 'TEST_APP_ID',
  CASHFREE_CLIENT_SECRET: 'TEST_SECRET',
  NODE_ENV: 'test',
}

function setEnv(over: Record<string, string> = {}) {
  for (const [k, v] of Object.entries({ ...ON, ...over })) vi.stubEnv(k, v)
}

describe('RD-PAYMENT-CASHFREE-SANDBOX-05A · provider selection', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs() })

  describe('the default never moves', () => {
    it('ACTIVE_PAYMENT_PROVIDER is razorpay, whatever Cashfree is configured to do', async () => {
      setEnv()
      const { ACTIVE_PAYMENT_PROVIDER } = await providers()
      // Enabling the sandbox makes Cashfree REACHABLE for testing. It does not make it the
      // provider new attendee payments are created with — that is a later phase.
      expect(ACTIVE_PAYMENT_PROVIDER).toBe('razorpay')
    })

    it('razorpay resolves unconditionally', async () => {
      vi.unstubAllEnvs()
      const { resolvePaymentProvider, isProviderEnabled } = await providers()
      expect(isProviderEnabled('razorpay')).toBe(true)
      expect(resolvePaymentProvider('razorpay').id).toBe('razorpay')
    })
  })

  describe('Cashfree needs all three conditions', () => {
    it('is enabled when flag + credentials + non-production all hold', async () => {
      setEnv()
      const { isProviderEnabled, resolvePaymentProvider } = await providers()
      expect(isProviderEnabled('cashfree')).toBe(true)
      expect(resolvePaymentProvider('cashfree').id).toBe('cashfree')
    })

    it('credentials ALONE do not enable it — the flag is required', async () => {
      // The rule this exists to prevent: "the keys are there, so use it".
      setEnv({ CASHFREE_SANDBOX_ENABLED: '' })
      const { isProviderEnabled } = await providers()
      expect(isProviderEnabled('cashfree')).toBe(false)
    })

    it('the flag ALONE does not enable it — credentials are required', async () => {
      setEnv({ CASHFREE_CLIENT_ID: '', CASHFREE_CLIENT_SECRET: '' })
      const { isProviderEnabled } = await providers()
      expect(isProviderEnabled('cashfree')).toBe(false)
    })

    it('PRODUCTION disables it even with the flag and credentials set', async () => {
      // This phase is sandbox-only, so a misconfigured production deployment must not be
      // able to switch a live gateway on by setting one variable.
      setEnv({ NODE_ENV: 'production' })
      const { isProviderEnabled } = await providers()
      expect(isProviderEnabled('cashfree')).toBe(false)
    })

    it('a truthy-but-not-"true" flag does not enable it', async () => {
      for (const v of ['1', 'yes', 'TRUE', 'on']) {
        vi.resetModules(); vi.unstubAllEnvs()
        setEnv({ CASHFREE_SANDBOX_ENABLED: v })
        const { isProviderEnabled } = await providers()
        expect(isProviderEnabled('cashfree'), `'${v}' must not enable cashfree`).toBe(false)
      }
    })
  })

  describe('fail closed, never fall back', () => {
    it('resolving a disabled Cashfree THROWS rather than returning Razorpay', async () => {
      // A silent fallback is worse than a failure: it succeeds, takes the money through a
      // gateway nobody chose, and reports nothing.
      setEnv({ CASHFREE_SANDBOX_ENABLED: '' })
      const { resolvePaymentProvider } = await providers()
      expect(() => resolvePaymentProvider('cashfree')).toThrow(/not enabled/i)
    })

    it('the refund resolver uses the SAME gate', async () => {
      // Money leaving through a gateway that is not permitted to take any.
      setEnv({ CASHFREE_SANDBOX_ENABLED: '' })
      const { resolveRefundProvider } = await providers()
      expect(() => resolveRefundProvider('cashfree')).toThrow()
    })

    it('there is no fallback expression anywhere in the registry', async () => {
      const src = (await import('node:fs')).readFileSync('lib/payments/providers/index.ts', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      expect(src).not.toMatch(/\?\?\s*razorpayAdapter/)
      expect(src).not.toMatch(/\|\|\s*razorpayAdapter/)
    })
  })

  describe('historical records', () => {
    it('a missing provider reads as RAZORPAY — never as Cashfree', async () => {
      setEnv()   // Cashfree fully enabled: the read must STILL be razorpay.
      const { readProvider, LEGACY_PROVIDER } = await providers()
      expect(LEGACY_PROVIDER).toBe('razorpay')
      for (const stored of [undefined, null, '', 'unknown', 0]) {
        expect(readProvider(stored)).toBe('razorpay')
      }
    })
  })
})
