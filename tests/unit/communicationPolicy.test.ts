// RD-PLATFORM-COMMS-01 Phase 4D — the policy resolver must produce a valid, non-duplicated
// policy for every registry entry, deriving (not re-declaring) priority/mandatory/support.

import { describe, it, expect } from 'vitest'
import { COMMUNICATION_REGISTRY, getRegistryEntry } from '@/lib/communications/registry/catalog'
import { resolveNotificationPolicy, type ChannelSupport } from '@/lib/communications/policy/resolve'

const supports: ChannelSupport = { email: true, whatsapp: false, inapp: false, sms: false, push: false }

describe('Notification Policy resolver', () => {
  it('resolves a policy for every registry entry', () => {
    for (const e of COMMUNICATION_REGISTRY) {
      const p = resolveNotificationPolicy(e, supports)
      expect(p.notificationId).toBe(e.id)
      expect(['critical', 'high', 'medium', 'low', 'informational']).toContain(p.priority)
      expect(['immediate', 'scheduled', 'manual', 'digest', 'disabled']).toContain(p.deliveryMode)
      expect(['never', 'retry_1', 'retry_3', 'retry_5', 'unlimited']).toContain(p.retryPolicy)
    }
  })

  it('derives mandatory + visibility from the registry (no duplication)', () => {
    for (const e of COMMUNICATION_REGISTRY) {
      const p = resolveNotificationPolicy(e, supports)
      expect(p.mandatory).toBe(e.mandatory)     // taken from registry, not re-declared
      expect(p.visibility).toBe(e.audience)      // taken from registry
      expect(p.allowDisable).toBe(!e.mandatory)  // derived from mandatory
    }
  })

  it('security is critical + escalates to the security team', () => {
    const otp = getRegistryEntry('EMAIL_VERIFICATION')!
    const p = resolveNotificationPolicy(otp, supports)
    expect(p.priority).toBe('critical')
    expect(p.escalation).toBe('security_team')
    expect(p.allowDisable).toBe(false)
  })

  it('marketing is informational, manual delivery, batch + campaign-ready', () => {
    const bc = getRegistryEntry('BROADCAST')!
    const p = resolveNotificationPolicy(bc, supports)
    expect(p.priority).toBe('informational')
    expect(p.deliveryMode).toBe('manual')
    expect(p.supportsBatch).toBe(true)
    expect(p.futureCampaign).toBe(true)
    expect(p.retryPolicy).toBe('never')
  })

  it('channel support mirrors the resolved registry support', () => {
    const e = getRegistryEntry('LICENSE_PURCHASED')!
    const p = resolveNotificationPolicy(e, { email: true, whatsapp: true, inapp: true, sms: false, push: false })
    expect(p.supportsWhatsApp).toBe(true)
    expect(p.supportsInApp).toBe(true)
    expect(p.supportsSMS).toBe(false)
  })
})
