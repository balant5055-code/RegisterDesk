import { describe, it, expect } from 'vitest'
import {
  ageOn, ageEligibilityError, resolveDobField, ageRangeLabel,
} from '@/lib/registrations/ageEligibility'
import type { FieldType } from '@/components/wizard/registrationFormConfig'

const field = (label: string, type: FieldType = 'date') => ({ id: label, type, label })

describe('ageOn — measured on the event date, never today', () => {
  it('counts whole years completed', () => {
    expect(ageOn('2000-01-01', '2026-01-01')).toBe(26)
  })

  it('subtracts a year when the birthday falls AFTER the event date', () => {
    // Turns 12 two days after race day → 11 on race day.
    expect(ageOn('2014-03-03', '2026-03-01')).toBe(11)
  })

  it('counts the birthday itself as having been reached', () => {
    expect(ageOn('2014-03-01', '2026-03-01')).toBe(12)
  })

  it('handles a 29 February birth date without drifting', () => {
    expect(ageOn('2004-02-29', '2026-02-28')).toBe(21)   // day before
    expect(ageOn('2004-02-29', '2026-03-01')).toBe(22)   // day after
  })

  it('is exact across a leap year, where 365.25-day division drifts', () => {
    expect(ageOn('2008-03-01', '2026-02-28')).toBe(17)
    expect(ageOn('2008-03-01', '2026-03-01')).toBe(18)
  })

  it('returns null for missing or malformed dates rather than guessing', () => {
    expect(ageOn('', '2026-03-01')).toBeNull()
    expect(ageOn('not-a-date', '2026-03-01')).toBeNull()
    expect(ageOn('2026-02-30', '2026-03-01')).toBeNull()  // impossible calendar date
  })
})

describe('ageEligibilityError', () => {
  const on = '2026-03-01'

  it('passes when no limits are configured', () => {
    expect(ageEligibilityError('2014-03-03', on, { minAge: null, maxAge: null })).toBeNull()
  })

  it('blocks a participant below the minimum on the event date', () => {
    const msg = ageEligibilityError('2014-03-03', on, { minAge: 12, maxAge: null })
    expect(msg).toContain('Minimum age for this pass is 12 years')
    expect(msg).toContain('you would be 11 on the event date')
  })

  it('allows a participant who reaches the minimum ON the event date', () => {
    expect(ageEligibilityError('2014-03-01', on, { minAge: 12, maxAge: null })).toBeNull()
  })

  it('blocks a participant above the maximum', () => {
    const msg = ageEligibilityError('1960-01-01', on, { minAge: null, maxAge: 60 })
    expect(msg).toContain('Maximum age for this pass is 60 years')
  })

  it('allows a participant exactly at the maximum', () => {
    expect(ageEligibilityError('1966-01-01', on, { minAge: null, maxAge: 60 })).toBeNull()
  })

  it('does not block when the event has no date — never fail on missing organiser data', () => {
    expect(ageEligibilityError('2014-03-03', null, { minAge: 12, maxAge: null })).toBeNull()
    expect(ageEligibilityError('2014-03-03', '',   { minAge: 12, maxAge: null })).toBeNull()
  })

  it('does not block an empty date of birth — the required-field rule owns that', () => {
    expect(ageEligibilityError('', on, { minAge: 12, maxAge: null })).toBeNull()
  })

  it('rejects a birth date after the event date', () => {
    expect(ageEligibilityError('2027-01-01', on, { minAge: 12, maxAge: null }))
      .toContain('on or before the event date')
  })
})

describe('ageEligibilityError — windowed passes (RD-RT3.2.3)', () => {
  const on = '2026-03-01'
  const window = { minAge: 12, maxAge: 17 }

  it('names BOTH bounds so the attendee can tell which pass to switch to', () => {
    const msg = ageEligibilityError('2002-01-01', on, window)
    expect(msg).toContain('aged 12–17 years')
    expect(msg).toContain('you would be 24 on the event date')
  })

  it('rejects below the window as well as above it', () => {
    expect(ageEligibilityError('2020-01-01', on, window)).toContain('aged 12–17 years')
  })

  it('accepts an age inside the window', () => {
    expect(ageEligibilityError('2012-01-01', on, window)).toBeNull()
  })

  it('accepts both boundaries inclusively', () => {
    expect(ageEligibilityError('2014-01-01', on, window)).toBeNull()   // exactly 12
    expect(ageEligibilityError('2008-06-01', on, window)).toBeNull()   // exactly 17
  })
})

describe('ageRangeLabel', () => {
  it('renders a closed window', () => {
    expect(ageRangeLabel({ minAge: 12, maxAge: 17 })).toBe('12–17 years')
  })
  it('renders an open upper bound as N+', () => {
    expect(ageRangeLabel({ minAge: 18, maxAge: null })).toBe('18+')
  })
  it('renders an open lower bound', () => {
    expect(ageRangeLabel({ minAge: null, maxAge: 60 })).toBe('Up to 60 years')
  })
  it('returns null when unrestricted, so callers hide the row', () => {
    expect(ageRangeLabel({ minAge: null, maxAge: null })).toBeNull()
  })
})

describe('resolveDobField', () => {
  it('finds the builder default label', () => {
    expect(resolveDobField([field('Full Name', 'text'), field('Date of Birth')])?.label)
      .toBe('Date of Birth')
  })

  it('accepts common organiser variants', () => {
    for (const label of ['DOB', 'Birth Date', 'birthdate', 'Participant date of birth']) {
      expect(resolveDobField([field(label)])).not.toBeNull()
    }
  })

  it('never treats an unrelated date field as a birth date', () => {
    expect(resolveDobField([field('Preferred Travel Date'), field('Arrival Date')])).toBeNull()
  })

  it('ignores a DOB-labelled field that is not a date input', () => {
    expect(resolveDobField([field('Date of Birth', 'text')])).toBeNull()
  })

  it('returns null when the form has no date fields at all', () => {
    expect(resolveDobField([field('Email', 'email')])).toBeNull()
  })
})
