// RD-AUTH-01 Phase 3 (H-B) — session persistence & Remember Me.
//
// Verifies the ONE canonical persistence decision in lib/firebase/auth: Remember Me
// selects browserLocalPersistence (true) vs browserSessionPersistence (false), it is
// applied BEFORE sign-in, every login path (authenticateUser + signInOrganizer) routes
// through it, and the no-checkbox default stays local (admin unchanged).

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/config', () => ({ firebaseApp: {} }))

vi.mock('firebase/auth', () => ({
  getAuth:                        () => ({ currentUser: null }),
  setPersistence:                vi.fn(() => Promise.resolve()),
  browserLocalPersistence:       { __persistence: 'local' },
  browserSessionPersistence:     { __persistence: 'session' },
  createUserWithEmailAndPassword: vi.fn(),
  updateProfile:                 vi.fn(() => Promise.resolve()),
  signInWithEmailAndPassword:    vi.fn(() => Promise.resolve({
    user: { uid: 'u1', email: 'a@b.c', emailVerified: true, reload: () => Promise.resolve() },
  })),
  signOut:                       vi.fn(() => Promise.resolve()),
  sendPasswordResetEmail:        vi.fn(() => Promise.resolve()),
}))

vi.mock('@/lib/firebase/firestore', () => ({
  db:                     {},
  createOrganizerProfile: vi.fn(() => Promise.resolve()),
  organizerProfileExists: vi.fn(() => Promise.resolve(false)),
}))

import { authenticateUser, signInOrganizer } from '@/lib/firebase/auth'
import {
  setPersistence,
  signInWithEmailAndPassword,
  browserLocalPersistence,
  browserSessionPersistence,
} from 'firebase/auth'

const sp = vi.mocked(setPersistence)
const si = vi.mocked(signInWithEmailAndPassword)

describe('Remember Me — one canonical persistence decision', () => {
  it('remember = true → browserLocalPersistence (persists across restarts)', async () => {
    await authenticateUser('a@b.c', 'pw', true)
    expect(sp).toHaveBeenCalledOnce()
    expect(sp).toHaveBeenCalledWith(expect.anything(), browserLocalPersistence)
  })

  it('remember = false → browserSessionPersistence (cleared on browser close)', async () => {
    await authenticateUser('a@b.c', 'pw', false)
    expect(sp).toHaveBeenCalledWith(expect.anything(), browserSessionPersistence)
  })

  it('no remember arg → defaults to local (admin / no-checkbox callers unchanged)', async () => {
    await authenticateUser('a@b.c', 'pw')
    expect(sp).toHaveBeenCalledWith(expect.anything(), browserLocalPersistence)
  })

  it('persistence is applied BEFORE the credential sign-in', async () => {
    await authenticateUser('a@b.c', 'pw', false)
    expect(sp.mock.invocationCallOrder[0]).toBeLessThan(si.mock.invocationCallOrder[0])
  })

  it('signInOrganizer forwards Remember Me to the same single decision', async () => {
    await signInOrganizer('a@b.c', 'pw', false)
    expect(sp).toHaveBeenLastCalledWith(expect.anything(), browserSessionPersistence)

    await signInOrganizer('a@b.c', 'pw', true)
    expect(sp).toHaveBeenLastCalledWith(expect.anything(), browserLocalPersistence)
  })
})
