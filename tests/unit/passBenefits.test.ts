import { describe, it, expect } from 'vitest'
import { rankPassBenefits, benefitCoverage } from '@/components/event-templates/shared/registration/passBenefits'
import type { PassPublic } from '@/components/event-templates/types'

// Minimal pass factory — only the fields the ranking model reads.
function pass(id: string, benefits: string[], status: 'active' | 'inactive' = 'active'): PassPublic {
  return {
    id, name: id, description: '', price: 0, quantity: null, unlimited: true,
    status, benefits,
  } as PassPublic
}

describe('rankPassBenefits', () => {
  it('ranks by how many passes offer each benefit (the ST5.2 worked example)', () => {
    const passes = [
      pass('A', ['Chip Timing', 'Hydration', 'Certificate']),
      pass('B', ['Hydration', 'Medical', 'Certificate']),
      pass('C', ['Certificate', 'Hydration', 'Finisher Medal']),
    ]
    expect(rankPassBenefits(passes).map(b => b.label)).toEqual([
      'Hydration',      // 3
      'Certificate',    // 3
      'Chip Timing',    // 1, first seen
      'Medical',        // 1
      'Finisher Medal', // 1
    ])
  })

  it('de-duplicates case- and whitespace-insensitively, keeping the first spelling', () => {
    const out = rankPassBenefits([
      pass('A', ['Chip Timing']),
      pass('B', ['  chip timing  ']),
      pass('C', ['CHIP TIMING']),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ label: 'Chip Timing', count: 3, total: 3 })
  })

  it('counts a benefit once per pass even if that pass lists it twice', () => {
    const out = rankPassBenefits([pass('A', ['Medal', 'medal', 'MEDAL'])])
    expect(out[0].count).toBe(1)
  })

  it('ignores inactive passes and blank labels', () => {
    const out = rankPassBenefits([
      pass('A', ['Hydration', '', '   ']),
      pass('B', ['Hydration'], 'inactive'),
    ])
    expect(out).toEqual([{ label: 'Hydration', count: 1, total: 1 }])
  })

  it('returns an empty list when no benefits exist, so the strip can hide', () => {
    expect(rankPassBenefits([pass('A', []), pass('B', [])])).toEqual([])
    expect(rankPassBenefits([])).toEqual([])
  })

  it('caps the result at the requested limit', () => {
    const many = pass('A', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(rankPassBenefits([many])).toHaveLength(5)
    expect(rankPassBenefits([many], 3)).toHaveLength(3)
  })

  it('is stable — equal counts keep first-appearance order across calls', () => {
    const passes = [pass('A', ['x', 'y', 'z'])]
    expect(rankPassBenefits(passes)).toEqual(rankPassBenefits(passes))
  })
})

describe('benefitCoverage', () => {
  it('states full coverage without inventing a number', () => {
    expect(benefitCoverage({ label: 'Medal', count: 3, total: 3 })).toBe('Included with every entry')
  })
  it('states partial coverage exactly', () => {
    expect(benefitCoverage({ label: 'Medal', count: 2, total: 3 })).toBe('Included with 2 of 3 entries')
  })
  it('avoids "1 of 1" phrasing for single-pass events', () => {
    expect(benefitCoverage({ label: 'Medal', count: 1, total: 1 })).toBe('Included with your entry')
  })
})
