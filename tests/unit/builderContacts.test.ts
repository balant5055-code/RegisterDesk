// RD-PRODUCT-01G — Event Builder pure utilities (lib/events/builder/*).
// These were untested inside the monolith; extraction lets us lock their behavior.

import { describe, it, expect } from 'vitest'
import { parseCsvText, parseContactsFromRows } from '@/lib/events/builder/contacts'
import { formatINR } from '@/lib/events/builder/format'

describe('parseCsvText', () => {
  it('parses headers (lower-cased) + rows', () => {
    const rows = parseCsvText('Name,Email\nJane,jane@x.com\nBob,bob@x.com')
    expect(rows).toEqual([
      { name: 'Jane', email: 'jane@x.com' },
      { name: 'Bob', email: 'bob@x.com' },
    ])
  })
  it('returns [] when there is no data row', () => {
    expect(parseCsvText('Name,Email')).toEqual([])
    expect(parseCsvText('')).toEqual([])
  })
  it('handles quoted values containing commas', () => {
    const rows = parseCsvText('Name,Note\n"Doe, Jane","hello, world"')
    expect(rows[0]).toEqual({ name: 'Doe, Jane', note: 'hello, world' })
  })
  it('skips blank lines and trims cells', () => {
    const rows = parseCsvText('Name,Email\n\n  Jane , jane@x.com \n')
    expect(rows).toEqual([{ name: 'Jane', email: 'jane@x.com' }])
  })
})

describe('parseContactsFromRows', () => {
  it('maps header aliases and requires a mobile number', () => {
    const contacts = parseContactsFromRows([
      { name: 'Jane', 'mobile number': '+91987', email: 'j@x.com', 'member id': 'M1' },
      { name: 'NoPhone', email: 'n@x.com' },              // dropped — no mobile
      { name: 'Bob', phone: '+91888', memberid: 'M2' },   // alias headers
    ])
    expect(contacts).toHaveLength(2)
    expect(contacts[0]).toMatchObject({ name: 'Jane', mobileNumber: '+91987', email: 'j@x.com', memberId: 'M1' })
    expect(contacts[1]).toMatchObject({ name: 'Bob', mobileNumber: '+91888', memberId: 'M2' })
    expect(contacts[0].id).toBeTruthy()
    expect(contacts[0].addedAt).toBeTruthy()
  })
})

describe('formatINR', () => {
  it('formats rupee amounts in en-IN currency style', () => {
    expect(formatINR(0)).toBe('₹0')
    expect(formatINR(100000)).toBe('₹1,00,000')
  })
})
