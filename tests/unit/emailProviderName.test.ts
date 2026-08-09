// RD-EMAIL-PROVIDER — provider-name resolution.
//
// This is the rule that decides which transport an event's mail leaves through, so it is
// pinned here in the `node` environment with no Firebase, AWS or Resend boot.
//
// The asymmetry these tests exist to protect:
//   • an ABSENT or UNREADABLE preference resolves to SES (today's behaviour, never throws)
//   • an EXPLICIT, VALID 'resend' is never downgraded to SES — that decision lives in
//     getEmailProvider(), which returns null rather than substituting a provider.

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_EMAIL_PROVIDER, EMAIL_PROVIDER_NAMES,
  isEmailProviderName, isExplicitProviderChoice, parseEmailProviderName,
} from '@/lib/email/providerName'

describe('A/B/C · resolution matrix', () => {
  it('A · absent preference → ses (existing events, behaviour unchanged)', () => {
    expect(parseEmailProviderName(undefined)).toBe('ses')
    expect(parseEmailProviderName(null)).toBe('ses')
  })

  it('B · explicit "ses" → ses', () => {
    expect(parseEmailProviderName('ses')).toBe('ses')
  })

  it('C · explicit "resend" → resend', () => {
    expect(parseEmailProviderName('resend')).toBe('resend')
  })
})

describe('D · invalid stored values fail SAFE to ses, never to an arbitrary provider', () => {
  it.each([
    ['empty string', ''],
    ['unknown name', 'sendgrid'],
    ['wrong case',   'RESEND'],
    ['whitespace',   ' resend '],
    ['number',       42],
    ['object',       { provider: 'resend' }],
    ['array',        ['resend']],
    ['boolean',      true],
  ])('%s → ses', (_label, value) => {
    expect(parseEmailProviderName(value)).toBe('ses')
  })

  it('never returns a value outside the enum', () => {
    for (const v of ['x', null, undefined, 0, {}, []]) {
      expect(EMAIL_PROVIDER_NAMES).toContain(parseEmailProviderName(v))
    }
  })
})

describe('E · an attendee-supplied string cannot become a provider', () => {
  it('a hostile request body value is rejected by the type guard', () => {
    // Provider never comes from a request — but if a value ever reached the parser from
    // untrusted input, it still cannot select a transport the platform did not define.
    const hostile = ['resend ', 'RESEND', 'ses;resend', '__proto__', 'mailgun']
    for (const v of hostile) expect(isEmailProviderName(v)).toBe(false)
  })
})

describe('explicit-choice detection (drives "no silent downgrade")', () => {
  it('distinguishes an explicit choice from a default', () => {
    expect(isExplicitProviderChoice('resend')).toBe(true)
    expect(isExplicitProviderChoice('ses')).toBe(true)
    expect(isExplicitProviderChoice(undefined)).toBe(false)
    expect(isExplicitProviderChoice('nonsense')).toBe(false)
  })
})

describe('constants', () => {
  it('the platform default is SES', () => {
    expect(DEFAULT_EMAIL_PROVIDER).toBe('ses')
  })

  it('exactly two providers are defined', () => {
    expect([...EMAIL_PROVIDER_NAMES].sort()).toEqual(['resend', 'ses'])
  })
})
