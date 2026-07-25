// RD-COMMS-01 Phase 2 — unit tests for the PURE communication read-model logic.
// Covers the capability SSOT, the channel state machine, status mapping, and the health +
// readiness builders. No server imports (env-free), so these run in the pure vitest env.

import { describe, it, expect } from 'vitest'
import {
  CHANNEL_CAPABILITIES,
  isChannelImplemented,
  computeChannelState,
  statusForState,
  rollupStatus,
  type ChannelSignals,
} from '@/lib/communications/health/channels'
import { buildChannelHealth, buildCommunicationReadiness } from '@/lib/communications/health/build'

const configured = (over: Partial<ChannelSignals> = {}): ChannelSignals => ({
  configured: true, platformEnabled: true, healthy: true, funded: null,
  templatesAvailable: true, ...over,
})

describe('channel capability SSOT', () => {
  it('marks only email and whatsapp as implemented', () => {
    expect(isChannelImplemented('email')).toBe(true)
    expect(isChannelImplemented('whatsapp')).toBe(true)
    expect(isChannelImplemented('sms')).toBe(false)
    expect(isChannelImplemented('push')).toBe(false)
  })
  it('labels email free and sms/push unavailable', () => {
    expect(CHANNEL_CAPABILITIES.email.billingLabel).toBe('Free')
    expect(CHANNEL_CAPABILITIES.whatsapp.paid).toBe(true)
    expect(CHANNEL_CAPABILITIES.sms.billingLabel).toBe('Unavailable')
    expect(CHANNEL_CAPABILITIES.push.billingLabel).toBe('Unavailable')
  })
})

describe('computeChannelState', () => {
  it('SMS/Push are always unavailable regardless of signals', () => {
    expect(computeChannelState('sms', configured({ platformEnabled: true }))).toBe('unavailable')
    expect(computeChannelState('push', configured())).toBe('unavailable')
  })
  it('implemented but unconfigured → available', () => {
    expect(computeChannelState('whatsapp', configured({ configured: false }))).toBe('available')
  })
  it('configured but platform-disabled → down', () => {
    expect(computeChannelState('email', configured({ platformEnabled: false }))).toBe('down')
  })
  it('paid channel with empty wallet → degraded', () => {
    expect(computeChannelState('whatsapp', configured({ funded: false }))).toBe('degraded')
  })
  it('free channel, configured + enabled → configured', () => {
    expect(computeChannelState('email', configured())).toBe('configured')
  })
  it('event-enabled with template → ready; event-off → configured', () => {
    expect(computeChannelState('whatsapp', configured({ funded: true, event: { enabled: true } }))).toBe('ready')
    expect(computeChannelState('whatsapp', configured({ funded: true, event: { enabled: false } }))).toBe('configured')
  })
  it('event-enabled without template → degraded (global fallback)', () => {
    expect(computeChannelState('whatsapp', configured({ funded: true, templatesAvailable: false, event: { enabled: true } }))).toBe('degraded')
  })
})

describe('statusForState', () => {
  it('maps states to traffic lights and flags enabled-but-unavailable as red', () => {
    expect(statusForState('ready', true)).toBe('green')
    expect(statusForState('configured', true)).toBe('green')
    expect(statusForState('degraded', true)).toBe('amber')
    expect(statusForState('down', true)).toBe('red')
    expect(statusForState('unavailable', true)).toBe('red')   // enabled an unavailable channel
    expect(statusForState('unavailable', false)).toBe('amber') // merely not offered
  })
})

describe('rollupStatus', () => {
  it('red beats amber beats green', () => {
    expect(rollupStatus(['green', 'amber', 'red'])).toBe('red')
    expect(rollupStatus(['green', 'amber'])).toBe('amber')
    expect(rollupStatus(['green', 'green'])).toBe('green')
  })
})

describe('buildChannelHealth', () => {
  it('SMS health is unavailable with red provider/templates dimensions (never green)', () => {
    const h = buildChannelHealth('sms', configured({ configured: false, templatesAvailable: false, event: { enabled: true } }))
    expect(h.implemented).toBe(false)
    expect(h.state).toBe('unavailable')
    expect(h.status).toBe('red')  // event-enabled + unavailable
    const provider = h.dimensions.find(d => d.dimension === 'provider')!
    expect(provider.status).toBe('red')
    // no dimension should claim green for an unavailable channel except (n/a) — verify none fake success
    expect(h.dimensions.some(d => d.status === 'green')).toBe(false)
  })
  it('email health is green when configured+enabled and free', () => {
    const h = buildChannelHealth('email', configured())
    expect(h.state).toBe('configured')
    expect(h.status).toBe('green')
    expect(h.dimensions.find(d => d.dimension === 'credits')!.status).toBe('green') // free
  })
  it('whatsapp with empty wallet is amber (degraded), credits flagged', () => {
    const h = buildChannelHealth('whatsapp', configured({ funded: false, event: { enabled: true } }))
    expect(h.state).toBe('degraded')
    expect(h.status).toBe('amber')
    expect(h.dimensions.find(d => d.dimension === 'credits')!.status).toBe('amber')
  })
})

describe('buildCommunicationReadiness', () => {
  it('SMS is never ready and reports a hard blocker', () => {
    const r = buildCommunicationReadiness({
      email: configured(), whatsapp: configured({ funded: true }), sms: configured({ configured: false }),
      certificateEnabled: true,
    })
    expect(r.sms.ready).toBe(false)
    expect(r.sms.blockers.length).toBeGreaterThan(0)
    expect(r.sms.state).toBe('unavailable')
  })
  it('email ready → overall ready; certificate inherits email + platform enable', () => {
    const r = buildCommunicationReadiness({
      email: configured({ event: { enabled: true } }),
      whatsapp: configured({ funded: true, event: { enabled: true } }),
      sms: configured({ configured: false }),
      certificateEnabled: true,
    })
    expect(r.email.ready).toBe(true)
    expect(r.overall.ready).toBe(true)
    expect(r.certificate.ready).toBe(true)
  })
  it('unconfigured email blocks overall readiness', () => {
    const r = buildCommunicationReadiness({
      email: configured({ configured: false }), whatsapp: configured(), sms: configured({ configured: false }),
      certificateEnabled: false,
    })
    expect(r.email.ready).toBe(false)
    expect(r.overall.ready).toBe(false)
    expect(r.certificate.ready).toBe(false) // certificates disabled
  })
  it('whatsapp low balance is a warning, not a hard blocker', () => {
    const r = buildCommunicationReadiness({
      email: configured(), whatsapp: configured({ funded: false, event: { enabled: true } }), sms: configured({ configured: false }),
      certificateEnabled: true,
    })
    expect(r.whatsapp.ready).toBe(false)
    expect(r.whatsapp.blockers.length).toBe(0)
    expect(r.whatsapp.warnings.length).toBeGreaterThan(0)
  })
})
