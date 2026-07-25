// RD-AUTH-02 — Organizer Profile Integrity.
// Covers the two canonical seams:
//   • resolveOrganizerEmailIdentity — Firestore-first, Auth email-identity fallback.
//   • ensureOrganizerProfile        — idempotent self-heal of a missing /users/{uid}.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mutable mock state, reset before each test ────────────────────────────────
const state: {
  userDoc:   Record<string, unknown> | null   // null ⇒ doc does not exist
  authUser:  { email?: string; displayName?: string; emailVerified?: boolean } | null
  setCalls:  Array<{ data: Record<string, unknown>; opts: unknown }>
} = { userDoc: null, authUser: null, setCalls: [] }

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: state.userDoc !== null,
          data:   () => state.userDoc ?? undefined,
        }),
        set: async (data: Record<string, unknown>, opts: unknown) => { state.setCalls.push({ data, opts }) },
      }),
    }),
  },
  adminAuth: {
    getUser: async () => {
      if (state.authUser === null) throw new Error('auth/user-not-found')
      return state.authUser
    },
  },
}))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ST__' },
}))

import { resolveOrganizerEmailIdentity } from '@/lib/organizer/emailIdentity'
import { ensureOrganizerProfile }        from '@/lib/organizer/ensureProfile'

beforeEach(() => { state.userDoc = null; state.authUser = null; state.setCalls = [] })

// ── resolveOrganizerEmailIdentity ─────────────────────────────────────────────
describe('resolveOrganizerEmailIdentity', () => {
  it('prefers the canonical Firestore email', async () => {
    state.userDoc  = { email: 'fs@example.com', name: 'FS Name' }
    state.authUser = { email: 'auth@example.com', displayName: 'Auth Name' }
    const r = await resolveOrganizerEmailIdentity('u1')
    expect(r).toEqual({ email: 'fs@example.com', name: 'FS Name', source: 'firestore' })
  })

  it('falls back to the Auth email when the profile doc is missing (phantom ancestor)', async () => {
    state.userDoc  = null
    state.authUser = { email: 'auth@example.com', displayName: 'Auth Name' }
    const r = await resolveOrganizerEmailIdentity('u1')
    expect(r).toEqual({ email: 'auth@example.com', name: 'Auth Name', source: 'auth' })
  })

  it('falls back to Auth when the profile exists but has no email (keeps the Firestore name)', async () => {
    state.userDoc  = { name: 'FS Name' }   // no email field
    state.authUser = { email: 'auth@example.com', displayName: 'Auth Name' }
    const r = await resolveOrganizerEmailIdentity('u1')
    expect(r).toEqual({ email: 'auth@example.com', name: 'FS Name', source: 'auth' })
  })

  it('returns source "none" when neither source has an email', async () => {
    state.userDoc  = null
    state.authUser = null   // getUser throws
    const r = await resolveOrganizerEmailIdentity('u1')
    expect(r).toEqual({ email: '', name: '', source: 'none' })
  })

  it('short-circuits on an empty uid', async () => {
    const r = await resolveOrganizerEmailIdentity('')
    expect(r.source).toBe('none')
    expect(r.email).toBe('')
  })
})

// ── ensureOrganizerProfile ────────────────────────────────────────────────────
describe('ensureOrganizerProfile', () => {
  it('is a no-op when the profile already exists (returns it, writes nothing)', async () => {
    state.userDoc = { uid: 'u1', email: 'fs@example.com', role: 'organizer' }
    const r = await ensureOrganizerProfile('u1')
    expect(r).toEqual(state.userDoc)
    expect(state.setCalls).toHaveLength(0)
  })

  it('reconstructs a missing profile from the Auth record (unverified)', async () => {
    state.userDoc  = null
    state.authUser = { email: 'auth@example.com', displayName: 'Auth Name', emailVerified: false }
    const r = await ensureOrganizerProfile('u1')

    expect(state.setCalls).toHaveLength(1)
    expect(state.setCalls[0].opts).toEqual({ merge: true })
    expect(r).toMatchObject({
      uid:              'u1',
      email:            'auth@example.com',
      name:             'Auth Name',
      role:             'organizer',
      organizationName: '',
      emailVerified:    false,
      profileHealed:    true,
    })
    expect((r as { trust: { level: string } }).trust.level).toBe('unverified')
  })

  it('reflects a verified Auth email into the reconstructed profile', async () => {
    state.userDoc  = null
    state.authUser = { email: 'auth@example.com', emailVerified: true }
    const r = await ensureOrganizerProfile('u1') as {
      emailVerified: boolean; name: string; trust: { level: string; score: number }
    }
    expect(r.emailVerified).toBe(true)
    expect(r.name).toBe('auth')                 // derived from the email local-part
    expect(r.trust).toMatchObject({ level: 'email_verified', score: 45 })
  })

  it('returns null for an empty uid without writing', async () => {
    const r = await ensureOrganizerProfile('')
    expect(r).toBeNull()
    expect(state.setCalls).toHaveLength(0)
  })
})
