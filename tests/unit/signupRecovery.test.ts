// RD-AUTH-01 Phase 2 (H-A) — signup reliability & orphan-user recovery.
//
// Exercises createOrganizerAccount (lib/firebase/auth) with firebase/auth + the
// firestore profile helpers mocked, covering every VERIFY scenario: happy path,
// Firestore-fails-after-Auth (orphan created), retry recovery, duplicate submit,
// existing complete account, wrong password, and non-recoverable network errors.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FirebaseError } from 'firebase/app'

vi.mock('@/lib/firebase/config', () => ({ firebaseApp: {} }))

vi.mock('firebase/auth', () => ({
  getAuth:                        () => ({ currentUser: null }),
  setPersistence:                vi.fn(() => Promise.resolve()),
  browserLocalPersistence:       {},
  createUserWithEmailAndPassword: vi.fn(),
  updateProfile:                 vi.fn(() => Promise.resolve()),
  signInWithEmailAndPassword:    vi.fn(),
  signOut:                       vi.fn(() => Promise.resolve()),
  sendPasswordResetEmail:        vi.fn(() => Promise.resolve()),
}))

vi.mock('@/lib/firebase/firestore', () => ({
  db:                     {},
  createOrganizerProfile: vi.fn(() => Promise.resolve()),
  organizerProfileExists: vi.fn(() => Promise.resolve(false)),
}))

import { createOrganizerAccount } from '@/lib/firebase/auth'
import {
  createUserWithEmailAndPassword,
  updateProfile,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import { createOrganizerProfile, organizerProfileExists } from '@/lib/firebase/firestore'

const cu  = vi.mocked(createUserWithEmailAndPassword)
const si  = vi.mocked(signInWithEmailAndPassword)
const so  = vi.mocked(signOut)
const up  = vi.mocked(updateProfile)
const cop = vi.mocked(createOrganizerProfile)
const ope = vi.mocked(organizerProfileExists)

const mkUser = (uid = 'uid-1', email = 'jane@example.com') => ({ uid, email })
const SIGNUP = { name: 'Jane Smith', email: 'jane@example.com', password: 'secret123', orgName: 'Acme Events', mobileE164: '+919000000001', mobileCountryCode: '+91' }
const emailInUse = () => new FirebaseError('auth/email-already-in-use', 'exists')

beforeEach(() => {
  // clearMocks (vitest config) resets call history each test; restore default impls.
  up.mockResolvedValue(undefined as never)
  so.mockResolvedValue(undefined as never)
  cop.mockResolvedValue(undefined as never)
  ope.mockResolvedValue(false)
})

describe('createOrganizerAccount — happy path', () => {
  it('creates the Auth user then the canonical profile, no recovery attempted', async () => {
    cu.mockResolvedValue({ user: mkUser() } as never)

    await expect(createOrganizerAccount(SIGNUP)).resolves.toBeUndefined()

    expect(cu).toHaveBeenCalledOnce()
    expect(up).toHaveBeenCalledWith(expect.anything(), { displayName: 'Jane Smith' })
    expect(cop).toHaveBeenCalledWith('uid-1', {
      name: 'Jane Smith', email: 'jane@example.com', organizationName: 'Acme Events',
      mobileE164: '+919000000001', mobileCountryCode: '+91',
    })
    expect(si).not.toHaveBeenCalled()
    expect(so).not.toHaveBeenCalled()
  })
})

describe('createOrganizerAccount — orphan recovery', () => {
  it('Firestore write fails right after Auth create → throws (orphan left for retry)', async () => {
    cu.mockResolvedValue({ user: mkUser() } as never)
    cop.mockRejectedValueOnce(new Error('firestore unavailable'))

    await expect(createOrganizerAccount(SIGNUP)).rejects.toThrow('firestore unavailable')
    // Auth user now exists without a profile — recoverable on the next submit (below).
  })

  it('retry on an orphaned account (no profile) → re-auths and completes the profile, orgName preserved, stays signed in', async () => {
    cu.mockRejectedValue(emailInUse())
    si.mockResolvedValue({ user: mkUser() } as never)
    ope.mockResolvedValue(false)

    await expect(createOrganizerAccount(SIGNUP)).resolves.toBeUndefined()

    expect(si).toHaveBeenCalledOnce()
    expect(ope).toHaveBeenCalledWith('uid-1')
    expect(cop).toHaveBeenCalledWith('uid-1', expect.objectContaining({ organizationName: 'Acme Events' }))
    expect(so).not.toHaveBeenCalled()   // must remain signed in so the caller can request the OTP
  })
})

describe('createOrganizerAccount — non-recoverable / duplicate', () => {
  it('existing COMPLETE account (profile present) → signs back out, surfaces email-already-in-use, does not touch the profile', async () => {
    cu.mockRejectedValue(emailInUse())
    si.mockResolvedValue({ user: mkUser() } as never)
    ope.mockResolvedValue(true)

    await expect(createOrganizerAccount(SIGNUP)).rejects.toMatchObject({ code: 'auth/email-already-in-use' })

    expect(so).toHaveBeenCalledOnce()
    expect(cop).not.toHaveBeenCalled()
  })

  it('existing account, WRONG password → rethrows email-already-in-use, no profile probe, no sign-out', async () => {
    cu.mockRejectedValue(emailInUse())
    si.mockRejectedValue(new FirebaseError('auth/wrong-password', 'nope'))

    await expect(createOrganizerAccount(SIGNUP)).rejects.toMatchObject({ code: 'auth/email-already-in-use' })

    expect(ope).not.toHaveBeenCalled()
    expect(so).not.toHaveBeenCalled()
    expect(cop).not.toHaveBeenCalled()
  })

  it('non-duplicate Auth error (network) → rethrows unchanged, no recovery attempted', async () => {
    cu.mockRejectedValue(new FirebaseError('auth/network-request-failed', 'net'))

    await expect(createOrganizerAccount(SIGNUP)).rejects.toMatchObject({ code: 'auth/network-request-failed' })

    expect(si).not.toHaveBeenCalled()
    expect(cop).not.toHaveBeenCalled()
  })
})
