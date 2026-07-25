// RD-PLATFORM-COMMS-02 Phase 5C — the pure composer validation: composite readiness verdict
// over the resolved parts. Never fabricates; flags every missing piece.

import { describe, it, expect } from 'vitest'
import { buildComposerValidation, isDraftReady, type ComposerValidationInput } from '@/lib/communications/composer/validate'

const ok = (over: Partial<ComposerValidationInput> = {}): ComposerValidationInput => ({
  campaignName: 'July maintenance', campaignType: 'maintenance', campaignCategory: 'operations',
  notificationFound: true, audience: { valid: true, health: 'valid' }, template: { bound: true },
  channelSupported: true, variables: [{ id: 'OrganizerName', token: '{{OrganizerName}}', label: 'x', sample: 'y', known: true }],
  policyResolved: true, ...over,
})

describe('buildComposerValidation', () => {
  it('a fully assembled draft passes every check', () => {
    const v = buildComposerValidation(ok())
    expect(isDraftReady(v)).toBe(true)
    expect(v.map(x => x.check).sort()).toEqual(['audience', 'campaign', 'channel', 'notification', 'policy', 'template', 'variables'])
  })

  it('flags a missing audience', () => {
    const v = buildComposerValidation(ok({ audience: null }))
    expect(v.find(x => x.check === 'audience')!.ok).toBe(false)
    expect(isDraftReady(v)).toBe(false)
  })

  it('flags an unknown campaign type/category', () => {
    expect(buildComposerValidation(ok({ campaignType: 'bogus' })).find(x => x.check === 'campaign')!.ok).toBe(false)
    expect(buildComposerValidation(ok({ campaignName: '' })).find(x => x.check === 'campaign')!.ok).toBe(false)
  })

  it('flags a missing/unbound template and unsupported channel', () => {
    expect(buildComposerValidation(ok({ template: null })).find(x => x.check === 'template')!.ok).toBe(false)
    expect(buildComposerValidation(ok({ template: { bound: false } })).find(x => x.check === 'template')!.ok).toBe(false)
    expect(buildComposerValidation(ok({ channelSupported: false })).find(x => x.check === 'channel')!.ok).toBe(false)
  })

  it('flags unknown variables', () => {
    const v = buildComposerValidation(ok({ variables: [{ id: 'Bogus', token: '{{Bogus}}', label: 'x', sample: '', known: false }] }))
    expect(v.find(x => x.check === 'variables')!.ok).toBe(false)
    expect(v.find(x => x.check === 'variables')!.detail).toContain('Bogus')
  })

  it('flags an invalid (not valid) audience', () => {
    const v = buildComposerValidation(ok({ audience: { valid: false, health: 'invalid' } }))
    expect(v.find(x => x.check === 'audience')!.ok).toBe(false)
  })
})
