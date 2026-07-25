// RD-COMMS-01 Phase 3 — unit tests for the canonical Communication Configuration Resolver.
// Verifies the Platform < Organizer < Event precedence, deep (nested) merge, the invalid-
// override fallback, and the zero-override fast path (backward compatibility).

import { describe, it, expect } from 'vitest'
import { resolveCommunicationConfiguration, type CommunicationConfigOverride } from '@/lib/communications/config/resolver'
import { BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'

const platform = BUSINESS_CONFIG_DEFAULTS.communication

describe('resolveCommunicationConfiguration', () => {
  it('returns the platform config unchanged when there are no overrides (fast path)', () => {
    const r = resolveCommunicationConfiguration(platform)
    expect(r).toBe(platform)  // identity — no clone, no merge (today's behavior)
  })

  it('returns platform when override layers are empty objects', () => {
    expect(resolveCommunicationConfiguration(platform, {}, {})).toBe(platform)
  })

  it('applies an organizer override without touching unspecified fields (deep merge)', () => {
    const organizer: CommunicationConfigOverride = { email: { fromName: 'Acme Events' } }
    const r = resolveCommunicationConfiguration(platform, organizer)
    expect(r.email.fromName).toBe('Acme Events')
    expect(r.email.enabled).toBe(platform.email.enabled)          // untouched sibling
    expect(r.whatsapp.pricePaise).toBe(platform.whatsapp.pricePaise) // untouched channel
  })

  it('event override wins over organizer over platform (precedence)', () => {
    const organizer: CommunicationConfigOverride = { email: { replyTo: 'org@x.com', fromName: 'Org' } }
    const event:     CommunicationConfigOverride = { email: { replyTo: 'event@x.com' } }
    const r = resolveCommunicationConfiguration(platform, organizer, event)
    expect(r.email.replyTo).toBe('event@x.com')  // event wins
    expect(r.email.fromName).toBe('Org')          // organizer-only field survives
  })

  it('does not mutate the platform config object', () => {
    const before = platform.email.fromName
    resolveCommunicationConfiguration(platform, { email: { fromName: 'Mutated?' } })
    expect(platform.email.fromName).toBe(before)
  })

  it('skips an override that would produce an invalid config (falls back to prior layer)', () => {
    // pricePaise must be a number ≥ 0; a negative value is invalid → override skipped.
    const bad: CommunicationConfigOverride = { whatsapp: { pricePaise: -5 } as never }
    const r = resolveCommunicationConfiguration(platform, bad)
    expect(r.whatsapp.pricePaise).toBe(platform.whatsapp.pricePaise) // unchanged (invalid skipped)
  })
})
