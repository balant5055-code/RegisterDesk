// RD-AUTH-02 Phase 4 — the canonical organizer recipient resolver.
//
// Proves platform notifications resolve to the PRIVATE account mobile
// (users/{uid}.mobile.e164) and NEVER to organizationProfile.supportPhone, and that a
// missing mobile degrades gracefully (hasMobile=false → WhatsApp skips, email stays).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({
  adminDb:   { collection: vi.fn() },
  adminAuth: { getUser: vi.fn() },
}))

import { resolveOrganizerRecipients } from '@/lib/organizer/recipients'
import { adminDb, adminAuth } from '@/lib/firebase/admin'

type Snap = { exists: boolean; data?: () => Record<string, unknown> }

function mockDoc(snap: Snap) {
  ;(adminDb.collection as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    doc: () => ({ get: () => Promise.resolve(snap) }),
  })
}

beforeEach(() => {
  ;(adminAuth.getUser as unknown as ReturnType<typeof vi.fn>).mockReset()
})

describe('resolveOrganizerRecipients', () => {
  it('returns the private account mobile + firestore email; no Auth fallback needed', async () => {
    mockDoc({ exists: true, data: () => ({ email: 'a@b.com', name: 'Ann', mobile: { e164: '+919000000001', verified: false } }) })

    const r = await resolveOrganizerRecipients('uid-1')

    expect(r.email).toBe('a@b.com')
    expect(r.emailSource).toBe('firestore')
    expect(r.mobileE164).toBe('+919000000001')
    expect(r.hasMobile).toBe(true)
    expect(adminAuth.getUser).not.toHaveBeenCalled()
  })

  it('IGNORES organizationProfile.supportPhone — no account mobile → hasMobile false', async () => {
    mockDoc({ exists: true, data: () => ({ email: 'a@b.com', organizationProfile: { supportPhone: '+918888888888' } }) })

    const r = await resolveOrganizerRecipients('uid-2')

    // The public support phone must NEVER become the notification destination.
    expect(r.mobileE164).toBe('')
    expect(r.hasMobile).toBe(false)
  })

  it('falls back to the authoritative Auth email when the profile has none', async () => {
    mockDoc({ exists: true, data: () => ({ name: 'Ann', mobile: { e164: '+917777777777' } }) })
    ;(adminAuth.getUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ email: 'auth@b.com', displayName: 'Auth Ann' })

    const r = await resolveOrganizerRecipients('uid-3')

    expect(r.email).toBe('auth@b.com')
    expect(r.emailSource).toBe('auth')
    expect(r.mobileE164).toBe('+917777777777')
  })

  it('empty uid → fully empty result (never throws)', async () => {
    const r = await resolveOrganizerRecipients('')
    expect(r).toEqual({ email: '', name: '', mobileE164: '', hasMobile: false, mobileVerified: false, emailSource: 'none' })
  })
})
