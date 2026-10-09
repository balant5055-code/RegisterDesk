// RD-IMPORT-ROWNUM-01 · RD-IMPORT-DUP-02 · RD-IMPORT-AGE-01 · RD-IMPORT-EMAIL-01 — the pure rules.
// The same behaviour through the real routes + Firestore: tests/emulator/registrationImportRules.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { validateImportRows, sanitizeRowNumbers, type ImportValidationContext } from '@/lib/registrations/importValidation'
import { numberImportRows } from '@/lib/registrations/importTemplate'

const HEADERS = ['Full Name *', 'Email *', 'Phone', 'Pass *', 'Date of Birth']
const row = (name: string, email: string, phone = '', pass = 'Standard', dob = '') =>
  ({ 'Full Name *': name, 'Email *': email, 'Phone': phone, 'Pass *': pass, 'Date of Birth': dob })
const field = (id: string, label: string, type: string) => ({
  id, label, type, required: false, visible: true, placeholder: '', helperText: '', options: [], validation: {},
  section: 's', conditionalLogic: null, passVisibility: 'all',
})

function ctx(over: Partial<ImportValidationContext> = {}): ImportValidationContext {
  return {
    form: { sections: [{ id: 's', title: 'S', order: 0, fields: [field('f_dob', 'Date of Birth', 'date')] }], conditionalRules: [] } as unknown as ImportValidationContext['form'],
    passIdByName: new Map([['standard', 'p1'], ['adult', 'p2']]),
    passBlockedReason: new Map(), eventCapacity: null, eventCount: 0,
    passCapacity: new Map([['p1', null], ['p2', null]]), passCount: new Map(),
    duplicatePolicy: 'block', approvalMode: 'auto',
    existingEmailClaims: new Set(), existingPhoneClaims: new Set(),
    ...over,
  }
}

describe('row numbers are the real spreadsheet rows', () => {
  it('numberImportRows keeps interior and leading blank rows in the count (header = row 1)', () => {
    const data = [HEADERS, [null, null], ['A', 'a@x.io'], ['', '  '], [null], ['B', 'b@x.io']]
    const { rows, rowNumbers } = numberImportRows(data, HEADERS)
    expect(rowNumbers).toEqual([3, 6])
    expect(rows.map(r => r['Full Name *'])).toEqual(['A', 'B'])
  })

  it('validateImportRows reports the supplied row numbers and the array index separately', () => {
    const v = validateImportRows([row('A', 'a@x.io'), row('B', 'bad')], HEADERS, ctx(), [3, 9])
    expect(v.validatedRows.map(r => [r.rowNumber, r.index, r.status])).toEqual([[3, 0, 'READY'], [9, 1, 'ERROR']])
  })

  it('a missing or malformed list falls back to index + 2 (old clients keep working)', () => {
    for (const bad of [undefined, null, [3], [3, 3], [1, 2], [2.5, 3], ['2', '3'], [5, 4], 'x']) {
      expect(sanitizeRowNumbers(bad, 2)).toBeNull()
      expect(validateImportRows([row('A', 'a@x.io'), row('B', 'b@x.io')], HEADERS, ctx(), bad).validatedRows.map(r => r.rowNumber)).toEqual([2, 3])
    }
    expect(sanitizeRowNumbers([2, 5], 2)).toEqual([2, 5])
  })

  it('capacity is consumed by array position, not by row number', () => {
    const v = validateImportRows([row('A', 'a@x.io'), row('B', 'b@x.io')], HEADERS,
      ctx({ eventCapacity: 1 }), [10, 40])
    expect(v.validatedRows.map(r => r.status)).toEqual(['READY', 'ERROR'])
    expect(v.validatedRows[1].reasons).toContain('Event is at capacity')
  })
})

describe('mobile-number duplicate limit', () => {
  const rows = [row('One', 'one@x.io', '+919876500001'), row('Two', 'two@x.io', '+919876500001')]
  it('limit OFF (or absent): a shared phone alone never makes a duplicate — in the file or against claims', () => {
    for (const c of [ctx(), ctx({ limitPerMobile: false, existingPhoneClaims: new Set(['+919876500001']) })]) {
      expect(validateImportRows(rows, HEADERS, c).validatedRows.map(r => r.status)).toEqual(['READY', 'READY'])
    }
  })
  it('limit ON: the shared phone is a duplicate (policy block), a warning (policy warn), nothing (policy allow)', () => {
    expect(validateImportRows(rows, HEADERS, ctx({ limitPerMobile: true })).validatedRows.map(r => r.status)).toEqual(['READY', 'DUPLICATE'])
    expect(validateImportRows(rows, HEADERS, ctx({ limitPerMobile: true, duplicatePolicy: 'warn' })).validatedRows.map(r => r.status)).toEqual(['READY', 'WARNING'])
    expect(validateImportRows(rows, HEADERS, ctx({ limitPerMobile: true, duplicatePolicy: 'allow' })).validatedRows.map(r => r.status)).toEqual(['READY', 'READY'])
    expect(validateImportRows([rows[0]], HEADERS, ctx({ limitPerMobile: true, existingPhoneClaims: new Set(['+919876500001']) })).validatedRows[0].status).toBe('DUPLICATE')
  })
  it('the EMAIL duplicate rule is unchanged with the mobile limit off', () => {
    const v = validateImportRows([row('A', 'same@x.io', '+919876500001'), row('B', 'SAME@x.io', '+919876500002')], HEADERS, ctx())
    expect(v.validatedRows.map(r => r.status)).toEqual(['READY', 'DUPLICATE'])
  })
})

describe('age eligibility — organizer override with a warning', () => {
  const age = ctx({ eventDate: '2026-12-01', passAgeLimits: new Map([['p2', { minAge: 18, maxAge: 60 }]]) })
  it('outside the window ⇒ WARNING (still imported), with the age and the window', () => {
    const v = validateImportRows([row('Kid', 'k@x.io', '', 'Adult', '2015-01-01')], HEADERS, age)
    expect(v.validatedRows[0].status).toBe('WARNING')
    expect(v.validatedRows[0].resultStatus).toBe('confirmed')
    expect(v.validatedRows[0].reasons[0]).toContain('Age 11 on the event date')
    expect(v.validatedRows[0].reasons[0]).toContain('(18–60 years)')
  })
  it('inside the window, an unrestricted pass, no DOB, or no age context ⇒ no warning', () => {
    const rows = [row('A', 'a@x.io', '', 'Adult', '1990-01-01'), row('B', 'b@x.io', '', 'Standard', '2015-01-01'), row('C', 'c@x.io', '', 'Adult', '')]
    expect(validateImportRows(rows, HEADERS, age).validatedRows.map(r => r.status)).toEqual(['READY', 'READY', 'READY'])
    expect(validateImportRows([row('Kid', 'k@x.io', '', 'Adult', '2015-01-01')], HEADERS, ctx()).validatedRows[0].status).toBe('READY')
  })
  it('the warning never outranks a real error', () => {
    const v = validateImportRows([row('Kid', 'not-an-email', '', 'Adult', '2015-01-01')], HEADERS, age)
    expect(v.validatedRows[0].status).toBe('ERROR')
  })
})

describe('wiring', () => {
  const read = (f: string) => readFileSync(f, 'utf8')
  const DRAWER = read('app/(dashboard)/dashboard/events/[eventId]/registrations/ImportParticipantsDrawer.tsx')
  it('the drawer sends real row numbers to validate AND import, and looks rows up by index', () => {
    expect(DRAWER).toContain('numberImportRows(partSheet.data, headers)')
    expect(DRAWER).toContain('rowNumbers: data.rowNumbers')
    expect(DRAWER).toContain('rowNumbers: parsed.rowNumbers')
    expect(DRAWER).toContain('parsed?.rows[vr.index]')
    expect(DRAWER).not.toContain('rowNumber - 2')
  })
  it('the drawer says imports send no confirmation email, and that warning rows are imported', () => {
    expect(DRAWER).toContain('No confirmation emails are sent to imported participants.')
    expect(DRAWER).toContain('with warnings, which are imported too')
  })
  it('both routes pass rowNumbers through; the import route never indexes by rowNumber', () => {
    const IMP = read('app/api/organizer/events/[eventId]/registrations/import/route.ts')
    expect(IMP).toContain('validateImportRows(rows, headers, built.ctx, body.rowNumbers)')
    expect(IMP).not.toContain('rowNumber - 2')
    expect(IMP).toContain('rowNumber: vr.rowNumber }')
    expect(read('app/api/organizer/events/[eventId]/registrations/import-validate/route.ts'))
      .toContain('validateImportRows(rows, headers, built.ctx, body.rowNumbers)')
  })
  it('the context feeds the canonical mobile limit and the online age rule', () => {
    const C = read('lib/registrations/importContext.ts')
    expect(C).toContain('limitPerMobile: rules?.limitPerMobile ?? false')
    expect(C).toContain('resolveServerEligibility(eventDetails')
  })
})
