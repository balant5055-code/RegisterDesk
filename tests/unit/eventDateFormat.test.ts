// Event-template date formatting — "Invalid Date" must never reach the page.
//
// THE BUG THIS PINS
// `formatDate`/`formatDateShort` did `dateStr.split('-').map(Number)`, assuming the value
// is exactly 'YYYY-MM-DD'. Pass sales windows are not stored that way: salesStartDate /
// salesEndDate come from <input type="datetime-local"> and persist in its native
// 'YYYY-MM-DDTHH:mm' form. The live NOYYAL AWARENESS MARATHON 2026 event stores
// "2026-08-14T23:00" on both active passes. Splitting that on '-' gives
// ['2026','08','14T23:00'] → Number('14T23:00') is NaN → new Date(2026, 7, NaN) is an
// Invalid Date → toLocaleDateString() returns the literal string "Invalid Date", which the
// event page rendered as "Registration closes on Invalid Date".
//
// Six call sites pass a pass sales date into these formatters (SportsHero,
// TicketSection ×3, StickyRegistrationCard, ChallengeSelectionSection,
// CommunityRegistration), so this is fixed once in the shared formatter.

import { describe, it, expect } from 'vitest'
import { formatDate, formatDateShort } from '@/components/event-templates/shared/utils/format'

const FORMATTERS: [string, (s: string) => string][] = [
  ['formatDate', formatDate],
  ['formatDateShort', formatDateShort],
]

describe('the exact production value that produced "Invalid Date"', () => {
  // pricing.passes[].salesEndDate on events/noyyal-marathon-2026, verified against Firestore.
  const NOYYAL_SALES_END = '2026-08-14T23:00'

  it('formatDateShort renders the datetime-local value as a real date', () => {
    const out = formatDateShort(NOYYAL_SALES_END)
    expect(out).not.toBe('')
    expect(out).not.toMatch(/Invalid/i)
    expect(out).toContain('2026')
    expect(out).toContain('14')
  })

  it('formatDate renders it too', () => {
    const out = formatDate(NOYYAL_SALES_END)
    expect(out).not.toMatch(/Invalid/i)
    expect(out).toContain('2026')
  })

  it('the datetime-local form formats identically to its date-only prefix', () => {
    // The time part must not shift the calendar day — no timezone conversion is introduced.
    expect(formatDateShort('2026-08-14T23:00')).toBe(formatDateShort('2026-08-14'))
    expect(formatDate('2026-08-14T23:00')).toBe(formatDate('2026-08-14'))
  })
})

describe('accepted input shapes', () => {
  it.each([
    ['date only',            '2026-08-15'],
    ['datetime-local',       '2026-08-14T23:00'],
    ['datetime with seconds','2026-08-14T23:00:30'],
    ['full ISO with Z',      '2026-08-14T23:00:00.000Z'],
    ['space separated',      '2026-08-14 23:00'],
  ])('%s renders a real date', (_label, value) => {
    for (const [name, fn] of FORMATTERS) {
      const out = fn(value)
      expect(out, name).not.toBe('')
      expect(out, name).not.toMatch(/Invalid/i)
      expect(out, name).toContain('2026')
    }
  })
})

describe('never renders "Invalid Date" for anything', () => {
  it.each([
    ['empty string',      ''],
    ['whitespace',        '   '],
    ['null',              null],
    ['undefined',         undefined],
    ['malformed text',    'not-a-date'],
    ['partial date',      '2026-08'],
    ['slashes',           '15/08/2026'],
    ['impossible month',  '2026-13-01'],
    ['impossible day',    '2026-02-30'],
    ['a number',          12345],
    ['an object',         { seconds: 1 }],
    ['an array',          []],
    ['a Date instance',   new Date('2026-08-15')],
  ])('%s → empty string, never "Invalid Date"', (_label, value) => {
    for (const [name, fn] of FORMATTERS) {
      const out = fn(value as unknown as string)
      expect(out, name).toBe('')
      expect(out, name).not.toMatch(/Invalid/i)
    }
  })

  it('no input shape can make either formatter emit the literal "Invalid Date"', () => {
    const inputs = ['', '  ', 'x', '2026', '2026-', '2026-08-', 'T23:00', '--', '2026-00-00',
      '9999-99-99', 'Invalid Date', '0000-00-00', '2026-08-15T', 'null', 'undefined']
    for (const v of inputs) {
      for (const [name, fn] of FORMATTERS) {
        expect(fn(v), `${name}(${JSON.stringify(v)})`).not.toMatch(/Invalid/i)
      }
    }
  })
})

describe('existing valid event data is unchanged', () => {
  it('plain YYYY-MM-DD still formats exactly as before', () => {
    // The event schedule fields (startDate/endDate) are date-only and must not regress.
    expect(formatDateShort('2026-08-15')).toBe(
      new Date(2026, 7, 15).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
    )
    expect(formatDate('2026-08-15')).toBe(
      new Date(2026, 7, 15).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }),
    )
  })

  it('an empty value still yields an empty string (unchanged contract)', () => {
    expect(formatDate('')).toBe('')
    expect(formatDateShort('')).toBe('')
  })
})
