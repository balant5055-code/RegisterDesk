// RD-RT4.0 — the server-side half of registration validation.
//
// These exercise the shared utilities the API routes call, not the routes themselves:
// the routes are thin (auth → gate → load → validate → transact) and the rules they
// enforce all live in these functions. Testing here proves the rule; testing the route
// would mostly prove Firestore mocking.

import { describe, it, expect } from 'vitest'
import {
  sanitizeFormResponses, collectFormErrors, validateFormResponses,
} from '@/lib/registrations/validateFormResponses'
import { resolveServerEligibility, ageEligibilityError } from '@/lib/registrations/ageEligibility'
import type { FormSection } from '@/components/wizard/registrationFormConfig'

const field = (over: Partial<FormSection['fields'][number]> & { id: string; label: string }) => ({
  type: 'text', required: false, visible: true, placeholder: '', helperText: '',
  options: [], validation: {}, section: 's1', conditionalLogic: null, passVisibility: 'all',
  ...over,
}) as FormSection['fields'][number]

const sections: FormSection[] = [{
  id: 's1', title: 'Details', description: '', order: 0,
  fields: [
    field({ id: 'name',  label: 'Full Name', required: true }),
    field({ id: 'email', label: 'Email Address', type: 'email', required: true }),
    field({ id: 'dob',   label: 'Date of Birth', type: 'date', required: true }),
    field({ id: 'size',  label: 'T-Shirt Size', type: 'dropdown', options: ['S', 'M', 'L'] }),
  ],
}]

const valid = { name: 'Asha R', email: 'asha@example.com', dob: '1996-05-04', size: 'M' }

describe('sanitizeFormResponses — unknown-field injection', () => {
  it('drops keys that are not configured fields', () => {
    const out = sanitizeFormResponses(sections, {
      ...valid,
      isAdmin:      'true',          // privilege-shaped key
      amountPaise:  '0',             // price-shaped key
      __proto__:    'polluted',
    })
    expect(Object.keys(out).sort()).toEqual(['dob', 'email', 'name', 'size'])
    expect(out).not.toHaveProperty('isAdmin')
    expect(out).not.toHaveProperty('amountPaise')
  })

  it('keeps every configured field, including ones for other passes', () => {
    expect(sanitizeFormResponses(sections, valid)).toEqual(valid)
  })

  it('caps value length so a known field cannot write an oversized document', () => {
    const out = sanitizeFormResponses(sections, { ...valid, name: 'x'.repeat(20_000) })
    expect(out.name.length).toBe(5_000)
  })

  it('coerces non-string values instead of storing raw objects', () => {
    const out = sanitizeFormResponses(sections, { ...valid, size: 42 })
    expect(out.size).toBe('42')
  })

  it('tolerates a missing body', () => {
    expect(sanitizeFormResponses(sections, undefined)).toEqual({})
  })
})

describe('server form validation mirrors the client rules', () => {
  it('rejects a missing required field', () => {
    const errs = collectFormErrors(sections, [], 'p1', { ...valid, name: '' })
    expect(errs.some(e => e.fieldId === 'name')).toBe(true)
  })

  it('rejects a malformed email', () => {
    const errs = collectFormErrors(sections, [], 'p1', { ...valid, email: 'not-an-email' })
    expect(errs.some(e => e.fieldId === 'email')).toBe(true)
  })

  it('rejects a dropdown value that is not one of the configured options', () => {
    const errs = collectFormErrors(sections, [], 'p1', { ...valid, size: 'XXL' })
    expect(errs.some(e => e.fieldId === 'size')).toBe(true)
  })

  it('accepts a fully valid payload', () => {
    expect(collectFormErrors(sections, [], 'p1', valid)).toEqual([])
  })
})

describe('age eligibility is enforced server-side (RD-RT4.0)', () => {
  const form = { sections, conditionalRules: [] } as never

  it('rejects an under-age registration even though the browser was bypassed', () => {
    const err = validateFormResponses(form, 'p1', { ...valid, dob: '2015-01-01' }, {
      eventDate: '2026-03-01', minAge: 18, maxAge: null,
    })
    expect(err?.fieldId).toBe('dob')
    expect(err?.message).toContain('Minimum age for this pass is 18 years')
  })

  it('rejects an over-age registration', () => {
    const err = validateFormResponses(form, 'p1', { ...valid, dob: '1950-01-01' }, {
      eventDate: '2026-03-01', minAge: null, maxAge: 60,
    })
    expect(err?.fieldId).toBe('dob')
  })

  it('accepts an eligible registration', () => {
    expect(validateFormResponses(form, 'p1', valid, {
      eventDate: '2026-03-01', minAge: 18, maxAge: 60,
    })).toBeNull()
  })

  it('is skipped entirely when the pass has no limits — unchanged behaviour', () => {
    expect(validateFormResponses(form, 'p1', { ...valid, dob: '2015-01-01' }, {
      eventDate: '2026-03-01', minAge: null, maxAge: null,
    })).toBeNull()
  })

  it('uses the EVENT date, so a birthday after the event does not count', () => {
    // Turns 18 three days after the event → 17 on the day, therefore ineligible.
    expect(ageEligibilityError('2008-03-04', '2026-03-01', { minAge: 18, maxAge: null }))
      .toContain('Minimum age')
    expect(ageEligibilityError('2008-02-26', '2026-03-01', { minAge: 18, maxAge: null }))
      .toBeNull()
  })
})

describe('resolveServerEligibility — limits come from Firestore, never the client', () => {
  it('reads the start date and the pass age window', () => {
    expect(resolveServerEligibility(
      { schedule: { startDate: '2026-03-01' } },
      { raceDetails: { minAge: 12, maxAge: 17 } },
    )).toEqual({ eventDate: '2026-03-01', minAge: 12, maxAge: 17 })
  })

  it('yields null limits for a pass with no raceDetails', () => {
    expect(resolveServerEligibility({ schedule: { startDate: '2026-03-01' } }, { id: 'p1' }))
      .toEqual({ eventDate: '2026-03-01', minAge: null, maxAge: null })
  })

  it('yields a null event date when the organiser set none, so the rule is skipped', () => {
    expect(resolveServerEligibility({}, { raceDetails: { minAge: 18, maxAge: null } }))
      .toEqual({ eventDate: null, minAge: 18, maxAge: null })
  })

  it('ignores non-numeric age values rather than trusting them', () => {
    expect(resolveServerEligibility(
      { schedule: { startDate: '2026-03-01' } },
      { raceDetails: { minAge: '18', maxAge: {} } },
    )).toEqual({ eventDate: '2026-03-01', minAge: null, maxAge: null })
  })

  it('tolerates a missing event or pass entirely', () => {
    expect(resolveServerEligibility(null, null))
      .toEqual({ eventDate: null, minAge: null, maxAge: null })
  })
})
