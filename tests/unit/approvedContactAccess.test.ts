// The pure "Approved Contact List" rule (lib/registrations/approvedContactAccess). The emulator
// suite (approvedContactAccess.emu.test.ts) proves both registration endpoints apply it.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/attendee/auth', () => ({ verifyAttendeeSession: async () => null }))
// lib/attendee/identity (the shared email normaliser) sits beside Admin SDK readers; the rule is pure.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import { checkApprovedContactAccess, approvedContactEmails } from '@/lib/registrations/approvedContactAccess'

const AC = { type: 'approved_contacts', approvedContacts: [
  { email: 'Ann@Example.com' }, { email: '' }, { email: 'not-an-email' }, { mobileNumber: '+91900' }, null, 'junk',
] }

describe('approved-contact access rule', () => {
  it('other access modes are not its concern', () => {
    for (const ac of [null, undefined, {}, { type: 'open' }, { type: 'invite_code', inviteCode: { code: 'x' } }]) {
      expect(checkApprovedContactAccess({ accessControl: ac, attendeeEmail: 'x@y.z', verifiedEmails: [] })).toEqual({ ok: true })
    }
  })

  it('only well-formed emails count; malformed rows are ignored', () => {
    expect([...approvedContactEmails(AC)]).toEqual(['ann@example.com'])
    expect(approvedContactEmails({ type: 'approved_contacts', approvedContacts: 'nope' }).size).toBe(0)
  })

  it('fails closed: empty list, no verified identity, mismatch, not listed', () => {
    const r = (accessControl: unknown, attendeeEmail: string, verifiedEmails: (string | null)[]) =>
      checkApprovedContactAccess({ accessControl, attendeeEmail, verifiedEmails })
    expect(r({ type: 'approved_contacts', approvedContacts: [] }, 'ann@example.com', ['ann@example.com'])).toMatchObject({ ok: false, reason: 'APPROVED_CONTACTS_UNAVAILABLE' })
    expect(r(AC, 'ann@example.com', [])).toMatchObject({ ok: false, reason: 'APPROVED_CONTACT_VERIFICATION_REQUIRED' })
    expect(r(AC, 'ann@example.com', [null, '  '])).toMatchObject({ ok: false, reason: 'APPROVED_CONTACT_VERIFICATION_REQUIRED' })
    expect(r(AC, 'bob@example.com', ['ann@example.com'])).toMatchObject({ ok: false, reason: 'APPROVED_CONTACT_EMAIL_MISMATCH' })
    expect(r(AC, 'bob@example.com', ['bob@example.com'])).toMatchObject({ ok: false, reason: 'NOT_APPROVED_CONTACT' })
  })

  it('a verified, listed email registering for itself passes (case/space-insensitive)', () => {
    expect(checkApprovedContactAccess({ accessControl: AC, attendeeEmail: ' ANN@example.com ', verifiedEmails: ['ann@EXAMPLE.com'] })).toEqual({ ok: true })
  })

  it('refusals never reveal who is on the list', () => {
    const r = checkApprovedContactAccess({ accessControl: AC, attendeeEmail: 'bob@example.com', verifiedEmails: ['bob@example.com'] })
    expect(JSON.stringify(r)).not.toContain('ann')
  })

  it('both registration endpoints apply it, after the attendee identity is resolved', () => {
    for (const f of ['app/api/registrations/submit/route.ts', 'app/api/registrations/create-order/route.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src, f).toContain('checkApprovedContactAccess({')
      expect(src, f).toContain('verifiedEmails: await verifiedRegistrationEmails(event.accessControl, decodedToken)')
      expect(src.indexOf('checkApprovedContactAccess({'), f).toBeGreaterThan(src.indexOf('resolveAttendeeIdentity(identityFields'))
    }
  })
})
