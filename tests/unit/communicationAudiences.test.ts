// RD-PLATFORM-COMMS-02 Phase 5B — the pure audience normalizer/resolver: validates rule trees
// against the canonical field registry, counts leaves, derives health — never fabricates.

import { describe, it, expect } from 'vitest'
import { normalizeAudience, resolveAudience } from '@/lib/communications/audiences/normalize'
import type { AudienceRuleGroup } from '@/lib/communications/audiences/types'

const grp = (rules: AudienceRuleGroup['rules']): AudienceRuleGroup => ({ operator: 'and', rules })

describe('normalizeAudience', () => {
  it('returns null without a usable id + name', () => {
    expect(normalizeAudience({})).toBeNull()
    expect(normalizeAudience({ audienceId: 'a1' })).toBeNull()
  })
  it('coerces unknown enums to safe defaults and empty rules to a valid group', () => {
    const a = normalizeAudience({ id: 'a1', name: 'x', type: 'bogus', scope: 'bogus', status: 'bogus' })!
    expect(a.type).toBe('dynamic'); expect(a.scope).toBe('platform'); expect(a.status).toBe('draft')
    expect(a.rules.operator).toBe('and'); expect(a.rules.rules).toEqual([])
  })
})

describe('resolveAudience', () => {
  const base = (rules: AudienceRuleGroup, over = {}) => resolveAudience(normalizeAudience({ id: 'a', name: 'n', type: 'dynamic', rules, lastEvaluatedAt: '2026-01-01T00:00:00.000Z', ...over })!)

  it('validates a good rule tree and counts leaves', () => {
    const r = base(grp([
      { field: 'licenseTier', condition: 'equals', value: 'professional' },
      grp([{ field: 'walletBalancePaise', condition: 'greater_than', value: 1000 }]),
    ]))
    expect(r.ruleCount).toBe(2)
    expect(r.valid).toBe(true)
    expect(r.health).toBe('valid')
  })

  it('flags unknown fields', () => {
    const r = base(grp([{ field: 'bogusField', condition: 'equals', value: 'x' }]))
    expect(r.valid).toBe(false)
    expect(r.health).toBe('invalid')
    expect(r.warnings.some(w => w.code === 'unknown_field')).toBe(true)
  })

  it('flags a condition invalid for the field type', () => {
    const r = base(grp([{ field: 'emailVerified', condition: 'greater_than', value: 1 }]))  // boolean field
    expect(r.warnings.some(w => w.code === 'invalid_condition')).toBe(true)
    expect(r.valid).toBe(false)
  })

  it('flags a missing value (except exists/not_exists)', () => {
    const missing = base(grp([{ field: 'country', condition: 'equals' }]))
    expect(missing.warnings.some(w => w.code === 'missing_value')).toBe(true)
    const exists = base(grp([{ field: 'country', condition: 'exists' }]))
    expect(exists.valid).toBe(true)
  })

  it('warns when a dynamic audience has no rules and when never evaluated', () => {
    const r = resolveAudience(normalizeAudience({ id: 'a', name: 'n', type: 'dynamic', rules: grp([]) })!)
    expect(r.valid).toBe(false)
    expect(r.warnings.some(w => w.code === 'no_rules')).toBe(true)
    expect(r.warnings.some(w => w.code === 'never_evaluated')).toBe(true)
  })
})
