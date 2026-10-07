// RD-LICENSE-GA-02 — write-layer version-awareness. The purchase SERVICE is pure, so we
// test it directly: at CURRENT_LICENSE_VERSION=1 it is byte-for-byte V1 behavior, validates
// against the current version, and ranks upgrades cross-version by registration limit.

import { describe, it, expect } from 'vitest'
import { EventLicenseService } from '@/lib/licensing/service'
import {
  defaultLicenseTierForVersion, CURRENT_LICENSE_VERSION, getEventLicenseDefinitionV2,
} from '@/lib/licensing/eventLicense'

const svc = new EventLicenseService({} as never)   // purchase/upgrade methods are pure (no repo I/O)

describe('defaultLicenseTierForVersion — version-appropriate free tier', () => {
  it('version 1 → starter, version 2 → free', () => {
    expect(defaultLicenseTierForVersion(1)).toBe('starter')
    expect(defaultLicenseTierForVersion(2)).toBe('free')
  })
})

describe('CURRENT_LICENSE_VERSION is 2 (GA-04 cutover complete)', () => {
  it('is 2 — new licenses are Licensing V2', () => { expect(CURRENT_LICENSE_VERSION).toBe(2) })
})

describe('purchase service — resolves against the CURRENT version (V2)', () => {
  const ctx = { eventExists: true, currentTier: null }

  it('validates a V2 tier and prices it from the V2 catalog', () => {
    const r = svc.purchaseLicense({ eventId: 'e', organizerUid: 'u', tier: 'professional', method: 'razorpay' }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.receipt.amountPaise).toBe(getEventLicenseDefinitionV2('professional').offerPricePaise)   // ₹1,499
  })

  it('prices Business from the V2 catalog (offer price)', () => {
    const r = svc.purchaseLicense({ eventId: 'e', organizerUid: 'u', tier: 'business', method: 'razorpay' }, ctx)
    expect(r.ok && r.receipt.amountPaise).toBe(getEventLicenseDefinitionV2('business').offerPricePaise)   // ₹2,499
  })

  it('an admin-supplied effective price overrides the catalog default', () => {
    const r = svc.purchaseLicense({ eventId: 'e', organizerUid: 'u', tier: 'business', method: 'razorpay' }, { ...ctx, pricePaise: 123456 })
    expect(r.ok && r.receipt.amountPaise).toBe(123456)
  })

  it('rejects a V1-only tier ("growth") now that the current version is V2', () => {
    const r = svc.purchaseLicense({ eventId: 'e', organizerUid: 'u', tier: 'growth', method: 'razorpay' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failureReason).toBe('invalid_tier')
  })
})

// RD-EVENT-COMMERCE-04 — the tier UPGRADE preparation (pay-the-difference between tiers) had no
// caller and priced a retired commercial model; it was removed. Guard: it must not come back.
describe('tier upgrade path is retired', () => {
  it('the service exposes no upgrade / upgrade-price method', () => {
    const proto = EventLicenseService.prototype as unknown as Record<string, unknown>
    expect(proto.upgradeLicense).toBeUndefined()
    expect(proto.calculateUpgradePrice).toBeUndefined()
    expect(proto.validateUpgrade).toBeUndefined()
  })
})
