// RD-EVENT-DAY-CERTIFICATE-CENTER — the short-lived download capability.
//
// The Certificate Center identifies people by email or registration id, both guessable.
// So the token it hands back must be strictly weaker than the permanent
// `verificationToken`: one certificate, one event, one purpose, and it must expire.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/env', () => ({ TICKET_SECRET: 'test-secret-for-capability-tests' }))

import {
  signCertificateDownloadCapability,
  verifyCertificateDownloadCapability,
  looksLikeDownloadCapability,
  CAPABILITY_TTL_MS,
} from '@/lib/certificates/downloadCapability'

const CERT = 'RDC-2026-5OHOUL'
const SLUG = 'noyyal-marathon-2026'
const T0   = 1_800_000_000_000        // fixed clock — no wall-clock flake

let token = ''
beforeEach(() => { token = signCertificateDownloadCapability(CERT, SLUG, T0) })

describe('a freshly minted capability', () => {
  it('verifies for its own certificate and event', () => {
    expect(verifyCertificateDownloadCapability(CERT, SLUG, token, T0 + 1000)).toBe(true)
  })

  it('carries the expiry in the token, ahead of now', () => {
    expect(Number(token.split('.')[0])).toBe(T0 + CAPABILITY_TTL_MS)
  })

  it('is 15 minutes, not indefinite', () => {
    expect(CAPABILITY_TTL_MS).toBe(15 * 60 * 1000)
  })
})

describe('scope — a capability unlocks exactly one certificate', () => {
  it('is rejected for a DIFFERENT certificate in the same event', () => {
    expect(verifyCertificateDownloadCapability('RDC-2026-OTHER', SLUG, token, T0)).toBe(false)
  })

  it('is rejected for the SAME certificate reached through another event', () => {
    // Cross-event replay: the same certificate id must not be reachable by pointing a
    // token at a different event's Certificate Center.
    expect(verifyCertificateDownloadCapability(CERT, 'other-event-2026', token, T0)).toBe(false)
  })

  it('two certificates in one event get non-interchangeable tokens', () => {
    const a = signCertificateDownloadCapability('RDC-A', SLUG, T0)
    const b = signCertificateDownloadCapability('RDC-B', SLUG, T0)
    expect(a).not.toBe(b)
    expect(verifyCertificateDownloadCapability('RDC-B', SLUG, a, T0)).toBe(false)
  })
})

describe('expiry', () => {
  it('is rejected one millisecond past its expiry', () => {
    expect(verifyCertificateDownloadCapability(CERT, SLUG, token, T0 + CAPABILITY_TTL_MS + 1)).toBe(false)
  })

  it('is still valid just before expiry', () => {
    expect(verifyCertificateDownloadCapability(CERT, SLUG, token, T0 + CAPABILITY_TTL_MS - 1000)).toBe(true)
  })

  it('an attacker cannot extend it by editing the expiry — the expiry is signed', () => {
    const forged = `${T0 + 86_400_000}.${token.split('.')[1]}`
    expect(verifyCertificateDownloadCapability(CERT, SLUG, forged, T0)).toBe(false)
  })
})

describe('malformed and hostile input is rejected outright', () => {
  it.each([
    ['empty',            ''],
    ['no expiry part',   'a'.repeat(64)],
    ['no signature',     `${T0}.`],
    ['short signature',  `${T0}.abcd`],
    ['non-hex signature', `${T0}.${'z'.repeat(64)}`],
    ['negative expiry',  `-1.${'a'.repeat(64)}`],
    ['two dots',         `${T0}.${'a'.repeat(64)}.x`],
    ['whitespace only',  '   '],
  ])('rejects %s', (_label, bad) => {
    expect(verifyCertificateDownloadCapability(CERT, SLUG, bad, T0)).toBe(false)
  })

  it('rejects a bare 64-hex string — the shape of the PERMANENT verificationToken', () => {
    // Guards against a permanent token being accepted here (or vice versa) by accident.
    expect(verifyCertificateDownloadCapability(CERT, SLUG, 'f'.repeat(64), T0)).toBe(false)
  })
})

describe('looksLikeDownloadCapability distinguishes it from verificationToken', () => {
  it('recognises a capability', () => {
    expect(looksLikeDownloadCapability(token)).toBe(true)
  })

  it('does NOT recognise a permanent 64-hex verificationToken', () => {
    expect(looksLikeDownloadCapability('a'.repeat(64))).toBe(false)
  })

  it('does not recognise junk', () => {
    expect(looksLikeDownloadCapability('nonsense')).toBe(false)
  })
})
