// RD-GA-HARDEN-01 — registration capacity math (lib/registrations/capacity.ts).
// The pure logic behind oversell prevention and the license→capacity mapping.

import { describe, it, expect } from 'vitest'
import {
  capacityPlanForRegistrationLimit, resolveTotalCapacity,
  deriveStoredEventCapacity, computePassAvailability,
} from '@/lib/registrations/capacity'
import type { CapacityPlan } from '@/lib/registrations/types'

describe('capacityPlanForRegistrationLimit — license limit → enforcing bucket', () => {
  it('maps the frozen license tiers exactly', () => {
    expect(capacityPlanForRegistrationLimit(100)).toBe('free')
    expect(capacityPlanForRegistrationLimit(1000)).toBe('pack_1000')
    expect(capacityPlanForRegistrationLimit(5000)).toBe('pack_5000')
    expect(capacityPlanForRegistrationLimit(Infinity)).toBe('unlimited')
  })
  it('rounds up to the smallest covering bucket', () => {
    expect(capacityPlanForRegistrationLimit(50)).toBe('free')
    expect(capacityPlanForRegistrationLimit(250)).toBe('pack_500')
    expect(capacityPlanForRegistrationLimit(9999)).toBe('unlimited')
  })
})

describe('resolveTotalCapacity (RD-GA-HOTFIX-01)', () => {
  it('returns the seat count for finite plans — UNCHANGED', () => {
    expect(resolveTotalCapacity('free')).toBe(100)
    expect(resolveTotalCapacity('pack_500')).toBe(500)
    expect(resolveTotalCapacity('pack_1000')).toBe(1000)
    expect(resolveTotalCapacity('pack_5000')).toBe(5000)
  })

  it('FIX: unlimited resolves to null (uncapped), not 100', () => {
    expect(resolveTotalCapacity('unlimited')).toBeNull()
  })

  it('falls back to the Free cap ONLY for an unknown/corrupt plan value', () => {
    expect(resolveTotalCapacity('legacy_bogus' as CapacityPlan)).toBe(100)
  })
})

describe('publish capacity chain: license limit → plan → stored capacity', () => {
  it('Enterprise (unlimited) publishes uncapped; all finite tiers unchanged', () => {
    const chain = (limit: number) => resolveTotalCapacity(capacityPlanForRegistrationLimit(limit))
    expect(chain(100)).toBe(100)        // free
    expect(chain(1000)).toBe(1000)      // pack_1000
    expect(chain(5000)).toBe(5000)      // pack_5000
    expect(chain(Infinity)).toBeNull()  // enterprise/unlimited → null (was wrongly 100)
  })
})

describe('deriveStoredEventCapacity — stamped vs legacy back-fill', () => {
  it('uses a stamped numeric capacity as-is', () => {
    expect(deriveStoredEventCapacity({ totalCapacity: 500 })).toBe(500)
  })
  it('treats explicit null as unlimited', () => {
    expect(deriveStoredEventCapacity({ totalCapacity: null })).toBeNull()
  })
  it('derives from capacityPlan when totalCapacity is absent', () => {
    expect(deriveStoredEventCapacity({ capacityPlan: 'pack_1000' })).toBe(1000)
  })
  it('legacy free event → 100, legacy paid → unlimited', () => {
    expect(deriveStoredEventCapacity({ pricing: { eventType: 'free' } })).toBe(100)
    expect(deriveStoredEventCapacity({ pricing: { eventType: 'paid' } })).toBeNull()
  })
})

describe('computePassAvailability — oversell prevention (remaining = min(pass, event))', () => {
  it('binds on the tighter of pass/event remaining', () => {
    const a = computePassAvailability({ passId: 'p', passCapacity: 100, passCount: 95, eventCapacity: 1000, eventTotalCount: 100 })
    expect(a.remaining).toBe(5)      // pass binds
    expect(a.status).toBe('low')      // <= 10
  })
  it('marks sold_out at zero remaining', () => {
    const a = computePassAvailability({ passId: 'p', passCapacity: 100, passCount: 100, eventCapacity: 1000, eventTotalCount: 100 })
    expect(a.remaining).toBe(0)
    expect(a.status).toBe('sold_out')
  })
  it('unlimited pass + unlimited event → truly unlimited', () => {
    const a = computePassAvailability({ passId: 'p', passCapacity: null, passCount: 500, eventCapacity: null, eventTotalCount: 9999 })
    expect(a.remaining).toBeNull()
    expect(a.status).toBe('available')
  })
  it('event capacity binds when the pass is unlimited', () => {
    const a = computePassAvailability({ passId: 'p', passCapacity: null, passCount: 0, eventCapacity: 50, eventTotalCount: 45 })
    expect(a.remaining).toBe(5)
    expect(a.status).toBe('low')
  })
})
