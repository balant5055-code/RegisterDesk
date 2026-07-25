// RD-GA-HARDEN-01 — pricing validation (validation.ts): summary invariants, platform
// settings ranges, admin/organizer override rules.

import { describe, it, expect } from 'vitest'
import {
  validatePricingSummary, validateAdminEventOverride, validateOrganizerEventOverride,
} from '@/lib/platform/pricing/validation'
import { buildPricingSummary } from '../fixtures/pricingSummary'

describe('validatePricingSummary', () => {
  it('accepts a well-formed summary', () => {
    expect(validatePricingSummary(buildPricingSummary())).toEqual({ ok: true })
  })

  it('rejects platformFeeTotal ≠ base + gst', () => {
    const s = buildPricingSummary()
    const bad = { ...s, platformFeeTotal: { paise: s.platformFee.paise + s.platformGst.paise + 1, rupees: 0 } }
    expect(validatePricingSummary(bad).ok).toBe(false)
  })

  it('rejects organizerReceives > ticketPrice and negative platformRevenue', () => {
    const s = buildPricingSummary()
    expect(validatePricingSummary({ ...s, organizerReceives: { paise: s.ticketPrice.paise + 1, rupees: 0 } }).ok).toBe(false)
    expect(validatePricingSummary({ ...s, platformRevenue: { paise: -1, rupees: -0.01 } }).ok).toBe(false)
  })

  it('rejects a rupees≠paise/100 money inconsistency', () => {
    const s = buildPricingSummary()
    expect(validatePricingSummary({ ...s, ticketPrice: { paise: 100000, rupees: 999 } }).ok).toBe(false)
  })
})

describe('validateAdminEventOverride', () => {
  it('accepts an empty and a valid override', () => {
    expect(validateAdminEventOverride({})).toEqual({ ok: true })
    expect(validateAdminEventOverride({ registrationLimit: 2000, platformFeeAmount: 5 })).toEqual({ ok: true })
    expect(validateAdminEventOverride({ registrationLimit: null })).toEqual({ ok: true }) // unlimited
  })
  it('rejects out-of-range values', () => {
    expect(validateAdminEventOverride({ platformFeeAmount: -1 }).ok).toBe(false)
    expect(validateAdminEventOverride({ gatewayPercent: 99 }).ok).toBe(false)       // > 10
    expect(validateAdminEventOverride({ platformGstPercent: 200 }).ok).toBe(false)  // > 100
  })
})

describe('validateOrganizerEventOverride — downward-only rule (Phase 8)', () => {
  it('allows a registration limit at or below the licensed max', () => {
    expect(validateOrganizerEventOverride({ registrationLimit: 500 }, 1000)).toEqual({ ok: true })
    expect(validateOrganizerEventOverride({ registrationLimit: 1000 }, 1000)).toEqual({ ok: true })
  })
  it('rejects a limit above the licensed max', () => {
    expect(validateOrganizerEventOverride({ registrationLimit: 2000 }, 1000).ok).toBe(false)
  })
  it('treats an unlimited license (Infinity) as any finite limit being downward', () => {
    expect(validateOrganizerEventOverride({ registrationLimit: 999999 }, Infinity)).toEqual({ ok: true })
  })
  it('rejects a non-integer / negative convenience fee', () => {
    expect(validateOrganizerEventOverride({ registrationLimit: 1.5 }, 1000).ok).toBe(false)
    expect(validateOrganizerEventOverride({ convenienceFee: -1 }, 1000).ok).toBe(false)
  })
})
