// RD-PAYMENT-02 Phase 1 — canonical fee-model resolution + builder→engine mapping.
// resolveEffectiveFeeModel lives in resolveFeeConfig.ts (reusing FeeResolutionContext),
// whose module chain touches adminDb — stubbed per the repo's per-file pattern.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import { resolveEffectiveFeeModel, DEFAULT_FEE_MODEL } from '@/lib/fees/resolveFeeConfig'
import { builderFeeModelToEngine } from '@/lib/events/builder/types'

describe('resolveEffectiveFeeModel — Event → Organizer → Platform → default', () => {
  it('defaults to organizer_pays when no candidate is supplied (today’s universal case)', () => {
    expect(resolveEffectiveFeeModel()).toBe('organizer_pays')
    expect(resolveEffectiveFeeModel({})).toBe('organizer_pays')
    expect(DEFAULT_FEE_MODEL).toBe('organizer_pays')
  })

  it('event level wins over organizer and platform', () => {
    expect(resolveEffectiveFeeModel({
      eventFeeModel: 'customer_pays', organizerFeeModel: 'organizer_pays', platformFeeModel: 'organizer_pays',
    })).toBe('customer_pays')
  })

  it('falls through nullish event → organizer → platform in order', () => {
    expect(resolveEffectiveFeeModel({ eventFeeModel: null, organizerFeeModel: 'customer_pays' })).toBe('customer_pays')
    expect(resolveEffectiveFeeModel({ eventFeeModel: null, organizerFeeModel: null, platformFeeModel: 'customer_pays' })).toBe('customer_pays')
    expect(resolveEffectiveFeeModel({ eventFeeModel: null, organizerFeeModel: null, platformFeeModel: null })).toBe('organizer_pays')
  })
})

describe('builderFeeModelToEngine — canonical builder→engine mapping', () => {
  it('organizer_absorbs → organizer_pays, attendee_pays → customer_pays', () => {
    expect(builderFeeModelToEngine('organizer_absorbs')).toBe('organizer_pays')
    expect(builderFeeModelToEngine('attendee_pays')).toBe('customer_pays')
  })
})
