// RD-LICENSE-GA-01 — runtime foundation: workspaceEntitlements (version-aware, cross-version
// ranking) + feeEngine (V1+V2 fee mapping) + fee-config completeness. Proves a V2 license is
// never dropped/rejected and that V1 behavior is byte-for-byte unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Configurable Firestore stub: `licenseDocs` are the organizer's eventLicenses; `userDoc`
// is users/{uid} (admin override). Reset per test.
let licenseDocs: Array<Record<string, unknown>> = []
let userDoc: { exists: boolean; data?: () => unknown } = { exists: false }

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs: licenseDocs.map(d => ({ data: () => d })) }) }) }) }),
    doc: () => ({ get: async () => userDoc }),
  },
}))
// No config overrides → catalogs resolve to the code defaults (V1 + V2).
vi.mock('@/lib/config/businessConfigService', () => ({
  businessConfig: { getSection: async () => ({ tierOverrides: {}, tierOverridesV2: {}, fees: {} }) },
}))

import { getWorkspaceEntitlements } from '@/lib/licensing/workspaceEntitlements'
import { licenseTierToFeeTier } from '@/lib/billing/feeEngine'
import { getDefaultFeeConfig } from '@/lib/fees/config'
import { getEventLicenseDefinition, getEventLicenseDefinitionV2 } from '@/lib/licensing/eventLicense'

beforeEach(() => { licenseDocs = []; userDoc = { exists: false } })

describe('workspaceEntitlements — version-aware, never drops V2', () => {
  it('a historical V1 license resolves through V1 (unchanged)', async () => {
    licenseDocs = [{ organizerUid: 'u', tier: 'growth', status: 'active', version: 1 }]
    const e = await getWorkspaceEntitlements('u')
    expect(e.effectiveTier).toBe('growth')
    expect(e.effectiveVersion).toBe(1)
    expect(e.limits.maxRegistrations).toBe(1000)
    expect(e.source).toBe('event_license')
  })

  it('a V2 Business license is NOT dropped — resolves to Business entitlements', async () => {
    licenseDocs = [{ organizerUid: 'u', tier: 'business', status: 'active', version: 2 }]
    const e = await getWorkspaceEntitlements('u')
    expect(e.effectiveTier).toBe('business')      // ← was silently skipped before GA-01
    expect(e.effectiveVersion).toBe(2)
    expect(e.limits.maxRegistrations).toBe(5000)
    expect(e.definition.name).toBe('Business')
    expect(e.source).toBe('event_license')
  })

  it('a V2 Free license resolves to Free (200), not the Starter fallback', async () => {
    licenseDocs = [{ organizerUid: 'u', tier: 'free', status: 'active', version: 2 }]
    const e = await getWorkspaceEntitlements('u')
    expect(e.effectiveTier).toBe('free')
    expect(e.limits.maxRegistrations).toBe(200)
  })

  it('cross-version: highest by registration limit wins (V2 Business 5000 > V1 growth 1000)', async () => {
    licenseDocs = [
      { organizerUid: 'u', tier: 'growth',   status: 'active', version: 1 },
      { organizerUid: 'u', tier: 'business', status: 'active', version: 2 },
    ]
    const e = await getWorkspaceEntitlements('u')
    expect(e.effectiveTier).toBe('business')
    expect(e.limits.maxRegistrations).toBe(5000)
    expect(e.activeEventCount).toBe(2)
  })

  it('V1-only ranking is identical to the legacy tier order (enterprise wins over growth)', async () => {
    licenseDocs = [
      { organizerUid: 'u', tier: 'growth',     status: 'active', version: 1 },
      { organizerUid: 'u', tier: 'enterprise', status: 'active', version: 1 },
    ]
    const e = await getWorkspaceEntitlements('u')
    expect(e.effectiveTier).toBe('enterprise')
  })

  it('no active license → most-restrictive fallback (Starter)', async () => {
    const e = await getWorkspaceEntitlements('u')
    expect(e.effectiveTier).toBe('starter')
    expect(e.source).toBe('fallback')
  })

  it('suspended license is ignored', async () => {
    licenseDocs = [{ organizerUid: 'u', tier: 'business', status: 'active', version: 2, admin: { lifecycle: 'suspended' } }]
    const e = await getWorkspaceEntitlements('u')
    expect(e.source).toBe('fallback')
  })
})

describe('feeEngine.licenseTierToFeeTier — canonical V1+V2 mapping (rate-matched)', () => {
  it('V1 mapping is byte-for-byte unchanged', () => {
    expect(licenseTierToFeeTier('starter', 1)).toBe('starter')
    expect(licenseTierToFeeTier('growth', 1)).toBe('growth')
    expect(licenseTierToFeeTier('professional', 1)).toBe('pro')
    expect(licenseTierToFeeTier('enterprise', 1)).toBe('enterprise')
  })
  it('V2 mapping resolves every tier to a valid fee row', () => {
    expect(licenseTierToFeeTier('free', 2)).toBe('starter')
    expect(licenseTierToFeeTier('starter', 2)).toBe('growth')
    expect(licenseTierToFeeTier('professional', 2)).toBe('professional')
    expect(licenseTierToFeeTier('business', 2)).toBe('business')
    expect(licenseTierToFeeTier('enterprise', 2)).toBe('enterprise')
  })

  // Each mapped fee row's ticketed % must equal the license def's transactionFeePercent.
  it('V1 fee-row rates match the V1 license definitions', () => {
    for (const t of ['starter', 'growth', 'professional', 'enterprise'] as const) {
      const rowBps = getDefaultFeeConfig('event_registration', licenseTierToFeeTier(t, 1)).platformFeePercentBps
      expect(rowBps / 100).toBe(getEventLicenseDefinition(t).transactionFeePercent)
    }
  })
  it('V2 fee-row rates match the V2 license definitions', () => {
    for (const t of ['free', 'starter', 'professional', 'business', 'enterprise'] as const) {
      const rowBps = getDefaultFeeConfig('event_registration', licenseTierToFeeTier(t, 2)).platformFeePercentBps
      expect(rowBps / 100).toBe(getEventLicenseDefinitionV2(t).transactionFeePercent)
    }
  })
})

describe('fee config completeness — no tier crashes', () => {
  it('every fee tier (incl. professional + business) resolves a config', () => {
    for (const t of ['free', 'starter', 'growth', 'pro', 'professional', 'business', 'enterprise'] as const) {
      expect(getDefaultFeeConfig('event_registration', t).platformFeePercentBps).toBeGreaterThanOrEqual(0)
    }
  })
  it('professional + business rows mirror pro (per V2 defs)', () => {
    const pro = getDefaultFeeConfig('event_registration', 'pro')
    expect(getDefaultFeeConfig('event_registration', 'professional')).toEqual(pro)
    expect(getDefaultFeeConfig('event_registration', 'business')).toEqual(pro)
  })
})
