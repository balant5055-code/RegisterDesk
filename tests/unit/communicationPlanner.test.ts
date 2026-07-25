// RD-PLATFORM-COMMS-02 Phase 5E — the pure planner projections: honest channel support, batch
// math, cost estimation, and validation. Deterministic; never fabricates numbers.

import { describe, it, expect } from 'vitest'
import { projectChannels, projectBatches, projectCost, buildPlanValidation } from '@/lib/communications/planner/project'
import { PLAN_BATCH_SIZE } from '@/lib/communications/planner/types'

describe('projectChannels', () => {
  it('marks SMS/Push unsupported (unavailable) and honors notification support', () => {
    const p = projectChannels({ email: true, whatsapp: true, inapp: false })
    const byId = Object.fromEntries(p.map(c => [c.channel, c.supported]))
    expect(byId.email).toBe(true); expect(byId.whatsapp).toBe(true); expect(byId.inapp).toBe(false)
    expect(byId.sms).toBe(false); expect(byId.push).toBe(false)
    expect(p.find(c => c.channel === 'sms')!.reason).toContain('unavailable')
  })
})

describe('projectBatches', () => {
  it('returns nulls when recipients are unknown', () => {
    expect(projectBatches(null, 2)).toEqual({ messages: null, batches: null })
  })
  it('computes messages = recipients × channels and ceil batches', () => {
    const { messages, batches } = projectBatches(1200, 2)   // 2400 messages
    expect(messages).toBe(2400)
    expect(batches).toBe(Math.ceil(2400 / PLAN_BATCH_SIZE))
  })
})

describe('projectCost', () => {
  it('is null when recipients unknown; free channels contribute 0', () => {
    expect(projectCost(null, [{ channel: 'email', paid: false, pricePaise: 0 }])).toBeNull()
    expect(projectCost(100, [{ channel: 'email', paid: false, pricePaise: 0 }, { channel: 'whatsapp', paid: true, pricePaise: 50 }])).toBe(5000)
  })
})

describe('buildPlanValidation', () => {
  const base = {
    campaignFound: true, approved: true, audience: { valid: true, evaluated: true },
    hasTemplate: true, unknownVariables: [] as string[], policyResolved: true, usedProvidersReady: true, walletSufficient: null,
  }
  it('passes a fully-ready plan (wallet null = not-applicable is ok)', () => {
    const v = buildPlanValidation(base)
    expect(v.every(x => x.ok)).toBe(true)
  })
  it('flags not-approved, missing template, and unknown variables', () => {
    expect(buildPlanValidation({ ...base, approved: false }).find(x => x.check === 'approval')!.ok).toBe(false)
    expect(buildPlanValidation({ ...base, hasTemplate: false }).find(x => x.check === 'templates')!.ok).toBe(false)
    expect(buildPlanValidation({ ...base, unknownVariables: ['Bogus'] }).find(x => x.check === 'variables')!.ok).toBe(false)
  })
  it('flags insufficient wallet only when explicitly false', () => {
    expect(buildPlanValidation({ ...base, walletSufficient: false }).find(x => x.check === 'wallet')!.ok).toBe(false)
    expect(buildPlanValidation({ ...base, walletSufficient: true }).find(x => x.check === 'wallet')!.ok).toBe(true)
  })
})
