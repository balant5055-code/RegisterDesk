// RD-LAUNCH-02 — the shared contact-enquiry contract.
//
// Covers the validator and normaliser the endpoint and the form both call, plus the
// HTML escaping in the notification body (the one place attacker-supplied text is
// interpolated into markup).

import { describe, it, expect } from 'vitest'
import {
  validateEnquiry, normaliseEnquiry, escapeHtml, buildEnquiryEmailHtml, ENQUIRY_LIMITS,
} from '@/lib/marketing/enquiry'

const valid = {
  fullName:  'Asha Rao',
  workEmail: 'asha@example.com',
  message:   'We run a 10k road race and need registrations for 2,000 runners.',
}

describe('validateEnquiry', () => {
  it('accepts a minimal genuine enquiry', () => {
    expect(validateEnquiry(valid)).toEqual([])
  })

  it('requires name, email and message', () => {
    const fields = validateEnquiry({}).map(e => e.field)
    expect(fields).toContain('fullName')
    expect(fields).toContain('workEmail')
    expect(fields).toContain('message')
  })

  it('rejects a malformed email', () => {
    const errs = validateEnquiry({ ...valid, workEmail: 'not-an-email' })
    expect(errs.some(e => e.field === 'workEmail')).toBe(true)
  })

  it('treats whitespace-only values as missing', () => {
    const errs = validateEnquiry({ fullName: '   ', workEmail: '  ', message: '\n\t' })
    expect(errs).toHaveLength(3)
  })

  it('rejects an oversized message rather than silently truncating it', () => {
    const errs = validateEnquiry({ ...valid, message: 'x'.repeat(ENQUIRY_LIMITS.message + 1) })
    expect(errs.some(e => e.field === 'message')).toBe(true)
  })

  it('rejects an oversized short field', () => {
    const errs = validateEnquiry({ ...valid, organization: 'x'.repeat(ENQUIRY_LIMITS.short + 1) })
    expect(errs.some(e => e.field === 'organization')).toBe(true)
  })

  it('tolerates a null or non-object body without throwing', () => {
    expect(validateEnquiry(null).length).toBeGreaterThan(0)
    expect(validateEnquiry('nonsense').length).toBeGreaterThan(0)
  })

  it('ignores non-string values instead of trusting them', () => {
    const errs = validateEnquiry({ fullName: { a: 1 }, workEmail: 42, message: [] })
    expect(errs).toHaveLength(3)
  })
})

describe('normaliseEnquiry — stores only what was typed', () => {
  it('lowercases the email and trims every value', () => {
    const out = normaliseEnquiry({ ...valid, fullName: '  Asha Rao  ', workEmail: '  ASHA@Example.COM ' })
    expect(out.workEmail).toBe('asha@example.com')
    expect(out.fullName).toBe('Asha Rao')
  })

  it('omits empty optionals rather than storing empty strings', () => {
    const out = normaliseEnquiry({ ...valid, phone: '', organization: '   ' })
    expect(out.phone).toBeUndefined()
    expect(out.organization).toBeUndefined()
  })

  it('never carries fields that were not submitted by the user', () => {
    const out = normaliseEnquiry({ ...valid, ip: '1.2.3.4', userAgent: 'Mozilla', isAdmin: true })
    expect(out).not.toHaveProperty('ip')
    expect(out).not.toHaveProperty('userAgent')
    expect(out).not.toHaveProperty('isAdmin')
  })

  it('caps values so one request cannot write an oversized document', () => {
    const out = normaliseEnquiry({ ...valid, message: 'x'.repeat(50_000) })
    expect(out.message.length).toBe(ENQUIRY_LIMITS.message)
  })
})

describe('notification HTML is injection-safe', () => {
  it('escapes every HTML metacharacter', () => {
    expect(escapeHtml(`<script>"&'`)).toBe('&lt;script&gt;&quot;&amp;&#39;')
  })

  it('neutralises markup submitted in the message body', () => {
    const html = buildEnquiryEmailHtml(
      { ...valid, message: '<img src=x onerror=alert(1)>' },
      '27 Jul 2026, 12:00',
    )
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('neutralises markup submitted in the name', () => {
    const html = buildEnquiryEmailHtml({ ...valid, fullName: '<b>Asha</b>' }, 'now')
    expect(html).toContain('&lt;b&gt;Asha&lt;/b&gt;')
  })

  it('omits rows for optional values that were not supplied', () => {
    const html = buildEnquiryEmailHtml(valid, 'now')
    expect(html).not.toContain('Phone')
    expect(html).not.toContain('Company')
  })

  it('includes optional values when they are supplied', () => {
    const html = buildEnquiryEmailHtml({ ...valid, phone: '+91 90000 00000', organization: 'Acme' }, 'now')
    expect(html).toContain('Phone')
    expect(html).toContain('Acme')
  })
})
