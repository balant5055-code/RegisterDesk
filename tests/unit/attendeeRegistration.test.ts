// RD-ATTENDEE-03A — canonical attendee identity (C1), sales-window state (M2),
// and client/server validation parity (H3).

import { describe, it, expect } from 'vitest'
import { resolveAttendeeIdentity } from '@/lib/registrations/attendeeIdentity'
import type { IdentityField } from '@/lib/registrations/attendeeIdentity'
import { resolvePassSaleState } from '@/lib/registrations/salesWindow'
import { collectFormErrors, validateFormResponses } from '@/lib/registrations/validateFormResponses'
import type { FormField, FormSection, RegistrationFormDraft } from '@/components/wizard/registrationFormConfig'

// ── C1: attendee identity ─────────────────────────────────────────────────────
const idf = (id: string, type: IdentityField['type'], label: string): IdentityField => ({ id, type, label })

describe('resolveAttendeeIdentity (C1)', () => {
  it('picks the person name, email and phone by type + curated label', () => {
    const fields = [idf('a', 'text', 'Full Name'), idf('b', 'email', 'Email Address'), idf('c', 'mobile', 'Mobile Number')]
    const r = resolveAttendeeIdentity(fields, { a: 'Asha Rao', b: 'asha@example.com', c: '9876543210' })
    expect(r).toEqual({ name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' })
  })

  it('does NOT mistake a "Company Name" field for the attendee name', () => {
    // Company Name appears BEFORE Full Name — the old /name/i heuristic would pick it.
    const fields = [idf('co', 'text', 'Company Name'), idf('n', 'text', 'Full Name'), idf('e', 'email', 'Email')]
    const r = resolveAttendeeIdentity(fields, { co: 'Acme Corp', n: 'Asha Rao', e: 'asha@example.com' })
    expect(r.name).toBe('Asha Rao')
  })

  it('ignores "Emergency Contact Name" and empty name fields in favour of the real name', () => {
    const fields = [idf('em', 'text', 'Emergency Contact Name'), idf('n', 'text', 'Your Name'), idf('e', 'email', 'Email')]
    const r = resolveAttendeeIdentity(fields, { em: 'Mother', n: 'Asha', e: 'asha@example.com' })
    expect(r.name).toBe('Asha')
  })

  it('takes the FIRST email / mobile field when several exist', () => {
    const fields = [idf('e1', 'email', 'Email'), idf('e2', 'email', 'Confirm Email'), idf('p', 'mobile', 'Phone')]
    const r = resolveAttendeeIdentity(fields, { e1: 'first@x.com', e2: 'second@x.com', p: '12345' })
    expect(r.email).toBe('first@x.com')
  })

  it('omits phone when no mobile field has a value', () => {
    const r = resolveAttendeeIdentity([idf('n', 'text', 'Name'), idf('e', 'email', 'Email')], { n: 'A', e: 'a@x.com' })
    expect(r).toEqual({ name: 'A', email: 'a@x.com' })
  })
})

// ── M2: sales window ──────────────────────────────────────────────────────────
describe('resolvePassSaleState (M2)', () => {
  const today = '2026-07-24'
  it('scheduled before the start date', () => {
    expect(resolvePassSaleState({ salesStartDate: '2026-08-01' }, today)).toBe('scheduled')
  })
  it('ended after the end date', () => {
    expect(resolvePassSaleState({ salesEndDate: '2026-07-01' }, today)).toBe('ended')
  })
  it('open within the window (or with no dates)', () => {
    expect(resolvePassSaleState({ salesStartDate: '2026-07-01', salesEndDate: '2026-08-01' }, today)).toBe('open')
    expect(resolvePassSaleState({}, today)).toBe('open')
  })
  it('open on the exact boundary days (inclusive)', () => {
    expect(resolvePassSaleState({ salesStartDate: today }, today)).toBe('open')
    expect(resolvePassSaleState({ salesEndDate: today }, today)).toBe('open')
  })
})

// ── H3: client/server validation parity ──────────────────────────────────────
const field = (p: Partial<FormField>): FormField => ({
  id: 'f', label: 'Field', type: 'text', required: false, visible: true, placeholder: '',
  helperText: '', options: [], validation: {}, section: '', conditionalLogic: null, passVisibility: 'all', ...p,
})
const draft = (fields: FormField[]): RegistrationFormDraft => ({
  template: '', sections: [{ id: 's', title: '', description: '', order: 0, fields } as FormSection],
  fields, settings: {} as never, registrationRules: {} as never, conditionalRules: [],
})

describe('validation parity (H3)', () => {
  const fields = [
    field({ id: 'name', label: 'Full Name', type: 'text', required: true }),
    field({ id: 'email', label: 'Email', type: 'email', required: true }),
    field({ id: 'code', label: 'Code', type: 'text', validation: { minLength: 4 } }),
  ]

  it('collectFormErrors returns ALL errors; validateFormResponses returns the FIRST', () => {
    const responses = { name: '', email: 'not-an-email', code: 'ab' }
    const all = collectFormErrors(draft(fields).sections, [], 'p1', responses)
    expect(all.map(e => e.fieldId)).toEqual(['name', 'email', 'code'])   // required, email format, minLength
    const first = validateFormResponses(draft(fields), 'p1', responses)
    expect(first?.fieldId).toBe('name')
  })

  it('both agree there are no errors on a valid submission', () => {
    const responses = { name: 'Asha', email: 'asha@example.com', code: 'abcd' }
    expect(collectFormErrors(draft(fields).sections, [], 'p1', responses)).toHaveLength(0)
    expect(validateFormResponses(draft(fields), 'p1', responses)).toBeNull()
  })
})
