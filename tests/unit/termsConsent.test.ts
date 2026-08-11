// Mandatory Terms & Conditions consent — the SERVER gate.
//
// The registration form already had a client-side consent gate. It was never enforced on
// the server, so a direct POST to /api/registrations/submit or /create-order registered an
// attendee — and could mint a real Razorpay order — with no consent at all. `disabled`
// buttons and hidden inputs are UI; `validateTermsConsent` is the control.
//
// The predicate is deliberately strict: only a real boolean `true` passes, so a truthy
// string, 1, or an object cannot smuggle consent past it. Those cases are the bypass
// attempts a hand-rolled request would actually make.

import { describe, it, expect } from 'vitest'
import {
  validateTermsConsent, PLATFORM_TERMS_VERSION,
  PLATFORM_TERMS_SECTIONS, PLATFORM_TERMS_TITLE,
} from '@/lib/legal/platformTerms'

describe('1 · consent present ⇒ registration continues', () => {
  it('termsAccepted === true passes and returns a version to stamp', () => {
    const r = validateTermsConsent({ termsAccepted: true })
    expect(r.ok).toBe(true)
    expect(r.version).toBe(PLATFORM_TERMS_VERSION)
    expect(r.error).toBeUndefined()
  })

  it('an explicit client version is preserved, not overwritten', () => {
    expect(validateTermsConsent({ termsAccepted: true, termsVersion: '2026-01-01' }).version).toBe('2026-01-01')
  })

  it('a blank/omitted version is stamped with the current one rather than rejected', () => {
    // The acceptance is the legally meaningful act; failing a real attendee over a
    // metadata field would block a valid registration for no benefit.
    for (const v of [undefined, '', '   ', 42, null, {}]) {
      const r = validateTermsConsent({ termsAccepted: true, termsVersion: v })
      expect(r.ok).toBe(true)
      expect(r.version).toBe(PLATFORM_TERMS_VERSION)
    }
  })
})

describe('2-4 · missing, false or malformed consent ⇒ rejected', () => {
  it.each([
    ['missing',        {}],
    ['undefined',      { termsAccepted: undefined }],
    ['null',           { termsAccepted: null }],
    ['false',          { termsAccepted: false }],
    ['string "true"',  { termsAccepted: 'true' }],
    ['string "false"', { termsAccepted: 'false' }],
    ['number 1',       { termsAccepted: 1 }],
    ['number 0',       { termsAccepted: 0 }],
    ['object',         { termsAccepted: {} }],
    ['array',          { termsAccepted: [true] }],
    ['string "yes"',   { termsAccepted: 'yes' }],
  ])('%s is rejected', (_label, body) => {
    const r = validateTermsConsent(body)
    expect(r.ok).toBe(false)
    expect(r.version).toBeUndefined()
  })

  it('the refusal carries the exact message the UI must show', () => {
    expect(validateTermsConsent({}).error)
      .toBe('Please read and agree to the Terms & Conditions to continue.')
  })

  it('a truthy version cannot substitute for the acceptance itself', () => {
    // The bypass a hand-rolled request would try: send the version, omit the boolean.
    expect(validateTermsConsent({ termsVersion: PLATFORM_TERMS_VERSION }).ok).toBe(false)
  })
})

describe('terms content is carried verbatim', () => {
  it('is versioned', () => {
    expect(PLATFORM_TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(PLATFORM_TERMS_TITLE).toBe('Terms & Conditions')
  })

  it('carries every supplied section heading, in order', () => {
    expect(PLATFORM_TERMS_SECTIONS.map(s => s.heading).filter(Boolean)).toEqual([
      'RegisterDesk Event Terms and Conditions:',
      'Participant Responsibilities:',
      'Personal Information:',
      'Liability Waiver:',
      'Registration and Payment:',
      'Organizer Responsibility:',
      'Event Changes or Cancellation:',
    ])
  })

  it('opens and closes with the supplied wording', () => {
    const all = PLATFORM_TERMS_SECTIONS.flatMap(s => s.paragraphs)
    expect(all[0]).toBe('Welcome to RegisterDesk! Before participating in any of our events, please read and agree to the following terms and conditions:')
    expect(all[all.length - 1]).toBe('Thank you for being part of the RegisterDesk community!')
  })

  it('retains the clauses that carry legal weight', () => {
    const text = PLATFORM_TERMS_SECTIONS.flatMap(s => s.paragraphs).join(' ')
    for (const clause of [
      'solely responsible for their own safety, health, and actions',
      'RegisterDesk is not liable for any injuries, damages, losses, or expenses',
      'waive any claims against RegisterDesk and its affiliates',
      'does not store or handle payment information directly',
      'acts solely as a platform to facilitate event registration',
      'reserves the right to modify event details',
      'support@registerdesk.in',
    ]) {
      expect(text, `missing clause: ${clause}`).toContain(clause)
    }
  })

  it('carries NO third-party sample branding', () => {
    // The supplied draft was written for another company. This asserts the rebrand can
    // never silently regress — the terms are attendee-facing and legally operative.
    const blob = JSON.stringify([PLATFORM_TERMS_TITLE, PLATFORM_TERMS_SECTIONS])
    expect(blob, `third-party sample branding present`).not.toMatch(/novarace/i)
    expect(blob).toContain('RegisterDesk')
    expect(blob).toContain('support@registerdesk.in')
  })

  it('every paragraph is non-empty — no section renders blank', () => {
    for (const s of PLATFORM_TERMS_SECTIONS) {
      expect(s.paragraphs.length).toBeGreaterThan(0)
      for (const p of s.paragraphs) expect(p.trim().length).toBeGreaterThan(0)
    }
  })
})
