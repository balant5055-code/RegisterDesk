// RD-PAYMENT-02 Phase 7 — the Event Builder fee-model normalization is gated by the pricing
// engine. OFF (production default): always organizer_absorbs (attendee_pays stays "Coming
// Soon"). ON: a valid Attendee-Pays selection is honoured and maps to customer_pays. Pure.

import { describe, it, expect } from 'vitest'
import { normalizeFeeModel, builderFeeModelToEngine } from '@/lib/events/builder/types'

describe('normalizeFeeModel — Phase 7 pricing-engine gate', () => {
  it('engine OFF (default): always organizer_absorbs, even for a stored attendee_pays', () => {
    expect(normalizeFeeModel('attendee_pays')).toBe('organizer_absorbs')          // default = off
    expect(normalizeFeeModel('attendee_pays', false)).toBe('organizer_absorbs')
    expect(normalizeFeeModel('organizer_absorbs', false)).toBe('organizer_absorbs')
    expect(normalizeFeeModel(undefined, false)).toBe('organizer_absorbs')
  })

  it('engine ON: honours a valid stored fee model', () => {
    expect(normalizeFeeModel('attendee_pays', true)).toBe('attendee_pays')
    expect(normalizeFeeModel('organizer_absorbs', true)).toBe('organizer_absorbs')
  })

  it('engine ON: unknown / legacy values still fall back to organizer_absorbs', () => {
    expect(normalizeFeeModel('garbage', true)).toBe('organizer_absorbs')
    expect(normalizeFeeModel(undefined, true)).toBe('organizer_absorbs')
    expect(normalizeFeeModel(null, true)).toBe('organizer_absorbs')
  })

  it('end-to-end mapping: attendee_pays maps to customer_pays only when the engine is on', () => {
    expect(builderFeeModelToEngine(normalizeFeeModel('attendee_pays', true))).toBe('customer_pays')
    expect(builderFeeModelToEngine(normalizeFeeModel('attendee_pays', false))).toBe('organizer_pays')
    expect(builderFeeModelToEngine(normalizeFeeModel('organizer_absorbs', true))).toBe('organizer_pays')
  })
})
