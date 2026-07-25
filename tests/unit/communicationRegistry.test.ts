// RD-PLATFORM-COMMS-01 Phase 4C — the registry is the canonical catalog: it must cover EVERY
// NotificationType exactly once (completeness + no duplicates), with valid metadata.

import { describe, it, expect } from 'vitest'
import { NotificationType } from '@/lib/notifications/catalog'
import {
  COMMUNICATION_REGISTRY, COMM_REGISTRY_CATEGORIES, getRegistryEntry,
} from '@/lib/communications/registry/catalog'

const allTypes = Object.values(NotificationType)

describe('Communication Registry — canonical completeness', () => {
  it('has exactly one entry per NotificationType (no missing)', () => {
    for (const t of allTypes) expect(getRegistryEntry(t), `missing registry entry: ${t}`).toBeDefined()
    expect(COMMUNICATION_REGISTRY.length).toBe(allTypes.length)
  })

  it('has no duplicate ids', () => {
    const ids = COMMUNICATION_REGISTRY.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every entry uses a known category', () => {
    for (const e of COMMUNICATION_REGISTRY) {
      expect(COMM_REGISTRY_CATEGORIES, `unknown category on ${e.id}`).toContain(e.category)
    }
  })

  it('every entry has non-empty display metadata + a future-rule key', () => {
    for (const e of COMMUNICATION_REGISTRY) {
      expect(e.displayName.length, e.id).toBeGreaterThan(0)
      expect(e.description.length, e.id).toBeGreaterThan(0)
      expect(e.trigger.length, e.id).toBeGreaterThan(0)
      expect(e.templateKey.length, e.id).toBeGreaterThan(0)
      expect(e.futureRuleKey.includes('.'), `${e.id} futureRuleKey should be namespaced`).toBe(true)
    }
  })
})
