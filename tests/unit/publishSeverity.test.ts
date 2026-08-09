// RD-EVENT-20 — adding a severity/section taxonomy must not move a single event's
// publishability.
//
// The engine is isomorphic: `lib/events/validatePublish.ts` (the server publish gate) and
// the Review page both call `validatePublish()`. A change here that shifted `canPublish`
// would let an organizer through a gate the server rejects, or block one it would accept.
// These tests pin that it did not.

import { describe, it, expect } from 'vitest'
import {
  validatePublish, severityOf, sectionOf, buildSectionHealth, PUBLISH_SECTIONS,
  type PublishRequirement,
} from '@/lib/events/publishRequirements'

/** A draft with every mandatory requirement satisfied. */
const complete = {
  pricing: { eventType: 'paid', passes: [{ id: 'p1', name: 'Pass 1', price: 1500 }] },
  eventDetails: {
    name: 'City Marathon 2026',
    schedule: { startDate: '2026-09-01', startTime: '06:00', endDate: '2026-09-01', endTime: '12:00', timezone: 'Asia/Kolkata' },
    venue: { type: 'physical', name: 'Central Park', city: 'Bengaluru', address: 'MG Road' },
    organizer: { name: 'Profiling Events Co', email: 'organizer@example.com' },
  },
  registrationForm: { template: 'standard', fields: [{ id: 'f1', label: 'Name' }], sections: [{ id: 's1' }] },
}

const req = (over: Partial<PublishRequirement>): PublishRequirement => ({
  id: 'x', passed: true, title: 't', description: 'd', stepName: 'Event Details', stepIndex: 5, ...over,
})

describe('publishability is unchanged by the taxonomy', () => {
  // THE regression guard: this exact set gates publishing. RD-EVENT-24 added warning and
  // suggestion requirements; if any of these seven is ever downgraded, an event becomes
  // publishable that previously was not — and the server gate would still reject it.
  const GATING_IDS = [
    'event_title', 'event_schedule', 'event_venue', 'event_organizer',
    'pricing_model', 'passes', 'registration_form',
  ]

  it('the blocking set is EXACTLY the seven original requirements', () => {
    const s = validatePublish({ pricing: null, eventDetails: null, registrationForm: null })
    expect(s.canPublish).toBe(false)
    expect(s.blockers.map(b => b.id).sort()).toEqual([...GATING_IDS].sort())
  })

  it('warnings and suggestions exist and never gate', () => {
    const s = validatePublish({ pricing: null, eventDetails: null, registrationForm: null })
    expect(s.warnings.length).toBeGreaterThan(0)
    expect(s.suggestions.length).toBeGreaterThan(0)
    for (const b of [...s.warnings, ...s.suggestions]) expect(GATING_IDS).not.toContain(b.id)
  })

  it('blockers still equal the full failed set', () => {
    const s = validatePublish({ pricing: null, eventDetails: null, registrationForm: null })
    const failedCritical = s.requirements.filter(r => !r.passed && severityOf(r) === 'critical')
    expect(s.blockers.map(b => b.id).sort()).toEqual(failedCritical.map(r => r.id).sort())
  })

  it('canPublish is still exactly "no failed requirements"', () => {
    for (const input of [
      { pricing: null, eventDetails: null, registrationForm: null },
      complete,
      { ...complete, pricing: null },
      { ...complete, registrationForm: null },
    ]) {
      const s = validatePublish(input)
      expect(s.canPublish).toBe(s.requirements.every(r => r.passed))
    }
  })

  it('score and completedSections are untouched', () => {
    const s = validatePublish({ pricing: null, eventDetails: null, registrationForm: null })
    expect(s.score).toBe(Math.round((s.completedSections / s.requirements.length) * 100))
  })
})

describe('severity defaults preserve the previous behaviour', () => {
  it('a requirement with no declared severity is critical', () => {
    expect(severityOf(req({}))).toBe('critical')
  })

  it('every requirement declares a severity explicitly — none relies on the default', () => {
    const s = validatePublish({ pricing: null, eventDetails: null, registrationForm: null })
    for (const r of s.requirements) expect(r.severity, r.id).toBeDefined()
  })

  it('a warning would NOT block publishing — the taxonomy is live, just unused', () => {
    // Proves the wiring works without reclassifying anything shipped.
    const reqs = [req({ id: 'a', passed: false, severity: 'warning' })]
    const failed = reqs.filter(r => !r.passed)
    const criticals = failed.filter(r => severityOf(r) === 'critical')
    expect(criticals).toHaveLength(0)
  })
})

describe('the three tiers are never mixed', () => {
  it('a finding appears in exactly one bucket', () => {
    const s = validatePublish({ pricing: null, eventDetails: null, registrationForm: null })
    const ids = [...s.blockers, ...s.warnings, ...s.suggestions].map(b => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('a PASSED requirement never appears in any bucket', () => {
    // Asserted against the requirement list itself rather than a hand-built "complete"
    // draft — a fixture that merely looks complete proves nothing, as the RD-EVENT-19
    // seed demonstrated.
    for (const input of [complete, { pricing: null, eventDetails: null, registrationForm: null }]) {
      const s = validatePublish(input)
      const passedIds = new Set(s.requirements.filter(r => r.passed).map(r => r.id))
      const bucketed = [...s.blockers, ...s.warnings, ...s.suggestions].map(b => b.id)
      for (const id of bucketed) expect(passedIds.has(id)).toBe(false)
    }
  })
})

describe('section health', () => {
  it('covers all ten sections in presentation order', () => {
    const s = validatePublish(complete)
    expect(s.sections.map(x => x.section)).toEqual([...PUBLISH_SECTIONS])
  })

  it('a section with no requirements is complete, not failed', () => {
    const health = buildSectionHealth([])
    for (const h of health) {
      expect(h.status).toBe('complete')
      expect(h.score).toBe(100)
      expect(h.stepIndex).toBeNull()
    }
  })

  it('reports the worst unmet severity in a section', () => {
    const health = buildSectionHealth([
      req({ id: 'a', passed: false, severity: 'suggestion', stepName: 'Passes & Pricing', stepIndex: 3 }),
      req({ id: 'b', passed: false, severity: 'critical',   stepName: 'Passes & Pricing', stepIndex: 3 }),
    ])
    expect(health.find(h => h.section === 'Pricing')?.status).toBe('critical')
  })

  it('exposes a navigation target for the first unmet requirement', () => {
    const s = validatePublish({ pricing: null, eventDetails: null, registrationForm: null })
    const pricing = s.sections.find(h => h.section === 'Pricing')!
    expect(pricing.stepIndex).toBe(3)
    expect(pricing.stepName).toBe('Passes & Pricing')
  })

  it('section status agrees with its own requirements, for any draft', () => {
    for (const input of [complete, { pricing: null, eventDetails: null, registrationForm: null }]) {
      const s = validatePublish(input)
      for (const h of s.sections) {
        const mine = s.requirements.filter(r => sectionOf(r) === h.section)
        const allPassed = mine.every(r => r.passed)
        expect(h.status === 'complete', `${h.section}`).toBe(allPassed)
        expect(h.passed).toBe(mine.filter(r => r.passed).length)
        expect(h.total).toBe(mine.length)
      }
    }
  })
})

describe('section mapping is distinct from step mapping', () => {
  it('derives a section from stepName when none is declared', () => {
    expect(sectionOf(req({ stepName: 'Passes & Pricing' }))).toBe('Pricing')
    expect(sectionOf(req({ stepName: 'Registration Form' }))).toBe('Registration')
    expect(sectionOf(req({ stepName: 'Event Details' }))).toBe('Event Information')
  })

  it('an explicit section wins over the derivation', () => {
    expect(sectionOf(req({ stepName: 'Event Details', section: 'Media' }))).toBe('Media')
  })
})
