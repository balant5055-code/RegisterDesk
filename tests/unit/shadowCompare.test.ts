// RD-GA-HARDEN-01 — shadow comparison (shadowCompare.ts): the equivalence proof that
// the reconciled engine reproduces production under the default commercial model.

import { describe, it, expect } from 'vitest'
import { compareFeeComputation } from '@/lib/platform/pricing/shadowCompare'
import { DEFAULT_COMMERCIAL_MODEL } from '@/lib/platform/pricing/commercial'
import { feeConfigFor, ALL_PLAN_TIERS } from '../fixtures/feeConfig'

const GROSSES = [0, 100, 4900, 5000, 50000, 100000, 149900, 999999, 100_000_00]

describe('compareFeeComputation — full matrix equivalence (default)', () => {
  it('matches production across every tier × amount (720-field parity)', () => {
    let compared = 0
    for (const tier of ALL_PLAN_TIERS) {
      for (const gross of GROSSES) {
        const r = compareFeeComputation(gross, feeConfigFor(tier), DEFAULT_COMMERCIAL_MODEL)
        expect(r.comparedAs).toBe('organizer_pays')
        expect(r.match, `mismatch ${tier}/${gross}: ${JSON.stringify(r.differences)}`).toBe(true)
        expect(r.differences).toHaveLength(0)
        compared++
      }
    }
    expect(compared).toBe(ALL_PLAN_TIERS.length * GROSSES.length)
  })
})

describe('compareFeeComputation — divergence handling', () => {
  it('non-production commercial model reports comparedAs=null and no match', () => {
    const r = compareFeeComputation(100000, feeConfigFor('starter'), { ...DEFAULT_COMMERCIAL_MODEL, gatewayGstEnabled: true })
    expect(r.comparedAs).toBeNull()
    expect(r.match).toBe(false)
  })
})
