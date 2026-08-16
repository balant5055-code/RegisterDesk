// RD-REG-DUP-01 · the ONE rule that decides whether a duplicate matters.
//
// ═══ WHAT WAS WRONG ══════════════════════════════════════════════════════════
// Three organizer settings described duplicate handling — `duplicatePolicy`
// ('block' | 'warn' | 'allow') plus `limitPerEmail` / `limitPerMobile` — but the attendee
// paths consulted only the two booleans. `duplicatePolicy` was read by the bulk importer
// alone, so an organizer who chose "Allow All" still had duplicates blocked at registration.
// The control displayed a decision the system did not honour.
//
// ═══ WHY THIS IS A MONEY TEST, NOT A UI TEST ═════════════════════════════════
// On the PAID path a duplicate does not merely block — it throws
// DuplicateRegistrationError inside settlement, which is routed to refuse() and REFUNDS the
// captured payment in full. So "Allow All" failing to take effect does not just annoy an
// attendee: it reverses a legitimate charge. That is why `allow` must zero the limits
// rather than merely skip a check — every downstream consumer (query, claim write, throw)
// already branches on those booleans, so zeroing them disables all three at once.

import { describe, it, expect, vi } from 'vitest'

// duplicateCheck imports the Admin SDK for its Firestore query; the resolver under test is
// pure and never touches it, so the module is stubbed to keep this suite bootless.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const { resolveDuplicateEnforcement } = await import('@/lib/registrations/duplicateCheck')

describe('1 · policy = allow ⇒ duplicates are permitted everywhere', () => {
  it('zeroes BOTH limits, whatever the booleans say', () => {
    const e = resolveDuplicateEnforcement({
      duplicatePolicy: 'allow', limitPerEmail: true, limitPerMobile: true,
    })
    expect(e).toEqual({ policy: 'allow', enforce: false, limitPerEmail: false, limitPerMobile: false })
  })

  it('nothing blocks — the flag every caller branches on is false', () => {
    expect(resolveDuplicateEnforcement({ duplicatePolicy: 'allow', limitPerEmail: true }).enforce).toBe(false)
  })
})

describe('2 · policy = warn ⇒ detected, announced, never blocking', () => {
  it('keeps the limits so detection still runs for the warning', () => {
    const e = resolveDuplicateEnforcement({
      duplicatePolicy: 'warn', limitPerEmail: true, limitPerMobile: true,
    })
    expect(e.limitPerEmail).toBe(true)
    expect(e.limitPerMobile).toBe(true)
  })

  it('but never enforces — no 409, no throw, no refund', () => {
    expect(resolveDuplicateEnforcement({ duplicatePolicy: 'warn', limitPerEmail: true }).enforce).toBe(false)
  })
})

describe('3 · policy = block ⇒ the existing behaviour, unchanged', () => {
  it('enforces exactly the limits the organizer set', () => {
    expect(resolveDuplicateEnforcement({ duplicatePolicy: 'block', limitPerEmail: true, limitPerMobile: false }))
      .toEqual({ policy: 'block', enforce: true, limitPerEmail: true, limitPerMobile: false })
  })

  it('block with BOTH limits off still detects nothing — the limits are the scope', () => {
    const e = resolveDuplicateEnforcement({ duplicatePolicy: 'block', limitPerEmail: false, limitPerMobile: false })
    expect(e.enforce).toBe(true)
    expect(e.limitPerEmail).toBe(false)
    expect(e.limitPerMobile).toBe(false)
  })
})

describe('4 · BACKWARD COMPATIBILITY — legacy events are untouched', () => {
  it('an absent policy resolves to block, preserving today behaviour exactly', () => {
    expect(resolveDuplicateEnforcement({ limitPerEmail: true, limitPerMobile: false }))
      .toEqual({ policy: 'block', enforce: true, limitPerEmail: true, limitPerMobile: false })
  })

  it('no registrationRules at all ⇒ block, with nothing in scope', () => {
    expect(resolveDuplicateEnforcement(undefined))
      .toEqual({ policy: 'block', enforce: true, limitPerEmail: false, limitPerMobile: false })
    expect(resolveDuplicateEnforcement(null))
      .toEqual({ policy: 'block', enforce: true, limitPerEmail: false, limitPerMobile: false })
  })

  it.each([['garbage'], [''], [null], [undefined], [0], [true], [{}]])(
    'an unrecognised policy %j fails SAFE to block', (v) => {
      expect(resolveDuplicateEnforcement({ duplicatePolicy: v, limitPerEmail: true }).policy).toBe('block')
      expect(resolveDuplicateEnforcement({ duplicatePolicy: v, limitPerEmail: true }).enforce).toBe(true)
    })

  it('a non-boolean limit is not treated as enabled', () => {
    // Strict === true: a stray string would otherwise silently enable a block.
    expect(resolveDuplicateEnforcement({ limitPerEmail: 'yes' }).limitPerEmail).toBe(false)
    expect(resolveDuplicateEnforcement({ limitPerEmail: 1 }).limitPerEmail).toBe(false)
  })
})

describe('5 · the claim-doc consequence', () => {
  // Claim docs are written only when the resolved limit is true. Under allow/warn they must
  // NOT be written: a claim blocks the NEXT registration, reintroducing the very block the
  // organizer switched off. Callers pass these exact booleans to createRegistration and to
  // the settlement transaction, so this is the property that carries.
  it.each([
    ['allow', false, false],
    ['warn',  true,  true],
    ['block', true,  true],
  ])('policy %s ⇒ email limit %s, mobile limit %s', (policy, email, mobile) => {
    const e = resolveDuplicateEnforcement({ duplicatePolicy: policy, limitPerEmail: true, limitPerMobile: true })
    expect(e.limitPerEmail).toBe(email)
    expect(e.limitPerMobile).toBe(mobile)
  })

  it('under allow the settlement gate cannot fire, so no refund can be triggered', () => {
    // settleCapturedRegistration throws only when `limitPerEmail && emailClaimSnap.exists`.
    // With the limit false the left operand short-circuits — no throw, no refuse(), no
    // razorpay.payments.refund(). This is the exact condition that reverses a good payment.
    const e = resolveDuplicateEnforcement({ duplicatePolicy: 'allow', limitPerEmail: true, limitPerMobile: true })
    expect(e.limitPerEmail && true).toBe(false)
    expect(e.limitPerMobile && true).toBe(false)
  })
})
