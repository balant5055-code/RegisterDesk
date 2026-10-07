// RD-PREPROD · the admin cannot SAVE activeProvider='cashfree' while Cashfree production is off.
//
// Selecting Cashfree with its gates shut does not fall back to Razorpay (by design — the new-order
// resolver FAILS CLOSED on a refused explicit choice), so saving it would stop every new payment.
// The POST now refuses it before anything is written. Razorpay selection is unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { activeProviderSelectionRefusal } from '@/lib/payments/providerSelection'

const OFF = { productionEnabled: false, sandboxEnabled: false, emulator: false }

describe('activeProviderSelectionRefusal (pure)', () => {
  it('refuses cashfree while production is off', () => {
    expect(activeProviderSelectionRefusal('cashfree', OFF)).toMatch(/Cashfree production is not enabled/)
  })

  it('refuses cashfree with only the SANDBOX gate open against a real (non-emulator) Firestore', () => {
    // The config document is the ONE production Firestore: a sandbox flag on a developer
    // machine must not be able to flip production checkout.
    expect(activeProviderSelectionRefusal('cashfree', { ...OFF, sandboxEnabled: true })).not.toBeNull()
  })

  it('allows cashfree once production is enabled', () => {
    expect(activeProviderSelectionRefusal('cashfree', { ...OFF, productionEnabled: true })).toBeNull()
  })

  it('allows cashfree on the emulator with the sandbox gate open (local checkout testing)', () => {
    expect(activeProviderSelectionRefusal('cashfree', { ...OFF, sandboxEnabled: true, emulator: true })).toBeNull()
    expect(activeProviderSelectionRefusal('cashfree', { ...OFF, emulator: true })).not.toBeNull()
  })

  it('never refuses razorpay, or a patch that does not touch the provider', () => {
    expect(activeProviderSelectionRefusal('razorpay', OFF)).toBeNull()
    expect(activeProviderSelectionRefusal(undefined, OFF)).toBeNull()
  })
})

// ─── The route, with its dependencies stubbed ────────────────────────────────

const updateSection = vi.fn(async () => ({ version: 2, section: {} }))

function stubRouteDeps() {
  vi.doMock('@/lib/admin/auth', () => ({
    resolveAdminUid:      async () => 'super-admin-uid',
    resolveSuperAdminUid: async () => 'super-admin-uid',
  }))
  vi.doMock('@/lib/config/businessConfigService', () => ({
    businessConfig: { updateSection, getSection: async () => ({}), getValue: async () => null },
  }))
  vi.doMock('@/lib/licensing/resolveCommercialTerms', () => ({ resolveGlobalCommercialTerms: async () => ({}) }))
  vi.doMock('@/lib/licensing/serviceAllowanceConfig', () => ({ getServiceCatalog: async () => ({}) }))
}

async function post(patch: Record<string, unknown>) {
  const { POST } = await import('@/app/api/admin/business-config/route')
  const req = new Request('http://localhost/api/admin/business-config', {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'payments', patch, reason: 'switch gateway' }),
  })
  const res = await POST(req as never)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('POST /api/admin/business-config · payments.activeProvider', () => {
  beforeEach(() => {
    vi.resetModules(); vi.unstubAllEnvs(); updateSection.mockClear()
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '')
    vi.stubEnv('CASHFREE_PRODUCTION_ENABLED', '')
    vi.stubEnv('CASHFREE_SANDBOX_ENABLED', '')
    stubRouteDeps()
  })

  it('REFUSES cashfree (409 CASHFREE_NOT_ENABLED) and writes nothing', async () => {
    const r = await post({ activeProvider: 'cashfree' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('CASHFREE_NOT_ENABLED')
    expect(updateSection).not.toHaveBeenCalled()
  })

  it('still refuses cashfree with the sandbox gate open against a real Firestore', async () => {
    vi.stubEnv('CASHFREE_SANDBOX_ENABLED', 'true')
    vi.stubEnv('CASHFREE_CLIENT_ID', 'TEST_APP_ID')
    vi.stubEnv('CASHFREE_CLIENT_SECRET', 'TEST_SECRET')
    vi.stubEnv('CASHFREE_ENV', 'sandbox')
    const r = await post({ activeProvider: 'cashfree' })
    expect(r.status).toBe(409)
    expect(updateSection).not.toHaveBeenCalled()
  })

  it('razorpay is saved exactly as before', async () => {
    const r = await post({ activeProvider: 'razorpay' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(updateSection).toHaveBeenCalledTimes(1)
  })
})
