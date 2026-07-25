// RD-PLATFORM-COMMS-01 Phase 4E — every platform notification binds to a template, every
// template variable comes from the ONE canonical variable registry (no unknown variables),
// and no orphan bindings exist.

import { describe, it, expect } from 'vitest'
import { COMMUNICATION_REGISTRY, getRegistryEntry } from '@/lib/communications/registry/catalog'
import { isKnownVariable } from '@/lib/communications/templates/variables'
import {
  PLATFORM_TEMPLATE_VARS, isPlatformAudience, buildTemplatesForNotification, templateHealth,
} from '@/lib/communications/templates/registry'

describe('Platform Template Center', () => {
  it('every platform notification has a variable contract (no orphan notification)', () => {
    for (const e of COMMUNICATION_REGISTRY) {
      if (isPlatformAudience(e.audience)) {
        expect(PLATFORM_TEMPLATE_VARS[e.id], `platform notification missing template vars: ${e.id}`).toBeDefined()
      }
    }
  })

  it('every template variable exists in the canonical registry (no unknown variables)', () => {
    for (const ids of Object.values(PLATFORM_TEMPLATE_VARS)) {
      for (const id of ids ?? []) expect(isKnownVariable(id), `unknown variable: ${id}`).toBe(true)
    }
  })

  it('no template-var mapping references a non-platform / unknown notification (no orphan template)', () => {
    for (const id of Object.keys(PLATFORM_TEMPLATE_VARS)) {
      const e = getRegistryEntry(id as keyof typeof PLATFORM_TEMPLATE_VARS)
      expect(e, `orphan template mapping: ${id}`).toBeDefined()
      expect(isPlatformAudience(e!.audience), `non-platform template mapping: ${id}`).toBe(true)
    }
  })

  it('builds an email binding for a platform notification and reports healthy', () => {
    const lic = getRegistryEntry('LICENSE_PURCHASED')!
    const ts = buildTemplatesForNotification(lic, { email: true, whatsapp: true, inapp: true })
    expect(ts.length).toBe(3)                       // email + whatsapp + inapp
    expect(ts.find(t => t.channel === 'email')!.templateId).toBe('LICENSE_PURCHASED.email')
    expect(templateHealth(ts[0]).healthy).toBe(true)
  })

  it('returns no templates for a participant-facing notification (out of scope)', () => {
    const reg = getRegistryEntry('REGISTRATION_CONFIRMATION')!   // audience: attendee
    expect(buildTemplatesForNotification(reg, { email: true, whatsapp: false, inapp: false })).toEqual([])
  })
})
